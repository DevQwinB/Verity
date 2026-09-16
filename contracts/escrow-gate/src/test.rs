#![cfg(test)]

use crate::{EscrowGate, EscrowGateClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};
use verity_common::{ConfigRecord, Error, ResolutionMethod, TaskType, Verdict};
use zk_verifier_registry::{ZkVerifierRegistry, ZkVerifierRegistryClient};

const STROOP: i128 = 1;
const XLM: i128 = 10_000_000 * STROOP;

fn default_config() -> ConfigRecord {
    ConfigRecord {
        min_stake_floor: 500 * XLM,
        quorum_min_reexecutors: 3,
        quorum_supermajority_bps: 6600,
        agent_bond_min_bps: 500,
        challenger_bond_min_bps: 500,
        window_tier_small_ceiling: 100_000 * XLM,
        window_tier_small_s: 3600,
        window_tier_large_s: 86_400,
        slash_split_challenger_bps: 2000,
    }
}

struct World<'a> {
    e: Env,
    client: EscrowGateClient<'a>,
    admin: Address,
    token: token::Client<'a>,
    token_admin: token::StellarAssetClient<'a>,
}

fn setup(e: &Env) -> World<'_> {
    e.mock_all_auths();
    let admin = Address::generate(e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(e, &sac.address());
    let token_admin = token::StellarAssetClient::new(e, &sac.address());

    let id = e.register(EscrowGate, ());
    let client = EscrowGateClient::new(e, &id);
    client.initialize(&admin, &sac.address(), &default_config());

    World { e: e.clone(), client, admin, token, token_admin }
}

fn fund(w: &World, who: &Address, amount: i128) {
    w.token_admin.mint(who, &amount);
}

fn submit_default(w: &World, agent: &Address) -> u64 {
    fund(w, agent, 1000 * XLM);
    w.client.submit(
        agent,
        &BytesN::from_array(&w.e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&w.e, &[2u8; 32]),
        &BytesN::from_array(&w.e, &[3u8; 32]),
        &(50 * XLM), // 5% of escrow_value, exactly the min bond
    )
}

fn register_rex(w: &World, rex: &Address) {
    fund(w, rex, 2000 * XLM);
    w.client.register_reexecutor(rex, &(600 * XLM));
}

// ---- basic submit / bond custody ----

#[test]
fn submit_transfers_bond_and_creates_pending_submission() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    assert_eq!(w.token.balance(&agent), 950 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 50 * XLM);

    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.verdict, Verdict::Pending);
    assert!(!sub.finalized);
}

#[test]
fn submit_rejects_bond_below_minimum() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);

    let res = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(10 * XLM), // below the 5% = 50 XLM floor
    );
    assert!(matches!(res, Err(Ok(Error::BondTooLow))));
}

#[test]
fn submit_rejects_unverifiable_task_type() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);

    let res = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Unverifiable,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );
    assert!(matches!(res, Err(Ok(Error::InvalidTaskType))));
}

// ---- invariant 1: no auto-verify before window closes unless majority already exists ----

#[test]
fn finalize_before_window_with_no_votes_stays_pending() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    assert_eq!(w.client.finalize(&id), Verdict::Pending);
    let sub = w.client.get_submission(&id).unwrap();
    assert!(!sub.finalized);
}

#[test]
fn early_consensus_match_supermajority_allows_finalize_before_window() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }

    // Window is 24h (escrow_value 1000 XLM >= 100,000 XLM ceiling? no —
    // 1000 XLM < 100_000 XLM ceiling, so this is actually the 1h tier).
    // Regardless, finalize succeeds immediately because 3/3 unanimous match
    // votes clears the quorum (3) and supermajority (66%) with zero elapsed
    // time — this IS invariant 1's early path.
    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Verified);
    assert_eq!(w.token.balance(&agent), 1000 * XLM); // bond returned in full
}

#[test]
fn mismatch_supermajority_slashes_agent_bond_without_a_challenge() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Slashed);
    // Agent never gets the bond back; no challenger exists so it routes to admin.
    assert_eq!(w.token.balance(&agent), 950 * XLM);
    assert_eq!(w.token.balance(&w.admin), 50 * XLM);
}

#[test]
fn window_elapsed_with_no_consensus_and_no_challenge_defaults_verified() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    // One lone match vote: quorum of 3 never reached, so no early consensus.
    let rex1 = Address::generate(&e);
    register_rex(&w, &rex1);
    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601); // past the 1h window
    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Verified);
    assert_eq!(w.token.balance(&agent), 1000 * XLM);
}

// ---- invariant 3: finalize is idempotent and irreversible ----

#[test]
fn finalize_is_idempotent_zero_extra_writes_or_transfers() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    let v1 = w.client.finalize(&id);
    let bal_after_first = w.token.balance(&agent);

    let v2 = w.client.finalize(&id);
    let v3 = w.client.finalize(&id);
    assert_eq!(v1, v2);
    assert_eq!(v2, v3);
    assert_eq!(w.token.balance(&agent), bal_after_first); // no double payout
}

#[test]
fn open_challenge_after_finalize_is_rejected() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    w.client.finalize(&id);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    let res = w.client.try_open_challenge(&challenger, &id, &(50 * XLM));
    assert!(matches!(res, Err(Ok(Error::ChallengeWindowClosed))));
}

// ---- invariant 2: slash derives authority only from already-committed state ----

#[test]
fn slash_called_by_admin_has_no_special_power() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    // Not finalized yet — even the admin cannot slash.
    let rex1 = Address::generate(&e);
    register_rex(&w, &rex1);
    let res = w.client.try_slash(&w.admin, &rex1, &id, &XLM);
    assert!(matches!(res, Err(Ok(Error::SubmissionNotFinalized))));
}

#[test]
fn slash_requires_the_target_to_actually_be_on_the_wrong_side() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    let honest = [&rex1, &rex2, &rex3];
    for r in honest {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }
    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Verified);

    // rex1 voted "matched" (the correct side, since verdict is Verified) —
    // slashing them must fail regardless of who calls it, including admin.
    let random_caller = Address::generate(&e);
    let res = w.client.try_slash(&random_caller, &rex1, &id, &XLM);
    assert!(matches!(res, Err(Ok(Error::PartyNotOnWrongSide)))); // never on-chain state says otherwise
}

#[test]
fn slash_succeeds_against_a_provably_wrong_voter_after_mismatch_consensus() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e); // will vote wrong (matched=true)
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    register_rex(&w, &rex1);
    register_rex(&w, &rex2);
    register_rex(&w, &rex3);
    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[9u8; 32]), &true);
    w.client.attest_replay(&rex2, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    w.client.attest_replay(&rex3, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);

    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Slashed);

    let any_random_keeper = Address::generate(&e);
    w.client.slash(&any_random_keeper, &rex1, &id, &(100 * XLM));
    let info = w.client.reexecutor_info(&rex1).unwrap();
    assert_eq!(info.stake_amount, 500 * XLM); // 600 - 100

    // Cannot slash the same party twice for the same submission.
    let res = w.client.try_slash(&any_random_keeper, &rex1, &id, &XLM);
    assert!(matches!(res, Err(Ok(Error::AlreadySlashed))));
}

// ---- invariant 5: bond proportionality holds across the i128 range without wrapping ----

#[test]
fn bond_math_does_not_wrap_at_i128_extremes() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, i128::MAX);

    // Just under the point where value * agent_bond_min_bps (500) would
    // overflow i128: correct checked math computes the true 5% bond exactly.
    let large_but_safe_value = i128::MAX / 501;
    let exact_min_bond = (large_but_safe_value * 500) / 10_000;
    let res_ok = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &large_but_safe_value,
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &exact_min_bond,
    );
    assert!(res_ok.is_ok(), "expected exact-proportional bond to succeed: {:?}", res_ok);

    // Just over that point, naive `value * bps` (never mind `* 10_000` for
    // the challenger-bond check elsewhere) overflows i128 — checked
    // arithmetic must produce a clean Overflow error, never a silent wrap
    // into a small or negative "bond requirement".
    let overflowing_value = i128::MAX / 100;
    let res_overflow = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[4u8; 32]),
        &overflowing_value,
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[5u8; 32]),
        &BytesN::from_array(&e, &[6u8; 32]),
        &(overflowing_value / 2),
    );
    assert!(matches!(res_overflow, Err(Ok(Error::Overflow))), "expected a clean Overflow error, got {:?}", res_overflow);
}

// ---- invariant 4: ZKVerifierRegistry never default-accepts ----

#[test]
#[should_panic]
fn resolve_challenge_via_zk_proof_traps_against_empty_registry() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let registry_id = e.register(ZkVerifierRegistry, ());
    let registry_client = ZkVerifierRegistryClient::new(&e, &registry_id);
    registry_client.initialize(&w.admin);
    assert_eq!(registry_client.list_verifiers().len(), 0);
    w.client.set_zk_registry(&w.admin, &registry_id);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    // The registry has zero registered verifiers, so this must trap rather
    // than fabricate a ZK-verified result — that is the whole point of
    // invariant 4, and #[should_panic] is how a cross-contract trap surfaces
    // in a test.
    w.client.resolve_challenge(&id, &ResolutionMethod::ZkProof);
}

// ---- challenge flow end to end ----

#[test]
fn challenge_upheld_slashes_agent_bond_and_pays_challenger() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    let verdict = w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus);
    assert_eq!(verdict, Verdict::Slashed);

    // challenger gets 20% of the 50 XLM forfeited agent bond = 10 XLM, plus
    // their own 50 XLM challenge bond back... actually the challenge bond
    // itself is not auto-refunded by settle() (only the agent's submission
    // bond is split) — assert the documented split share landed.
    assert_eq!(w.token.balance(&challenger), 1000 * XLM - 50 * XLM + 10 * XLM);
    assert_eq!(w.token.balance(&w.admin), 40 * XLM);
}

#[test]
fn challenge_rejected_verifies_agent() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }

    let verdict = w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus);
    assert_eq!(verdict, Verdict::Verified);
    assert_eq!(w.token.balance(&agent), 1000 * XLM);
}

// ---- withdraw / release_attestation_lock bookkeeping ----

#[test]
fn withdraw_is_blocked_below_floor_while_attestation_is_open_then_unlocks_after_finalize() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    register_rex(&w, &rex1); // stake = 600 XLM, floor = 500 XLM
    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);

    // Withdrawing 150 XLM would drop stake to 450, below the 500 floor,
    // while this attestation is still open on an unfinalized submission.
    let res = w.client.try_withdraw_stake(&rex1, &(150 * XLM));
    assert!(matches!(res, Err(Ok(Error::StakeLockedByOpenAttestation))));

    // Withdrawing down to exactly the floor (100 XLM) is fine.
    w.client.withdraw_stake(&rex1, &(100 * XLM));

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    w.client.finalize(&id);

    w.client.release_attestation_lock(&id, &rex1);
    // Now fully unlocked — can withdraw everything.
    w.client.withdraw_stake(&rex1, &(500 * XLM));
    let info = w.client.reexecutor_info(&rex1).unwrap();
    assert_eq!(info.stake_amount, 0);
}

mod proptest_model;

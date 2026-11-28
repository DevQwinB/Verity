#![cfg(test)]
//! Model-based test: a randomized sequence of attest_replay votes (with
//! random stakes and random match/mismatch) is applied to the real contract,
//! then finalize()'s outcome is checked against an independent reference
//! implementation of the same bonded-supermajority rule. This is the
//! highest-leverage test for sequencing/threshold bugs in consensus_outcome,
//! run across many randomized cases rather than a handful of hand-picked ones.

use crate::{EscrowGate, EscrowGateClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};
use verity_common::{ConfigRecord, ResolutionMethod, TaskType, Verdict};

const XLM: i128 = 10_000_000;
const QUORUM_MIN: u32 = 3;
const SUPERMAJORITY_BPS: i64 = 6600;

fn reference_outcome(votes: &[(i128, bool)]) -> Option<Verdict> {
    let total_votes = votes.len() as u32;
    if total_votes < QUORUM_MIN {
        return None;
    }
    let matched_weight: i64 = votes
        .iter()
        .filter(|(_, m)| *m)
        .map(|(s, _)| *s as i64)
        .sum();
    let mismatched_weight: i64 = votes
        .iter()
        .filter(|(_, m)| !*m)
        .map(|(s, _)| *s as i64)
        .sum();
    let total = matched_weight + mismatched_weight;
    if total <= 0 {
        return None;
    }
    if matched_weight * 10_000 >= total * SUPERMAJORITY_BPS {
        return Some(Verdict::Verified);
    }
    if mismatched_weight * 10_000 >= total * SUPERMAJORITY_BPS {
        return Some(Verdict::Slashed);
    }
    None
}

fn run_case(votes: Vec<(i64, bool)>) {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let config = ConfigRecord {
        min_stake_floor: 1,
        quorum_min_reexecutors: QUORUM_MIN,
        quorum_supermajority_bps: SUPERMAJORITY_BPS as u32,
        agent_bond_min_bps: 500,
        challenger_bond_min_bps: 500,
        window_tier_small_ceiling: 100_000 * XLM,
        window_tier_small_s: 3600,
        window_tier_large_s: 86_400,
        slash_split_challenger_bps: 2000,
        reexecutor_slash_bps: 1000,
        voter_reward_bps: 0,
        reexecutor_allowlist: false,
    };
    let id = e.register(EscrowGate, (admin.clone(), sac.address(), config));
    let client = EscrowGateClient::new(&e, &id);

    let agent = Address::generate(&e);
    token_admin.mint(&agent, &(1000 * XLM));
    let submission_id = client.submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    let mut recorded_votes = Vec::new();
    for (stake, matched) in &votes {
        let stake = (*stake).max(1) as i128;
        let rex = Address::generate(&e);
        token_admin.mint(&rex, &(stake + 1));
        client.register_reexecutor(&rex, &stake);
        // A match reports the claimed hash, a mismatch a different one.
        let hash = BytesN::from_array(&e, &[if *matched { 3u8 } else { 9u8 }; 32]);
        client.attest_replay(&rex, &submission_id, &hash, matched);
        recorded_votes.push((stake, *matched));
    }

    let expected = reference_outcome(&recorded_votes);
    let actual = client.finalize(&submission_id);

    match expected {
        Some(v) => {
            assert_eq!(actual, v, "votes={:?}", recorded_votes);
            assert_eq!(
                client
                    .get_submission(&submission_id)
                    .unwrap()
                    .resolution_method,
                ResolutionMethod::ReexecutionConsensus
            );
        }
        None => {
            assert_eq!(
                actual,
                Verdict::Pending,
                "expected no consensus yet (window hasn't elapsed): votes={:?}",
                recorded_votes
            );
            // Once the window closes without a consensus, the outcome is a
            // default, never a slash: Verified only if nobody reported a
            // mismatch, and always labelled as a window that elapsed.
            e.ledger().with_mut(|l| l.timestamp += 3600);
            let any_mismatch = recorded_votes.iter().any(|(_, matched)| !*matched);
            let defaulted = client.finalize(&submission_id);
            assert_eq!(
                defaulted,
                if any_mismatch {
                    Verdict::ExpiredUnverified
                } else {
                    Verdict::Verified
                },
                "votes={:?}",
                recorded_votes
            );
            assert_eq!(
                client
                    .get_submission(&submission_id)
                    .unwrap()
                    .resolution_method,
                ResolutionMethod::WindowElapsed
            );
            assert_eq!(
                token.balance(&agent),
                1000 * XLM,
                "bond must come back on a default"
            );
        }
    }
    let _ = token; // silence unused warning if a future edit drops balance assertions
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn finalize_matches_reference_supermajority_model(
        votes in prop::collection::vec((1i64..1_000_000i64, any::<bool>()), 0..8)
    ) {
        run_case(votes);
    }
}

/// Voter rewards: whatever the votes, the shares and the order of the calls,
/// the contract never pays out more than it took in. After every lock is
/// released and every reward claimed, what it still holds is exactly the
/// stakes that remain plus the part of the reward pool nobody could draw, and
/// that part is never negative.
fn run_reward_case(
    votes: Vec<(i64, bool)>,
    split_bps: u32,
    reward_bps: u32,
    challenged: bool,
    release_order_seed: u64,
) {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let config = ConfigRecord {
        min_stake_floor: 1,
        quorum_min_reexecutors: QUORUM_MIN,
        quorum_supermajority_bps: SUPERMAJORITY_BPS as u32,
        agent_bond_min_bps: 500,
        challenger_bond_min_bps: 500,
        window_tier_small_ceiling: 100_000 * XLM,
        window_tier_small_s: 3600,
        window_tier_large_s: 86_400,
        slash_split_challenger_bps: split_bps,
        reexecutor_slash_bps: 1000,
        voter_reward_bps: reward_bps,
        reexecutor_allowlist: false,
    };
    let id = e.register(EscrowGate, (admin.clone(), sac.address(), config));
    let client = EscrowGateClient::new(&e, &id);

    let agent = Address::generate(&e);
    token_admin.mint(&agent, &(1000 * XLM));
    let submission_id = client.submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );
    let challenger = Address::generate(&e);
    if challenged {
        token_admin.mint(&challenger, &(50 * XLM));
        client.open_challenge(&challenger, &submission_id, &(50 * XLM));
    }

    let mut voters = Vec::new();
    for (stake, matched) in &votes {
        let stake = (*stake).max(1) as i128;
        let rex = Address::generate(&e);
        token_admin.mint(&rex, &stake);
        client.register_reexecutor(&rex, &stake);
        let hash = BytesN::from_array(&e, &[if *matched { 3u8 } else { 9u8 }; 32]);
        client.attest_replay(&rex, &submission_id, &hash, matched);
        voters.push(rex);
    }

    // Everything the contract was ever given.
    let taken_in = token.balance(&id);

    // Settle it one way or another.
    if challenged
        && client
            .try_resolve_challenge(&submission_id, &ResolutionMethod::ReexecutionConsensus)
            .is_err()
    {
        e.ledger().with_mut(|l| l.timestamp += 3600);
    }
    if client.finalize(&submission_id) == Verdict::Pending {
        e.ledger().with_mut(|l| l.timestamp += 3600);
        client.finalize(&submission_id);
    }
    let sub = client.get_submission(&submission_id).unwrap();
    assert!(sub.finalized, "votes={:?}", votes);

    // Release the locks in an order the case chooses, claiming in between.
    let mut order: Vec<usize> = (0..voters.len()).collect();
    let mut seed = release_order_seed;
    for i in (1..order.len()).rev() {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        order.swap(i, (seed >> 33) as usize % (i + 1));
    }
    let mut rewarded: i128 = 0;
    for &i in &order {
        let before = token.balance(&voters[i]);
        client.release_attestation_lock(&submission_id, &voters[i]);
        rewarded += token.balance(&voters[i]) - before;
        // A claim by somebody released earlier, for what was added since.
        rewarded += client.claim_voter_reward(&submission_id, &voters[order[0]]);
    }
    for rex in &voters {
        rewarded += client.claim_voter_reward(&submission_id, rex);
        assert_eq!(client.claim_voter_reward(&submission_id, rex), 0);
    }

    let pool = client.get_reward_pool(&submission_id);
    assert!(
        rewarded <= pool,
        "paid {} from a pool of {}: votes={:?}",
        rewarded,
        pool,
        votes
    );
    if sub.resolution_method != ResolutionMethod::ReexecutionConsensus {
        assert_eq!(
            pool, 0,
            "a window verdict set money aside: votes={:?}",
            votes
        );
    }

    let stakes: i128 = voters
        .iter()
        .map(|rex| client.reexecutor_info(rex).unwrap().stake_amount)
        .sum();
    let held = token.balance(&id);
    assert_eq!(held, stakes + (pool - rewarded), "votes={:?}", votes);
    assert!(held <= taken_in);
    assert!(held >= 0);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn rewards_never_pay_out_more_than_was_forfeited(
        votes in prop::collection::vec((1i64..1_000_000i64, any::<bool>()), 0..8),
        split_bps in 0u32..=10_000u32,
        reward_part in 0u32..=10_000u32,
        challenged in any::<bool>(),
        seed in any::<u64>(),
    ) {
        // Any pair of shares the config check accepts.
        let reward_bps = reward_part.min(10_000 - split_bps);
        run_reward_case(votes, split_bps, reward_bps, challenged, seed);
    }
}

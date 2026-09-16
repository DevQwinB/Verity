// Tests link std (needed by proptest and the std::vec::Vec used in the
// proptest model harness); the actual deployed contract build stays no_std.
#![cfg_attr(not(test), no_std)]
// submit()'s 8 scalar args mirror the PRD §8 entrypoint signature (plus the
// escrow_value this design adds) — a Soroban contract entrypoint, not an
// internal API a caller would otherwise want bundled into a struct.
#![allow(clippy::too_many_arguments)]

mod events;
mod storage;

use events::{
    ChallengeOpened, ChallengeResolved, Finalized, ReexecutorRegistered,
    ReexecutorStakeWithdrawn, ReplayAttested, Slashed, SubmissionCreated,
};
use soroban_sdk::{contract, contractimpl, vec, Address, Bytes, BytesN, Env, IntoVal, Symbol};
use verity_common::{
    ChallengeRecord, ConfigRecord, Error, ReexecutorInfo, Resolution, ResolutionMethod,
    SubmissionRecord, TaskType, Verdict,
};

const MAX_BPS: i128 = 10_000;

fn checked_bps(value: i128, bps: u32) -> Result<i128, Error> {
    let product = value.checked_mul(bps as i128).ok_or(Error::Overflow)?;
    product.checked_div(MAX_BPS).ok_or(Error::Overflow)
}

fn validate_config(cfg: &ConfigRecord) -> Result<(), Error> {
    if cfg.quorum_supermajority_bps < ConfigRecord::MIN_SUPERMAJORITY_BPS
        || cfg.quorum_supermajority_bps > ConfigRecord::MAX_BPS
    {
        return Err(Error::InvalidConfig);
    }
    if cfg.window_tier_small_s < ConfigRecord::MIN_WINDOW_S
        || cfg.window_tier_large_s < ConfigRecord::MIN_WINDOW_S
    {
        return Err(Error::InvalidConfig);
    }
    if cfg.agent_bond_min_bps == 0 || cfg.agent_bond_min_bps > ConfigRecord::MAX_BPS {
        return Err(Error::InvalidConfig);
    }
    if cfg.challenger_bond_min_bps == 0 || cfg.challenger_bond_min_bps > ConfigRecord::MAX_BPS {
        return Err(Error::InvalidConfig);
    }
    if cfg.slash_split_challenger_bps > ConfigRecord::MAX_BPS {
        return Err(Error::InvalidConfig);
    }
    if cfg.quorum_min_reexecutors == 0 {
        return Err(Error::InvalidConfig);
    }
    if cfg.window_tier_small_ceiling < 0 {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

/// Supermajority check on already-tallied bonded vote weight. Returns the
/// implied terminal verdict once BOTH a minimum voter count and a bonded
/// supermajority in one direction are reached; None while the outcome is
/// still contested or under-quorate.
fn consensus_outcome(sub: &SubmissionRecord) -> Result<Option<Verdict>, Error> {
    let total_votes = sub.match_votes + sub.mismatch_votes;
    if total_votes < sub.cfg_quorum_min_reexecutors {
        return Ok(None);
    }
    let total_weight = sub
        .bonded_weight_matched
        .checked_add(sub.bonded_weight_mismatched)
        .ok_or(Error::Overflow)?;
    if total_weight <= 0 {
        return Ok(None);
    }
    let rhs = total_weight
        .checked_mul(sub.cfg_quorum_supermajority_bps as i128)
        .ok_or(Error::Overflow)?;
    let match_lhs = sub
        .bonded_weight_matched
        .checked_mul(MAX_BPS)
        .ok_or(Error::Overflow)?;
    if match_lhs >= rhs {
        return Ok(Some(Verdict::Verified));
    }
    let mismatch_lhs = sub
        .bonded_weight_mismatched
        .checked_mul(MAX_BPS)
        .ok_or(Error::Overflow)?;
    if mismatch_lhs >= rhs {
        return Ok(Some(Verdict::Slashed));
    }
    Ok(None)
}

fn settle(e: &Env, sub: &SubmissionRecord) -> Result<(), Error> {
    let bond_asset = storage::get_bond_asset(e).ok_or(Error::NotInitialized)?;
    let token = soroban_sdk::token::TokenClient::new(e, &bond_asset);
    let contract_address = e.current_contract_address();
    match sub.verdict {
        Verdict::Verified => {
            if sub.bond_amount > 0 {
                token.transfer(&contract_address, sub.agent.clone(), &sub.bond_amount);
            }
        }
        Verdict::Slashed => {
            let admin = storage::get_admin(e).ok_or(Error::NotInitialized)?;
            if let Some(chal) = storage::get_challenge(e, sub.id) {
                let challenger_share =
                    checked_bps(sub.bond_amount, sub.cfg_slash_split_challenger_bps)?;
                let remainder = sub
                    .bond_amount
                    .checked_sub(challenger_share)
                    .ok_or(Error::Overflow)?;
                if challenger_share > 0 {
                    token.transfer(&contract_address, chal.challenger.clone(), &challenger_share);
                }
                if remainder > 0 {
                    token.transfer(&contract_address, admin, &remainder);
                }
            } else if sub.bond_amount > 0 {
                // Pure replay-consensus slash: no challenger exists to reward,
                // so the forfeited agent bond routes to the admin/treasury
                // account configured at initialize().
                token.transfer(&contract_address, admin, &sub.bond_amount);
            }
        }
        _ => {}
    }
    Ok(())
}

#[contract]
pub struct EscrowGate;

#[contractimpl]
impl EscrowGate {
    pub fn initialize(
        e: Env,
        admin: Address,
        bond_asset: Address,
        config: ConfigRecord,
    ) -> Result<(), Error> {
        if storage::get_admin(&e).is_some() {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        validate_config(&config)?;
        storage::set_admin(&e, &admin);
        storage::set_bond_asset(&e, &bond_asset);
        storage::set_config(&e, &config);
        Ok(())
    }

    /// Admin-gated, additive capability change only (which knobs future
    /// submissions use) — never a per-submission or per-dispute override.
    /// Every SubmissionRecord snapshots the config values that govern it at
    /// submit() time, so this can never retroactively change an in-flight
    /// submission's rules.
    pub fn update_config(e: Env, admin: Address, config: ConfigRecord) -> Result<(), Error> {
        let stored_admin = storage::get_admin(&e).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::NotAdmin);
        }
        validate_config(&config)?;
        storage::set_config(&e, &config);
        Ok(())
    }

    /// Registers the (currently empty-by-design) ZKVerifierRegistry this
    /// deployment will consult from resolve_challenge's ZkProof branch.
    pub fn set_zk_registry(e: Env, admin: Address, registry: Address) -> Result<(), Error> {
        let stored_admin = storage::get_admin(&e).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::NotAdmin);
        }
        storage::set_zk_registry(&e, &registry);
        Ok(())
    }

    pub fn submit(
        e: Env,
        agent: Address,
        escrow_ref: BytesN<32>,
        escrow_value: i128,
        task_type: TaskType,
        input_hash: BytesN<32>,
        output_hash: BytesN<32>,
        bond: i128,
    ) -> Result<u64, Error> {
        agent.require_auth();
        if escrow_value <= 0 {
            return Err(Error::InvalidEscrowValue);
        }
        // v1 only covers deterministic-replayable and statistically
        // spot-checkable retrieval tasks (PRD §5/§3 scope). Open-ended/
        // subjective tasks have no on-chain verification path in Phase 1.
        if matches!(task_type, TaskType::Unverifiable) {
            return Err(Error::InvalidTaskType);
        }
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;

        let min_bond = checked_bps(escrow_value, cfg.agent_bond_min_bps)?;
        if bond < min_bond {
            return Err(Error::BondTooLow);
        }

        let contract_address = e.current_contract_address();
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&agent, contract_address, &bond);

        let window_s = if escrow_value < cfg.window_tier_small_ceiling {
            cfg.window_tier_small_s
        } else {
            cfg.window_tier_large_s
        };

        let id = storage::next_submission_id(&e);
        let record = SubmissionRecord {
            id,
            agent: agent.clone(),
            escrow_ref: escrow_ref.clone(),
            escrow_value,
            task_type,
            input_hash,
            claimed_output_hash: output_hash,
            bond_amount: bond,
            submitted_at: e.ledger().timestamp(),
            challenge_window_s: window_s,
            verdict: Verdict::Pending,
            finalized: false,
            match_votes: 0,
            mismatch_votes: 0,
            bonded_weight_matched: 0,
            bonded_weight_mismatched: 0,
            resolution_method: ResolutionMethod::None,
            cfg_quorum_min_reexecutors: cfg.quorum_min_reexecutors,
            cfg_quorum_supermajority_bps: cfg.quorum_supermajority_bps,
            cfg_slash_split_challenger_bps: cfg.slash_split_challenger_bps,
            cfg_challenger_bond_min_bps: cfg.challenger_bond_min_bps,
        };
        storage::set_submission(&e, id, &record);

        SubmissionCreated {
            submission_id: id,
            agent,
            escrow_ref,
            escrow_value,
            bond,
        }
        .publish(&e);

        Ok(id)
    }

    /// Also serves as a stake top-up for an already-registered reexecutor.
    pub fn register_reexecutor(e: Env, reexecutor: Address, stake_amount: i128) -> Result<(), Error> {
        reexecutor.require_auth();
        if stake_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;

        let existing = storage::get_reexecutor(&e, &reexecutor);
        let (prior_stake, joined_at, open_attestations) = match &existing {
            Some(info) => (info.stake_amount, info.joined_at, info.open_attestations),
            None => (0, e.ledger().timestamp(), 0),
        };
        let new_stake = prior_stake.checked_add(stake_amount).ok_or(Error::Overflow)?;

        let contract_address = e.current_contract_address();
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&reexecutor, contract_address, &stake_amount);

        let info = ReexecutorInfo {
            stake_amount: new_stake,
            active: new_stake >= cfg.min_stake_floor,
            joined_at,
            open_attestations,
        };
        storage::set_reexecutor(&e, &reexecutor, &info);

        ReexecutorRegistered {
            reexecutor,
            stake_amount: new_stake,
            active: info.active,
        }
        .publish(&e);
        Ok(())
    }

    /// Blocked below min_stake_floor while any of this reexecutor's
    /// attestations sit on a not-yet-finalized submission — see
    /// release_attestation_lock. A reexecutor with zero open attestations
    /// may withdraw in full, deactivating themselves.
    pub fn withdraw_stake(e: Env, reexecutor: Address, amount: i128) -> Result<(), Error> {
        reexecutor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;
        let mut info = storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;

        let new_stake = info.stake_amount.checked_sub(amount).ok_or(Error::Overflow)?;
        if new_stake < 0 {
            return Err(Error::InvalidAmount);
        }
        if info.open_attestations > 0 && new_stake < cfg.min_stake_floor {
            return Err(Error::StakeLockedByOpenAttestation);
        }

        info.stake_amount = new_stake;
        info.active = new_stake >= cfg.min_stake_floor;
        storage::set_reexecutor(&e, &reexecutor, &info);

        let contract_address = e.current_contract_address();
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&contract_address, reexecutor.clone(), &amount);

        ReexecutorStakeWithdrawn { reexecutor, new_stake }.publish(&e);
        Ok(())
    }

    pub fn reexecutor_info(e: Env, reexecutor: Address) -> Option<ReexecutorInfo> {
        storage::get_reexecutor(&e, &reexecutor)
    }

    /// Permissionless: any account with sufficient active stake may attest on
    /// any submission (off-chain assignment/scheduling is the backend's job,
    /// not an on-chain gate). One vote per (submission, reexecutor), enforced
    /// by the ReplayAttestation storage guard. Records the raw output hash
    /// alongside the vote for later off-chain audit; the contract itself only
    /// trusts the boolean `matched` claim plus bonded-majority economics.
    pub fn attest_replay(
        e: Env,
        reexecutor: Address,
        submission_id: u64,
        output_hash: BytesN<32>,
        matched: bool,
    ) -> Result<(), Error> {
        reexecutor.require_auth();
        let mut info = storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        if !info.active || info.stake_amount < cfg.min_stake_floor {
            return Err(Error::ReexecutorNotActive);
        }
        if storage::get_attestation(&e, submission_id, &reexecutor).is_some() {
            return Err(Error::AlreadyAttested);
        }
        let mut sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if sub.finalized {
            return Err(Error::ChallengeWindowClosed);
        }

        storage::mark_attested(&e, submission_id, &reexecutor, matched);
        info.open_attestations = info.open_attestations.saturating_add(1);
        storage::set_reexecutor(&e, &reexecutor, &info);

        if matched {
            sub.match_votes += 1;
            sub.bonded_weight_matched = sub
                .bonded_weight_matched
                .checked_add(info.stake_amount)
                .ok_or(Error::Overflow)?;
        } else {
            sub.mismatch_votes += 1;
            sub.bonded_weight_mismatched = sub
                .bonded_weight_mismatched
                .checked_add(info.stake_amount)
                .ok_or(Error::Overflow)?;
        }
        storage::set_submission(&e, submission_id, &sub);

        ReplayAttested {
            submission_id,
            reexecutor,
            output_hash,
            matched,
        }
        .publish(&e);
        Ok(())
    }

    /// Attester with zero open (unresolved) attestations already withdraws
    /// freely; this permissionless bookkeeping call unlocks the counter once
    /// a given submission this reexecutor voted on has been finalized, without
    /// requiring the contract to enumerate all of a submission's attesters.
    pub fn release_attestation_lock(
        e: Env,
        submission_id: u64,
        reexecutor: Address,
    ) -> Result<(), Error> {
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if !sub.finalized {
            return Err(Error::SubmissionNotFinalized);
        }
        storage::get_attestation(&e, submission_id, &reexecutor).ok_or(Error::PartyNotOnWrongSide)?;
        if storage::is_released(&e, submission_id, &reexecutor) {
            return Err(Error::AttestationAlreadyReleased);
        }
        let mut info =
            storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;
        info.open_attestations = info.open_attestations.saturating_sub(1);
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::mark_released(&e, submission_id, &reexecutor);
        Ok(())
    }

    /// Bond-proportional, snapshotted at submit() time (invariant 5).
    pub fn open_challenge(
        e: Env,
        challenger: Address,
        submission_id: u64,
        bond: i128,
    ) -> Result<(), Error> {
        challenger.require_auth();
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if sub.finalized {
            return Err(Error::ChallengeWindowClosed);
        }
        let now = e.ledger().timestamp();
        if now >= sub.submitted_at.saturating_add(sub.challenge_window_s) {
            return Err(Error::ChallengeWindowClosed);
        }
        if storage::get_challenge(&e, submission_id).is_some() {
            return Err(Error::ChallengeAlreadyOpen);
        }
        let min_bond = checked_bps(sub.escrow_value, sub.cfg_challenger_bond_min_bps)?;
        if bond < min_bond {
            return Err(Error::BondTooLow);
        }

        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&challenger, e.current_contract_address(), &bond);

        let chal = ChallengeRecord {
            challenger: challenger.clone(),
            bond,
            opened_at: now,
            resolution: Resolution::None,
            resolution_method: ResolutionMethod::None,
        };
        storage::set_challenge(&e, submission_id, &chal);

        ChallengeOpened { submission_id, challenger, bond }.publish(&e);
        Ok(())
    }

    /// Permissionless — every precondition is read from already-committed
    /// on-chain state (attestation tallies, or a registered ZK verifier's own
    /// boolean result), never from caller identity (invariant 2). Delegates
    /// the actual verdict-setting and fund movement to finalize(), which is
    /// the single idempotent writer of terminal state (invariant 3).
    pub fn resolve_challenge(
        e: Env,
        submission_id: u64,
        method: ResolutionMethod,
    ) -> Result<Verdict, Error> {
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        let mut chal = storage::get_challenge(&e, submission_id).ok_or(Error::ChallengeNotFound)?;
        if chal.resolution != Resolution::None {
            return Err(Error::ChallengeAlreadyResolved);
        }

        let resolution = match method {
            ResolutionMethod::ReexecutionConsensus => {
                match consensus_outcome(&sub)? {
                    Some(Verdict::Verified) => Resolution::Rejected,
                    Some(Verdict::Slashed) => Resolution::Upheld,
                    _ => return Err(Error::InsufficientConsensus),
                }
            }
            ResolutionMethod::ZkProof => {
                // Phase 2 path. Real cross-contract call into the registered
                // ZKVerifierRegistry — but that registry ships with zero
                // registered verifiers in this deployment (see
                // ZKVerifierRegistry::list_verifiers), so verify_proof will
                // always trap the call rather than accept anything. This is
                // the concrete, tested mechanism behind invariant 4: there is
                // no code path here that fabricates a ZK-verified result.
                let registry = storage::get_zk_registry(&e).ok_or(Error::VerifierNotRegistered)?;
                let proof_system = Symbol::new(&e, "none");
                let empty_proof = Bytes::new(&e);
                let accepted: bool = e.invoke_contract(
                    &registry,
                    &Symbol::new(&e, "verify_proof"),
                    vec![
                        &e,
                        proof_system.into_val(&e),
                        submission_id.into_val(&e),
                        empty_proof.into_val(&e),
                    ],
                );
                if accepted {
                    Resolution::Upheld
                } else {
                    Resolution::Rejected
                }
            }
            ResolutionMethod::None => return Err(Error::InvalidResolutionMethod),
        };

        chal.resolution = resolution;
        chal.resolution_method = method;
        storage::set_challenge(&e, submission_id, &chal);

        ChallengeResolved { submission_id, resolution, method }.publish(&e);

        Self::finalize(e, submission_id)
    }

    /// The sole writer of terminal submission state and the sole mover of the
    /// agent's bond. Idempotent: a repeat call after finalized=true is a pure
    /// read with zero storage writes and zero token transfers (invariant 3).
    /// Only ever auto-verifies before the window closes when a bonded
    /// consensus majority already exists and no challenge is open
    /// (invariant 1); absent both a challenge and an early consensus, a
    /// window-elapsed submission defaults to Verified per the PRD's
    /// optimistic-verification design (no challenge => no proof of fraud).
    pub fn finalize(e: Env, submission_id: u64) -> Result<Verdict, Error> {
        let mut sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if sub.finalized {
            return Ok(sub.verdict);
        }

        if let Some(chal) = storage::get_challenge(&e, submission_id) {
            sub.verdict = match chal.resolution {
                Resolution::None => return Ok(Verdict::Pending),
                Resolution::Upheld => Verdict::Slashed,
                Resolution::Rejected => Verdict::Verified,
            };
            sub.finalized = true;
            sub.resolution_method = chal.resolution_method;
            settle(&e, &sub)?;
            storage::set_submission(&e, submission_id, &sub);
            Finalized { submission_id, verdict: sub.verdict }.publish(&e);
            return Ok(sub.verdict);
        }

        let now = e.ledger().timestamp();
        let window_elapsed = now >= sub.submitted_at.saturating_add(sub.challenge_window_s);
        let consensus = consensus_outcome(&sub)?;

        let verdict = match consensus {
            Some(v) => v,
            None if window_elapsed => Verdict::Verified,
            None => return Ok(Verdict::Pending),
        };

        sub.verdict = verdict;
        sub.finalized = true;
        sub.resolution_method = ResolutionMethod::ReexecutionConsensus;
        settle(&e, &sub)?;
        storage::set_submission(&e, submission_id, &sub);
        Finalized { submission_id, verdict: sub.verdict }.publish(&e);
        Ok(sub.verdict)
    }

    /// keeper.require_auth() only proves the call is a signed transaction from
    /// *some* account — it grants no special rights. Every other check derives
    /// authority solely from already-committed on-chain state: the submission
    /// must be finalized into a slashable terminal verdict, and the target
    /// reexecutor's own recorded vote (stored at attest_replay time) must be
    /// on the side that verdict proved wrong. There is no branch here, or
    /// anywhere in this contract, where the admin/keeper address itself grants
    /// extra power (invariant 2) — calling this with the admin's own address
    /// as `keeper` has exactly the same effect as calling it with any other
    /// funded account.
    pub fn slash(
        e: Env,
        keeper: Address,
        reexecutor: Address,
        submission_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        keeper.require_auth();
        if storage::is_slashed(&e, submission_id, &reexecutor) {
            return Err(Error::AlreadySlashed);
        }
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if !sub.finalized {
            return Err(Error::SubmissionNotFinalized);
        }
        let wrong_vote = match sub.verdict {
            Verdict::Verified => false,
            Verdict::Slashed => true,
            _ => return Err(Error::NotUpheldResolution),
        };
        let recorded_vote = storage::get_attestation(&e, submission_id, &reexecutor)
            .ok_or(Error::PartyNotOnWrongSide)?;
        if recorded_vote != wrong_vote {
            return Err(Error::PartyNotOnWrongSide);
        }

        let mut info =
            storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;
        if amount <= 0 || amount > info.stake_amount {
            return Err(Error::InvalidAmount);
        }
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        info.stake_amount = info.stake_amount.checked_sub(amount).ok_or(Error::Overflow)?;
        info.active = info.stake_amount >= cfg.min_stake_floor;
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::mark_slashed(&e, submission_id, &reexecutor);

        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        let contract_address = e.current_contract_address();
        let admin = storage::get_admin(&e).ok_or(Error::NotInitialized)?;
        if let Some(chal) = storage::get_challenge(&e, submission_id) {
            let challenger_share = checked_bps(amount, sub.cfg_slash_split_challenger_bps)?;
            let remainder = amount.checked_sub(challenger_share).ok_or(Error::Overflow)?;
            if challenger_share > 0 {
                token.transfer(&contract_address, chal.challenger.clone(), &challenger_share);
            }
            if remainder > 0 {
                token.transfer(&contract_address, admin, &remainder);
            }
        } else if amount > 0 {
            token.transfer(&contract_address, admin, &amount);
        }

        Slashed { submission_id, reexecutor, amount }.publish(&e);
        Ok(())
    }

    pub fn get_submission(e: Env, id: u64) -> Option<SubmissionRecord> {
        storage::get_submission(&e, id)
    }

    pub fn get_challenge(e: Env, id: u64) -> Option<ChallengeRecord> {
        storage::get_challenge(&e, id)
    }

    pub fn get_config(e: Env) -> Option<ConfigRecord> {
        storage::get_config(&e)
    }

    pub fn get_admin(e: Env) -> Option<Address> {
        storage::get_admin(&e)
    }
}

#[cfg(test)]
mod test;

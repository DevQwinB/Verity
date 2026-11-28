use soroban_sdk::{contracttype, Address, Env};
use verity_common::{ChallengeRecord, ConfigRecord, ReexecutorInfo, SubmissionRecord};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// The address `propose_admin` named, until it accepts or another
    /// proposal replaces it.
    PendingAdmin,
    /// Where forfeited bonds and slashed stake are paid. The constructor
    /// sets it to the admin; only `set_treasury` changes it.
    Treasury,
    BondAsset,
    Config,
    NextSubmissionId,
    Submission(u64),
    /// Stores the reexecutor's actual vote (true = matched), not just a presence
    /// guard — slash() needs the recorded vote to prove which side was wrong
    /// without maintaining a separate attester list.
    ReplayAttestation(u64, Address),
    Challenge(u64),
    Reexecutor(Address),
    Slashed(u64, Address),
    AttestationReleased(u64, Address),
    /// Everything set aside so far for the winning voters of a submission.
    /// It only grows; what each voter has drawn is in RewardPaid.
    RewardPool(u64),
    /// The stake a vote was tallied with, fixed when it was cast.
    VoteWeight(u64, Address),
    RewardPaid(u64, Address),
}

// Persistent entries are extended generously on every touch so a submission
// sitting mid-challenge for days doesn't get archived out from under finalize().
const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_TO: u32 = 500_000;

fn extend(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
}

/// The instance entry holds the admin, treasury, config and id counter, and its TTL
/// also covers the contract code. Called from every state-changing
/// entrypoint so a deployment in use never has them archived.
pub fn bump_instance(e: &Env) {
    e.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

pub fn get_admin(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::Admin)
}

pub fn set_admin(e: &Env, admin: &Address) {
    e.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_pending_admin(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::PendingAdmin)
}

pub fn set_pending_admin(e: &Env, pending: &Address) {
    e.storage().instance().set(&DataKey::PendingAdmin, pending);
}

pub fn clear_pending_admin(e: &Env) {
    e.storage().instance().remove(&DataKey::PendingAdmin);
}

pub fn get_treasury(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::Treasury)
}

pub fn set_treasury(e: &Env, treasury: &Address) {
    e.storage().instance().set(&DataKey::Treasury, treasury);
}

pub fn get_bond_asset(e: &Env) -> Option<Address> {
    e.storage().instance().get(&DataKey::BondAsset)
}

pub fn set_bond_asset(e: &Env, asset: &Address) {
    e.storage().instance().set(&DataKey::BondAsset, asset);
}

pub fn get_config(e: &Env) -> Option<ConfigRecord> {
    e.storage().instance().get(&DataKey::Config)
}

pub fn set_config(e: &Env, cfg: &ConfigRecord) {
    e.storage().instance().set(&DataKey::Config, cfg);
}

pub fn next_submission_id(e: &Env) -> u64 {
    let id: u64 = e
        .storage()
        .instance()
        .get(&DataKey::NextSubmissionId)
        .unwrap_or(0);
    e.storage()
        .instance()
        .set(&DataKey::NextSubmissionId, &(id + 1));
    id
}

pub fn get_submission(e: &Env, id: u64) -> Option<SubmissionRecord> {
    e.storage().persistent().get(&DataKey::Submission(id))
}

pub fn set_submission(e: &Env, id: u64, s: &SubmissionRecord) {
    let key = DataKey::Submission(id);
    e.storage().persistent().set(&key, s);
    extend(e, &key);
}

pub fn get_attestation(e: &Env, submission_id: u64, reexecutor: &Address) -> Option<bool> {
    e.storage()
        .persistent()
        .get(&DataKey::ReplayAttestation(submission_id, reexecutor.clone()))
}

pub fn mark_attested(e: &Env, submission_id: u64, reexecutor: &Address, matched: bool) {
    let key = DataKey::ReplayAttestation(submission_id, reexecutor.clone());
    e.storage().persistent().set(&key, &matched);
    extend(e, &key);
}

pub fn get_challenge(e: &Env, submission_id: u64) -> Option<ChallengeRecord> {
    e.storage()
        .persistent()
        .get(&DataKey::Challenge(submission_id))
}

pub fn set_challenge(e: &Env, submission_id: u64, c: &ChallengeRecord) {
    let key = DataKey::Challenge(submission_id);
    e.storage().persistent().set(&key, c);
    extend(e, &key);
}

pub fn get_reexecutor(e: &Env, who: &Address) -> Option<ReexecutorInfo> {
    e.storage()
        .persistent()
        .get(&DataKey::Reexecutor(who.clone()))
}

pub fn set_reexecutor(e: &Env, who: &Address, info: &ReexecutorInfo) {
    let key = DataKey::Reexecutor(who.clone());
    e.storage().persistent().set(&key, info);
    extend(e, &key);
}

pub fn is_released(e: &Env, submission_id: u64, reexecutor: &Address) -> bool {
    e.storage()
        .persistent()
        .has(&DataKey::AttestationReleased(submission_id, reexecutor.clone()))
}

pub fn mark_released(e: &Env, submission_id: u64, reexecutor: &Address) {
    let key = DataKey::AttestationReleased(submission_id, reexecutor.clone());
    e.storage().persistent().set(&key, &true);
    extend(e, &key);
}

pub fn is_slashed(e: &Env, submission_id: u64, party: &Address) -> bool {
    e.storage()
        .persistent()
        .has(&DataKey::Slashed(submission_id, party.clone()))
}

pub fn mark_slashed(e: &Env, submission_id: u64, party: &Address) {
    let key = DataKey::Slashed(submission_id, party.clone());
    e.storage().persistent().set(&key, &true);
    extend(e, &key);
}

pub fn get_reward_pool(e: &Env, submission_id: u64) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::RewardPool(submission_id))
        .unwrap_or(0)
}

pub fn set_reward_pool(e: &Env, submission_id: u64, total: i128) {
    let key = DataKey::RewardPool(submission_id);
    e.storage().persistent().set(&key, &total);
    extend(e, &key);
}

pub fn get_vote_weight(e: &Env, submission_id: u64, reexecutor: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::VoteWeight(submission_id, reexecutor.clone()))
        .unwrap_or(0)
}

pub fn set_vote_weight(e: &Env, submission_id: u64, reexecutor: &Address, weight: i128) {
    let key = DataKey::VoteWeight(submission_id, reexecutor.clone());
    e.storage().persistent().set(&key, &weight);
    extend(e, &key);
}

pub fn get_reward_paid(e: &Env, submission_id: u64, reexecutor: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::RewardPaid(submission_id, reexecutor.clone()))
        .unwrap_or(0)
}

pub fn set_reward_paid(e: &Env, submission_id: u64, reexecutor: &Address, paid: i128) {
    let key = DataKey::RewardPaid(submission_id, reexecutor.clone());
    e.storage().persistent().set(&key, &paid);
    extend(e, &key);
}

use soroban_sdk::{contracttype, Address};

/// The shape of task a submission claims to have completed.
/// `Unverifiable` exists so a marketplace can still route a submission through
/// EscrowGate for record-keeping even when it cannot be replayed or spot-checked;
/// such a submission can only ever resolve via ManualReview off-chain and never
/// auto-verifies on-chain (see EscrowGate::submit).
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskType {
    Deterministic,
    Retrieval,
    Unverifiable,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pending,
    Verified,
    Disputed,
    Slashed,
    ExpiredUnverified,
}

/// `ManualReview` is deliberately NOT a variant here. On-chain resolution must be
/// derivable from already-committed state (attestation tallies or a registered
/// ZK verifier's boolean result) with zero admin-discretionary paths. A
/// marketplace's own manual-review process for withdrawn/unresolvable challenges
/// is an off-chain/Postgres-only concept.
///
/// `None` (rather than wrapping this in `Option<ResolutionMethod>` on the
/// containing structs) is a deliberate soroban-sdk contracttype workaround:
/// `Option<CustomEnum>` fields fail to derive their ScVal conversion in
/// soroban-sdk 27's #[contracttype] macro for simple (data-less) enums, so a
/// dedicated `None` variant is used as the "not yet set" sentinel instead.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolutionMethod {
    None,
    ReexecutionConsensus,
    ZkProof,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    None,
    Upheld,
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ConfigRecord {
    pub min_stake_floor: i128,
    pub quorum_min_reexecutors: u32,
    /// Basis points, must be in [5100, 10000] — bounds enforced at update_config time.
    pub quorum_supermajority_bps: u32,
    /// Minimum agent bond as bps of escrow_value, e.g. 500 = 5%.
    pub agent_bond_min_bps: u32,
    /// Minimum challenger bond as bps of escrow_value.
    pub challenger_bond_min_bps: u32,
    /// escrow_value strictly below this uses the "small" window tier.
    pub window_tier_small_ceiling: i128,
    pub window_tier_small_s: u64,
    pub window_tier_large_s: u64,
    /// Share of a slashed amount that goes to the prevailing challenger; the
    /// remainder is distributed to correctly-voting re-executors. Fixed in
    /// practice — treated as effectively immutable governance, not a per-dispute lever.
    pub slash_split_challenger_bps: u32,
}

impl ConfigRecord {
    pub const MIN_WINDOW_S: u64 = 600;
    pub const MIN_SUPERMAJORITY_BPS: u32 = 5100;
    pub const MAX_BPS: u32 = 10000;
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SubmissionRecord {
    pub id: u64,
    pub agent: Address,
    pub escrow_ref: soroban_sdk::BytesN<32>,
    pub escrow_value: i128,
    pub task_type: TaskType,
    pub input_hash: soroban_sdk::BytesN<32>,
    pub claimed_output_hash: soroban_sdk::BytesN<32>,
    pub bond_amount: i128,
    pub submitted_at: u64,
    pub challenge_window_s: u64,
    pub verdict: Verdict,
    pub finalized: bool,
    pub match_votes: u32,
    pub mismatch_votes: u32,
    pub bonded_weight_matched: i128,
    pub bonded_weight_mismatched: i128,
    pub resolution_method: ResolutionMethod,
    // Config values snapshotted at submit() time, so a later admin config change
    // never retroactively changes an in-flight submission's rules.
    pub cfg_quorum_min_reexecutors: u32,
    pub cfg_quorum_supermajority_bps: u32,
    pub cfg_slash_split_challenger_bps: u32,
    pub cfg_challenger_bond_min_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ChallengeRecord {
    pub challenger: Address,
    pub bond: i128,
    pub opened_at: u64,
    pub resolution: Resolution,
    pub resolution_method: ResolutionMethod,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ReexecutorInfo {
    pub stake_amount: i128,
    pub active: bool,
    pub joined_at: u64,
    /// Count of attestations this reexecutor has made on submissions that are
    /// not yet finalized/resolved. Stake cannot be withdrawn below
    /// min_stake_floor while this is nonzero — see EscrowGate::withdraw_stake
    /// and EscrowGate::release_attestation_lock.
    pub open_attestations: u32,
}

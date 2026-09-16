/// Event topic symbols shared by EscrowGate and ZKVerifierRegistry so the
/// off-chain indexer has one frozen vocabulary to poll for via getEvents.
pub const SUBMISSION_CREATED: &str = "submit_ok";
pub const REEXECUTOR_REGISTERED: &str = "rex_reg";
pub const REEXECUTOR_STAKE_WITHDRAWN: &str = "rex_wd";
pub const REPLAY_ATTESTED: &str = "replay";
pub const EARLY_VERIFIED: &str = "early_ok";
pub const CHALLENGE_OPENED: &str = "chal_open";
pub const CHALLENGE_RESOLVED: &str = "chal_res";
pub const FINALIZED: &str = "final";
pub const SLASHED: &str = "slash";

pub const VERIFIER_REGISTERED: &str = "ver_reg";
pub const VERIFIER_DEREGISTERED: &str = "ver_dereg";
pub const PROOF_VERIFIED: &str = "proof_ok";

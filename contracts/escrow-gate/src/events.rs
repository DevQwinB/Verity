use soroban_sdk::{contractevent, Address, BytesN};
use verity_common::{Resolution, ResolutionMethod, Verdict};

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmissionCreated {
    #[topic]
    pub submission_id: u64,
    pub agent: Address,
    pub escrow_ref: BytesN<32>,
    pub escrow_value: i128,
    pub bond: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReexecutorRegistered {
    #[topic]
    pub reexecutor: Address,
    pub stake_amount: i128,
    pub active: bool,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReexecutorStakeWithdrawn {
    #[topic]
    pub reexecutor: Address,
    pub new_stake: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayAttested {
    #[topic]
    pub submission_id: u64,
    pub reexecutor: Address,
    pub output_hash: BytesN<32>,
    pub matched: bool,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChallengeOpened {
    #[topic]
    pub submission_id: u64,
    pub challenger: Address,
    pub bond: i128,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChallengeResolved {
    #[topic]
    pub submission_id: u64,
    pub resolution: Resolution,
    pub method: ResolutionMethod,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finalized {
    #[topic]
    pub submission_id: u64,
    pub verdict: Verdict,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slashed {
    #[topic]
    pub submission_id: u64,
    pub reexecutor: Address,
    pub amount: i128,
}

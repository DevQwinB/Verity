use soroban_sdk::{contractevent, Address, Symbol};

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifierRegistered {
    #[topic]
    pub proof_system: Symbol,
    pub verifier_contract: Address,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifierDeregistered {
    #[topic]
    pub proof_system: Symbol,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofVerified {
    #[topic]
    pub proof_system: Symbol,
    pub submission_id: u64,
}

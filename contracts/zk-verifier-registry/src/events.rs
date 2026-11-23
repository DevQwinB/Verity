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

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminProposed {
    #[topic]
    pub proposed_admin: Address,
    pub admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminChanged {
    #[topic]
    pub new_admin: Address,
    pub old_admin: Address,
}

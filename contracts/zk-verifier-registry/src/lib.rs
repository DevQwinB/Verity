#![no_std]

mod events;

use events::{ProofVerified, VerifierDeregistered, VerifierRegistered};
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Bytes, Env, IntoVal, Symbol, Vec};
use verity_common::Error;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Verifier(Symbol),
    VerifierList,
}

// All registry state lives in instance storage; keep it (and the code) from
// being archived while the registry is in use.
const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_TO: u32 = 500_000;

fn bump_instance(e: &Env) {
    e.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

#[contract]
pub struct ZkVerifierRegistry;

#[contractimpl]
impl ZkVerifierRegistry {
    /// Runs once, atomically with deployment, so nobody but the deployer can
    /// ever claim the admin role.
    pub fn __constructor(e: Env, admin: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage()
            .instance()
            .set(&DataKey::VerifierList, &Vec::<Symbol>::new(&e));
    }

    /// Additive-only, admin-gated capability grant: which proof systems
    /// *exist*. EscrowGate does not consult this registry in Phase 1 — its
    /// resolve_challenge rejects ZkProof outright — so registering a verifier
    /// here cannot decide a dispute.
    pub fn register_verifier(
        e: Env,
        admin: Address,
        proof_system: Symbol,
        verifier_contract: Address,
    ) -> Result<(), Error> {
        Self::require_admin(&e, &admin)?;
        if e.storage()
            .instance()
            .has(&DataKey::Verifier(proof_system.clone()))
        {
            return Err(Error::VerifierAlreadyRegistered);
        }
        e.storage()
            .instance()
            .set(&DataKey::Verifier(proof_system.clone()), &verifier_contract);
        let mut list: Vec<Symbol> = e
            .storage()
            .instance()
            .get(&DataKey::VerifierList)
            .unwrap_or(Vec::new(&e));
        list.push_back(proof_system.clone());
        e.storage().instance().set(&DataKey::VerifierList, &list);
        bump_instance(&e);

        VerifierRegistered { proof_system, verifier_contract }.publish(&e);
        Ok(())
    }

    /// Lets a compromised or retired verifier be pulled without ever adding an
    /// implicit accept path elsewhere in verify_proof.
    pub fn deregister_verifier(e: Env, admin: Address, proof_system: Symbol) -> Result<(), Error> {
        Self::require_admin(&e, &admin)?;
        let key = DataKey::Verifier(proof_system.clone());
        if !e.storage().instance().has(&key) {
            return Err(Error::VerifierNotRegistered);
        }
        e.storage().instance().remove(&key);
        let list: Vec<Symbol> = e
            .storage()
            .instance()
            .get(&DataKey::VerifierList)
            .unwrap_or(Vec::new(&e));
        let mut new_list = Vec::new(&e);
        for sym in list.iter() {
            if sym != proof_system {
                new_list.push_back(sym);
            }
        }
        e.storage().instance().set(&DataKey::VerifierList, &new_list);
        bump_instance(&e);

        VerifierDeregistered { proof_system }.publish(&e);
        Ok(())
    }

    /// There is no code path here that returns `true` for an unregistered
    /// proof system, for any input, including empty/garbage/malformed proof
    /// bytes, or bytes valid for a different registered system — this is the
    /// concrete mechanism behind invariant 4. If registered (Phase 2 only),
    /// this performs a real cross-contract call into the registered verifier
    /// and returns its boolean unmodified; the registry never fabricates a
    /// result itself.
    pub fn verify_proof(
        e: Env,
        proof_system: Symbol,
        submission_id: u64,
        proof: Bytes,
    ) -> Result<bool, Error> {
        let verifier: Address = e
            .storage()
            .instance()
            .get(&DataKey::Verifier(proof_system.clone()))
            .ok_or(Error::VerifierNotRegistered)?;

        // Convention for a registered Phase-2 verifier contract: a `verify`
        // function taking (submission_id, proof) and returning bool.
        let accepted: bool = e.invoke_contract(
            &verifier,
            &Symbol::new(&e, "verify"),
            vec![&e, submission_id.into_val(&e), proof.into_val(&e)],
        );

        if accepted {
            ProofVerified { proof_system, submission_id }.publish(&e);
        }
        Ok(accepted)
    }

    pub fn is_registered(e: Env, proof_system: Symbol) -> bool {
        e.storage()
            .instance()
            .has(&DataKey::Verifier(proof_system))
    }

    pub fn list_verifiers(e: Env) -> Vec<Symbol> {
        e.storage()
            .instance()
            .get(&DataKey::VerifierList)
            .unwrap_or(Vec::new(&e))
    }

    fn require_admin(e: &Env, admin: &Address) -> Result<(), Error> {
        let stored: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != &stored {
            return Err(Error::NotAdmin);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;

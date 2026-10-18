#![no_std]

//! Reference contract only — demonstrates the drop-in wrapper pattern any real
//! marketplace's own escrow contract uses to gate its `release()` on Verity's
//! `EscrowGate.finalize()` before paying an agent. Not deployed as part of
//! Verity's own stack; shipped as integration documentation an external
//! integrator can copy the pattern from (Rust) or reimplement against the
//! exported EscrowGate contract spec (any language via stellar-sdk bindings).

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};
use verity_common::{Error, SubmissionRecord, Verdict};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Gate,
    BondAsset,
    Escrow(u64),
    NextId,
}

#[contracttype]
#[derive(Clone)]
struct EscrowRecord {
    payee: Address,
    poster: Address,
    amount: i128,
    released: bool,
}

#[contract]
pub struct ExampleMarketplaceEscrow;

/// `escrow_ref` for escrow `N` is the 32-byte value with all bytes zero except
/// the last 8, which hold `N` as a big-endian `u64`. This is the convention a
/// marketplace and its submitters agree on so a submission can be bound to the
/// escrow it names; a submission must carry it for its escrow to be releasable.
fn escrow_ref_for(e: &Env, escrow_id: u64) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[24..32].copy_from_slice(&escrow_id.to_be_bytes());
    BytesN::from_array(e, &bytes)
}

#[contractimpl]
impl ExampleMarketplaceEscrow {
    pub fn initialize(e: Env, admin: Address, gate: Address, bond_asset: Address) -> Result<(), Error> {
        if e.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Gate, &gate);
        e.storage().instance().set(&DataKey::BondAsset, &bond_asset);
        Ok(())
    }

    /// The bounty poster escrows funds for a specific payee agent, unrelated
    /// to (and pre-dating) any Verity submission — this is the marketplace's
    /// own existing escrow behavior, unchanged by integrating Verity.
    pub fn create_escrow(e: Env, poster: Address, payee: Address, amount: i128) -> Result<u64, Error> {
        poster.require_auth();
        let bond_asset: Address = e
            .storage()
            .instance()
            .get(&DataKey::BondAsset)
            .ok_or(Error::NotInitialized)?;
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&poster, e.current_contract_address(), &amount);

        let id: u64 = e.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        e.storage().instance().set(&DataKey::NextId, &(id + 1));
        e.storage().persistent().set(
            &DataKey::Escrow(id),
            &EscrowRecord { payee, poster, amount, released: false },
        );
        Ok(id)
    }

    /// The one line a real marketplace adds to its own release() path:
    /// gate `finalize()` before paying out. Verdict::Verified pays the agent;
    /// Slashed/ExpiredUnverified returns funds to the bounty poster instead;
    /// Pending/Disputed simply refuse to release yet.
    pub fn release(e: Env, escrow_id: u64, submission_id: u64) -> Result<(), Error> {
        let mut rec: EscrowRecord = e
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::SubmissionNotFound)?;
        if rec.released {
            return Ok(());
        }
        let gate: Address = e
            .storage()
            .instance()
            .get(&DataKey::Gate)
            .ok_or(Error::NotInitialized)?;

        // Bind the named submission to this escrow before finalizing it.
        // Otherwise any submission that verifies (or gets slashed) could
        // release any escrow: the verdict alone says nothing about which
        // escrow the work was for. A mismatch must not reach `finalize`, so a
        // wrong submission is not finalized (and its bonds not moved) as a
        // side effect of a failed release attempt.
        let submission: Option<SubmissionRecord> = e.invoke_contract(
            &gate,
            &soroban_sdk::Symbol::new(&e, "get_submission"),
            soroban_sdk::vec![&e, soroban_sdk::IntoVal::into_val(&submission_id, &e)],
        );
        let submission = submission.ok_or(Error::SubmissionNotFound)?;
        if submission.agent != rec.payee || submission.escrow_ref != escrow_ref_for(&e, escrow_id) {
            return Err(Error::SubmissionNotFound);
        }
        if submission.escrow_value != rec.amount {
            return Err(Error::InvalidEscrowValue);
        }

        let verdict: Verdict = e.invoke_contract(
            &gate,
            &soroban_sdk::Symbol::new(&e, "finalize"),
            soroban_sdk::vec![&e, soroban_sdk::IntoVal::into_val(&submission_id, &e)],
        );

        let bond_asset: Address = e
            .storage()
            .instance()
            .get(&DataKey::BondAsset)
            .ok_or(Error::NotInitialized)?;
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        let contract_address = e.current_contract_address();

        match verdict {
            Verdict::Verified => {
                token.transfer(&contract_address, rec.payee.clone(), &rec.amount);
                rec.released = true;
            }
            Verdict::Slashed | Verdict::ExpiredUnverified => {
                token.transfer(&contract_address, rec.poster.clone(), &rec.amount);
                rec.released = true;
            }
            Verdict::Pending | Verdict::Disputed => {
                return Err(Error::ChallengeWindowNotElapsed);
            }
        }
        e.storage().persistent().set(&DataKey::Escrow(escrow_id), &rec);
        Ok(())
    }
}

#[cfg(test)]
mod test;

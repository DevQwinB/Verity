#![cfg(test)]

use crate::events::{ProofVerified, VerifierDeregistered, VerifierRegistered};
use crate::{ZkVerifierRegistry, ZkVerifierRegistryClient};
use soroban_sdk::{
    contract, contractimpl, events::Event as _, testutils::Address as _, testutils::Events as _, vec, Address,
    Bytes, Env, Symbol,
};
use verity_common::Error;

fn setup(e: &Env) -> (ZkVerifierRegistryClient<'_>, Address) {
    let admin = Address::generate(e);
    let id = e.register(ZkVerifierRegistry, (admin.clone(),));
    let client = ZkVerifierRegistryClient::new(e, &id);
    e.mock_all_auths();
    (client, admin)
}

#[test]
fn fresh_registry_is_empty() {
    let e = Env::default();
    let (client, _admin) = setup(&e);
    assert_eq!(client.list_verifiers().len(), 0);
}

#[test]
fn verify_proof_never_accepts_unregistered_system_garbage_bytes() {
    let e = Env::default();
    let (client, _admin) = setup(&e);
    let sym = Symbol::new(&e, "groth16");

    // Empty bytes.
    let empty = Bytes::new(&e);
    let res = client.try_verify_proof(&sym, &1u64, &empty);
    assert!(matches!(res, Err(Ok(Error::VerifierNotRegistered))));

    // Garbage bytes.
    let garbage = Bytes::from_array(&e, &[0xDE, 0xAD, 0xBE, 0xEF]);
    let res2 = client.try_verify_proof(&sym, &1u64, &garbage);
    assert!(matches!(res2, Err(Ok(Error::VerifierNotRegistered))));
}

#[test]
fn verify_proof_rejects_bytes_valid_for_a_different_registered_system() {
    let e = Env::default();
    let (client, admin) = setup(&e);

    // Register one proof system pointing at some placeholder verifier
    // address (never actually invoked in this test, since we only probe a
    // *different*, unregistered symbol).
    let placeholder_verifier = Address::generate(&e);
    let registered_sym = Symbol::new(&e, "groth16");
    client.register_verifier(&admin, &registered_sym, &placeholder_verifier);
    assert!(client.is_registered(&registered_sym));
    assert_eq!(client.list_verifiers().len(), 1);

    let other_sym = Symbol::new(&e, "plonky2");
    let bytes_for_other = Bytes::from_array(&e, &[1, 2, 3]);
    let res = client.try_verify_proof(&other_sym, &1u64, &bytes_for_other);
    assert!(matches!(res, Err(Ok(Error::VerifierNotRegistered))));
}

#[test]
fn register_verifier_requires_admin_and_is_additive_only() {
    let e = Env::default();
    let (client, admin) = setup(&e);
    let not_admin = Address::generate(&e);
    let verifier = Address::generate(&e);
    let sym = Symbol::new(&e, "groth16");

    // Non-admin cannot register (mock_all_auths lets any require_auth pass,
    // but the contract's own admin==stored check must still reject it).
    let res = client.try_register_verifier(&not_admin, &sym, &verifier);
    assert!(matches!(res, Err(Ok(Error::NotAdmin))));

    client.register_verifier(&admin, &sym, &verifier);
    let res2 = client.try_register_verifier(&admin, &sym, &verifier);
    assert!(matches!(res2, Err(Ok(Error::VerifierAlreadyRegistered))));
}

#[test]
fn deregister_removes_from_list_and_blocks_future_accept() {
    let e = Env::default();
    let (client, admin) = setup(&e);
    let verifier = Address::generate(&e);
    let sym = Symbol::new(&e, "groth16");

    client.register_verifier(&admin, &sym, &verifier);
    assert_eq!(client.list_verifiers().len(), 1);

    client.deregister_verifier(&admin, &sym);
    assert_eq!(client.list_verifiers().len(), 0);
    assert!(!client.is_registered(&sym));

    let bytes = Bytes::new(&e);
    let res = client.try_verify_proof(&sym, &1u64, &bytes);
    assert!(matches!(res, Err(Ok(Error::VerifierNotRegistered))));
}

// ---- a real verifier behind the registry ----

/// Stand-in verifier, test-only. The first proof byte picks the behaviour:
/// 0 rejects, 1 accepts, 2 accepts only the exact `(42, [2, 9, 8, 7])` pair
/// (to show the arguments arrive unchanged), anything else, including an
/// empty proof, panics.
#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify(e: Env, submission_id: u64, proof: Bytes) -> bool {
        match proof.get(0) {
            Some(0) => false,
            Some(1) => true,
            Some(2) => submission_id == 42 && proof == Bytes::from_array(&e, &[2, 9, 8, 7]),
            _ => panic!("unknown proof"),
        }
    }
}

fn setup_with_mock(e: &Env) -> (ZkVerifierRegistryClient<'_>, Address, Symbol) {
    let (client, admin) = setup(e);
    let verifier = e.register(MockVerifier, ());
    let sym = Symbol::new(e, "groth16");
    client.register_verifier(&admin, &sym, &verifier);
    (client, admin, sym)
}

fn proof_verified_was_emitted(e: &Env, client: &ZkVerifierRegistryClient, sym: &Symbol, id: u64) -> bool {
    let expected = ProofVerified { proof_system: sym.clone(), submission_id: id }.to_xdr(e, &client.address);
    e.events().all().events().contains(&expected)
}

#[test]
fn verify_proof_accepts_when_the_registered_verifier_says_true_and_emits_proof_verified() {
    let e = Env::default();
    let (client, _admin, sym) = setup_with_mock(&e);

    let accepted = client.verify_proof(&sym, &7u64, &Bytes::from_array(&e, &[1]));
    assert!(accepted);
    assert!(proof_verified_was_emitted(&e, &client, &sym, 7));
}

#[test]
fn verify_proof_returns_false_without_an_event_when_the_verifier_rejects() {
    let e = Env::default();
    let (client, _admin, sym) = setup_with_mock(&e);

    let accepted = client.verify_proof(&sym, &7u64, &Bytes::from_array(&e, &[0]));
    assert!(!accepted);
    assert!(!proof_verified_was_emitted(&e, &client, &sym, 7));
}

#[test]
fn verify_proof_fails_without_an_event_when_the_verifier_panics() {
    let e = Env::default();
    let (client, _admin, sym) = setup_with_mock(&e);

    // The host reports a failed sub-call as an InvokeError, not a contract Error.
    let res = client.try_verify_proof(&sym, &7u64, &Bytes::from_array(&e, &[9]));
    assert!(matches!(res, Err(Err(_))));
    assert!(!proof_verified_was_emitted(&e, &client, &sym, 7));

    let empty = client.try_verify_proof(&sym, &7u64, &Bytes::new(&e));
    assert!(matches!(empty, Err(Err(_))));
}

#[test]
fn verify_proof_forwards_the_submission_id_and_proof_bytes_unchanged() {
    let e = Env::default();
    let (client, _admin, sym) = setup_with_mock(&e);
    let proof = Bytes::from_array(&e, &[2, 9, 8, 7]);

    assert!(client.verify_proof(&sym, &42u64, &proof));
    // Same proof, different submission id: the mock rejects it.
    assert!(!client.verify_proof(&sym, &43u64, &proof));
    // Same id, different proof bytes: the mock rejects it too.
    assert!(!client.verify_proof(&sym, &42u64, &Bytes::from_array(&e, &[2, 9, 8, 6])));
}

// ---- admin and listing paths ----

#[test]
fn deregister_verifier_requires_admin_and_leaves_the_registration_in_place() {
    let e = Env::default();
    let (client, admin) = setup(&e);
    let sym = Symbol::new(&e, "groth16");
    client.register_verifier(&admin, &sym, &Address::generate(&e));

    let not_admin = Address::generate(&e);
    let res = client.try_deregister_verifier(&not_admin, &sym);
    assert!(matches!(res, Err(Ok(Error::NotAdmin))));
    assert!(client.is_registered(&sym));
    assert_eq!(client.list_verifiers().len(), 1);
}

#[test]
fn deregister_verifier_rejects_a_system_that_was_never_registered() {
    let e = Env::default();
    let (client, admin) = setup(&e);
    let res = client.try_deregister_verifier(&admin, &Symbol::new(&e, "groth16"));
    assert!(matches!(res, Err(Ok(Error::VerifierNotRegistered))));
}

#[test]
fn removing_a_middle_verifier_keeps_the_others_in_order() {
    let e = Env::default();
    let (client, admin) = setup(&e);
    let (a, b, c) = (Symbol::new(&e, "a"), Symbol::new(&e, "b"), Symbol::new(&e, "c"));
    for sym in [&a, &b, &c] {
        client.register_verifier(&admin, sym, &Address::generate(&e));
    }
    assert_eq!(client.list_verifiers(), vec![&e, a.clone(), b.clone(), c.clone()]);

    client.deregister_verifier(&admin, &b);
    assert_eq!(client.list_verifiers(), vec![&e, a.clone(), c.clone()]);
    assert!(!client.is_registered(&b));
    assert!(client.is_registered(&a));
    assert!(client.is_registered(&c));

    let res = client.try_verify_proof(&b, &1u64, &Bytes::from_array(&e, &[1]));
    assert!(matches!(res, Err(Ok(Error::VerifierNotRegistered))));
}

#[test]
fn register_and_deregister_emit_their_events() {
    let e = Env::default();
    let (client, admin) = setup(&e);
    let sym = Symbol::new(&e, "groth16");
    let verifier = Address::generate(&e);

    client.register_verifier(&admin, &sym, &verifier);
    let registered = VerifierRegistered { proof_system: sym.clone(), verifier_contract: verifier }
        .to_xdr(&e, &client.address);
    assert!(e.events().all().events().contains(&registered));

    client.deregister_verifier(&admin, &sym);
    let deregistered = VerifierDeregistered { proof_system: sym }.to_xdr(&e, &client.address);
    assert!(e.events().all().events().contains(&deregistered));
}

// ---- admin transfer ----

mod admin_transfer {
    use super::*;
    use crate::events::{AdminChanged, AdminProposed};
    use soroban_sdk::{
        testutils::{storage::Instance as _, Ledger as _, MockAuth, MockAuthInvoke},
        IntoVal as _, Val, Vec,
    };

    #[test]
    fn the_registry_reports_its_admin_and_no_proposal_at_first() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        assert_eq!(client.get_admin(), Some(admin));
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    fn propose_admin_is_refused_for_anyone_but_the_admin() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let stranger = Address::generate(&e);
        let next = Address::generate(&e);

        assert_eq!(
            client.try_propose_admin(&stranger, &next),
            Err(Ok(Error::NotAdmin))
        );
        assert_eq!(
            client.try_propose_admin(&stranger, &stranger),
            Err(Ok(Error::NotAdmin))
        );
        assert_eq!(client.get_pending_admin(), None);
        assert_eq!(client.get_admin(), Some(admin));
    }

    #[test]
    fn a_proposal_alone_gives_the_proposed_address_no_rights() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let next = Address::generate(&e);
        client.propose_admin(&admin, &next);
        assert_eq!(client.get_pending_admin(), Some(next.clone()));
        assert_eq!(client.get_admin(), Some(admin.clone()));

        let sym = Symbol::new(&e, "groth16");
        let verifier = Address::generate(&e);
        assert_eq!(
            client.try_register_verifier(&next, &sym, &verifier),
            Err(Ok(Error::NotAdmin))
        );
        assert!(!client.is_registered(&sym));
        // The admin is still the admin.
        client.register_verifier(&admin, &sym, &verifier);
        assert!(client.is_registered(&sym));
    }

    #[test]
    fn accept_admin_hands_the_role_to_the_proposed_address() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let next = Address::generate(&e);
        let sym = Symbol::new(&e, "groth16");
        let verifier = Address::generate(&e);
        client.register_verifier(&admin, &sym, &verifier);

        client.propose_admin(&admin, &next);
        client.accept_admin(&next);
        assert_eq!(client.get_admin(), Some(next.clone()));
        assert_eq!(client.get_pending_admin(), None);

        // The old admin can no longer register, deregister or propose.
        let other = Symbol::new(&e, "plonk");
        assert_eq!(
            client.try_register_verifier(&admin, &other, &verifier),
            Err(Ok(Error::NotAdmin))
        );
        assert_eq!(
            client.try_deregister_verifier(&admin, &sym),
            Err(Ok(Error::NotAdmin))
        );
        assert_eq!(
            client.try_propose_admin(&admin, &admin),
            Err(Ok(Error::NotAdmin))
        );
        assert!(client.is_registered(&sym));
        assert!(!client.is_registered(&other));
        assert_eq!(client.get_pending_admin(), None);

        // The new admin can.
        client.register_verifier(&next, &other, &verifier);
        assert!(client.is_registered(&other));
        client.deregister_verifier(&next, &sym);
        assert!(!client.is_registered(&sym));
        client.propose_admin(&next, &admin);
        assert_eq!(client.get_pending_admin(), Some(admin));
    }

    #[test]
    fn accept_admin_is_refused_for_anyone_but_the_proposed_address() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let next = Address::generate(&e);
        let stranger = Address::generate(&e);
        client.propose_admin(&admin, &next);

        assert_eq!(
            client.try_accept_admin(&stranger),
            Err(Ok(Error::NotPendingAdmin))
        );
        assert_eq!(
            client.try_accept_admin(&admin),
            Err(Ok(Error::NotPendingAdmin))
        );
        assert_eq!(client.get_admin(), Some(admin));
        assert_eq!(client.get_pending_admin(), Some(next));
    }

    #[test]
    fn accept_admin_is_refused_when_nothing_is_proposed() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let next = Address::generate(&e);
        assert_eq!(
            client.try_accept_admin(&next),
            Err(Ok(Error::NoPendingAdmin))
        );
        assert_eq!(
            client.try_accept_admin(&admin),
            Err(Ok(Error::NoPendingAdmin))
        );
        assert_eq!(client.get_admin(), Some(admin.clone()));

        // Accepting uses the proposal up.
        client.propose_admin(&admin, &next);
        client.accept_admin(&next);
        assert_eq!(
            client.try_accept_admin(&next),
            Err(Ok(Error::NoPendingAdmin))
        );
        assert_eq!(client.get_admin(), Some(next));
    }

    #[test]
    fn a_later_proposal_replaces_an_earlier_one() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let mistyped = Address::generate(&e);
        let meant = Address::generate(&e);
        client.propose_admin(&admin, &mistyped);
        client.propose_admin(&admin, &meant);

        assert_eq!(client.get_pending_admin(), Some(meant.clone()));
        assert_eq!(
            client.try_accept_admin(&mistyped),
            Err(Ok(Error::NotPendingAdmin))
        );
        assert_eq!(client.get_admin(), Some(admin));
        client.accept_admin(&meant);
        assert_eq!(client.get_admin(), Some(meant));
    }

    #[test]
    fn each_half_needs_the_signature_of_its_own_party() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let next = Address::generate(&e);

        // The proposed address signs its own proposal in the admin's name: refused.
        let args: Vec<Val> = (admin.clone(), next.clone()).into_val(&e);
        let by_next = MockAuth {
            address: &next,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "propose_admin",
                args: args.clone(),
                sub_invokes: &[],
            },
        };
        assert!(client
            .mock_auths(&[by_next])
            .try_propose_admin(&admin, &next)
            .is_err());
        assert_eq!(client.get_pending_admin(), None);
        let by_admin = MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "propose_admin",
                args,
                sub_invokes: &[],
            },
        };
        client.mock_auths(&[by_admin]).propose_admin(&admin, &next);
        assert_eq!(client.get_pending_admin(), Some(next.clone()));

        // The current admin signs the acceptance: refused.
        let args: Vec<Val> = (next.clone(),).into_val(&e);
        let by_admin = MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args: args.clone(),
                sub_invokes: &[],
            },
        };
        assert!(client
            .mock_auths(&[by_admin])
            .try_accept_admin(&next)
            .is_err());
        assert_eq!(client.get_admin(), Some(admin.clone()));
        let by_next = MockAuth {
            address: &next,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args,
                sub_invokes: &[],
            },
        };
        client.mock_auths(&[by_next]).accept_admin(&next);
        assert_eq!(client.get_admin(), Some(next));
    }

    #[test]
    fn proposing_and_accepting_emit_their_events_and_a_refusal_emits_none() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let next = Address::generate(&e);

        assert!(client.try_propose_admin(&next, &next).is_err());
        assert!(e.events().all().events().is_empty());
        assert!(client.try_accept_admin(&next).is_err());
        assert!(e.events().all().events().is_empty());

        client.propose_admin(&admin, &next);
        let proposed = AdminProposed {
            proposed_admin: next.clone(),
            admin: admin.clone(),
        }
        .to_xdr(&e, &client.address);
        assert!(e.events().all().events().contains(&proposed));

        client.accept_admin(&next);
        let changed = AdminChanged {
            new_admin: next,
            old_admin: admin,
        }
        .to_xdr(&e, &client.address);
        assert!(e.events().all().events().contains(&changed));
    }

    #[test]
    fn both_halves_report_not_initialized_without_a_stored_admin() {
        let e = Env::default();
        let (client, admin) = setup(&e);
        let next = Address::generate(&e);
        client.propose_admin(&admin, &next);
        e.as_contract(&client.address, || {
            e.storage().instance().remove(&crate::DataKey::Admin)
        });

        assert_eq!(
            client.try_propose_admin(&admin, &next),
            Err(Ok(Error::NotInitialized))
        );
        assert_eq!(
            client.try_accept_admin(&next),
            Err(Ok(Error::NotInitialized))
        );
        assert_eq!(client.get_admin(), None);
    }

    #[test]
    fn both_halves_extend_the_instance_ttl() {
        for half in ["propose_admin", "accept_admin"] {
            let e = Env::default();
            let (client, admin) = setup(&e);
            let next = Address::generate(&e);
            // A proposal brings the TTL to BUMP_TO (500_000 ledgers).
            client.propose_admin(&admin, &next);
            let ttl = || e.as_contract(&client.address, || e.storage().instance().get_ttl());
            assert_eq!(ttl(), 500_000);
            e.ledger().with_mut(|l| l.sequence_number += 450_000);
            assert_eq!(ttl(), 50_000);

            if half == "propose_admin" {
                client.propose_admin(&admin, &next);
            } else {
                client.accept_admin(&next);
            }
            assert_eq!(ttl(), 500_000, "{half}");
        }
    }
}

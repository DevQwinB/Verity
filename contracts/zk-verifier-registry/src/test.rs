#![cfg(test)]

use crate::{ZkVerifierRegistry, ZkVerifierRegistryClient};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Symbol};
use verity_common::Error;

fn setup(e: &Env) -> (ZkVerifierRegistryClient<'_>, Address) {
    let admin = Address::generate(e);
    let id = e.register(ZkVerifierRegistry, ());
    let client = ZkVerifierRegistryClient::new(e, &id);
    e.mock_all_auths();
    client.initialize(&admin);
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

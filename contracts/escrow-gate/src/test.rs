#![cfg(test)]

use crate::EscrowGate;
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn placeholder_compiles() {
    let e = Env::default();
    let id = e.register(EscrowGate, ());
    let _ = id;
    let _admin = Address::generate(&e);
}

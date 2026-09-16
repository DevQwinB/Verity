#![cfg(test)]

use crate::ExampleMarketplaceEscrow;
use soroban_sdk::Env;

#[test]
fn placeholder_compiles() {
    let e = Env::default();
    let _id = e.register(ExampleMarketplaceEscrow, ());
}

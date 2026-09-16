#![cfg(test)]

use crate::{ExampleMarketplaceEscrow, ExampleMarketplaceEscrowClient};
use escrow_gate::{EscrowGate, EscrowGateClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};
use verity_common::{ConfigRecord, TaskType};

const XLM: i128 = 10_000_000;

fn default_config() -> ConfigRecord {
    ConfigRecord {
        min_stake_floor: 500 * XLM,
        quorum_min_reexecutors: 3,
        quorum_supermajority_bps: 6600,
        agent_bond_min_bps: 500,
        challenger_bond_min_bps: 500,
        window_tier_small_ceiling: 100_000 * XLM,
        window_tier_small_s: 3600,
        window_tier_large_s: 86_400,
        slash_split_challenger_bps: 2000,
    }
}

#[test]
fn release_pays_agent_only_after_gate_verifies() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, ());
    let gate = EscrowGateClient::new(&e, &gate_id);
    gate.initialize(&admin, &sac.address(), &default_config());

    let mkt_id = e.register(ExampleMarketplaceEscrow, ());
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);
    mkt.initialize(&admin, &gate_id, &sac.address());

    let poster = Address::generate(&e);
    let agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&agent, &(1000 * XLM)); // agent needs its own bond for submit()

    let escrow_id = mkt.create_escrow(&poster, &agent, &(1000 * XLM));

    let submission_id = gate.submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    // Before the window elapses and with no consensus yet, release() must
    // refuse to pay out — this is the whole point of gating on finalize().
    let res = mkt.try_release(&escrow_id, &submission_id);
    assert!(res.is_err());
    assert_eq!(token.balance(&agent), 950 * XLM);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    mkt.release(&escrow_id, &submission_id);

    // Agent gets both their returned Verity bond AND the marketplace's own
    // escrowed bounty payout.
    assert_eq!(token.balance(&agent), 950 * XLM + 50 * XLM + 1000 * XLM);
    assert_eq!(token.balance(&mkt_id), 0);

    // Idempotent on the marketplace side too.
    mkt.release(&escrow_id, &submission_id);
    assert_eq!(token.balance(&agent), 950 * XLM + 50 * XLM + 1000 * XLM);
}

#[test]
fn release_refunds_poster_when_gate_slashes() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, ());
    let gate = EscrowGateClient::new(&e, &gate_id);
    gate.initialize(&admin, &sac.address(), &default_config());

    let mkt_id = e.register(ExampleMarketplaceEscrow, ());
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);
    mkt.initialize(&admin, &gate_id, &sac.address());

    let poster = Address::generate(&e);
    let agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&agent, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(&poster, &agent, &(1000 * XLM));
    let submission_id = gate.submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        token_admin.mint(r, &(2000 * XLM));
        gate.register_reexecutor(r, &(600 * XLM));
        gate.attest_replay(r, &submission_id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    mkt.release(&escrow_id, &submission_id);
    // Bounty returns to the poster, not the agent, on a Slashed verdict.
    assert_eq!(token.balance(&poster), 1000 * XLM);
    assert_eq!(token.balance(&agent), 950 * XLM); // never got the Verity bond back either
}

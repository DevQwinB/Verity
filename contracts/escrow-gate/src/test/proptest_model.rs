#![cfg(test)]
//! Model-based test: a randomized sequence of attest_replay votes (with
//! random stakes and random match/mismatch) is applied to the real contract,
//! then finalize()'s outcome is checked against an independent reference
//! implementation of the same bonded-supermajority rule. This is the
//! highest-leverage test for sequencing/threshold bugs in consensus_outcome,
//! run across many randomized cases rather than a handful of hand-picked ones.

use crate::{EscrowGate, EscrowGateClient};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, token, Address, BytesN, Env};
use verity_common::{ConfigRecord, TaskType, Verdict};

const XLM: i128 = 10_000_000;
const QUORUM_MIN: u32 = 3;
const SUPERMAJORITY_BPS: i64 = 6600;

fn reference_outcome(votes: &[(i128, bool)]) -> Option<Verdict> {
    let total_votes = votes.len() as u32;
    if total_votes < QUORUM_MIN {
        return None;
    }
    let matched_weight: i64 = votes.iter().filter(|(_, m)| *m).map(|(s, _)| *s as i64).sum();
    let mismatched_weight: i64 = votes.iter().filter(|(_, m)| !*m).map(|(s, _)| *s as i64).sum();
    let total = matched_weight + mismatched_weight;
    if total <= 0 {
        return None;
    }
    if matched_weight * 10_000 >= total * SUPERMAJORITY_BPS {
        return Some(Verdict::Verified);
    }
    if mismatched_weight * 10_000 >= total * SUPERMAJORITY_BPS {
        return Some(Verdict::Slashed);
    }
    None
}

fn run_case(votes: Vec<(i64, bool)>) {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let id = e.register(EscrowGate, ());
    let client = EscrowGateClient::new(&e, &id);
    client.initialize(
        &admin,
        &sac.address(),
        &ConfigRecord {
            min_stake_floor: 1,
            quorum_min_reexecutors: QUORUM_MIN,
            quorum_supermajority_bps: SUPERMAJORITY_BPS as u32,
            agent_bond_min_bps: 500,
            challenger_bond_min_bps: 500,
            window_tier_small_ceiling: 100_000 * XLM,
            window_tier_small_s: 3600,
            window_tier_large_s: 86_400,
            slash_split_challenger_bps: 2000,
        },
    );

    let agent = Address::generate(&e);
    token_admin.mint(&agent, &(1000 * XLM));
    let submission_id = client.submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    let mut recorded_votes = Vec::new();
    for (stake, matched) in &votes {
        let stake = (*stake).max(1) as i128;
        let rex = Address::generate(&e);
        token_admin.mint(&rex, &(stake + 1));
        client.register_reexecutor(&rex, &stake);
        client.attest_replay(&rex, &submission_id, &BytesN::from_array(&e, &[9u8; 32]), matched);
        recorded_votes.push((stake, *matched));
    }

    let expected = reference_outcome(&recorded_votes);
    let actual = client.finalize(&submission_id);

    match expected {
        Some(v) => assert_eq!(actual, v, "votes={:?}", recorded_votes),
        None => assert_eq!(
            actual,
            Verdict::Pending,
            "expected no consensus yet (window hasn't elapsed): votes={:?}",
            recorded_votes
        ),
    }
    let _ = token; // silence unused warning if a future edit drops balance assertions
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn finalize_matches_reference_supermajority_model(
        votes in prop::collection::vec((1i64..1_000_000i64, any::<bool>()), 0..8)
    ) {
        run_case(votes);
    }
}

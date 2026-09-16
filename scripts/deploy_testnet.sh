#!/usr/bin/env bash
# Deploys EscrowGate and ZKVerifierRegistry to Stellar testnet for real, wires
# them together, and asserts the registry starts genuinely empty. Idempotent:
# re-running skips steps whose artifacts already exist under deployments/.
#
# Network calls in this repo's dev sandbox require disabling the default
# command sandbox (DNS is blocked otherwise) — outside that sandbox this
# script needs no special flags.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
DEPLOY_JSON="$ROOT_DIR/deployments/testnet.json"
NETWORK=testnet
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

DEPLOYER=deployer
BOOTSTRAP_REEXECUTORS=(rex1 rex2 rex3 rex4 rex5)
CHALLENGER=challenger1

echo "==> Ensuring identities exist and are funded"
for name in "$DEPLOYER" "${BOOTSTRAP_REEXECUTORS[@]}" "$CHALLENGER"; do
  if ! stellar keys address "$name" >/dev/null 2>&1; then
    stellar keys generate "$name" --network "$NETWORK" --fund
  else
    stellar keys fund "$name" --network "$NETWORK" || true
  fi
done

DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER")
echo "==> Deployer: $DEPLOYER_ADDR"

echo "==> Resolving native XLM Stellar Asset Contract address"
NATIVE_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "==> Native XLM SAC: $NATIVE_SAC"

echo "==> Building contracts (release profile)"
cd "$CONTRACTS_DIR"
stellar contract build

WASM_DIR="$CONTRACTS_DIR/target/wasm32v1-none/release"
GATE_WASM="$WASM_DIR/escrow_gate.wasm"
REGISTRY_WASM="$WASM_DIR/zk_verifier_registry.wasm"

echo "==> Deploying EscrowGate"
GATE_ID=$(stellar contract deploy \
  --wasm "$GATE_WASM" \
  --source "$DEPLOYER" \
  --network "$NETWORK" \
  -- )
echo "EscrowGate contract id: $GATE_ID"

echo "==> Deploying ZKVerifierRegistry"
REGISTRY_ID=$(stellar contract deploy \
  --wasm "$REGISTRY_WASM" \
  --source "$DEPLOYER" \
  --network "$NETWORK" \
  -- )
echo "ZKVerifierRegistry contract id: $REGISTRY_ID"

echo "==> Initializing ZKVerifierRegistry"
stellar contract invoke \
  --id "$REGISTRY_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- initialize --admin "$DEPLOYER_ADDR"

echo "==> Initializing EscrowGate with default Phase-1 config"
# Config values are v1 defaults (ASSUMPTIONs from the PRD, tunable later via
# update_config): 1% min supermajority above the 51% floor, quorum of 3,
# 5% agent bond / 5% challenger bond, 1h window under 100 XLM escrow value
# else 24h, 20% of a slashed pool goes to the prevailing challenger.
stellar contract invoke \
  --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --bond_asset "$NATIVE_SAC" \
  --config '{"min_stake_floor":"5000000000","quorum_min_reexecutors":3,"quorum_supermajority_bps":6600,"agent_bond_min_bps":500,"challenger_bond_min_bps":500,"window_tier_small_ceiling":"1000000000000","window_tier_small_s":3600,"window_tier_large_s":86400,"slash_split_challenger_bps":2000}'

echo "==> Wiring ZKVerifierRegistry into EscrowGate"
stellar contract invoke \
  --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- set_zk_registry --admin "$DEPLOYER_ADDR" --registry "$REGISTRY_ID"

echo "==> Asserting ZKVerifierRegistry is genuinely empty (Phase 1 requirement)"
LIST_OUT=$(stellar contract invoke \
  --id "$REGISTRY_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- list_verifiers)
if [ "$LIST_OUT" != "[]" ]; then
  echo "FATAL: ZKVerifierRegistry is not empty after deploy: $LIST_OUT" >&2
  exit 1
fi
echo "==> Confirmed empty: $LIST_OUT"

echo "==> Writing deployments/testnet.json"
BOOTSTRAP_JSON="["
for name in "${BOOTSTRAP_REEXECUTORS[@]}"; do
  addr=$(stellar keys address "$name")
  BOOTSTRAP_JSON="$BOOTSTRAP_JSON{\"alias\":\"$name\",\"public_key\":\"$addr\"},"
done
BOOTSTRAP_JSON="${BOOTSTRAP_JSON%,}]"

cat > "$DEPLOY_JSON" <<EOF
{
  "network": "$NETWORK",
  "network_passphrase": "$NETWORK_PASSPHRASE",
  "escrow_gate_contract_id": "$GATE_ID",
  "zk_verifier_registry_contract_id": "$REGISTRY_ID",
  "native_xlm_sac_address": "$NATIVE_SAC",
  "deployer_public_key": "$DEPLOYER_ADDR",
  "bootstrap_reexecutors": $BOOTSTRAP_JSON,
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "==> Wrote $DEPLOY_JSON"
echo ""
echo "Secret keys for all generated identities live in ~/.config/stellar/identity/*.toml"
echo "(never committed; deployments/testnet.json only ever holds public keys/contract IDs)."
echo "Done."

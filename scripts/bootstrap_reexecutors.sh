#!/usr/bin/env bash
# Stakes each bootstrap re-executor identity into EscrowGate with a real
# signed register_reexecutor transaction, then has the admin approve it so
# its votes count (the deployment runs with the voter allow-list on).
# Requires deployments/<name>.json (run deploy_testnet.sh first).
#
# Safe to re-run: an identity already at or above the target stake is left
# alone, and approving an approved account changes nothing.
#
#   VERITY_DEPLOYMENT   deployment name (default: testnet)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_deployment.sh
source "$ROOT_DIR/scripts/_deployment.sh"
require_deployment
assert_identities_match

STAKE_AMOUNT=10000000000 # 1,000 XLM in stroops — comfortably above min_stake_floor

GATE_ID=$(json_field escrow_gate_contract_id)
if [ -z "$GATE_ID" ]; then
  echo "FATAL: could not read escrow_gate_contract_id from $DEPLOY_JSON" >&2
  exit 1
fi
DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER")
echo "==> EscrowGate: $GATE_ID (deployment '$DEPLOYMENT')"

cfg_output=$(stellar contract invoke \
  --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- get_config)

min_floor_raw=$(echo "$cfg_output" | grep -o '"min_stake_floor": *"[0-9]*"' | grep -o '[0-9]*' || true)
if [ -z "$min_floor_raw" ]; then
  # Fallback for integer JSON without quotes
  min_floor_raw=$(echo "$cfg_output" | grep -o '"min_stake_floor": *[0-9]*' | grep -o '[0-9]*' || true)
fi

if [ -z "$min_floor_raw" ]; then
  echo "FATAL: could not parse min_stake_floor from get_config output: $cfg_output" >&2
  exit 1
fi

TARGET_STAKE="$STAKE_AMOUNT"
if [ "$min_floor_raw" -gt "$TARGET_STAKE" ]; then
  TARGET_STAKE="$min_floor_raw"
fi
echo "==> Target stake per re-executor: $TARGET_STAKE stroops (min_stake_floor: $min_floor_raw)"

read_stake() {
  local raw="$1"
  local alias_name="$2"
  # Clean un-registered cases: null, empty string, or "null" literal
  local trimmed
  trimmed=$(echo "$raw" | tr -d '[:space:]')
  if [ -z "$trimmed" ] || [ "$trimmed" = "null" ]; then
    echo "0"
    return 0
  fi

  local parsed
  parsed=$(echo "$raw" | grep -o '"stake_amount": *"[0-9]*"' | grep -o '[0-9]*' || true)
  if [ -z "$parsed" ]; then
    parsed=$(echo "$raw" | grep -o '"stake_amount": *[0-9]*' | grep -o '[0-9]*' || true)
  fi

  if [ -z "$parsed" ]; then
    echo "FATAL: could not parse stake_amount for '$alias_name' from output: $raw" >&2
    return 1
  fi

  echo "$parsed"
  return 0
}

for name in "${BOOTSTRAP_REEXECUTORS[@]}"; do
  if ! addr=$(stellar keys address "$name" 2>/dev/null); then
    echo "FATAL: no stellar-cli identity '$name' — run scripts/deploy_testnet.sh first" >&2
    exit 1
  fi

  info=$(stellar contract invoke \
    --id "$GATE_ID" --source "$name" --network "$NETWORK" \
    -- reexecutor_info --reexecutor "$addr")

  current=$(read_stake "$info" "$name")
  if [ "$current" -ge "$TARGET_STAKE" ]; then
    echo "==> $name ($addr) already staked ${current} stroops"
  else
    shortfall=$((TARGET_STAKE - current))
    echo "==> Staking $name ($addr) for $shortfall stroops (current: $current, target: $TARGET_STAKE)"
    stellar contract invoke \
      --id "$GATE_ID" --source "$name" --network "$NETWORK" \
      -- register_reexecutor --reexecutor "$addr" --stake_amount "$shortfall"
  fi

  echo "==> Approving $name as a voter"
  stellar contract invoke \
    --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
    -- set_reexecutor_approved --admin "$DEPLOYER_ADDR" --reexecutor "$addr" --approved

  info=$(stellar contract invoke \
    --id "$GATE_ID" --source "$name" --network "$NETWORK" \
    -- reexecutor_info --reexecutor "$addr")
  echo "    on-chain state: $info"

  if ! echo "$info" | grep -q '"active": *true'; then
    echo "FATAL: re-executor '$name' ($addr) is not active after bootstrap (state: $info)" >&2
    exit 1
  fi
  if ! echo "$info" | grep -q '"approved": *true'; then
    echo "FATAL: re-executor '$name' ($addr) is not approved after bootstrap (state: $info)" >&2
    exit 1
  fi
done

echo "Done. The bootstrap re-executors are staked, active and approved on EscrowGate ($GATE_ID)."
echo "Next: run a reexecutor-agent for each of these identities so assignments get replayed."

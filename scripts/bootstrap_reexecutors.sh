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

STAKE_AMOUNT=10000000000 # 1,000 XLM in stroops — comfortably above min_stake_floor

GATE_ID=$(json_field escrow_gate_contract_id)
if [ -z "$GATE_ID" ]; then
  echo "FATAL: could not read escrow_gate_contract_id from $DEPLOY_JSON" >&2
  exit 1
fi
DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER")
echo "==> EscrowGate: $GATE_ID (deployment '$DEPLOYMENT')"

for name in "${BOOTSTRAP_REEXECUTORS[@]}"; do
  if ! addr=$(stellar keys address "$name" 2>/dev/null); then
    echo "FATAL: no stellar-cli identity '$name' — run scripts/deploy_testnet.sh first" >&2
    exit 1
  fi

  info=$(stellar contract invoke \
    --id "$GATE_ID" --source "$name" --network "$NETWORK" \
    -- reexecutor_info --reexecutor "$addr")
  current=$(echo "$info" | grep -o '"stake_amount": *"[0-9]*"' | grep -o '[0-9]*' || true)
  if [ "${current:-0}" -ge "$STAKE_AMOUNT" ]; then
    echo "==> $name ($addr) already staked ${current} stroops"
  else
    echo "==> Staking $name ($addr) for $STAKE_AMOUNT stroops"
    stellar contract invoke \
      --id "$GATE_ID" --source "$name" --network "$NETWORK" \
      -- register_reexecutor --reexecutor "$addr" --stake_amount "$STAKE_AMOUNT"
  fi

  echo "==> Approving $name as a voter"
  stellar contract invoke \
    --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
    -- set_reexecutor_approved --admin "$DEPLOYER_ADDR" --reexecutor "$addr" --approved

  info=$(stellar contract invoke \
    --id "$GATE_ID" --source "$name" --network "$NETWORK" \
    -- reexecutor_info --reexecutor "$addr")
  echo "    on-chain state: $info"
done

echo "Done. The bootstrap re-executors are staked, active and approved on EscrowGate ($GATE_ID)."
echo "Next: run a reexecutor-agent for each of these identities so assignments get replayed."

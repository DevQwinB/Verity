#!/usr/bin/env bash
# Stakes each real, funded bootstrap re-executor identity into EscrowGate via
# a real signed register_reexecutor transaction. Requires deployments/testnet.json
# to already exist (run deploy_testnet.sh first). Idempotent: re-running just
# tops up stake (register_reexecutor adds to existing stake).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_JSON="$ROOT_DIR/deployments/testnet.json"
NETWORK=testnet
STAKE_AMOUNT=10000000000 # 1,000 XLM in stroops — comfortably above min_stake_floor

if [ ! -f "$DEPLOY_JSON" ]; then
  echo "FATAL: $DEPLOY_JSON not found — run scripts/deploy_testnet.sh first" >&2
  exit 1
fi

GATE_ID=$(grep -o '"escrow_gate_contract_id": *"[^"]*"' "$DEPLOY_JSON" | cut -d'"' -f4)
if [ -z "$GATE_ID" ]; then
  echo "FATAL: could not read escrow_gate_contract_id from $DEPLOY_JSON" >&2
  exit 1
fi
echo "==> EscrowGate: $GATE_ID"

BOOTSTRAP_REEXECUTORS=(rex1 rex2 rex3 rex4 rex5)

for name in "${BOOTSTRAP_REEXECUTORS[@]}"; do
  addr=$(stellar keys address "$name")
  echo "==> Staking $name ($addr) for $STAKE_AMOUNT stroops"
  stellar contract invoke \
    --id "$GATE_ID" --source "$name" --network "$NETWORK" \
    -- register_reexecutor --reexecutor "$addr" --stake_amount "$STAKE_AMOUNT"

  info=$(stellar contract invoke \
    --id "$GATE_ID" --source "$name" --network "$NETWORK" \
    -- reexecutor_info --reexecutor "$addr")
  echo "    on-chain state: $info"
done

echo "Done. All bootstrap re-executors are staked and active on EscrowGate ($GATE_ID)."
echo "Next: run reexecutor-agent using each of these identities to actually pick up and replay assignments."

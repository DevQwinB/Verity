#!/usr/bin/env bash
# Approves (or revokes) a staked re-executor as a voter on EscrowGate. Signed
# by the deployment's admin identity from your stellar-cli keystore — that key
# never needs to be on a server.
#
#   scripts/approve_reexecutor.sh G...            approve
#   scripts/approve_reexecutor.sh G... --revoke   revoke
#
#   VERITY_DEPLOYMENT   deployment name (default: testnet)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_deployment.sh
source "$ROOT_DIR/scripts/_deployment.sh"
require_deployment
assert_identities_match

ACCOUNT="${1:-}"
MODE="${2:-}"
if ! [[ "$ACCOUNT" =~ ^G[A-Z2-7]{55}$ ]] || { [ -n "$MODE" ] && [ "$MODE" != "--revoke" ]; }; then
  echo "usage: scripts/approve_reexecutor.sh <G... account> [--revoke]" >&2
  exit 2
fi

GATE_ID=$(json_field escrow_gate_contract_id)
DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER")

# A bool contract argument is a flag on the CLI: bare means true.
APPROVED_FLAG=(--approved)
VERB="Approving"
if [ "$MODE" = "--revoke" ]; then
  APPROVED_FLAG=(--approved false)
  VERB="Revoking"
fi

echo "==> $VERB $ACCOUNT on EscrowGate $GATE_ID (deployment '$DEPLOYMENT')"
stellar contract invoke \
  --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- set_reexecutor_approved --admin "$DEPLOYER_ADDR" --reexecutor "$ACCOUNT" "${APPROVED_FLAG[@]}"

stellar contract invoke \
  --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- reexecutor_info --reexecutor "$ACCOUNT"

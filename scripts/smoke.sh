#!/usr/bin/env bash
# Runs the end-to-end smoke test against a stack started by `pnpm dev`.
# Plays the agent and the challenger with two funded testnet identities from
# your stellar-cli keystore; the re-executor agents started by `pnpm dev` do
# the actual replaying and on-chain attesting.
#
#   SMOKE_AGENT_ALIAS (agent1)  SMOKE_CHALLENGER_ALIAS (challenger1)
#   VERITY_API_PORT (3001)      SMOKE_ONLY=honest-deterministic,...
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${VERITY_API_PORT:-3001}"
AGENT_ALIAS="${SMOKE_AGENT_ALIAS:-agent1}"
CHALLENGER_ALIAS="${SMOKE_CHALLENGER_ALIAS:-challenger1}"
DEPLOY_JSON="$ROOT_DIR/deployments/testnet.json"
json_field() { grep -o "\"$1\": *\"[^\"]*\"" "$DEPLOY_JSON" | cut -d'"' -f4; }

for alias in "$AGENT_ALIAS" "$CHALLENGER_ALIAS"; do
  if ! stellar keys address "$alias" >/dev/null 2>&1; then
    echo "==> Creating and funding testnet identity '$alias'"
    stellar keys generate "$alias" --network testnet --fund
  fi
done

if ! curl -fs "http://127.0.0.1:$API_PORT/health" >/dev/null; then
  echo "FATAL: no Verity backend on :$API_PORT — start the stack with 'pnpm dev' first" >&2
  exit 1
fi

cd "$ROOT_DIR/backend"
SMOKE_AGENT_SECRET="$(stellar keys secret "$AGENT_ALIAS")" \
SMOKE_CHALLENGER_SECRET="$(stellar keys secret "$CHALLENGER_ALIAS")" \
SMOKE_BACKEND_URL="http://127.0.0.1:$API_PORT" \
PORT="$API_PORT" \
ESCROW_GATE_CONTRACT_ID="$(json_field escrow_gate_contract_id)" \
ZK_VERIFIER_REGISTRY_CONTRACT_ID="$(json_field zk_verifier_registry_contract_id)" \
BOND_ASSET_CONTRACT_ID="$(json_field native_xlm_sac_address)" \
DATABASE_URL="${DATABASE_URL:-postgres://verity:verity@127.0.0.1:${VERITY_PG_PORT:-5433}/verity}" \
WEB_AUTH_DOMAIN="localhost:$API_PORT" HOME_DOMAIN="localhost:$API_PORT" \
  exec node_modules/.bin/tsx src/smoke/run.ts

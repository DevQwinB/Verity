# Sourced by the other scripts: resolves which Verity deployment they act on.
#
#   VERITY_DEPLOYMENT=testnet (default)  deployments/testnet.json, the dev and
#                                        smoke deployment, identities deployer,
#                                        keeper, rex1..rex5
#   VERITY_DEPLOYMENT=<name>             deployments/<name>.json, identities
#                                        <name>-deployer, <name>-keeper,
#                                        <name>-rex1..rex5
#
# Every deployment lives on Stellar testnet; the name separates contracts and
# keys, not networks. A deployment whose file says "public": true is one real
# users are on, and the dev runner and smoke test refuse to touch it.
#
# Expects ROOT_DIR to be set by the caller.

DEPLOYMENT="${VERITY_DEPLOYMENT:-testnet}"
if ! [[ "$DEPLOYMENT" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "FATAL: VERITY_DEPLOYMENT must be lowercase letters, digits and dashes (got '$DEPLOYMENT')" >&2
  exit 2
fi
if [ "$DEPLOYMENT" = testnet ]; then
  ALIAS_PREFIX=""
else
  ALIAS_PREFIX="$DEPLOYMENT-"
fi

NETWORK=testnet
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
DEPLOY_JSON="$ROOT_DIR/deployments/$DEPLOYMENT.json"

DEPLOYER="${ALIAS_PREFIX}deployer"
KEEPER="${ALIAS_PREFIX}keeper"
BOOTSTRAP_REEXECUTORS=("${ALIAS_PREFIX}rex1" "${ALIAS_PREFIX}rex2" "${ALIAS_PREFIX}rex3" "${ALIAS_PREFIX}rex4" "${ALIAS_PREFIX}rex5")

json_field() { grep -o "\"$1\": *\"[^\"]*\"" "$DEPLOY_JSON" | cut -d'"' -f4; }

deployment_is_public() { grep -q '"public": *true' "$DEPLOY_JSON"; }

require_deployment() {
  if [ ! -f "$DEPLOY_JSON" ]; then
    echo "FATAL: $DEPLOY_JSON not found — run scripts/deploy_testnet.sh first" >&2
    exit 1
  fi
}

refuse_public_deployment() {
  if deployment_is_public; then
    echo "FATAL: deployment '$DEPLOYMENT' is marked public. $1" >&2
    exit 1
  fi
}

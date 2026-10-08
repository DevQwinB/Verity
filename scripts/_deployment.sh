# Sourced by the other scripts: resolves which Verity deployment they act on.
#
#   VERITY_DEPLOYMENT=testnet (default)  deployments/testnet.json, the dev and
#                                        smoke deployment, identities deployer,
#                                        keeper, rex1..rex5
#   VERITY_DEPLOYMENT=<name>             deployments/<name>.json, identities
#                                        verity-<name>-deployer,
#                                        verity-<name>-keeper,
#                                        verity-<name>-rex1..rex5
#
# The stellar-cli keystore is one flat namespace shared by every project on
# the machine, and another project that generates an identity called "keeper"
# or "deployer" silently replaces yours. Named deployments are therefore
# prefixed with "verity-"; the dev deployment keeps its short historical
# aliases, and every script checks them against the deployment record (see
# assert_identities_match) so a replaced key is reported, not used.
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
  ALIAS_PREFIX="verity-$DEPLOYMENT-"
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

# Fails if the deployer or a fleet re-executor in the keystore is no longer
# the account the deployment record names: the deployer is the contract's
# admin and each re-executor holds a stake, so a different key under the same
# alias cannot stand in for them. The keeper is different — it has no
# authority on-chain and any funded account can do its job — so a changed
# keeper is reported and the keystore's current one is used.
assert_identities_match() {
  local problems=0 recorded current alias
  recorded="$(json_field deployer_public_key)"
  current="$(stellar keys address "$DEPLOYER" 2>/dev/null || true)"
  if [ -n "$recorded" ] && [ "$recorded" != "$current" ]; then
    echo "FATAL: keystore identity '$DEPLOYER' is ${current:-missing}, but the admin of deployment '$DEPLOYMENT' is $recorded." >&2
    problems=1
  fi
  for alias in "${BOOTSTRAP_REEXECUTORS[@]}"; do
    recorded="$(grep -o "{\"alias\":\"$alias\",\"public_key\":\"[^\"]*\"" "$DEPLOY_JSON" | cut -d'"' -f8)"
    current="$(stellar keys address "$alias" 2>/dev/null || true)"
    if [ -n "$recorded" ] && [ -n "$current" ] && [ "$recorded" != "$current" ]; then
      echo "FATAL: keystore identity '$alias' is $current, but deployment '$DEPLOYMENT' staked $recorded under that name." >&2
      problems=1
    fi
  done
  if [ "$problems" = 1 ]; then
    echo "       Another project has probably generated an identity with the same name. Restore the" >&2
    echo "       original key into the keystore, or redeploy (scripts/deploy_testnet.sh --force)." >&2
    exit 1
  fi
  recorded="$(json_field keeper_public_key)"
  current="$(stellar keys address "$KEEPER" 2>/dev/null || true)"
  if [ -n "$recorded" ] && [ -n "$current" ] && [ "$recorded" != "$current" ]; then
    echo "WARN: keystore identity '$KEEPER' is $current, not the $recorded recorded at deploy time." >&2
    echo "      The keeper needs no authority on-chain, so this one is used; verdict attestations will be signed by it." >&2
  fi
}

refuse_public_deployment() {
  if deployment_is_public; then
    echo "FATAL: deployment '$DEPLOYMENT' is marked public. $1" >&2
    exit 1
  fi
}

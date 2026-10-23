#!/usr/bin/env bash
# Regenerates the TypeScript contract bindings under
# backend/src/chain/generated/ from the locally built wasm and rebuilds them.
# Run after any change to a contract's interface. Needs no network: the
# bindings carry the interface only, and every client is given its contract
# id from configuration at runtime.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_DIR="$ROOT_DIR/contracts/target/wasm32v1-none/release"
OUT_ROOT="$ROOT_DIR/backend/src/chain/generated"
# Scratch output lives under the (gitignored) cargo target dir and is simply
# overwritten on the next run.
SCRATCH_DIR="$ROOT_DIR/contracts/target/bindings"

echo "==> Building contracts (release profile)"
(cd "$ROOT_DIR/contracts" && stellar contract build)

for pair in "escrow_gate:escrow-gate" "zk_verifier_registry:zk-verifier-registry"; do
  wasm="$WASM_DIR/${pair%%:*}.wasm"
  name="${pair##*:}"
  if [ ! -f "$wasm" ]; then
    echo "FATAL: $wasm not found" >&2
    exit 1
  fi
  echo "==> Generating bindings for $name"
  # Generate into scratch and copy only the source over, so the package.json
  # the workspace resolves (name, exports) stays as committed.
  stellar contract bindings typescript --wasm "$wasm" --output-dir "$SCRATCH_DIR/$name" --overwrite
  cp "$SCRATCH_DIR/$name/src/index.ts" "$OUT_ROOT/$name/src/index.ts"
done

echo "==> Rebuilding binding packages"
(cd "$ROOT_DIR" && pnpm --filter escrow-gate --filter zk-verifier-registry build)
echo "Done."

#!/usr/bin/env bash
# Exports the frozen EscrowGate / ZKVerifierRegistry contract interfaces as
# JSON so the backend team generates typed TS bindings
# (`stellar contract bindings typescript`) instead of hand-rolling XDR.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_DIR="$ROOT_DIR/contracts/target/wasm32v1-none/release"
OUT_DIR="$ROOT_DIR/deployments/interfaces"
mkdir -p "$OUT_DIR"

for name in escrow_gate zk_verifier_registry example_marketplace_escrow; do
  wasm="$WASM_DIR/$name.wasm"
  if [ ! -f "$wasm" ]; then
    echo "FATAL: $wasm not found — run 'stellar contract build' in contracts/ first" >&2
    exit 1
  fi
  out="$OUT_DIR/$name.json"
  echo "==> Exporting interface for $name"
  stellar contract info interface --wasm "$wasm" --output json > "$out"
  echo "    wrote $out"
done

echo "Done. Interfaces written to $OUT_DIR"

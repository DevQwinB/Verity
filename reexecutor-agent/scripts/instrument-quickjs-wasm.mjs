// Generates src/sandbox/quickjs-fuel.wasm: the pinned quickjs-emscripten
// release-sync engine with fuel metering injected at every wasm loop header.
//
// A wasm-level counter (global $verity_fuel) is decremented on every loop
// back-edge — including the C loops inside native builtins such as
// Array.prototype.indexOf or join, which the interpreter's interrupt handler
// never sees — and traps through the host import "verity"/"fuel_exhausted"
// when it goes negative. Because the counter lives in the wasm, the same
// budget means the same amount of work on every re-executor host, whatever
// its CPU speed.
//
// Run once when quickjs-emscripten is upgraded; the output is committed:
//   pnpm --filter @verity/reexecutor-agent instrument:wasm
// A test pins the artifact's sha256 (see runner.test.ts).
import binaryen from "binaryen";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SRC = require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
const OUT = new URL("../src/sandbox/quickjs-fuel.wasm", import.meta.url);
const FUEL = "verity_fuel";

const bytes0 = new Uint8Array(fs.readFileSync(SRC));
const mod = binaryen.readBinary(bytes0);
// keep exactly the source feature set (plus mutable globals for the fuel
// global) — never let binaryen emit newer encodings (e.g. compact imports)
// that the hosts' V8 does not support yet.
mod.setFeatures(binaryen.Features.All & ~binaryen.Features.CompactImports);

// --- add the fuel global + accessor functions ------------------------------
// starts at INT32_MAX = "metering off" so emscripten init code can run;
// the replay worker sets the real budget before every eval
mod.addGlobal(FUEL, binaryen.i32, true, mod.i32.const(2147483647));
const i32Result = binaryen.createType([binaryen.i32]);
const fuelGet = mod.addFunction(
  "verity_fuel_get",
  binaryen.createType([]),
  i32Result,
  [],
  mod.global.get(FUEL, binaryen.i32)
);
mod.addFunctionExport("verity_fuel_get", "verity_fuel_get");
const fuelSet = mod.addFunction(
  "verity_fuel_set",
  i32Result,
  binaryen.none,
  [],
  mod.global.set(FUEL, mod.local.get(0, binaryen.i32))
);
mod.addFunctionExport("verity_fuel_set", "verity_fuel_set");

// Host-provided import: throws a distinctive JS error when called, so a fuel
// trap is distinguishable from any other wasm trap on the host side.
mod.addFunctionImport("$verity_fuel_exhausted", "verity", "fuel_exhausted", binaryen.none, binaryen.none);

// --- fuel check injected at every loop header -------------------------------
function fuelCheck() {
  return mod.block(null, [
    mod.global.set(FUEL, mod.i32.sub(mod.global.get(FUEL, binaryen.i32), mod.i32.const(1))),
    mod.if(
      mod.i32.lt_s(mod.global.get(FUEL, binaryen.i32), mod.i32.const(0)),
      mod.block(null, [
        mod.call("$verity_fuel_exhausted", [], binaryen.none),
        mod.unreachable(),
      ])
    ),
  ]);
}

// Rebuild expression trees bottom-up, wrapping every Loop. Nodes whose
// children cannot contain a loop in compiler output (loads/stores, indirect
// call operands, ...) are passed through unchanged.
function rewrite(expr) {
  let info;
  try { info = binaryen.getExpressionInfo(expr); } catch { return expr; } // e.g. Unreachable
  const id = info.id;
  if (id === binaryen.LoopId) {
    loops++;
    return mod.loop(info.name, mod.block(null, [fuelCheck(), rewrite(info.body)], info.type));
  }
  switch (id) {
    case binaryen.BlockId:
      return mod.block(info.name, info.children.map(rewrite), info.type);
    case binaryen.IfId:
      return mod.if(rewrite(info.condition), rewrite(info.ifTrue), info.ifFalse ? rewrite(info.ifFalse) : undefined);
    case binaryen.BreakId:
      return info.condition
        ? mod.br_if(info.name, rewrite(info.condition), info.value ? rewrite(info.value) : undefined)
        : mod.br(info.name, undefined, info.value ? rewrite(info.value) : undefined);
    case binaryen.SwitchId:
      return mod.switch(info.names, info.defaultName, rewrite(info.condition), info.value ? rewrite(info.value) : undefined);
    case binaryen.CallId:
      return info.isReturn
        ? mod.return_call(info.target, info.operands.map(rewrite), info.type)
        : mod.call(info.target, info.operands.map(rewrite), info.type);
    case binaryen.LocalSetId:
      return info.isTee
        ? mod.local.tee(info.index, rewrite(info.value), info.type)
        : mod.local.set(info.index, rewrite(info.value));
    case binaryen.GlobalSetId:
      return mod.global.set(info.name, rewrite(info.value));
    case binaryen.SelectId:
      return mod.select(rewrite(info.condition), rewrite(info.ifTrue), rewrite(info.ifFalse));
    case binaryen.DropId:
      return mod.drop(rewrite(info.value));
    case binaryen.ReturnId:
      return mod.return(info.value ? rewrite(info.value) : undefined);
    case binaryen.UnaryId:
      return binaryen._BinaryenUnary(mod.ptr, info.op, rewrite(info.value));
    case binaryen.BinaryId:
      return binaryen._BinaryenBinary(mod.ptr, info.op, rewrite(info.left), rewrite(info.right));
    case binaryen.MemoryCopyId:
      return mod.memory.copy(rewrite(info.dest), rewrite(info.source), rewrite(info.size));
    case binaryen.MemoryFillId:
      return mod.memory.fill(rewrite(info.dest), rewrite(info.value), rewrite(info.size));
    default:
      // leaves (Const, LocalGet, GlobalGet, Load, Store, MemorySize, Nop,
      // Unreachable, ...) and nodes that cannot wrap a loop in practice
      return expr;
  }
}

let loops = 0;
const funcs = mod.getNumFunctions();
for (let i = 0; i < funcs; i++) {
  const f = mod.getFunctionByIndex(i);
  const info = binaryen.getFunctionInfo(f);
  if (!info.body) continue;
  binaryen._BinaryenFunctionSetBody(f, rewrite(info.body));
}

if (mod.validate() !== 1) {
  throw new Error("instrumented module failed validation");
}
const bytes = mod.emitBinary();
fs.writeFileSync(OUT, bytes);
console.error("wrote", new URL(OUT).pathname);
console.log(`instrumented ${loops} loops across ${funcs} functions -> ${bytes.length} bytes (source ${fs.statSync(SRC).size})`);
mod.dispose();

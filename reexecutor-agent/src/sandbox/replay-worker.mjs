// Runs ONE replay inside a QuickJS WebAssembly sandbox, in its own worker
// thread, and posts a single message back. Plain JavaScript on purpose: the
// worker is started without the TypeScript loader and imports nothing but
// the engine, so the guest code's only neighbours are this file and Node's
// worker runtime — not the agent, its environment, or its signing key.
//
// Outcomes:
//   { kind: "ok", outputJson }       the function returned (null = undefined)
//   { kind: "guest-error", reason }  the function threw, or hit an engine
//                                    limit. Engine limits are enforced by the
//                                    same fuel-instrumented WASM build on every
//                                    re-executor, so this is the same on all
//                                    of them.
//   { kind: "host-error", reason }   this host failed, not the function.
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant, RELEASE_SYNC } from "quickjs-emscripten";

const { functionSource, inputJson, limits } = workerData;

// Thrown by the host import the fuel-instrumented engine calls when its
// loop counter goes negative. A distinctive message keeps a fuel trap
// distinguishable from any other wasm trap or engine error.
const FUEL_EXHAUSTED_MESSAGE = "verity: computation fuel exhausted";

// The engine is the pinned release-sync build with fuel metering injected at
// every wasm loop header (scripts/instrument-quickjs-wasm.mjs). The counter
// lives in the wasm, so the budget means the same work on every host; it
// also covers the C loops inside native builtins (indexOf, join, ...), which
// the interpreter's interrupt handler never sees.
const fuelWasmBytes = readFileSync(new URL("./quickjs-fuel.wasm", import.meta.url));
let fuelExports = null;
const baseModuleLoader = await RELEASE_SYNC.importModuleLoader();
const fuelModuleFactory = (opts) =>
  baseModuleLoader({
    ...opts,
    wasmBinary: fuelWasmBytes,
    instantiateWasm: (imports, onSuccess) =>
      WebAssembly.instantiate(fuelWasmBytes, {
        ...imports,
        verity: {
          fuel_exhausted: () => {
            throw new Error(FUEL_EXHAUSTED_MESSAGE);
          },
        },
      }).then((res) => {
        const instance = res.instance ?? res;
        fuelExports = instance.exports;
        onSuccess(instance);
        return instance;
      }),
  });
const fuelVariant = { ...RELEASE_SYNC, importModuleLoader: async () => fuelModuleFactory };

// Date and Math.random are the engine's only sources of non-determinism.
// A replay must give every honest re-executor the same answer, so a function
// that reads the clock or rolls dice is not replayable and gets neither.
const PRELUDE = `
delete globalThis.Date;
delete Math.random;
const __input = JSON.parse(__inputJson);
delete globalThis.__inputJson;
`;

/** True once the fuel counter has gone negative, i.e. the engine trapped on
 * the budget. After that the runtime is mid-unwind and must not be touched
 * again — any further engine error is treated as the same guest error. */
function fuelTrapped(err) {
  if (!fuelExports) return false;
  if (typeof fuelExports.verity_fuel_get === "function" && fuelExports.verity_fuel_get() < 0) return true;
  return typeof err?.message === "string" && err.message.includes(FUEL_EXHAUSTED_MESSAGE);
}

try {
  // A fresh WASM instance per replay: nothing a previous function did to the
  // engine can reach this one.
  const QuickJS = await newQuickJSWASMModuleFromVariant(fuelVariant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  let ticks = 0;
  runtime.setInterruptHandler(() => ++ticks > limits.ticks);

  const context = runtime.newContext();
  const input = context.newString(inputJson);
  context.setProp(context.global, "__inputJson", input);
  input.dispose();

  // Arm the wasm-level budget before evaluating. The same number on every
  // re-executor means the same amount of work everywhere.
  fuelExports.verity_fuel_set(limits.fuel);

  let result;
  let thrown;
  try {
    result = context.evalCode(
      `${PRELUDE}JSON.stringify((function(input){ ${functionSource}\n})(__input));`,
      "replay-function.js"
    );
  } catch (err) {
    thrown = err;
  }

  if (fuelTrapped(thrown)) {
    // Budget exceeded inside a native builtin or a bytecode loop: a property
    // of the function, identical on every host — a guest error, never a
    // host error, and never left half-disposed (we stop touching the engine).
    parentPort.postMessage({ kind: "guest-error", reason: "computation budget exceeded" });
  } else if (thrown) {
    throw thrown;
  } else if (result.error) {
    if (fuelTrapped(null)) {
      parentPort.postMessage({ kind: "guest-error", reason: "computation budget exceeded" });
    } else {
      const error = context.dump(result.error);
      result.error.dispose();
      const reason =
        ticks > limits.ticks
          ? "computation budget exceeded"
          : `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
      parentPort.postMessage({ kind: "guest-error", reason });
    }
  } else {
    const outputJson = context.typeof(result.value) === "string" ? context.getString(result.value) : null;
    result.value.dispose();
    parentPort.postMessage({ kind: "ok", outputJson });
  }
} catch (err) {
  // Anything thrown out of the engine itself (rather than reported by it) is
  // the host's stack or memory giving way, which differs from machine to
  // machine and so must never be turned into a vote — unless the fuel
  // counter already went negative, in which case the trap is the function's
  // fault, not the host's.
  if (fuelTrapped(err)) {
    parentPort.postMessage({ kind: "guest-error", reason: "computation budget exceeded" });
  } else {
    parentPort.postMessage({ kind: "host-error", reason: String(err?.message ?? err) });
  }
}

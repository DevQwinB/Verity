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
//                                    same WASM build on every re-executor, so
//                                    this is the same on all of them.
//   { kind: "host-error", reason }   this host failed, not the function.
import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModule } from "quickjs-emscripten";

const { functionSource, inputJson, limits } = workerData;

// Date and Math.random are the engine's only sources of non-determinism.
// A replay must give every honest re-executor the same answer, so a function
// that reads the clock or rolls dice is not replayable and gets neither.
const PRELUDE = `
delete globalThis.Date;
delete Math.random;
const __input = JSON.parse(__inputJson);
delete globalThis.__inputJson;
`;

try {
  // A fresh WASM instance per replay: nothing a previous function did to the
  // engine can reach this one.
  const QuickJS = await newQuickJSWASMModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  let ticks = 0;
  runtime.setInterruptHandler(() => ++ticks > limits.ticks);

  const context = runtime.newContext();
  const input = context.newString(inputJson);
  context.setProp(context.global, "__inputJson", input);
  input.dispose();

  const result = context.evalCode(
    `${PRELUDE}JSON.stringify((function(input){ ${functionSource}\n})(__input));`,
    "replay-function.js"
  );
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    const reason =
      ticks > limits.ticks
        ? "computation budget exceeded"
        : `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
    parentPort.postMessage({ kind: "guest-error", reason });
  } else {
    const outputJson = context.typeof(result.value) === "string" ? context.getString(result.value) : null;
    result.value.dispose();
    parentPort.postMessage({ kind: "ok", outputJson });
  }
} catch (err) {
  // Anything thrown out of the engine itself (rather than reported by it) is
  // the host's stack or memory giving way, which differs from machine to
  // machine and so must never be turned into a vote.
  parentPort.postMessage({ kind: "host-error", reason: String(err?.message ?? err) });
}

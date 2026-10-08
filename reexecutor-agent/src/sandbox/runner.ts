import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { canonicalHash } from "./canonical.js";

let dockerAvailable: boolean | undefined;
function hasDocker(): boolean {
  if (dockerAvailable === undefined) {
    try {
      execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
      dockerAvailable = true;
    } catch {
      dockerAvailable = false;
    }
  }
  return dockerAvailable;
}

/**
 * Real, sandboxed re-execution of a deterministic task's declared function
 * against its declared input, then a real sha256 of the canonical output —
 * never a fabricated match/mismatch. Prefers a real Docker container
 * (--network=none, resource-capped) when Docker is present; otherwise it
 * falls back to a Node `vm` context with no network/require access and a
 * hard timeout instead of silently no-op'ing.
 *
 * `node:vm` is NOT a security boundary — a hostile function can escape it.
 * The fallback is for local development only; run re-executors with Docker
 * available before replaying functions from agents you do not trust.
 */
export function runDeterministicFunction(
  functionSource: string,
  input: unknown
): { outputHash: string; output: unknown; engine: string } {
  if (hasDocker()) {
    return runInDocker(functionSource, input);
  }
  return runInVm(functionSource, input);
}

function runInVm(functionSource: string, input: unknown) {
  // Input goes in, and the result comes out, as JSON text: nothing from the
  // host realm (not even the input object's prototype chain) is reachable
  // from inside the context, and the context gets its own JSON/Math.
  const sandbox: Record<string, unknown> = { __inputJson: JSON.stringify(input), __resultJson: undefined };
  const context = vm.createContext(sandbox, {
    name: "verity-replay-sandbox",
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(
    `__resultJson = JSON.stringify((function(input){ ${functionSource}\n})(JSON.parse(__inputJson)));`,
    { filename: "replay-function.js" }
  );
  script.runInContext(context, { timeout: 3000 });
  const resultJson = sandbox.__resultJson;
  const output = typeof resultJson === "string" ? JSON.parse(resultJson) : null;
  return { outputHash: canonicalHash(output), output, engine: "node:vm (no Docker available — development only)" };
}

function runInDocker(functionSource: string, input: unknown) {
  const wrapped = `const input = ${JSON.stringify(input)}; const fn = (function(input){${functionSource}\n}); console.log(JSON.stringify(fn(input) ?? null));`;
  const out = execFileSync(
    "docker",
    ["run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL", "--memory=256m", "--cpus=0.5", "--pids-limit=64", "node:22-slim", "node", "-e", wrapped],
    { timeout: 15000 }
  ).toString();
  const output = JSON.parse(out.trim());
  return { outputHash: canonicalHash(output), output, engine: "docker (--network=none, resource-capped)" };
}

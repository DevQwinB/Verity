import { createHash } from "node:crypto";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Real, sandboxed re-execution of a deterministic task's declared function
 * against its declared input, then a real sha256 of the canonical output —
 * never a fabricated match/mismatch. Prefers a real Docker container
 * (--network=none, resource-capped) when Docker is present; this machine
 * has no Docker installed, so it documents and falls back to a Node `vm`
 * context with no network/require access and a hard timeout instead of
 * silently no-op'ing.
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

function canonicalHash(output: unknown): string {
  return createHash("sha256").update(JSON.stringify(output)).digest("hex");
}

function runInVm(functionSource: string, input: unknown) {
  const sandbox: Record<string, unknown> = { __input: input, __result: undefined, JSON, Math };
  const context = vm.createContext(sandbox, { name: "verity-replay-sandbox" });
  const script = new vm.Script(`__result = (function(input){ ${functionSource} })(__input);`, {
    filename: "replay-function.js",
  });
  script.runInContext(context, { timeout: 3000 });
  const output = sandbox.__result;
  return { outputHash: canonicalHash(output), output, engine: "node:vm (no Docker available in this environment)" };
}

function runInDocker(functionSource: string, input: unknown) {
  const wrapped = `const input = ${JSON.stringify(input)}; const fn = (${functionSource ? `function(input){${functionSource}}` : "function(){}"}); console.log(JSON.stringify(fn(input)));`;
  const out = execFileSync(
    "docker",
    ["run", "--rm", "--network=none", "--memory=256m", "--cpus=0.5", "node:20-slim", "node", "-e", wrapped],
    { timeout: 15000 }
  ).toString();
  const output = JSON.parse(out.trim());
  return { outputHash: canonicalHash(output), output, engine: "docker (--network=none, resource-capped)" };
}

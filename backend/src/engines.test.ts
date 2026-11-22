import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// The workspace requires Node 22.6+: the frontend test script runs
// `node --experimental-strip-types --test`, and that flag only exists from
// 22.6.0. engines, .nvmrc and the docs must all agree on the same floor.
const repoRoot = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")) as {
  engines: { node: string };
};
const readme = readFileSync(new URL("README.md", repoRoot), "utf8");
const contributing = readFileSync(new URL("CONTRIBUTING.md", repoRoot), "utf8");
const nvmrc = readFileSync(new URL(".nvmrc", repoRoot), "utf8").trim();
const npmrc = readFileSync(new URL(".npmrc", repoRoot), "utf8");

test("engines.node requires Node >= 22.6", () => {
  assert.equal(pkg.engines.node, ">=22.6");
});

test("running Node satisfies the engines floor", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(
    major > 22 || (major === 22 && minor >= 6),
    `tests must run on Node >= 22.6, got ${process.versions.node}`
  );
});

test(".nvmrc pins the same Node floor", () => {
  assert.match(nvmrc, /^22\.(6|\d{2,})/, `.nvmrc must pin Node 22.6+, got ${nvmrc}`);
});

test("install refuses older Node via engine-strict", () => {
  assert.match(npmrc, /engine-strict\s*=\s*true/);
});

test("docs require Node 22.6+ and no longer advertise Node 20", () => {
  assert.match(readme, /Node 22\.6\+/);
  assert.doesNotMatch(readme, /Node 20\+/);
  assert.match(contributing, /22\.6\+/);
  assert.doesNotMatch(contributing, /20\+ \(CI uses 22\)/);
});

test("CI and Docker images already build on Node 22", () => {
  const ci = readFileSync(new URL(".github/workflows/ci.yml", repoRoot), "utf8");
  assert.match(ci, /node-version:\s*22/);
  for (const dockerfile of ["frontend/Dockerfile", "backend/Dockerfile", "reexecutor-agent/Dockerfile"]) {
    const text = readFileSync(new URL(dockerfile, repoRoot), "utf8");
    assert.match(text, /FROM node:22(-alpine)?/, `${dockerfile} must use node:22`);
  }
});

// Repo-wide sweep: no markdown doc or workspace manifest may still advertise
// a Node floor below 22.6.
function walk(dir: URL, out: URL[] = []): URL[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
}

test("no doc or manifest in the repo still requires only Node 20", () => {
  const staleDoc = /node(?:\.js)?\s*20\s*\+|node\s*>=?\s*20\b|"node"\s*:\s*">=\s*20(?:\.0+)?"/i;
  const files = walk(repoRoot);
  const offenders: string[] = [];
  for (const file of files) {
    const name = file.pathname;
    if (name.endsWith("pnpm-lock.yaml") || name.includes("/engines.test.ts")) continue;
    if (name.endsWith(".md")) {
      const text = readFileSync(file, "utf8");
      if (staleDoc.test(text)) offenders.push(name);
    }
    if (name.endsWith("package.json")) {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as { engines?: { node?: string } };
      const floor = manifest.engines?.node;
      if (floor) {
        const m = floor.match(/>=\s*(\d+)(?:\.(\d+))?/);
        assert.ok(m, `${name}: unparseable engines.node ${floor}`);
        const [major, minor] = [Number(m[1]), Number(m[2] ?? 0)];
        assert.ok(
          major > 22 || (major === 22 && minor >= 6),
          `${name}: engines.node ${floor} is below the required >=22.6`
        );
      }
    }
  }
  assert.deepEqual(offenders, [], `stale Node 20 mentions in: ${offenders.join(", ")}`);
});

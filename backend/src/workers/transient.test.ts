import assert from "node:assert/strict";
import test from "node:test";
import { isTransientError } from "./transient.js";

test("network error codes are transient", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
    assert.ok(isTransientError(Object.assign(new Error("x"), { code })), code);
  }
});

test("postgres availability and serialization states are transient", () => {
  for (const code of ["08006", "08001", "40001", "40P01", "53300", "57P01", "57014"]) {
    assert.ok(isTransientError(Object.assign(new Error("x"), { code })), code);
  }
});

test("postgres data and constraint states are not transient", () => {
  for (const code of ["23505", "23502", "22P02", "42703", "22003"]) {
    assert.ok(!isTransientError(Object.assign(new Error("x"), { code })), code);
  }
});

test("HTTP 408, 429 and 5xx are transient; other 4xx are not", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.ok(isTransientError({ response: { status } }), String(status));
    assert.ok(isTransientError({ status }), String(status));
  }
  for (const status of [400, 401, 404, 422]) {
    assert.ok(!isTransientError({ response: { status } }), String(status));
  }
});

test("fetch failed is transient through its cause chain", () => {
  assert.ok(isTransientError(new TypeError("fetch failed")));
  const wrapped = new Error("rpc call failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
  assert.ok(isTransientError(wrapped));
});

test("an AggregateError is transient when any member is", () => {
  const agg = new AggregateError([new Error("bad"), Object.assign(new Error("x"), { code: "ECONNREFUSED" })]);
  assert.ok(isTransientError(agg));
});

test("deterministic failures are not transient", () => {
  assert.ok(!isTransientError(new Error("unexpected event shape")));
  assert.ok(!isTransientError(new RangeError("value out of range")));
  assert.ok(!isTransientError(null));
  assert.ok(!isTransientError("string"));
});

test("a cyclic cause chain terminates", () => {
  const a: { cause?: unknown } = {};
  a.cause = a;
  assert.ok(!isTransientError(a));
});

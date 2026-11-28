import test from "node:test";
import assert from "node:assert/strict";
import { backoffMs, shouldRetry, MAX_DELIVERY_ATTEMPTS } from "./retry-policy.js";

test("backoffMs follows exponential schedule capped at 8 attempts", () => {
  // 1m, 2m, 4m, 8m, 16m, 32m, 64m, 128m
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(3), 240_000);
  assert.equal(backoffMs(4), 480_000);
  assert.equal(backoffMs(5), 960_000);
  assert.equal(backoffMs(6), 1_920_000);
  assert.equal(backoffMs(7), 3_840_000);
  assert.equal(backoffMs(8), 7_680_000);

  // Capped at 8
  assert.equal(backoffMs(9), 7_680_000);
  assert.equal(backoffMs(100), 7_680_000);
});

test("shouldRetry returns true for network errors (null status)", () => {
  assert.equal(shouldRetry(null), true);
});

test("shouldRetry returns false for 2xx success", () => {
  assert.equal(shouldRetry(200), false);
  assert.equal(shouldRetry(201), false);
  assert.equal(shouldRetry(204), false);
});

test("shouldRetry returns false for 3xx redirects", () => {
  assert.equal(shouldRetry(301), false);
  assert.equal(shouldRetry(302), false);
  assert.equal(shouldRetry(307), false);
});

test("shouldRetry returns true for 408 and 429", () => {
  assert.equal(shouldRetry(408), true);
  assert.equal(shouldRetry(429), true);
});

test("shouldRetry returns false for other 4xx", () => {
  assert.equal(shouldRetry(400), false);
  assert.equal(shouldRetry(401), false);
  assert.equal(shouldRetry(403), false);
  assert.equal(shouldRetry(404), false);
  assert.equal(shouldRetry(418), false);
  assert.equal(shouldRetry(499), false);
});

test("shouldRetry returns true for 5xx", () => {
  assert.equal(shouldRetry(500), true);
  assert.equal(shouldRetry(502), true);
  assert.equal(shouldRetry(503), true);
  assert.equal(shouldRetry(504), true);
  assert.equal(shouldRetry(599), true);
});

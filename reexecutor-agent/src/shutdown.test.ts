import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

process.env.NODE_ENV = "test";
process.env.ESCROW_GATE_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
process.env.REEXECUTOR_SECRET_KEY = Keypair.random().secret();

const { stopping } = await import("./index.js");

describe("graceful shutdown signal controller", () => {
  it("initializes without being aborted", () => {
    assert.equal(stopping.signal.aborted, false);
  });

  it("aborts when abort() is invoked", () => {
    const controller = new AbortController();
    assert.equal(controller.signal.aborted, false);
    controller.abort();
    assert.equal(controller.signal.aborted, true);
  });

  it("simulates graceful loop exit with in-flight assignment", async () => {
    const testStopping = new AbortController();
    let inFlightDone = false;
    let assignmentSkipped = false;

    // Simulate in-flight assignment taking 100ms
    const assignmentPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        inFlightDone = true;
        resolve();
      }, 100);
    });

    // Abort after 20ms while assignment is in-flight
    setTimeout(() => {
      testStopping.abort();
    }, 20);

    // Simulate worker shutdown wait
    if (testStopping.signal.aborted) {
      assignmentSkipped = true;
    }

    await assignmentPromise;
    assert.equal(inFlightDone, true);
    assert.equal(testStopping.signal.aborted, true);
  });
});

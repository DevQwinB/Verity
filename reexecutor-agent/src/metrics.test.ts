import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeHealth, MetricsRegistry } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("renders valid Prometheus text for counters, gauges, and histograms", () => {
    const reg = new MetricsRegistry();
    reg.registerCounter("verity_reexecutor_polls_total", "Total poll attempts");
    reg.registerGauge("verity_reexecutor_assignments_pending", "Pending assignments count");
    reg.registerHistogram("verity_reexecutor_replay_duration_seconds", "Replay duration in seconds", [0.1, 1, 5]);

    reg.incCounter("verity_reexecutor_polls_total", { result: "ok" });
    reg.incCounter("verity_reexecutor_polls_total", { result: "error" }, 2);
    reg.setGauge("verity_reexecutor_assignments_pending", 3);
    reg.observeHistogram("verity_reexecutor_replay_duration_seconds", 0.5, { task_type: "deterministic" });

    const output = reg.render();

    assert(output.includes("# HELP verity_reexecutor_polls_total Total poll attempts"));
    assert(output.includes("# TYPE verity_reexecutor_polls_total counter"));
    assert(output.includes('verity_reexecutor_polls_total{result="ok"} 1'));
    assert(output.includes('verity_reexecutor_polls_total{result="error"} 2'));

    assert(output.includes("# HELP verity_reexecutor_assignments_pending Pending assignments count"));
    assert(output.includes("# TYPE verity_reexecutor_assignments_pending gauge"));
    assert(output.includes("verity_reexecutor_assignments_pending 3"));

    assert(output.includes("# HELP verity_reexecutor_replay_duration_seconds Replay duration in seconds"));
    assert(output.includes("# TYPE verity_reexecutor_replay_duration_seconds histogram"));
    assert(output.includes('verity_reexecutor_replay_duration_seconds_bucket{task_type="deterministic",le="0.1"} 0'));
    assert(output.includes('verity_reexecutor_replay_duration_seconds_bucket{task_type="deterministic",le="1"} 1'));
    assert(output.includes('verity_reexecutor_replay_duration_seconds_bucket{task_type="deterministic",le="5"} 1'));
    assert(output.includes('verity_reexecutor_replay_duration_seconds_bucket{task_type="deterministic",le="+Inf"} 1'));
    assert(output.includes('verity_reexecutor_replay_duration_seconds_sum{task_type="deterministic"} 0.5'));
    assert(output.includes('verity_reexecutor_replay_duration_seconds_count{task_type="deterministic"} 1'));
  });

  it("escapes label values correctly in Prometheus output", () => {
    const reg = new MetricsRegistry();
    reg.registerCounter("test_metric", "test");
    reg.incCounter("test_metric", { msg: 'line1\nline2 and "quotes" and \\backslashes\\' });

    const output = reg.render();
    assert(output.includes('test_metric{msg="line1\\nline2 and \\"quotes\\" and \\\\backslashes\\\\"} 1'));
  });
});

describe("computeHealth", () => {
  it("returns 200 when last poll was recent within 3x interval", () => {
    const now = 100_000;
    const res = computeHealth(
      {
        lastPollOkAt: 95_000,
        pollIntervalMs: 3_000, // threshold 9_000 -> 91_000
        votingBlockedUntil: 0,
        heartbeatFailing: false,
      },
      now
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.healthy, true);
  });

  it("returns 503 when last poll is older than 3x interval", () => {
    const now = 100_000;
    const res = computeHealth(
      {
        lastPollOkAt: 85_000, // 15s ago, > 9s
        pollIntervalMs: 3_000,
        votingBlockedUntil: 0,
        heartbeatFailing: false,
      },
      now
    );
    assert.equal(res.status, 503);
    assert.equal(res.body.healthy, false);
  });

  it("returns 503 when no poll has completed yet", () => {
    const now = 100_000;
    const res = computeHealth(
      {
        lastPollOkAt: null,
        pollIntervalMs: 3_000,
        votingBlockedUntil: 0,
        heartbeatFailing: false,
      },
      now
    );
    assert.equal(res.status, 503);
    assert.equal(res.body.healthy, false);
  });
});

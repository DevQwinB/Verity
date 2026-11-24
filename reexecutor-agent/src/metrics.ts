import http from "node:http";

interface MetricValue {
  labels: Record<string, string>;
  value: number;
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface HistogramValue {
  labels: Record<string, string>;
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

export class MetricsRegistry {
  private counters = new Map<string, { help: string; values: MetricValue[] }>();
  private gauges = new Map<string, { help: string; values: MetricValue[] }>();
  private histograms = new Map<
    string,
    { help: string; buckets: number[]; values: HistogramValue[] }
  >();

  registerCounter(name: string, help: string) {
    this.counters.set(name, { help, values: [] });
  }

  registerGauge(name: string, help: string) {
    this.gauges.set(name, { help, values: [] });
  }

  registerHistogram(name: string, help: string, buckets: number[] = [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 20, 30]) {
    this.histograms.set(name, { help, buckets: [...buckets].sort((a, b) => a - b), values: [] });
  }

  incCounter(name: string, labels: Record<string, string> = {}, amount: number = 1) {
    const entry = this.counters.get(name);
    if (!entry) return;
    let val = entry.values.find((v) => labelsMatch(v.labels, labels));
    if (!val) {
      val = { labels, value: 0 };
      entry.values.push(val);
    }
    val.value += amount;
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}) {
    const entry = this.gauges.get(name);
    if (!entry) return;
    let val = entry.values.find((v) => labelsMatch(v.labels, labels));
    if (!val) {
      val = { labels, value: 0 };
      entry.values.push(val);
    }
    val.value = value;
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}) {
    const entry = this.histograms.get(name);
    if (!entry) return;
    let val = entry.values.find((v) => labelsMatch(v.labels, labels));
    if (!val) {
      val = {
        labels,
        buckets: entry.buckets.map((b) => ({ le: b, count: 0 })),
        sum: 0,
        count: 0,
      };
      entry.values.push(val);
    }
    val.count++;
    val.sum += value;
    for (const b of val.buckets) {
      if (value <= b.le) {
        b.count++;
      }
    }
  }

  render(): string {
    const lines: string[] = [];

    // Render counters
    for (const [name, entry] of this.counters) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const v of entry.values) {
        lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
      }
    }

    // Render gauges
    for (const [name, entry] of this.gauges) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const v of entry.values) {
        lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
      }
    }

    // Render histograms
    for (const [name, entry] of this.histograms) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const v of entry.values) {
        for (const b of v.buckets) {
          lines.push(`${name}_bucket${formatLabels({ ...v.labels, le: String(b.le) })} ${b.count}`);
        }
        lines.push(`${name}_bucket${formatLabels({ ...v.labels, le: "+Inf" })} ${v.count}`);
        lines.push(`${name}_sum${formatLabels(v.labels)} ${v.sum}`);
        lines.push(`${name}_count${formatLabels(v.labels)} ${v.count}`);
      }
    }

    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }
}

function labelsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

function escapeLabelValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  const pairs = keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`);
  return `{${pairs.join(",")}}`;
}

export interface HealthState {
  lastPollOkAt: number | null;
  pollIntervalMs: number;
  votingBlockedUntil: number;
  heartbeatFailing: boolean;
}

export function computeHealth(state: HealthState, now: number = Date.now()): {
  status: number;
  body: Record<string, unknown>;
} {
  const thresholdMs = 3 * state.pollIntervalMs;
  const pollOk =
    state.lastPollOkAt !== null && now - state.lastPollOkAt <= thresholdMs;
  const healthy = pollOk;

  return {
    status: healthy ? 200 : 503,
    body: {
      healthy,
      last_poll_ok_at: state.lastPollOkAt ? new Date(state.lastPollOkAt).toISOString() : null,
      poll_lag_seconds: state.lastPollOkAt ? Math.round((now - state.lastPollOkAt) / 1000) : null,
      voting_blocked_until: state.votingBlockedUntil > now ? new Date(state.votingBlockedUntil).toISOString() : null,
      heartbeat_failing: state.heartbeatFailing,
    },
  };
}

export function startMetricsServer(
  port: number,
  host: string = "127.0.0.1",
  getHealthState: () => HealthState,
  registry: MetricsRegistry
): { server: http.Server; stop: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0];
    if (url === "/healthz") {
      const { status, body } = computeHealth(getHealthState());
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (url === "/metrics") {
      const text = registry.render();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(text);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found\n");
  });

  server.listen(port, host);

  return {
    server,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

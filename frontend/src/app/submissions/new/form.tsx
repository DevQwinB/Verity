"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../components/wallet-provider";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { uploadArtifact, createSubmission, relaySubmission } from "../../../lib/client-api";
import { signXdr } from "../../../lib/wallet";
import { NETWORK_PASSPHRASE } from "../../../lib/config";
import { canonicalJson, parseJsonOrText } from "../../../lib/canonical";
import { bpsToPercent, formatDuration, stroopsToXlm, xlmToStroops } from "../../../lib/format";
import type { GateConfig, TaskType } from "../../../lib/types";

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

type Step = "idle" | "uploading" | "building" | "signing" | "relaying" | "done" | "error";

/** `config` is the contract's live rule set, so the bond floor and the
 * window shown here are the ones EscrowGate will actually apply. */
export function NewSubmissionForm({ config }: { config: GateConfig }) {
  const router = useRouter();
  const { account, connecting, login } = useWallet();
  // One key for this form: retrying after a declined signature reuses the
  // same draft instead of leaving a new unsigned one behind each time.
  const idempotencyKey = useRef<string | null>(null);

  const [escrowRef, setEscrowRef] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("deterministic");
  const [escrowValueXlm, setEscrowValueXlm] = useState("100");
  const [bondXlm, setBondXlm] = useState("5");
  const [inputContent, setInputContent] = useState("");
  const [functionContent, setFunctionContent] = useState("");
  const [outputContent, setOutputContent] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);

  const escrowValue = xlmToStroops(escrowValueXlm);
  const minBond =
    escrowValue === null ? null : (escrowValue * BigInt(config.agent_bond_min_bps)) / BigInt(10_000);
  const windowS =
    escrowValue !== null && escrowValue >= BigInt(config.window_tier_small_ceiling)
      ? config.window_tier_large_s
      : config.window_tier_small_s;

  /** Amounts are checked here, in words, before anything is uploaded or a
   * wallet prompt appears. */
  function prepareAmounts(): { escrowValue: string; bond: string } {
    if (escrowValue === null) {
      throw new Error("Enter the escrow value as a positive XLM amount, for example 100.");
    }
    const bond = xlmToStroops(bondXlm);
    if (bond === null) {
      throw new Error("Enter the bond as a positive XLM amount, for example 5.");
    }
    if (minBond !== null && bond < minBond) {
      throw new Error(
        `The bond must be at least ${stroopsToXlm(minBond.toString())} XLM: ${bpsToPercent(config.agent_bond_min_bps)} of the escrow value.`
      );
    }
    return { escrowValue: escrowValue.toString(), bond: bond.toString() };
  }

  /** Re-executors parse the input as JSON and hash their output in
   * canonical JSON, so both are normalised here before they are hashed —
   * otherwise a stray space or a different key order reads as a mismatch
   * and costs the agent their bond. */
  function prepareArtifacts(): { input: string; output: string } {
    let inputValue: unknown;
    try {
      inputValue = JSON.parse(inputContent);
    } catch {
      throw new Error(
        taskType === "retrieval"
          ? 'The request spec must be valid JSON, e.g. {"url": "https://...", "pointer": "/field"}.'
          : "The input must be valid JSON. It is passed to your function as `input`."
      );
    }
    if (taskType === "retrieval") {
      const url = (inputValue as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        throw new Error('The request spec needs a "url" starting with http:// or https://.');
      }
    }
    if (taskType === "deterministic" && !functionContent.trim()) {
      throw new Error("A deterministic task needs the function re-executors will replay.");
    }
    return { input: canonicalJson(inputValue), output: canonicalJson(parseJsonOrText(outputContent)) };
  }

  async function handleSubmit() {
    if (!account) return;
    setError(null);
    try {
      const amounts = prepareAmounts();
      const artifacts = prepareArtifacts();
      setStep("uploading");
      const input = await uploadArtifact(textToBase64(artifacts.input), "application/json");
      const output = await uploadArtifact(textToBase64(artifacts.output), "application/json");
      const fn =
        taskType === "deterministic"
          ? await uploadArtifact(textToBase64(functionContent), "text/javascript")
          : null;

      setStep("building");
      const { submission, unsigned_transaction_xdr } = await createSubmission({
        escrow_ref: escrowRef,
        task_type: taskType,
        input_hash: input.content_hash,
        input_ref: input.storage_ref,
        claimed_output_hash: output.content_hash,
        claimed_output_ref: output.storage_ref,
        function_hash: fn?.content_hash,
        function_ref: fn?.storage_ref,
        escrow_value: amounts.escrowValue,
        bond_amount: amounts.bond,
        idempotency_key: (idempotencyKey.current ??= crypto.randomUUID()),
      });
      if (unsigned_transaction_xdr === null) {
        // This draft already reached the chain on an earlier attempt.
        router.push(`/submissions/${submission.id}`);
        return;
      }

      setStep("signing");
      const signed = await signXdr(unsigned_transaction_xdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: account,
      });

      setStep("relaying");
      await relaySubmission(submission.id, signed);
      setStep("done");
      router.push(`/submissions/${submission.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
      setStep("error");
    }
  }

  const busy = step !== "idle" && step !== "error";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New submission</h1>
        <p className="mt-1 max-w-prose text-sm text-text-secondary">
          Submits a real, signed transaction to EscrowGate on Stellar testnet and locks your bond
          there. A deterministic task is replayed by a quorum of re-executors; a retrieval task is
          spot-checked by one, and escalated to a quorum if that check fails.
        </p>
      </div>

      <Card>
        <CardHeader>
          <span className="font-medium">Task details</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Escrow reference">
            <input
              value={escrowRef}
              onChange={(e) => setEscrowRef(e.target.value)}
              placeholder="bounty-platform-order-id"
              className={inputClass}
            />
          </Field>

          <Field label="Task type">
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskType)}
              className={inputClass}
            >
              <option value="deterministic">Deterministic (replay-verified)</option>
              <option value="retrieval">Retrieval (spot-checked)</option>
            </select>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Escrow value (XLM)"
              helper={`What the work is worth to the marketplace. Sets the bond floor and the challenge window: ${formatDuration(windowS)} at this value.`}
            >
              <input
                inputMode="decimal"
                value={escrowValueXlm}
                onChange={(e) => setEscrowValueXlm(e.target.value)}
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field
              label="Agent bond (XLM)"
              helper={
                minBond === null
                  ? `At least ${bpsToPercent(config.agent_bond_min_bps)} of the escrow value. Forfeited if the work is found wrong.`
                  : `At least ${stroopsToXlm(minBond.toString())} XLM (${bpsToPercent(config.agent_bond_min_bps)} of the escrow value). Returned if verified, forfeited if the work is found wrong.`
              }
            >
              <input
                inputMode="decimal"
                value={bondXlm}
                onChange={(e) => setBondXlm(e.target.value)}
                className={`${inputClass} font-mono`}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span className="font-medium">Content-addressed artifacts</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field
            label={taskType === "retrieval" ? "Request spec (JSON)" : "Input (JSON)"}
            helper={
              taskType === "retrieval"
                ? "The public URL you fetched, plus an optional JSON pointer to the value you extracted. A sampled re-executor re-fetches it."
                : "Passed to your function as `input`."
            }
          >
            <textarea
              value={inputContent}
              onChange={(e) => setInputContent(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={
                taskType === "retrieval"
                  ? '{"url": "https://horizon-testnet.stellar.org/", "pointer": "/network_passphrase"}'
                  : '{"n": 21}'
              }
              className={cnMono}
            />
          </Field>
          {taskType === "deterministic" && (
            <Field
              label="Function body (JavaScript)"
              helper="The body of a pure function of `input` that returns the result. Re-executors run this exact artifact in a WebAssembly sandbox with no network, files or clock: `Date` and `Math.random` do not exist there, and compute and memory are capped. A function that throws or exceeds the limits counts as a mismatch."
            >
              <textarea
                value={functionContent}
                onChange={(e) => setFunctionContent(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder="return { doubled: input.n * 2 };"
                className={cnMono}
              />
            </Field>
          )}
          <Field
            label="Claimed output"
            helper="JSON or plain text. Normalised to canonical JSON before hashing, so key order and whitespace do not matter."
          >
            <textarea
              value={outputContent}
              onChange={(e) => setOutputContent(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={taskType === "retrieval" ? "Test SDF Network ; September 2015" : '{"doubled": 42}'}
              className={cnMono}
            />
          </Field>
        </CardBody>
      </Card>

      {error && (
        <p role="alert" className="text-sm text-status-slashed">
          {error}
        </p>
      )}

      {account ? (
        <Button onClick={handleSubmit} disabled={busy || !escrowRef || !inputContent || !outputContent}>
          {step === "uploading"
            ? "Uploading artifacts..."
            : step === "building"
              ? "Building transaction..."
              : step === "signing"
                ? "Awaiting signature in Freighter..."
                : step === "relaying"
                  ? "Submitting to testnet..."
                  : step === "done"
                    ? "Confirmed. Opening the submission..."
                    : "Submit for verification"}
        </Button>
      ) : (
        <Button onClick={login} disabled={connecting}>
          {connecting ? "Connecting..." : "Connect wallet to continue"}
        </Button>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent";
const cnMono = `${inputClass} font-mono text-xs`;

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  // A wrapping <label> ties the caption to the control without threading ids
  // through every call site; the helper is linked for screen readers.
  const helperId = useId();
  return (
    <label className="block space-y-2" aria-describedby={helper ? helperId : undefined}>
      <span className="block text-sm text-text-secondary">{label}</span>
      {children}
      {helper && (
        <span id={helperId} className="block max-w-[65ch] text-xs text-text-tertiary">
          {helper}
        </span>
      )}
    </label>
  );
}

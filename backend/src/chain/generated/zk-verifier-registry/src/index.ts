import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDYK2EZ4PKL3X5XMORKFGDFQD5V4ITXBW2T224AYS33FB3VSTNZP55CL",
  }
} as const




export type Verdict = {tag: "Pending", values: void} | {tag: "Verified", values: void} | {tag: "Disputed", values: void} | {tag: "Slashed", values: void} | {tag: "ExpiredUnverified", values: void};

/**
 * The shape of task a submission claims to have completed.
 * `Unverifiable` exists so a marketplace can still route a submission through
 * EscrowGate for record-keeping even when it cannot be replayed or spot-checked;
 * such a submission can only ever resolve via ManualReview off-chain and never
 * auto-verifies on-chain (see EscrowGate::submit).
 */
export type TaskType = {tag: "Deterministic", values: void} | {tag: "Retrieval", values: void} | {tag: "Unverifiable", values: void};

export type Resolution = {tag: "None", values: void} | {tag: "Upheld", values: void} | {tag: "Rejected", values: void};


export interface ConfigRecord {
  /**
 * Minimum agent bond as bps of escrow_value, e.g. 500 = 5%.
 */
agent_bond_min_bps: u32;
  /**
 * Minimum challenger bond as bps of escrow_value.
 */
challenger_bond_min_bps: u32;
  min_stake_floor: i128;
  quorum_min_reexecutors: u32;
  /**
 * Basis points, must be in [5100, 10000] — bounds enforced at update_config time.
 */
quorum_supermajority_bps: u32;
  /**
 * Share of a slashed amount that goes to the prevailing challenger; the
 * remainder is distributed to correctly-voting re-executors. Fixed in
 * practice — treated as effectively immutable governance, not a per-dispute lever.
 */
slash_split_challenger_bps: u32;
  window_tier_large_s: u64;
  /**
 * escrow_value strictly below this uses the "small" window tier.
 */
window_tier_small_ceiling: i128;
  window_tier_small_s: u64;
}


export interface ReexecutorInfo {
  active: boolean;
  joined_at: u64;
  /**
 * Count of attestations this reexecutor has made on submissions that are
 * not yet finalized/resolved. Stake cannot be withdrawn below
 * min_stake_floor while this is nonzero — see EscrowGate::withdraw_stake
 * and EscrowGate::release_attestation_lock.
 */
open_attestations: u32;
  stake_amount: i128;
}


export interface ChallengeRecord {
  bond: i128;
  challenger: string;
  opened_at: u64;
  resolution: Resolution;
  resolution_method: ResolutionMethod;
}

/**
 * `ManualReview` is deliberately NOT a variant here. On-chain resolution must be
 * derivable from already-committed state (attestation tallies or a registered
 * ZK verifier's boolean result) with zero admin-discretionary paths. A
 * marketplace's own manual-review process for withdrawn/unresolvable challenges
 * is an off-chain/Postgres-only concept.
 * 
 * `None` (rather than wrapping this in `Option<ResolutionMethod>` on the
 * containing structs) is a deliberate soroban-sdk contracttype workaround:
 * `Option<CustomEnum>` fields fail to derive their ScVal conversion in
 * soroban-sdk 27's #[contracttype] macro for simple (data-less) enums, so a
 * dedicated `None` variant is used as the "not yet set" sentinel instead.
 */
export type ResolutionMethod = {tag: "None", values: void} | {tag: "ReexecutionConsensus", values: void} | {tag: "ZkProof", values: void};


export interface SubmissionRecord {
  agent: string;
  bond_amount: i128;
  bonded_weight_matched: i128;
  bonded_weight_mismatched: i128;
  cfg_challenger_bond_min_bps: u32;
  cfg_quorum_min_reexecutors: u32;
  cfg_quorum_supermajority_bps: u32;
  cfg_slash_split_challenger_bps: u32;
  challenge_window_s: u64;
  claimed_output_hash: Buffer;
  escrow_ref: Buffer;
  escrow_value: i128;
  finalized: boolean;
  id: u64;
  input_hash: Buffer;
  match_votes: u32;
  mismatch_votes: u32;
  resolution_method: ResolutionMethod;
  submitted_at: u64;
  task_type: TaskType;
  verdict: Verdict;
}

export const Errors = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  3: {message:"NotAdmin"},
  4: {message:"InvalidConfig"},
  5: {message:"Overflow"},
  6: {message:"InvalidAmount"},
  10: {message:"SubmissionNotFound"},
  11: {message:"BondTooLow"},
  12: {message:"InvalidTaskType"},
  13: {message:"InvalidEscrowValue"},
  20: {message:"ReexecutorNotActive"},
  21: {message:"StakeBelowFloor"},
  22: {message:"StakeLockedByOpenAttestation"},
  23: {message:"AlreadyAttested"},
  24: {message:"ReexecutorAlreadyRegistered"},
  25: {message:"AttestationAlreadyReleased"},
  26: {message:"SubmissionNotFinalized"},
  30: {message:"ChallengeAlreadyOpen"},
  31: {message:"ChallengeNotFound"},
  32: {message:"ChallengeWindowClosed"},
  33: {message:"ChallengeWindowNotElapsed"},
  34: {message:"NoUnresolvedChallenge"},
  35: {message:"ChallengeAlreadyResolved"},
  40: {message:"NotUpheldResolution"},
  41: {message:"AlreadySlashed"},
  42: {message:"PartyNotOnWrongSide"},
  44: {message:"InsufficientConsensus"},
  45: {message:"InvalidResolutionMethod"},
  50: {message:"VerifierNotRegistered"},
  51: {message:"VerifierAlreadyRegistered"},
  52: {message:"ProofRejected"}
}

export interface Client {
  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  initialize: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a verify_proof transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * There is no code path here that returns `true` for an unregistered
   * proof system, for any input, including empty/garbage/malformed proof
   * bytes, or bytes valid for a different registered system — this is the
   * concrete mechanism behind invariant 4. If registered (Phase 2 only,
   * never true in this deployment — see list_verifiers), this performs a
   * real cross-contract call into the registered verifier and returns its
   * boolean unmodified; the registry never fabricates a result itself.
   */
  verify_proof: ({proof_system, submission_id, proof}: {proof_system: string, submission_id: u64, proof: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a is_registered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_registered: ({proof_system}: {proof_system: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a list_verifiers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  list_verifiers: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a register_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Additive-only, admin-gated capability grant: which proof systems
   * *exist*, never a per-dispute verdict override (that authority lives
   * entirely in EscrowGate and never touches this contract's admin).
   */
  register_verifier: ({admin, proof_system, verifier_contract}: {admin: string, proof_system: string, verifier_contract: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a deregister_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lets a compromised or retired verifier be pulled without ever adding an
   * implicit accept path elsewhere in verify_proof.
   */
  deregister_verifier: ({admin, proof_system}: {admin: string, proof_system: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAAAAAAAKaW5pdGlhbGl6ZQAAAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAeNUaGVyZSBpcyBubyBjb2RlIHBhdGggaGVyZSB0aGF0IHJldHVybnMgYHRydWVgIGZvciBhbiB1bnJlZ2lzdGVyZWQKcHJvb2Ygc3lzdGVtLCBmb3IgYW55IGlucHV0LCBpbmNsdWRpbmcgZW1wdHkvZ2FyYmFnZS9tYWxmb3JtZWQgcHJvb2YKYnl0ZXMsIG9yIGJ5dGVzIHZhbGlkIGZvciBhIGRpZmZlcmVudCByZWdpc3RlcmVkIHN5c3RlbSDigJQgdGhpcyBpcyB0aGUKY29uY3JldGUgbWVjaGFuaXNtIGJlaGluZCBpbnZhcmlhbnQgNC4gSWYgcmVnaXN0ZXJlZCAoUGhhc2UgMiBvbmx5LApuZXZlciB0cnVlIGluIHRoaXMgZGVwbG95bWVudCDigJQgc2VlIGxpc3RfdmVyaWZpZXJzKSwgdGhpcyBwZXJmb3JtcyBhCnJlYWwgY3Jvc3MtY29udHJhY3QgY2FsbCBpbnRvIHRoZSByZWdpc3RlcmVkIHZlcmlmaWVyIGFuZCByZXR1cm5zIGl0cwpib29sZWFuIHVubW9kaWZpZWQ7IHRoZSByZWdpc3RyeSBuZXZlciBmYWJyaWNhdGVzIGEgcmVzdWx0IGl0c2VsZi4AAAAADHZlcmlmeV9wcm9vZgAAAAMAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAAAAAAVwcm9vZgAAAAAAAA4AAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAAAAAAAANaXNfcmVnaXN0ZXJlZAAAAAAAAAEAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAObGlzdF92ZXJpZmllcnMAAAAAAAAAAAABAAAD6gAAABE=",
        "AAAAAAAAAMVBZGRpdGl2ZS1vbmx5LCBhZG1pbi1nYXRlZCBjYXBhYmlsaXR5IGdyYW50OiB3aGljaCBwcm9vZiBzeXN0ZW1zCipleGlzdCosIG5ldmVyIGEgcGVyLWRpc3B1dGUgdmVyZGljdCBvdmVycmlkZSAodGhhdCBhdXRob3JpdHkgbGl2ZXMKZW50aXJlbHkgaW4gRXNjcm93R2F0ZSBhbmQgbmV2ZXIgdG91Y2hlcyB0aGlzIGNvbnRyYWN0J3MgYWRtaW4pLgAAAAAAABFyZWdpc3Rlcl92ZXJpZmllcgAAAAAAAAMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAMcHJvb2Zfc3lzdGVtAAAAEQAAAAAAAAARdmVyaWZpZXJfY29udHJhY3QAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHdMZXRzIGEgY29tcHJvbWlzZWQgb3IgcmV0aXJlZCB2ZXJpZmllciBiZSBwdWxsZWQgd2l0aG91dCBldmVyIGFkZGluZyBhbgppbXBsaWNpdCBhY2NlcHQgcGF0aCBlbHNld2hlcmUgaW4gdmVyaWZ5X3Byb29mLgAAAAATZGVyZWdpc3Rlcl92ZXJpZmllcgAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAADVByb29mVmVyaWZpZWQAAAAAAAABAAAADnByb29mX3ZlcmlmaWVkAAAAAAACAAAAAAAAAAxwcm9vZl9zeXN0ZW0AAAARAAAAAQAAAAAAAAANc3VibWlzc2lvbl9pZAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAElZlcmlmaWVyUmVnaXN0ZXJlZAAAAAAAAQAAABN2ZXJpZmllcl9yZWdpc3RlcmVkAAAAAAIAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAABAAAAAAAAABF2ZXJpZmllcl9jb250cmFjdAAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFZlcmlmaWVyRGVyZWdpc3RlcmVkAAAAAQAAABV2ZXJpZmllcl9kZXJlZ2lzdGVyZWQAAAAAAAABAAAAAAAAAAxwcm9vZl9zeXN0ZW0AAAARAAAAAQAAAAI=",
        "AAAAAgAAAAAAAAAAAAAAB1ZlcmRpY3QAAAAABQAAAAAAAAAAAAAAB1BlbmRpbmcAAAAAAAAAAAAAAAAIVmVyaWZpZWQAAAAAAAAAAAAAAAhEaXNwdXRlZAAAAAAAAAAAAAAAB1NsYXNoZWQAAAAAAAAAAAAAAAARRXhwaXJlZFVudmVyaWZpZWQAAAA=",
        "AAAAAgAAAVFUaGUgc2hhcGUgb2YgdGFzayBhIHN1Ym1pc3Npb24gY2xhaW1zIHRvIGhhdmUgY29tcGxldGVkLgpgVW52ZXJpZmlhYmxlYCBleGlzdHMgc28gYSBtYXJrZXRwbGFjZSBjYW4gc3RpbGwgcm91dGUgYSBzdWJtaXNzaW9uIHRocm91Z2gKRXNjcm93R2F0ZSBmb3IgcmVjb3JkLWtlZXBpbmcgZXZlbiB3aGVuIGl0IGNhbm5vdCBiZSByZXBsYXllZCBvciBzcG90LWNoZWNrZWQ7CnN1Y2ggYSBzdWJtaXNzaW9uIGNhbiBvbmx5IGV2ZXIgcmVzb2x2ZSB2aWEgTWFudWFsUmV2aWV3IG9mZi1jaGFpbiBhbmQgbmV2ZXIKYXV0by12ZXJpZmllcyBvbi1jaGFpbiAoc2VlIEVzY3Jvd0dhdGU6OnN1Ym1pdCkuAAAAAAAAAAAAAAhUYXNrVHlwZQAAAAMAAAAAAAAAAAAAAA1EZXRlcm1pbmlzdGljAAAAAAAAAAAAAAAAAAAJUmV0cmlldmFsAAAAAAAAAAAAAAAAAAAMVW52ZXJpZmlhYmxl",
        "AAAAAgAAAAAAAAAAAAAAClJlc29sdXRpb24AAAAAAAMAAAAAAAAAAAAAAAROb25lAAAAAAAAAAAAAAAGVXBoZWxkAAAAAAAAAAAAAAAAAAhSZWplY3RlZA==",
        "AAAAAQAAAAAAAAAAAAAADENvbmZpZ1JlY29yZAAAAAkAAAA5TWluaW11bSBhZ2VudCBib25kIGFzIGJwcyBvZiBlc2Nyb3dfdmFsdWUsIGUuZy4gNTAwID0gNSUuAAAAAAAAEmFnZW50X2JvbmRfbWluX2JwcwAAAAAABAAAAC9NaW5pbXVtIGNoYWxsZW5nZXIgYm9uZCBhcyBicHMgb2YgZXNjcm93X3ZhbHVlLgAAAAAXY2hhbGxlbmdlcl9ib25kX21pbl9icHMAAAAABAAAAAAAAAAPbWluX3N0YWtlX2Zsb29yAAAAAAsAAAAAAAAAFnF1b3J1bV9taW5fcmVleGVjdXRvcnMAAAAAAAQAAABRQmFzaXMgcG9pbnRzLCBtdXN0IGJlIGluIFs1MTAwLCAxMDAwMF0g4oCUIGJvdW5kcyBlbmZvcmNlZCBhdCB1cGRhdGVfY29uZmlnIHRpbWUuAAAAAAAAGHF1b3J1bV9zdXBlcm1ham9yaXR5X2JwcwAAAAQAAADcU2hhcmUgb2YgYSBzbGFzaGVkIGFtb3VudCB0aGF0IGdvZXMgdG8gdGhlIHByZXZhaWxpbmcgY2hhbGxlbmdlcjsgdGhlCnJlbWFpbmRlciBpcyBkaXN0cmlidXRlZCB0byBjb3JyZWN0bHktdm90aW5nIHJlLWV4ZWN1dG9ycy4gRml4ZWQgaW4KcHJhY3RpY2Ug4oCUIHRyZWF0ZWQgYXMgZWZmZWN0aXZlbHkgaW1tdXRhYmxlIGdvdmVybmFuY2UsIG5vdCBhIHBlci1kaXNwdXRlIGxldmVyLgAAABpzbGFzaF9zcGxpdF9jaGFsbGVuZ2VyX2JwcwAAAAAABAAAAAAAAAATd2luZG93X3RpZXJfbGFyZ2VfcwAAAAAGAAAAPmVzY3Jvd192YWx1ZSBzdHJpY3RseSBiZWxvdyB0aGlzIHVzZXMgdGhlICJzbWFsbCIgd2luZG93IHRpZXIuAAAAAAAZd2luZG93X3RpZXJfc21hbGxfY2VpbGluZwAAAAAAAAsAAAAAAAAAE3dpbmRvd190aWVyX3NtYWxsX3MAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAADlJlZXhlY3V0b3JJbmZvAAAAAAAEAAAAAAAAAAZhY3RpdmUAAAAAAAEAAAAAAAAACWpvaW5lZF9hdAAAAAAAAAYAAAD1Q291bnQgb2YgYXR0ZXN0YXRpb25zIHRoaXMgcmVleGVjdXRvciBoYXMgbWFkZSBvbiBzdWJtaXNzaW9ucyB0aGF0IGFyZQpub3QgeWV0IGZpbmFsaXplZC9yZXNvbHZlZC4gU3Rha2UgY2Fubm90IGJlIHdpdGhkcmF3biBiZWxvdwptaW5fc3Rha2VfZmxvb3Igd2hpbGUgdGhpcyBpcyBub256ZXJvIOKAlCBzZWUgRXNjcm93R2F0ZTo6d2l0aGRyYXdfc3Rha2UKYW5kIEVzY3Jvd0dhdGU6OnJlbGVhc2VfYXR0ZXN0YXRpb25fbG9jay4AAAAAAAARb3Blbl9hdHRlc3RhdGlvbnMAAAAAAAAEAAAAAAAAAAxzdGFrZV9hbW91bnQAAAAL",
        "AAAAAQAAAAAAAAAAAAAAD0NoYWxsZW5nZVJlY29yZAAAAAAFAAAAAAAAAARib25kAAAACwAAAAAAAAAKY2hhbGxlbmdlcgAAAAAAEwAAAAAAAAAJb3BlbmVkX2F0AAAAAAAABgAAAAAAAAAKcmVzb2x1dGlvbgAAAAAH0AAAAApSZXNvbHV0aW9uAAAAAAAAAAAAEXJlc29sdXRpb25fbWV0aG9kAAAAAAAH0AAAABBSZXNvbHV0aW9uTWV0aG9k",
        "AAAAAgAAArxgTWFudWFsUmV2aWV3YCBpcyBkZWxpYmVyYXRlbHkgTk9UIGEgdmFyaWFudCBoZXJlLiBPbi1jaGFpbiByZXNvbHV0aW9uIG11c3QgYmUKZGVyaXZhYmxlIGZyb20gYWxyZWFkeS1jb21taXR0ZWQgc3RhdGUgKGF0dGVzdGF0aW9uIHRhbGxpZXMgb3IgYSByZWdpc3RlcmVkClpLIHZlcmlmaWVyJ3MgYm9vbGVhbiByZXN1bHQpIHdpdGggemVybyBhZG1pbi1kaXNjcmV0aW9uYXJ5IHBhdGhzLiBBCm1hcmtldHBsYWNlJ3Mgb3duIG1hbnVhbC1yZXZpZXcgcHJvY2VzcyBmb3Igd2l0aGRyYXduL3VucmVzb2x2YWJsZSBjaGFsbGVuZ2VzCmlzIGFuIG9mZi1jaGFpbi9Qb3N0Z3Jlcy1vbmx5IGNvbmNlcHQuCgpgTm9uZWAgKHJhdGhlciB0aGFuIHdyYXBwaW5nIHRoaXMgaW4gYE9wdGlvbjxSZXNvbHV0aW9uTWV0aG9kPmAgb24gdGhlCmNvbnRhaW5pbmcgc3RydWN0cykgaXMgYSBkZWxpYmVyYXRlIHNvcm9iYW4tc2RrIGNvbnRyYWN0dHlwZSB3b3JrYXJvdW5kOgpgT3B0aW9uPEN1c3RvbUVudW0+YCBmaWVsZHMgZmFpbCB0byBkZXJpdmUgdGhlaXIgU2NWYWwgY29udmVyc2lvbiBpbgpzb3JvYmFuLXNkayAyNydzICNbY29udHJhY3R0eXBlXSBtYWNybyBmb3Igc2ltcGxlIChkYXRhLWxlc3MpIGVudW1zLCBzbyBhCmRlZGljYXRlZCBgTm9uZWAgdmFyaWFudCBpcyB1c2VkIGFzIHRoZSAibm90IHlldCBzZXQiIHNlbnRpbmVsIGluc3RlYWQuAAAAAAAAABBSZXNvbHV0aW9uTWV0aG9kAAAAAwAAAAAAAAAAAAAABE5vbmUAAAAAAAAAAAAAABRSZWV4ZWN1dGlvbkNvbnNlbnN1cwAAAAAAAAAAAAAAB1prUHJvb2YA",
        "AAAAAQAAAAAAAAAAAAAAEFN1Ym1pc3Npb25SZWNvcmQAAAAVAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAAC2JvbmRfYW1vdW50AAAAAAsAAAAAAAAAFWJvbmRlZF93ZWlnaHRfbWF0Y2hlZAAAAAAAAAsAAAAAAAAAGGJvbmRlZF93ZWlnaHRfbWlzbWF0Y2hlZAAAAAsAAAAAAAAAG2NmZ19jaGFsbGVuZ2VyX2JvbmRfbWluX2JwcwAAAAAEAAAAAAAAABpjZmdfcXVvcnVtX21pbl9yZWV4ZWN1dG9ycwAAAAAABAAAAAAAAAAcY2ZnX3F1b3J1bV9zdXBlcm1ham9yaXR5X2JwcwAAAAQAAAAAAAAAHmNmZ19zbGFzaF9zcGxpdF9jaGFsbGVuZ2VyX2JwcwAAAAAABAAAAAAAAAASY2hhbGxlbmdlX3dpbmRvd19zAAAAAAAGAAAAAAAAABNjbGFpbWVkX291dHB1dF9oYXNoAAAAA+4AAAAgAAAAAAAAAAplc2Nyb3dfcmVmAAAAAAPuAAAAIAAAAAAAAAAMZXNjcm93X3ZhbHVlAAAACwAAAAAAAAAJZmluYWxpemVkAAAAAAAAAQAAAAAAAAACaWQAAAAAAAYAAAAAAAAACmlucHV0X2hhc2gAAAAAA+4AAAAgAAAAAAAAAAttYXRjaF92b3RlcwAAAAAEAAAAAAAAAA5taXNtYXRjaF92b3RlcwAAAAAABAAAAAAAAAARcmVzb2x1dGlvbl9tZXRob2QAAAAAAAfQAAAAEFJlc29sdXRpb25NZXRob2QAAAAAAAAADHN1Ym1pdHRlZF9hdAAAAAYAAAAAAAAACXRhc2tfdHlwZQAAAAAAB9AAAAAIVGFza1R5cGUAAAAAAAAAB3ZlcmRpY3QAAAAH0AAAAAdWZXJkaWN0AA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAHwAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAAITm90QWRtaW4AAAADAAAAAAAAAA1JbnZhbGlkQ29uZmlnAAAAAAAABAAAAAAAAAAIT3ZlcmZsb3cAAAAFAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABgAAAAAAAAASU3VibWlzc2lvbk5vdEZvdW5kAAAAAAAKAAAAAAAAAApCb25kVG9vTG93AAAAAAALAAAAAAAAAA9JbnZhbGlkVGFza1R5cGUAAAAADAAAAAAAAAASSW52YWxpZEVzY3Jvd1ZhbHVlAAAAAAANAAAAAAAAABNSZWV4ZWN1dG9yTm90QWN0aXZlAAAAABQAAAAAAAAAD1N0YWtlQmVsb3dGbG9vcgAAAAAVAAAAAAAAABxTdGFrZUxvY2tlZEJ5T3BlbkF0dGVzdGF0aW9uAAAAFgAAAAAAAAAPQWxyZWFkeUF0dGVzdGVkAAAAABcAAAAAAAAAG1JlZXhlY3V0b3JBbHJlYWR5UmVnaXN0ZXJlZAAAAAAYAAAAAAAAABpBdHRlc3RhdGlvbkFscmVhZHlSZWxlYXNlZAAAAAAAGQAAAAAAAAAWU3VibWlzc2lvbk5vdEZpbmFsaXplZAAAAAAAGgAAAAAAAAAUQ2hhbGxlbmdlQWxyZWFkeU9wZW4AAAAeAAAAAAAAABFDaGFsbGVuZ2VOb3RGb3VuZAAAAAAAAB8AAAAAAAAAFUNoYWxsZW5nZVdpbmRvd0Nsb3NlZAAAAAAAACAAAAAAAAAAGUNoYWxsZW5nZVdpbmRvd05vdEVsYXBzZWQAAAAAAAAhAAAAAAAAABVOb1VucmVzb2x2ZWRDaGFsbGVuZ2UAAAAAAAAiAAAAAAAAABhDaGFsbGVuZ2VBbHJlYWR5UmVzb2x2ZWQAAAAjAAAAAAAAABNOb3RVcGhlbGRSZXNvbHV0aW9uAAAAACgAAAAAAAAADkFscmVhZHlTbGFzaGVkAAAAAAApAAAAAAAAABNQYXJ0eU5vdE9uV3JvbmdTaWRlAAAAACoAAAAAAAAAFUluc3VmZmljaWVudENvbnNlbnN1cwAAAAAAACwAAAAAAAAAF0ludmFsaWRSZXNvbHV0aW9uTWV0aG9kAAAAAC0AAAAAAAAAFVZlcmlmaWVyTm90UmVnaXN0ZXJlZAAAAAAAADIAAAAAAAAAGVZlcmlmaWVyQWxyZWFkeVJlZ2lzdGVyZWQAAAAAAAAzAAAAAAAAAA1Qcm9vZlJlamVjdGVkAAAAAAAANA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    initialize: this.txFromJSON<Result<void>>,
        verify_proof: this.txFromJSON<Result<boolean>>,
        is_registered: this.txFromJSON<boolean>,
        list_verifiers: this.txFromJSON<Array<string>>,
        register_verifier: this.txFromJSON<Result<void>>,
        deregister_verifier: this.txFromJSON<Result<void>>
  }
}
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
    contractId: "CDC642RZOEWWDS3GOF7QSPTMVUOYIZ5MDQ4EQQW27KG6XRILGGWR4F4G",
  }
} as const









export type DataKey = {tag: "Admin", values: void} | {tag: "BondAsset", values: void} | {tag: "ZkRegistry", values: void} | {tag: "Config", values: void} | {tag: "NextSubmissionId", values: void} | {tag: "Submission", values: readonly [u64]} | {tag: "ReplayAttestation", values: readonly [u64, string]} | {tag: "Challenge", values: readonly [u64]} | {tag: "Reexecutor", values: readonly [string]} | {tag: "Slashed", values: readonly [u64, string]} | {tag: "AttestationReleased", values: readonly [u64, string]};

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
   * Construct and simulate a slash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * keeper.require_auth() only proves the call is a signed transaction from
   * *some* account — it grants no special rights. Every other check derives
   * authority solely from already-committed on-chain state: the submission
   * must be finalized into a slashable terminal verdict, and the target
   * reexecutor's own recorded vote (stored at attest_replay time) must be
   * on the side that verdict proved wrong. There is no branch here, or
   * anywhere in this contract, where the admin/keeper address itself grants
   * extra power (invariant 2) — calling this with the admin's own address
   * as `keeper` has exactly the same effect as calling it with any other
   * funded account.
   */
  slash: ({keeper, reexecutor, submission_id, amount}: {keeper: string, reexecutor: string, submission_id: u64, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit: ({agent, escrow_ref, escrow_value, task_type, input_hash, output_hash, bond}: {agent: string, escrow_ref: Buffer, escrow_value: i128, task_type: TaskType, input_hash: Buffer, output_hash: Buffer, bond: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a finalize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The sole writer of terminal submission state and the sole mover of the
   * agent's bond. Idempotent: a repeat call after finalized=true is a pure
   * read with zero storage writes and zero token transfers (invariant 3).
   * Only ever auto-verifies before the window closes when a bonded
   * consensus majority already exists and no challenge is open
   * (invariant 1); absent both a challenge and an early consensus, a
   * window-elapsed submission defaults to Verified per the PRD's
   * optimistic-verification design (no challenge => no proof of fraud).
   */
  finalize: ({submission_id}: {submission_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Verdict>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Option<ConfigRecord>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  initialize: ({admin, bond_asset, config}: {admin: string, bond_asset: string, config: ConfigRecord}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a attest_replay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless: any account with sufficient active stake may attest on
   * any submission (off-chain assignment/scheduling is the backend's job,
   * not an on-chain gate). One vote per (submission, reexecutor), enforced
   * by the ReplayAttestation storage guard. Records the raw output hash
   * alongside the vote for later off-chain audit; the contract itself only
   * trusts the boolean `matched` claim plus bonded-majority economics.
   */
  attest_replay: ({reexecutor, submission_id, output_hash, matched}: {reexecutor: string, submission_id: u64, output_hash: Buffer, matched: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_challenge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_challenge: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ChallengeRecord>>>

  /**
   * Construct and simulate a update_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-gated, additive capability change only (which knobs future
   * submissions use) — never a per-submission or per-dispute override.
   * Every SubmissionRecord snapshots the config values that govern it at
   * submit() time, so this can never retroactively change an in-flight
   * submission's rules.
   */
  update_config: ({admin, config}: {admin: string, config: ConfigRecord}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_submission transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_submission: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SubmissionRecord>>>

  /**
   * Construct and simulate a open_challenge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Bond-proportional, snapshotted at submit() time (invariant 5).
   */
  open_challenge: ({challenger, submission_id, bond}: {challenger: string, submission_id: u64, bond: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a withdraw_stake transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Blocked below min_stake_floor while any of this reexecutor's
   * attestations sit on a not-yet-finalized submission — see
   * release_attestation_lock. A reexecutor with zero open attestations
   * may withdraw in full, deactivating themselves.
   */
  withdraw_stake: ({reexecutor, amount}: {reexecutor: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reexecutor_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  reexecutor_info: ({reexecutor}: {reexecutor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ReexecutorInfo>>>

  /**
   * Construct and simulate a set_zk_registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Registers the (currently empty-by-design) ZKVerifierRegistry this
   * deployment will consult from resolve_challenge's ZkProof branch.
   */
  set_zk_registry: ({admin, registry}: {admin: string, registry: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_challenge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless — every precondition is read from already-committed
   * on-chain state (attestation tallies, or a registered ZK verifier's own
   * boolean result), never from caller identity (invariant 2). Delegates
   * the actual verdict-setting and fund movement to finalize(), which is
   * the single idempotent writer of terminal state (invariant 3).
   */
  resolve_challenge: ({submission_id, method}: {submission_id: u64, method: ResolutionMethod}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Verdict>>>

  /**
   * Construct and simulate a register_reexecutor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Also serves as a stake top-up for an already-registered reexecutor.
   */
  register_reexecutor: ({reexecutor, stake_amount}: {reexecutor: string, stake_amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a release_attestation_lock transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Attester with zero open (unresolved) attestations already withdraws
   * freely; this permissionless bookkeeping call unlocks the counter once
   * a given submission this reexecutor voted on has been finalized, without
   * requiring the contract to enumerate all of a submission's attesters.
   */
  release_attestation_lock: ({submission_id, reexecutor}: {submission_id: u64, reexecutor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
      new ContractSpec([ "AAAAAAAAAoprZWVwZXIucmVxdWlyZV9hdXRoKCkgb25seSBwcm92ZXMgdGhlIGNhbGwgaXMgYSBzaWduZWQgdHJhbnNhY3Rpb24gZnJvbQoqc29tZSogYWNjb3VudCDigJQgaXQgZ3JhbnRzIG5vIHNwZWNpYWwgcmlnaHRzLiBFdmVyeSBvdGhlciBjaGVjayBkZXJpdmVzCmF1dGhvcml0eSBzb2xlbHkgZnJvbSBhbHJlYWR5LWNvbW1pdHRlZCBvbi1jaGFpbiBzdGF0ZTogdGhlIHN1Ym1pc3Npb24KbXVzdCBiZSBmaW5hbGl6ZWQgaW50byBhIHNsYXNoYWJsZSB0ZXJtaW5hbCB2ZXJkaWN0LCBhbmQgdGhlIHRhcmdldApyZWV4ZWN1dG9yJ3Mgb3duIHJlY29yZGVkIHZvdGUgKHN0b3JlZCBhdCBhdHRlc3RfcmVwbGF5IHRpbWUpIG11c3QgYmUKb24gdGhlIHNpZGUgdGhhdCB2ZXJkaWN0IHByb3ZlZCB3cm9uZy4gVGhlcmUgaXMgbm8gYnJhbmNoIGhlcmUsIG9yCmFueXdoZXJlIGluIHRoaXMgY29udHJhY3QsIHdoZXJlIHRoZSBhZG1pbi9rZWVwZXIgYWRkcmVzcyBpdHNlbGYgZ3JhbnRzCmV4dHJhIHBvd2VyIChpbnZhcmlhbnQgMikg4oCUIGNhbGxpbmcgdGhpcyB3aXRoIHRoZSBhZG1pbidzIG93biBhZGRyZXNzCmFzIGBrZWVwZXJgIGhhcyBleGFjdGx5IHRoZSBzYW1lIGVmZmVjdCBhcyBjYWxsaW5nIGl0IHdpdGggYW55IG90aGVyCmZ1bmRlZCBhY2NvdW50LgAAAAAABXNsYXNoAAAAAAAABAAAAAAAAAAGa2VlcGVyAAAAAAATAAAAAAAAAApyZWV4ZWN1dG9yAAAAAAATAAAAAAAAAA1zdWJtaXNzaW9uX2lkAAAAAAAABgAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAGc3VibWl0AAAAAAAHAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACmVzY3Jvd19yZWYAAAAAA+4AAAAgAAAAAAAAAAxlc2Nyb3dfdmFsdWUAAAALAAAAAAAAAAl0YXNrX3R5cGUAAAAAAAfQAAAACFRhc2tUeXBlAAAAAAAAAAppbnB1dF9oYXNoAAAAAAPuAAAAIAAAAAAAAAALb3V0cHV0X2hhc2gAAAAD7gAAACAAAAAAAAAABGJvbmQAAAALAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAg9UaGUgc29sZSB3cml0ZXIgb2YgdGVybWluYWwgc3VibWlzc2lvbiBzdGF0ZSBhbmQgdGhlIHNvbGUgbW92ZXIgb2YgdGhlCmFnZW50J3MgYm9uZC4gSWRlbXBvdGVudDogYSByZXBlYXQgY2FsbCBhZnRlciBmaW5hbGl6ZWQ9dHJ1ZSBpcyBhIHB1cmUKcmVhZCB3aXRoIHplcm8gc3RvcmFnZSB3cml0ZXMgYW5kIHplcm8gdG9rZW4gdHJhbnNmZXJzIChpbnZhcmlhbnQgMykuCk9ubHkgZXZlciBhdXRvLXZlcmlmaWVzIGJlZm9yZSB0aGUgd2luZG93IGNsb3NlcyB3aGVuIGEgYm9uZGVkCmNvbnNlbnN1cyBtYWpvcml0eSBhbHJlYWR5IGV4aXN0cyBhbmQgbm8gY2hhbGxlbmdlIGlzIG9wZW4KKGludmFyaWFudCAxKTsgYWJzZW50IGJvdGggYSBjaGFsbGVuZ2UgYW5kIGFuIGVhcmx5IGNvbnNlbnN1cywgYQp3aW5kb3ctZWxhcHNlZCBzdWJtaXNzaW9uIGRlZmF1bHRzIHRvIFZlcmlmaWVkIHBlciB0aGUgUFJEJ3MKb3B0aW1pc3RpYy12ZXJpZmljYXRpb24gZGVzaWduIChubyBjaGFsbGVuZ2UgPT4gbm8gcHJvb2Ygb2YgZnJhdWQpLgAAAAAIZmluYWxpemUAAAABAAAAAAAAAA1zdWJtaXNzaW9uX2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAdWZXJkaWN0AAAAAAM=",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPoAAAH0AAAAAxDb25maWdSZWNvcmQ=",
        "AAAAAAAAAAAAAAAKaW5pdGlhbGl6ZQAAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApib25kX2Fzc2V0AAAAAAATAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMQ29uZmlnUmVjb3JkAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAaFQZXJtaXNzaW9ubGVzczogYW55IGFjY291bnQgd2l0aCBzdWZmaWNpZW50IGFjdGl2ZSBzdGFrZSBtYXkgYXR0ZXN0IG9uCmFueSBzdWJtaXNzaW9uIChvZmYtY2hhaW4gYXNzaWdubWVudC9zY2hlZHVsaW5nIGlzIHRoZSBiYWNrZW5kJ3Mgam9iLApub3QgYW4gb24tY2hhaW4gZ2F0ZSkuIE9uZSB2b3RlIHBlciAoc3VibWlzc2lvbiwgcmVleGVjdXRvciksIGVuZm9yY2VkCmJ5IHRoZSBSZXBsYXlBdHRlc3RhdGlvbiBzdG9yYWdlIGd1YXJkLiBSZWNvcmRzIHRoZSByYXcgb3V0cHV0IGhhc2gKYWxvbmdzaWRlIHRoZSB2b3RlIGZvciBsYXRlciBvZmYtY2hhaW4gYXVkaXQ7IHRoZSBjb250cmFjdCBpdHNlbGYgb25seQp0cnVzdHMgdGhlIGJvb2xlYW4gYG1hdGNoZWRgIGNsYWltIHBsdXMgYm9uZGVkLW1ham9yaXR5IGVjb25vbWljcy4AAAAAAAANYXR0ZXN0X3JlcGxheQAAAAAAAAQAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAAAAAAtvdXRwdXRfaGFzaAAAAAPuAAAAIAAAAAAAAAAHbWF0Y2hlZAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAANZ2V0X2NoYWxsZW5nZQAAAAAAAAEAAAAAAAAAAmlkAAAAAAAGAAAAAQAAA+gAAAfQAAAAD0NoYWxsZW5nZVJlY29yZAA=",
        "AAAAAAAAASFBZG1pbi1nYXRlZCwgYWRkaXRpdmUgY2FwYWJpbGl0eSBjaGFuZ2Ugb25seSAod2hpY2gga25vYnMgZnV0dXJlCnN1Ym1pc3Npb25zIHVzZSkg4oCUIG5ldmVyIGEgcGVyLXN1Ym1pc3Npb24gb3IgcGVyLWRpc3B1dGUgb3ZlcnJpZGUuCkV2ZXJ5IFN1Ym1pc3Npb25SZWNvcmQgc25hcHNob3RzIHRoZSBjb25maWcgdmFsdWVzIHRoYXQgZ292ZXJuIGl0IGF0CnN1Ym1pdCgpIHRpbWUsIHNvIHRoaXMgY2FuIG5ldmVyIHJldHJvYWN0aXZlbHkgY2hhbmdlIGFuIGluLWZsaWdodApzdWJtaXNzaW9uJ3MgcnVsZXMuAAAAAAAADXVwZGF0ZV9jb25maWcAAAAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAxDb25maWdSZWNvcmQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOZ2V0X3N1Ym1pc3Npb24AAAAAAAEAAAAAAAAAAmlkAAAAAAAGAAAAAQAAA+gAAAfQAAAAEFN1Ym1pc3Npb25SZWNvcmQ=",
        "AAAAAAAAAD5Cb25kLXByb3BvcnRpb25hbCwgc25hcHNob3R0ZWQgYXQgc3VibWl0KCkgdGltZSAoaW52YXJpYW50IDUpLgAAAAAADm9wZW5fY2hhbGxlbmdlAAAAAAADAAAAAAAAAApjaGFsbGVuZ2VyAAAAAAATAAAAAAAAAA1zdWJtaXNzaW9uX2lkAAAAAAAABgAAAAAAAAAEYm9uZAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAOlCbG9ja2VkIGJlbG93IG1pbl9zdGFrZV9mbG9vciB3aGlsZSBhbnkgb2YgdGhpcyByZWV4ZWN1dG9yJ3MKYXR0ZXN0YXRpb25zIHNpdCBvbiBhIG5vdC15ZXQtZmluYWxpemVkIHN1Ym1pc3Npb24g4oCUIHNlZQpyZWxlYXNlX2F0dGVzdGF0aW9uX2xvY2suIEEgcmVleGVjdXRvciB3aXRoIHplcm8gb3BlbiBhdHRlc3RhdGlvbnMKbWF5IHdpdGhkcmF3IGluIGZ1bGwsIGRlYWN0aXZhdGluZyB0aGVtc2VsdmVzLgAAAAAAAA53aXRoZHJhd19zdGFrZQAAAAAAAgAAAAAAAAAKcmVleGVjdXRvcgAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAPcmVleGVjdXRvcl9pbmZvAAAAAAEAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAABAAAD6AAAB9AAAAAOUmVleGVjdXRvckluZm8AAA==",
        "AAAAAAAAAIJSZWdpc3RlcnMgdGhlIChjdXJyZW50bHkgZW1wdHktYnktZGVzaWduKSBaS1ZlcmlmaWVyUmVnaXN0cnkgdGhpcwpkZXBsb3ltZW50IHdpbGwgY29uc3VsdCBmcm9tIHJlc29sdmVfY2hhbGxlbmdlJ3MgWmtQcm9vZiBicmFuY2guAAAAAAAPc2V0X3prX3JlZ2lzdHJ5AAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIcmVnaXN0cnkAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAVNQZXJtaXNzaW9ubGVzcyDigJQgZXZlcnkgcHJlY29uZGl0aW9uIGlzIHJlYWQgZnJvbSBhbHJlYWR5LWNvbW1pdHRlZApvbi1jaGFpbiBzdGF0ZSAoYXR0ZXN0YXRpb24gdGFsbGllcywgb3IgYSByZWdpc3RlcmVkIFpLIHZlcmlmaWVyJ3Mgb3duCmJvb2xlYW4gcmVzdWx0KSwgbmV2ZXIgZnJvbSBjYWxsZXIgaWRlbnRpdHkgKGludmFyaWFudCAyKS4gRGVsZWdhdGVzCnRoZSBhY3R1YWwgdmVyZGljdC1zZXR0aW5nIGFuZCBmdW5kIG1vdmVtZW50IHRvIGZpbmFsaXplKCksIHdoaWNoIGlzCnRoZSBzaW5nbGUgaWRlbXBvdGVudCB3cml0ZXIgb2YgdGVybWluYWwgc3RhdGUgKGludmFyaWFudCAzKS4AAAAAEXJlc29sdmVfY2hhbGxlbmdlAAAAAAAAAgAAAAAAAAANc3VibWlzc2lvbl9pZAAAAAAAAAYAAAAAAAAABm1ldGhvZAAAAAAH0AAAABBSZXNvbHV0aW9uTWV0aG9kAAAAAQAAA+kAAAfQAAAAB1ZlcmRpY3QAAAAAAw==",
        "AAAAAAAAAENBbHNvIHNlcnZlcyBhcyBhIHN0YWtlIHRvcC11cCBmb3IgYW4gYWxyZWFkeS1yZWdpc3RlcmVkIHJlZXhlY3V0b3IuAAAAABNyZWdpc3Rlcl9yZWV4ZWN1dG9yAAAAAAIAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAAAAAAADHN0YWtlX2Ftb3VudAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAARZBdHRlc3RlciB3aXRoIHplcm8gb3BlbiAodW5yZXNvbHZlZCkgYXR0ZXN0YXRpb25zIGFscmVhZHkgd2l0aGRyYXdzCmZyZWVseTsgdGhpcyBwZXJtaXNzaW9ubGVzcyBib29ra2VlcGluZyBjYWxsIHVubG9ja3MgdGhlIGNvdW50ZXIgb25jZQphIGdpdmVuIHN1Ym1pc3Npb24gdGhpcyByZWV4ZWN1dG9yIHZvdGVkIG9uIGhhcyBiZWVuIGZpbmFsaXplZCwgd2l0aG91dApyZXF1aXJpbmcgdGhlIGNvbnRyYWN0IHRvIGVudW1lcmF0ZSBhbGwgb2YgYSBzdWJtaXNzaW9uJ3MgYXR0ZXN0ZXJzLgAAAAAAGHJlbGVhc2VfYXR0ZXN0YXRpb25fbG9jawAAAAIAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAAAAAApyZWV4ZWN1dG9yAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAABQAAAAAAAAAAAAAAB1NsYXNoZWQAAAAAAQAAAAdzbGFzaGVkAAAAAAMAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAQAAAAAAAAAKcmVleGVjdXRvcgAAAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACUZpbmFsaXplZAAAAAAAAAEAAAAJZmluYWxpemVkAAAAAAAAAgAAAAAAAAANc3VibWlzc2lvbl9pZAAAAAAAAAYAAAABAAAAAAAAAAd2ZXJkaWN0AAAAB9AAAAAHVmVyZGljdAAAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlJlcGxheUF0dGVzdGVkAAAAAAABAAAAD3JlcGxheV9hdHRlc3RlZAAAAAAEAAAAAAAAAA1zdWJtaXNzaW9uX2lkAAAAAAAABgAAAAEAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAAAAAAAAAAAAAtvdXRwdXRfaGFzaAAAAAPuAAAAIAAAAAAAAAAAAAAAB21hdGNoZWQAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD0NoYWxsZW5nZU9wZW5lZAAAAAABAAAAEGNoYWxsZW5nZV9vcGVuZWQAAAADAAAAAAAAAA1zdWJtaXNzaW9uX2lkAAAAAAAABgAAAAEAAAAAAAAACmNoYWxsZW5nZXIAAAAAABMAAAAAAAAAAAAAAARib25kAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEUNoYWxsZW5nZVJlc29sdmVkAAAAAAAAAQAAABJjaGFsbGVuZ2VfcmVzb2x2ZWQAAAAAAAMAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAQAAAAAAAAAKcmVzb2x1dGlvbgAAAAAH0AAAAApSZXNvbHV0aW9uAAAAAAAAAAAAAAAAAAZtZXRob2QAAAAAB9AAAAAQUmVzb2x1dGlvbk1ldGhvZAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEVN1Ym1pc3Npb25DcmVhdGVkAAAAAAAAAQAAABJzdWJtaXNzaW9uX2NyZWF0ZWQAAAAAAAUAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAQAAAAAAAAAFYWdlbnQAAAAAAAATAAAAAAAAAAAAAAAKZXNjcm93X3JlZgAAAAAD7gAAACAAAAAAAAAAAAAAAAxlc2Nyb3dfdmFsdWUAAAALAAAAAAAAAAAAAAAEYm9uZAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFJlZXhlY3V0b3JSZWdpc3RlcmVkAAAAAQAAABVyZWV4ZWN1dG9yX3JlZ2lzdGVyZWQAAAAAAAADAAAAAAAAAApyZWV4ZWN1dG9yAAAAAAATAAAAAQAAAAAAAAAMc3Rha2VfYW1vdW50AAAACwAAAAAAAAAAAAAABmFjdGl2ZQAAAAAAAQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAGFJlZXhlY3V0b3JTdGFrZVdpdGhkcmF3bgAAAAEAAAAacmVleGVjdXRvcl9zdGFrZV93aXRoZHJhd24AAAAAAAIAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAABAAAAAAAAAAluZXdfc3Rha2UAAAAAAAALAAAAAAAAAAI=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAACwAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAJQm9uZEFzc2V0AAAAAAAAAAAAAAAAAAAKWmtSZWdpc3RyeQAAAAAAAAAAAAAAAAAGQ29uZmlnAAAAAAAAAAAAAAAAABBOZXh0U3VibWlzc2lvbklkAAAAAQAAAAAAAAAKU3VibWlzc2lvbgAAAAAAAQAAAAYAAAABAAAAv1N0b3JlcyB0aGUgcmVleGVjdXRvcidzIGFjdHVhbCB2b3RlICh0cnVlID0gbWF0Y2hlZCksIG5vdCBqdXN0IGEgcHJlc2VuY2UKZ3VhcmQg4oCUIHNsYXNoKCkgbmVlZHMgdGhlIHJlY29yZGVkIHZvdGUgdG8gcHJvdmUgd2hpY2ggc2lkZSB3YXMgd3JvbmcKd2l0aG91dCBtYWludGFpbmluZyBhIHNlcGFyYXRlIGF0dGVzdGVyIGxpc3QuAAAAABFSZXBsYXlBdHRlc3RhdGlvbgAAAAAAAAIAAAAGAAAAEwAAAAEAAAAAAAAACUNoYWxsZW5nZQAAAAAAAAEAAAAGAAAAAQAAAAAAAAAKUmVleGVjdXRvcgAAAAAAAQAAABMAAAABAAAAAAAAAAdTbGFzaGVkAAAAAAIAAAAGAAAAEwAAAAEAAAAAAAAAE0F0dGVzdGF0aW9uUmVsZWFzZWQAAAAAAgAAAAYAAAAT",
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
    slash: this.txFromJSON<Result<void>>,
        submit: this.txFromJSON<Result<u64>>,
        finalize: this.txFromJSON<Result<Verdict>>,
        get_admin: this.txFromJSON<Option<string>>,
        get_config: this.txFromJSON<Option<ConfigRecord>>,
        initialize: this.txFromJSON<Result<void>>,
        attest_replay: this.txFromJSON<Result<void>>,
        get_challenge: this.txFromJSON<Option<ChallengeRecord>>,
        update_config: this.txFromJSON<Result<void>>,
        get_submission: this.txFromJSON<Option<SubmissionRecord>>,
        open_challenge: this.txFromJSON<Result<void>>,
        withdraw_stake: this.txFromJSON<Result<void>>,
        reexecutor_info: this.txFromJSON<Option<ReexecutorInfo>>,
        set_zk_registry: this.txFromJSON<Result<void>>,
        resolve_challenge: this.txFromJSON<Result<Verdict>>,
        register_reexecutor: this.txFromJSON<Result<void>>,
        release_attestation_lock: this.txFromJSON<Result<void>>
  }
}
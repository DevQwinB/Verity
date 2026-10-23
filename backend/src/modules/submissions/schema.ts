import { z } from "zod";

export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256 digest");

export const I128_MAX = 2n ** 127n - 1n;

export const stroops = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a positive integer amount in stroops, without leading zeros")
  .refine((v) => {
    try {
      return BigInt(v) <= I128_MAX;
    } catch {
      return false;
    }
  }, "amount exceeds the contract's i128 range");

export const submitBody = z.object({
  escrow_ref: z.string().min(1).max(256),
  // "unverifiable" is in the taxonomy but has no on-chain path in Phase 1 —
  // the contract rejects it, so it is rejected here with a clear message.
  task_type: z.enum(["deterministic", "retrieval"]),
  input_hash: sha256Hex,
  claimed_output_hash: sha256Hex,
  input_ref: z.string().max(1024).optional(),
  function_hash: sha256Hex.optional(),
  function_ref: z.string().max(1024).optional(),
  claimed_output_ref: z.string().max(1024).optional(),
  escrow_value: stroops,
  bond_amount: stroops,
  idempotency_key: z.string().min(1).max(256),
});

export type SubmitBody = z.infer<typeof submitBody>;

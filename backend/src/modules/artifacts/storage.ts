import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { env } from "../../config/env.js";

async function ensureDir() {
  await fs.mkdir(env.ARTIFACT_STORAGE_DIR, { recursive: true });
}

/** Content-addressed local disk storage: the file is stored under its own
 * sha256 hash, so `storage_ref` and `content_hash` are always consistent by
 * construction — there is no path where a stored blob doesn't match its
 * claimed hash. */
export async function storeArtifact(content: Buffer): Promise<{ contentHash: string; storageRef: string }> {
  await ensureDir();
  const contentHash = createHash("sha256").update(content).digest("hex");
  const storageRef = path.join(env.ARTIFACT_STORAGE_DIR, contentHash);
  await fs.writeFile(storageRef, content);
  return { contentHash, storageRef };
}

export async function readArtifact(storageRef: string): Promise<Buffer> {
  const content = await fs.readFile(storageRef);
  const actualHash = createHash("sha256").update(content).digest("hex");
  const claimedHash = path.basename(storageRef);
  if (actualHash !== claimedHash) {
    throw new Error(`Artifact content hash mismatch: expected ${claimedHash}, got ${actualHash}`);
  }
  return content;
}

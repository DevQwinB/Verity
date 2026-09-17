import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { storeArtifact, readArtifact } from "./storage.js";
import { env } from "../../config/env.js";
import * as path from "node:path";

export async function artifactsRoutes(app: FastifyInstance) {
  app.post("/v1/artifacts", { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({
        content_base64: z.string().min(1),
        content_type: z.string().optional(),
      })
      .parse(req.body);
    const content = Buffer.from(body.content_base64, "base64");
    const { contentHash, storageRef } = await storeArtifact(content);
    reply.code(201);
    return {
      content_hash: contentHash,
      storage_ref: storageRef,
      size_bytes: content.byteLength,
      content_type: body.content_type ?? null,
    };
  });

  app.get<{ Params: { hash: string } }>("/v1/artifacts/:hash", async (req, reply) => {
    const hash = req.params.hash;
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      reply.code(400);
      return { error: "invalid content hash" };
    }
    try {
      const content = await readArtifact(path.join(env.ARTIFACT_STORAGE_DIR, hash));
      return { content_hash: hash, content_base64: content.toString("base64") };
    } catch {
      reply.code(404);
      return { error: "not found" };
    }
  });
}

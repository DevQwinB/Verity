import { createDb } from "@verity/db";
import { env } from "./config/env.js";

export const db = createDb(env.DATABASE_URL);

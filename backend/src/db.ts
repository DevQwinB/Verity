import { createDb } from "@verity/db";
import type { Database } from "@verity/db";
import type { Kysely } from "kysely";
import { env } from "./config/env.js";

let _db: Kysely<Database> | null = null;

export function getDb(): Kysely<Database> {
  if (!_db) {
    _db = createDb(process.env.DATABASE_URL ?? env.DATABASE_URL);
  }
  return _db;
}

export function setDb(customDb: Kysely<Database> | null): void {
  _db = customDb;
}

export const db: Kysely<Database> = new Proxy({} as Kysely<Database>, {
  get(_target, prop) {
    const target = getDb() as any;
    const val = target[prop];
    if (typeof val === "function") {
      return val.bind(target);
    }
    return val;
  },
});


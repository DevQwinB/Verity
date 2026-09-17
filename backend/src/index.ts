import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { startIndexer } from "./workers/indexer.js";
import { startScheduler } from "./workers/scheduler.js";

async function main() {
  const app = buildApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  startIndexer();
  startScheduler();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

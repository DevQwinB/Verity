#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must be set" >&2
  exit 1
fi

echo "==> Running migrations up (initial)"
pnpm db:migrate

if command -v pg_dump >/dev/null 2>&1; then
  echo "==> Dumping initial schema"
  pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > /tmp/schema_initial.sql
fi

MIGRATION_COUNT=$(find db/migrations -maxdepth 1 -name '*.ts' | wc -l)
echo "==> Reversing $MIGRATION_COUNT migrations down"
for i in $(seq "$MIGRATION_COUNT"); do
  echo "--> Running migrate:down step $i of $MIGRATION_COUNT"
  pnpm --filter @verity/db migrate:down
done

echo "==> Running migrations up (re-apply)"
pnpm db:migrate

if command -v pg_dump >/dev/null 2>&1; then
  echo "==> Dumping re-applied schema and verifying equivalence"
  pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > /tmp/schema_reapplied.sql
  diff -u /tmp/schema_initial.sql /tmp/schema_reapplied.sql
fi

echo "==> All migrations applied, rolled back, and re-applied successfully."

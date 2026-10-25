## What and why

<!-- One or two sentences. Link the issue: "Closes #123". One concern per PR. -->

Closes #

## Area

- [ ] Contracts (`contracts/`)
- [ ] Backend (`backend/`)
- [ ] Re-executor agent (`reexecutor-agent/`)
- [ ] Dashboard (`frontend/`)
- [ ] Database / migrations (`db/`)
- [ ] Scripts / deployment / CI
- [ ] Docs only

## How I verified it

<!-- What you ran and what you saw. Be specific about what you did NOT run. -->

- [ ] `pnpm test:contracts`
- [ ] `pnpm typecheck` and `pnpm lint`
- [ ] `pnpm --filter <package> test` for each TypeScript package you touched (backend, frontend, reexecutor-agent)
- [ ] `pnpm smoke` against a local `pnpm dev` (needed for backend, agent or contract-flow changes)
- [ ] Slow smoke modes (`SMOKE_SLOW=1`, `SMOKE_PROFILE=underquorum`), for changes to finalisation, expiry or assignment
- [ ] Container image rebuilt, for Dockerfile or dependency changes

## Checklist

- [ ] The change is focused and does not include unrelated cleanups
- [ ] New behaviour has a test (or I explain below why it cannot)
- [ ] Contract interface changed: bindings regenerated with `scripts/generate_bindings.sh`
- [ ] Schema changed: new migration added, `db/src/types.ts` updated
- [ ] Canonical JSON changed: all three copies updated together
- [ ] README ("Known limits" included) and `docs/ARCHITECTURE.md` updated if a limit, default, endpoint or verdict path changed
- [ ] No secrets, keys or `.env` files committed
- [ ] The UI and API still say how each verdict was reached, and never report a ZK-verified result
- [ ] No mock or hardcoded data is shown to users

## Notes for the reviewer

<!-- Failure modes you considered, trade-offs, anything you want a second opinion on. -->

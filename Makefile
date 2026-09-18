.PHONY: dev build migrate seed demo audit rehearse memory providers parity container container-smoke test typecheck lint gate clean fresh

dev:
	npm run dev

build:
	npm run build

migrate:
	npm run db:migrate

seed: migrate
	npm run seed

## The Day One scenario end to end on the simulators.
demo: seed
	npm run demo

## The printable audit page for the most recent run.
audit:
	npx tsx scripts/export_audit.ts

## Rehearse the current workflow definition against the recorded run.
rehearse:
	npx tsx scripts/rehearse.ts

## The seven stage pass over the corpus, then the integrity suite.
memory:
	npx tsx scripts/memory.ts --twice

## The Day One scenario on every model provider this deployment can reach.
providers:
	npx tsx scripts/gate_providers.ts

## The same commit under the Vercel and the Azure configurations, compared.
parity:
	npx tsx scripts/parity.ts

## Build the container the customer cloud path deploys.
container:
	docker build -t work-ledger:$$(git rev-parse --short HEAD) -t work-ledger:local .

container-smoke:
	TAG=work-ledger:local ./scripts/container_smoke.sh

test:
	npm run test

typecheck:
	npm run typecheck

lint:
	npm run lint

##
## The gate. Nothing is committed red.
##   typecheck, lint, the state machine tests, the check pack tests, a headless
##   run of the Day One scenario, a rehearsal of the current definition against
##   that run with a zero diff on verified rows, and the memory pipeline with its
##   integrity suite. Set DATABASE_URL to run it against a Neon branch instead of
##   the embedded database.
##
gate: typecheck lint test fresh demo rehearse memory providers parity
	@echo ""
	@echo "gate: green"

## Start from an empty database.
fresh:
	@rm -rf .ledger-data

clean: fresh
	rm -rf .next .audit

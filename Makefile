.PHONY: dev build migrate seed demo audit test typecheck lint gate clean fresh

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

test:
	npm run test

typecheck:
	npm run typecheck

lint:
	npm run lint

##
## The gate. Nothing is committed red.
##   typecheck, lint, the state machine tests, the check pack tests, and a
##   headless run of the Day One scenario. Set DATABASE_URL to run it against a
##   Neon branch instead of the embedded database.
##
gate: typecheck lint test fresh demo
	@echo ""
	@echo "gate: green"

## Start from an empty database.
fresh:
	@rm -rf .ledger-data

clean: fresh
	rm -rf .next .audit

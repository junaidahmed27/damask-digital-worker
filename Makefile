.PHONY: dev build migrate seed demo test typecheck lint gate audit clean

dev:
	npm run dev

build:
	npm run build

migrate:
	npm run db:migrate

seed: migrate
	npm run seed

demo: seed
	npm run demo

test:
	npm run test

typecheck:
	npm run typecheck

lint:
	npm run lint

audit:
	npx tsx scripts/export_audit.ts

## The gate: nothing is committed red.
gate: typecheck test demo
	@echo "gate: green"

clean:
	rm -rf .ledger-data .next

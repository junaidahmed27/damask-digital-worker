#!/bin/sh
# The schema is applied before the server accepts a request, so a fresh
# deployment against an empty Azure Database for PostgreSQL comes up working
# rather than coming up and failing every query. The migration runner holds an
# advisory lock, so several replicas starting together is safe: one applies, the
# rest wait and find nothing to do.
set -e
node migrate.mjs
exec node_modules/.bin/next start

#!/bin/sh
# The container acceptance, runnable. Builds the image, starts it with nothing
# configured, and proves it came up working rather than merely came up: the
# schema was applied on boot, the health endpoint reports the local
# configuration, the API answers a database backed read, and MCP refuses a
# caller with no token.
set -e
TAG=${TAG:-work-ledger:local}
NAME=ledger-smoke-$$
PORT=${PORT:-3111}

docker build -t "$TAG" .
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT":3000 "$TAG" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

health=""
i=0
while [ "$i" -lt 90 ]; do
  health=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  [ -n "$health" ] && break
  i=$((i + 1))
  sleep 1
done

[ -n "$health" ] || { echo "the container never answered"; docker logs "$NAME"; exit 1; }
echo "$health" | grep -q '"ok":true' || { echo "health: $health"; exit 1; }

# queue is read from a table, so a queue object is proof the migrations ran.
echo "$health" | grep -q '"queue":{' || { echo "the schema was not applied on boot: $health"; docker logs "$NAME"; exit 1; }

docker logs "$NAME" 2>&1 | grep -q "applied .* migration" || { echo "no migration line in the boot log"; exit 1; }

runs=$(curl -s -m 10 "http://127.0.0.1:$PORT/api/runs")
echo "$runs" | grep -q '"runs"' || { echo "runs: $runs"; exit 1; }

mcp=$(curl -s -m 10 -X POST "http://127.0.0.1:$PORT/api/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
echo "$mcp" | grep -q '"no token"' || { echo "MCP let an unauthenticated caller in: $mcp"; exit 1; }

echo "container smoke passed"
echo "  health:  $health"
echo "  size:    $(docker images "$TAG" --format '{{.Size}}')"

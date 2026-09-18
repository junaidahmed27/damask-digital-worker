import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { authenticate } from "@/lib/interop/tokens";
import { callTool, MCP_TOOLS } from "@/lib/interop/mcp";
import { send, settle } from "@/lib/runtime/server";

export const dynamic = "force-dynamic";

/**
 * The MCP server. JSON-RPC 2.0 over HTTP, authenticated by a worker token.
 *
 * An external agent reaches the ledger through exactly this and nothing else, so
 * every invariant that holds for a built in agent holds for it: the state machine
 * refuses a status write, refuses a human approval, and refuses it entirely the
 * moment its worker is revoked.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = body.id ?? null;

  const { db } = await getDb();
  const auth = await authenticate(db, request.headers.get("authorization"));
  if (!auth.ok) {
    return Response.json(
      { jsonrpc: "2.0", id, error: { code: -32001, message: auth.reason } },
      { status: 401 },
    );
  }

  if (body.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "work-ledger", version: "0.1.0" },
        worker: { id: auth.worker.id, name: auth.worker.name, kind: auth.worker.kind },
      },
    });
  }

  if (body.method === "tools/list") {
    return Response.json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
  }

  if (body.method === "tools/call") {
    const name = String(body.params?.name ?? "");
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

    const result = await callTool(
      { db, worker: auth.worker, scopes: auth.token.scopes },
      name,
      args,
    );

    if (!result.ok) {
      // A refusal is a result the agent can read and act on, not a crash.
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: result.error }],
          structuredContent: { error: result.error, code: result.code },
        },
      });
    }

    if (result.events.length > 0) {
      await send(result.events);
      await settle();
    }

    return Response.json({
      jsonrpc: "2.0",
      id,
      result: {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        structuredContent: result.data,
      },
    });
  }

  return Response.json(
    { jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${body.method}` } },
    { status: 400 },
  );
}

export async function GET() {
  return Response.json({ name: "work-ledger", protocol: "mcp", tools: MCP_TOOLS.map((t) => t.name) });
}

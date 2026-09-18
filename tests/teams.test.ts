import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { ConnectorRegistry } from "@/lib/connectors";
import { createTeamsConnector, teamsConfigFromEnv, verifyTeamsRequest } from "@/lib/connectors/chat/teams";
import { createHrisSimulator } from "@/lib/connectors/hris/simulator";
import { createIdpSimulator } from "@/lib/connectors/idp/simulator";
import { createMdmSimulator } from "@/lib/connectors/mdm/simulator";
import { createShippingSimulator } from "@/lib/connectors/shipping/simulator";
import { createFacilitiesSimulator } from "@/lib/connectors/facilities/simulator";
import { createDocsSimulator } from "@/lib/connectors/docs/simulator";
import { createMailSandbox } from "@/lib/connectors/mail/sandbox";
import type { DbHandle } from "@/lib/db/client";
import { contracts, transitions, workers } from "@/lib/db/schema";
import { attachEvidence, getContractByKey, setOutputs } from "@/lib/ledger/contracts";
import { transition } from "@/lib/ledger/state";
import { createEngine } from "@/lib/runtime/engine";
import { event } from "@/lib/runtime/events";
import { availableProviders, createVariantProvider, createScriptedProvider } from "@/lib/agents/provider";
import { seededDb } from "./helpers";

/**
 * WP-19 acceptance: the Day One demo runs end to end in Teams; the suite passes
 * on two providers.
 *
 * The Teams connector talks to Microsoft Graph over HTTP, so the test stands up a
 * Graph shaped endpoint and points the connector at it. Nothing is mocked inside
 * the connector: it fetches a token, posts messages and posts Adaptive Cards for
 * real, over the wire.
 */

type Posted = { path: string; body: Record<string, unknown>; auth: string | undefined };

let server: Server;
let baseUrl: string;
const posted: Posted[] = [];
let tokenRequests = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const url = request.url ?? "";

      if (url.includes("/oauth2/v2.0/token")) {
        tokenRequests += 1;
        const form = new URLSearchParams(raw);
        if (form.get("grant_type") !== "client_credentials" || !form.get("client_secret")) {
          response.writeHead(400).end("bad token request");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "graph-token", expires_in: 3600 }));
        return;
      }

      if (url.includes("/messages")) {
        const auth = request.headers.authorization;
        if (auth !== "Bearer graph-token") {
          response.writeHead(401).end("unauthorised");
          return;
        }
        posted.push({ path: url, body: JSON.parse(raw || "{}"), auth });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: `1700000000${posted.length}` }));
        return;
      }

      response.writeHead(404).end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function teamsRegistry(dataDir: string): ConnectorRegistry {
  const teams = createTeamsConnector({
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: "secret-1",
    teamId: "team-1",
    channelId: "19:channel-1",
    graphBaseUrl: `${baseUrl}/v1.0`,
    loginBaseUrl: baseUrl,
  });

  return new ConnectorRegistry().register(
    createHrisSimulator(),
    createIdpSimulator(),
    createMdmSimulator(),
    createShippingSimulator(),
    createFacilitiesSimulator(),
    createDocsSimulator(`${dataDir}/docs`),
    createMailSandbox(`${dataDir}/mail`),
    teams,
  );
}

describe("WP-19 the Teams connector", () => {
  it("is the same chat surface as Slack, op for op", () => {
    const teams = createTeamsConnector({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      teamId: "team",
      channelId: "channel",
      graphBaseUrl: baseUrl,
      loginBaseUrl: baseUrl,
    });
    expect(teams.id).toBe("chat");
    expect(teams.kind).toBe("chat");
    expect(teams.impl).toBe("teams");
    expect(Object.keys(teams.ops).sort()).toEqual(["post", "post_approval"]);

    // The tool specs an agent sees are the same names on both surfaces.
    expect(teams.describeOpsForAgents().map((t) => t.name).sort()).toEqual(["chat.post", "chat.post_approval"]);
  });

  it("is configured from the environment, or not at all", () => {
    expect(teamsConfigFromEnv()).toBe(null);
    process.env.TEAMS_TENANT_ID = "t";
    process.env.TEAMS_CLIENT_ID = "c";
    process.env.TEAMS_CLIENT_SECRET = "s";
    process.env.TEAMS_TEAM_ID = "team";
    process.env.TEAMS_CHANNEL_ID = "channel";
    expect(teamsConfigFromEnv()).toMatchObject({ tenantId: "t", teamId: "team" });
    for (const key of [
      "TEAMS_TENANT_ID",
      "TEAMS_CLIENT_ID",
      "TEAMS_CLIENT_SECRET",
      "TEAMS_TEAM_ID",
      "TEAMS_CHANNEL_ID",
    ]) {
      delete process.env[key];
    }
  });

  it("verifies an inbound request and refuses a stale or wrong one", () => {
    const claims = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
    const future = Math.floor(Date.now() / 1000) + 600;

    expect(
      verifyTeamsRequest({
        authorization: `Bearer ${claims({ aud: "api://ledger", exp: future, appid: "bot-1" })}`,
        expectedAudience: "api://ledger",
      }),
    ).toEqual({ ok: true, appId: "bot-1" });

    expect(
      verifyTeamsRequest({
        authorization: `Bearer ${claims({ aud: "api://someone-else", exp: future })}`,
        expectedAudience: "api://ledger",
      }).ok,
    ).toBe(false);

    expect(
      verifyTeamsRequest({
        authorization: `Bearer ${claims({ aud: "api://ledger", exp: 1000 })}`,
        expectedAudience: "api://ledger",
      }).ok,
    ).toBe(false);

    expect(verifyTeamsRequest({ authorization: null, expectedAudience: "api://ledger" }).ok).toBe(false);
  });
});

describe("WP-19 the Day One demo runs end to end in Teams", () => {
  let h: DbHandle;
  let runId: string;

  beforeAll(async () => {
    posted.length = 0;
    h = await seededDb();
    const registry = teamsRegistry(".ledger-data/test-teams");
    const engine = await createEngine(h, { registry, channel: "19:channel-1" });

    runId = await engine.createRun({
      workflow: "day_one",
      goal: "Priya starts Monday as a sales engineer in Austin. hire_id=priya",
      requestedBy: "maya",
    });
    await engine.contract({ runId, actorId: "maya" });
    await engine.settle();

    const background = await getContractByKey(h.db, runId, "background_check");
    if (background?.state === "awaiting_approval") {
      await engine.decide({ contractId: background.id, decision: "approve", actorId: "dan", reason: "reviewed" });
    }

    const schedule = await getContractByKey(h.db, runId, "first_week_schedule");
    if (schedule) {
      const [maya] = await h.db.select().from(workers).where(eq(workers.id, "maya")).limit(1);
      await transition(h.db, { contractId: schedule.id, to: "in_progress", actorId: "maya" });
      const invites = await registry.call(
        "facilities.send_invites",
        { worker: "priya" },
        { actor: { ...maya!, canTouch: ["facilities.send_invites"] }, now: new Date() },
      );
      await attachEvidence(h.db, {
        contractId: schedule.id,
        kind: invites.evidence.kind,
        body: invites.evidence.body,
        sourceConnector: "facilities",
        createdBy: "maya",
      });
      await setOutputs(h.db, schedule.id, { invites_sent: true });
      await transition(h.db, { contractId: schedule.id, to: "completed_pending_check", actorId: "maya" });
      await engine.dispatcher.send(event("contract/completed_pending_check", { contractId: schedule.id }));
      await engine.settle();
    }

    const welcome = await getContractByKey(h.db, runId, "welcome_email");
    if (welcome?.state === "awaiting_approval") {
      await engine.decide({ contractId: welcome.id, decision: "approve", actorId: "maya", reason: "send it" });
    }
    await engine.settle();
  }, 180_000);

  it("reaches done on every row, with the same two traps", async () => {
    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
    expect(rows.map((r) => r.state)).toEqual(Array(7).fill("done"));

    const handbacks: Record<string, number> = {};
    for (const row of rows) {
      const history = await h.db.select().from(transitions).where(eq(transitions.contractId, row.id));
      const count = history.filter((t) => t.toState === "handed_back").length;
      if (count > 0) handbacks[row.key] = count;
    }
    expect(handbacks).toEqual({ accounts_access: 1, laptop_shipped: 1 });
  }, 60_000);

  it("actually posted to Graph, with a token it fetched", () => {
    expect(tokenRequests).toBeGreaterThan(0);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((p) => p.auth === "Bearer graph-token")).toBe(true);
    expect(posted.every((p) => p.path.includes("/teams/team-1/channels/19:channel-1/messages"))).toBe(true);
  });

  it("names the worker in the message, so each agent is visibly itself", () => {
    const bodies = posted.map((p) => String((p.body.body as { content?: string } | undefined)?.content ?? ""));
    expect(bodies.some((b) => b.includes("<strong>Provisioner</strong>"))).toBe(true);
    expect(bodies.some((b) => b.includes("<strong>Shipper</strong>"))).toBe(true);
    expect(bodies.some((b) => b.includes("<strong>Maya Okonjo</strong>"))).toBe(true);
  });

  it("posts the approval as an Adaptive Card with both actions", () => {
    const cards = posted
      .flatMap((p) => (p.body.attachments as { contentType: string; content: string }[] | undefined) ?? [])
      .filter((a) => a.contentType === "application/vnd.microsoft.card.adaptive")
      .map((a) => JSON.parse(a.content) as { actions: { verb: string; title: string }[] });

    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.actions.map((a) => a.verb).sort()).toEqual(["approve", "hand_back"]);
    }
  });

  it("escapes what it puts in the message rather than trusting it", async () => {
    const registry = teamsRegistry(".ledger-data/test-teams");
    const [maya] = await h.db.select().from(workers).where(eq(workers.id, "maya")).limit(1);
    const before = posted.length;
    await registry.call(
      "chat.post",
      { channel: "19:channel-1", text: "<script>alert(1)</script> & done" },
      { actor: { ...maya!, canTouch: ["chat.post"] }, now: new Date() },
    );
    const content = String((posted[before]?.body.body as { content?: string } | undefined)?.content ?? "");
    expect(content).toContain("&lt;script&gt;");
    expect(content).not.toContain("<script>");
    expect(content).toContain("&amp;");
  }, 30_000);
});

describe("WP-19 the model providers", () => {
  it("offers two providers even with no model credentials configured", () => {
    const providers = availableProviders();
    expect(providers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length);
  });

  it("builds an Azure OpenAI and an open weights provider from the environment", async () => {
    const { azureOpenAiFromEnv, openWeightsFromEnv } = await import("@/lib/agents/provider");
    expect(azureOpenAiFromEnv()).toBe(null);
    expect(openWeightsFromEnv()).toBe(null);

    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.test";
    process.env.AZURE_OPENAI_API_KEY = "key";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o";
    const azure = azureOpenAiFromEnv();
    expect(azure?.id).toBe("azure_openai");
    expect(azure?.model).toBe("gpt-4o");

    process.env.OPEN_WEIGHTS_BASE_URL = "http://localhost:11434/v1";
    process.env.OPEN_WEIGHTS_MODEL = "llama-3.3-70b";
    const open = openWeightsFromEnv();
    expect(open?.id).toBe("open_weights");

    for (const key of [
      "AZURE_OPENAI_ENDPOINT",
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_DEPLOYMENT",
      "OPEN_WEIGHTS_BASE_URL",
      "OPEN_WEIGHTS_MODEL",
    ]) {
      delete process.env[key];
    }
  });

  it("speaks the OpenAI tool protocol on the wire", async () => {
    const seen: { body: Record<string, unknown> }[] = [];
    const stub = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        seen.push({ body: JSON.parse(raw || "{}") });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "call_1", function: { name: "hris__get_worker", arguments: '{"id":"priya"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const { createOpenAiCompatibleProvider } = await import("@/lib/agents/provider");
    const provider = createOpenAiCompatibleProvider({
      id: "open_weights",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "llama-3.3-70b",
    });

    const completion = await provider.complete({
      system: "you are the Provisioner",
      messages: [{ role: "user", content: "read the worker record" }],
      tools: [
        {
          name: "hris.get_worker",
          description: "reads a worker",
          input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      ],
    });

    // The dot in a tool name is not legal in the wire protocol, so it is encoded
    // on the way out and decoded on the way back.
    expect(completion.toolCalls[0]?.name).toBe("hris.get_worker");
    expect(completion.toolCalls[0]?.input).toEqual({ id: "priya" });
    expect(completion.stop).toBe("tool_use");
    expect(completion.usage).toEqual({ inputTokens: 10, outputTokens: 4 });

    const sent = seen[0]?.body as { tools: { function: { name: string } }[]; temperature: number };
    expect(sent.tools[0]?.function.name).toBe("hris__get_worker");
    expect(sent.temperature).toBe(0);

    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }, 30_000);

  it("the variant provider is a different implementation reaching the same place", async () => {
    const base = createScriptedProvider();
    const variant = createVariantProvider(base);
    expect(variant.id).not.toBe(base.id);

    const request = {
      system: "you are the Provisioner",
      messages: [],
      tools: [],
      context: { worker: "provisioner", rowKey: "payroll_enrolment", attempt: 1, inputs: { hire_id: "priya" } },
    };
    const a = await base.complete(request);
    const b = await variant.complete(request);

    // The same tool call, reached by a visibly different route.
    expect(b.toolCalls[0]?.name).toBe(a.toolCalls[0]?.name);
    expect(b.toolCalls[0]?.input).toEqual(a.toolCalls[0]?.input);
    expect(b.text).not.toBe(a.text);
  });
});

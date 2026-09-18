import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { createRegistry, ConnectorRefused, type OpContext } from "@/lib/connectors";
import type { DbHandle } from "@/lib/db/client";
import { contracts, workers, type Worker } from "@/lib/db/schema";
import { verifySlackSignature } from "@/lib/connectors/chat/slack";
import { checkSignature } from "@/lib/connectors/chat/slackSurface";
import { seededDb } from "./helpers";

/**
 * WP-6 acceptance: /ledger new creates the run, Dan's button press resolves the
 * approval, and a revoked agent posts nothing.
 *
 * The surface talks to the process wide database through getDb(), so these tests
 * point that at the test database and then drive the same functions the three
 * route handlers call.
 */
let h: DbHandle;

beforeEach(async () => {
  h = await seededDb();
  vi.doMock("@/lib/db/client", async () => {
    const actual = await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
    return { ...actual, getDb: async () => h };
  });
  vi.resetModules();
});

async function surface() {
  return import("@/lib/connectors/chat/slackSurface");
}

describe("WP-6 the slash command", () => {
  it("drafts a run from /ledger new and runs nothing", async () => {
    const { handleCommand } = await surface();
    const outcome = await handleCommand({
      text: 'new "Priya starts Monday as a sales engineer in Austin"',
      slackUserId: "U0MAYA",
    });

    expect(outcome.kind).toBe("drafted");
    if (outcome.kind !== "drafted") return;
    expect(outcome.rows).toBe(7);

    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, outcome.runId));
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(["drafted"]));
  }, 60_000);

  it("starts the rows only when a person contracts the plan", async () => {
    const { handleCommand } = await surface();
    const drafted = await handleCommand({ text: 'new "Priya starts Monday hire_id=priya"', slackUserId: "U0MAYA" });
    if (drafted.kind !== "drafted") throw new Error("not drafted");

    const contracted = await handleCommand({ text: `contract ${drafted.runId}`, slackUserId: "U0MAYA" });
    expect(contracted.kind).toBe("contracted");
    if (contracted.kind !== "contracted") return;
    expect(contracted.started).toBeGreaterThan(0);

    const rows = await h.db.select().from(contracts).where(eq(contracts.runId, drafted.runId));
    expect(rows.every((r) => r.state !== "drafted")).toBe(true);
  }, 60_000);

  it("refuses a Slack user the ledger does not know", async () => {
    const { handleCommand } = await surface();
    const outcome = await handleCommand({ text: "new anything", slackUserId: "U0NOBODY" });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.text).toContain("do not know who you are");
  });
});

describe("WP-6 the approval buttons", () => {
  it("lets Dan resolve the background check and refuses everyone else", async () => {
    const { handleCommand, handleInteraction } = await surface();
    const drafted = await handleCommand({ text: 'new "Priya starts Monday hire_id=priya"', slackUserId: "U0MAYA" });
    if (drafted.kind !== "drafted") throw new Error("not drafted");
    await handleCommand({ text: `contract ${drafted.runId}`, slackUserId: "U0MAYA" });

    const [background] = await h.db
      .select()
      .from(contracts)
      .where(eq(contracts.key, "background_check"))
      .limit(1);
    if (!background) throw new Error("no background row");
    expect(background.state).toBe("awaiting_approval");

    // Maya is a person but not the named approver: the state machine refuses her.
    const byMaya = await handleInteraction({
      actionId: "approve",
      contractId: background.id,
      slackUserId: "U0MAYA",
    });
    expect(byMaya.kind).toBe("decided");
    const [afterMaya] = await h.db.select().from(contracts).where(eq(contracts.id, background.id)).limit(1);
    expect(afterMaya?.state).toBe("awaiting_approval");

    // Dan is named, so his press settles it.
    const byDan = await handleInteraction({
      actionId: "approve",
      contractId: background.id,
      slackUserId: "U0DAN",
    });
    expect(byDan.kind).toBe("decided");
    if (byDan.kind === "decided") expect(byDan.by).toBe("dan");

    const [afterDan] = await h.db.select().from(contracts).where(eq(contracts.id, background.id)).limit(1);
    expect(["verified", "done"]).toContain(afterDan?.state);
  }, 90_000);

  it("refuses an agent pressing the button", async () => {
    const { handleCommand, handleInteraction } = await surface();
    const drafted = await handleCommand({ text: 'new "Priya starts Monday hire_id=priya"', slackUserId: "U0MAYA" });
    if (drafted.kind !== "drafted") throw new Error("not drafted");
    await handleCommand({ text: `contract ${drafted.runId}`, slackUserId: "U0MAYA" });

    await h.db.update(workers).set({ slackUserId: "U0BOT" }).where(eq(workers.id, "provisioner"));
    const [background] = await h.db.select().from(contracts).where(eq(contracts.key, "background_check")).limit(1);

    const outcome = await handleInteraction({
      actionId: "approve",
      contractId: background?.id ?? "",
      slackUserId: "U0BOT",
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.text).toContain("only a person settles an approval");
  }, 90_000);
});

describe("WP-6 a revoked agent posts nothing", () => {
  it("is refused at the connector kit, not in a prompt", async () => {
    const registry = createRegistry({ simulatorsOnly: true });
    const [agent] = await h.db.select().from(workers).where(eq(workers.id, "welcomer")).limit(1);
    if (!agent) throw new Error("no welcomer");

    const ctx = (worker: Worker): OpContext => ({
      actor: { ...worker, canTouch: [...worker.canTouch, "chat.post"] },
      now: new Date(),
    });

    const posted = await registry.call("chat.post", { channel: "#t", text: "hello" }, ctx(agent));
    expect((posted.data as { text: string }).text).toBe("hello");

    const revoked: Worker = { ...agent, status: "revoked" };
    await expect(registry.call("chat.post", { channel: "#t", text: "still here" }, ctx(revoked))).rejects.toMatchObject(
      { code: "not_permitted" },
    );
    await expect(
      registry.call("chat.post", { channel: "#t", text: "still here" }, ctx(revoked)),
    ).rejects.toBeInstanceOf(ConnectorRefused);

    const chat = registry.get("chat") as { posts?: { text: string }[] };
    expect(chat.posts?.map((p) => p.text)).toEqual(["hello"]);
  });
});

describe("WP-6 the signature check", () => {
  it("accepts a correctly signed request and rejects a tampered one", () => {
    const secret = "test-secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "command=%2Fledger&text=new+%22Priya%22&user_id=U0MAYA";
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;

    expect(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody }).ok).toBe(true);
    expect(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody: `${rawBody}&x=1` }).ok).toBe(
      false,
    );
    expect(verifySlackSignature({ signingSecret: secret, timestamp: "100", signature, rawBody }).ok).toBe(false);
  });

  it("accepts requests when no signing secret is configured, which is the simulator", () => {
    const previous = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    expect(checkSignature(new Headers(), "anything").ok).toBe(true);
    if (previous) process.env.SLACK_SIGNING_SECRET = previous;
  });

  it("rejects an unsigned request when a signing secret is configured", () => {
    const previous = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = "test-secret";
    const result = checkSignature(new Headers(), "anything");
    expect(result.ok).toBe(false);
    if (previous) process.env.SLACK_SIGNING_SECRET = previous;
    else delete process.env.SLACK_SIGNING_SECRET;
  });
});

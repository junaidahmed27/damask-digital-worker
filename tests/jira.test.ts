import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorRegistry } from "@/lib/connectors";
import {
  createJiraConnector,
  DEFAULT_STATUS_MAP,
  jiraConfigFromEnv,
  ledgerStateFor,
  readJiraWebhook,
} from "@/lib/connectors/ticketing/jira";
import type { Worker } from "@/lib/db/schema";

/**
 * WP-9, the optional Jira adapter. Driven over a real socket against an endpoint
 * shaped like the Jira Cloud REST API, the same way the Teams connector is.
 */
let server: Server;
let baseUrl: string;
const calls: { method: string; path: string; body: unknown; auth: string | undefined }[] = [];

const actor: Worker = {
  id: "maya",
  orgId: "org_damask",
  name: "Maya Okonjo",
  kind: "person",
  identity: "clerk:maya",
  slackUserId: "U0MAYA",
  places: ["sheet"],
  canTouch: ["ticketing.create_issue", "ticketing.sync_state", "ticketing.get_issue"],
  neverWithoutHuman: [],
  role: "approver",
  status: "active",
  createdAt: new Date(),
};

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      calls.push({
        method: request.method ?? "GET",
        path,
        body: raw ? JSON.parse(raw) : null,
        auth: request.headers.authorization,
      });

      if (path.endsWith("/transitions") && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            transitions: [
              { id: "11", to: { name: "To Do" } },
              { id: "21", to: { name: "In Progress" } },
              { id: "31", to: { name: "In Review" } },
              { id: "41", to: { name: "Done" } },
            ],
          }),
        );
        return;
      }
      if (path.endsWith("/transitions") || path.endsWith("/comment")) {
        response.writeHead(204).end();
        return;
      }
      if (path === "/rest/api/3/issue" && request.method === "POST") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ key: "LED-41", id: "10041" }));
        return;
      }
      if (path.startsWith("/rest/api/3/issue/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            key: "LED-41",
            fields: { summary: "Accounts and access", status: { name: "In Review" }, assignee: { accountId: "acc-1" } },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function registry() {
  return new ConnectorRegistry().register(
    createJiraConnector({
      baseUrl,
      email: "ledger@example.test",
      apiToken: "token",
      projectKey: "LED",
    }),
  );
}

describe("WP-9 the Jira adapter", () => {
  it("is wired in only when its credentials are present", () => {
    expect(jiraConfigFromEnv()).toBe(null);
  });

  it("creates an issue per row, over the wire", async () => {
    calls.length = 0;
    const created = await registry().call(
      "ticketing.create_issue",
      {
        summary: "Accounts and access",
        description: "Create the account and assign exactly the role profile.",
        assignee: "acc-1",
        contract_id: "c_1",
      },
      { actor, now: new Date() },
    );

    const data = created.data as { key: string; url: string; contract_id: string };
    expect(data.key).toBe("LED-41");
    expect(data.url).toBe(`${baseUrl}/browse/LED-41`);
    expect(data.contract_id).toBe("c_1");
    expect(created.evidence.kind).toBe("jira_issue");

    const post = calls.find((c) => c.method === "POST" && c.path === "/rest/api/3/issue");
    expect(post?.auth?.startsWith("Basic ")).toBe(true);
    const fields = (post?.body as { fields: { project: { key: string }; assignee: { id: string } } }).fields;
    expect(fields.project.key).toBe("LED");
    expect(fields.assignee.id).toBe("acc-1");
  }, 30_000);

  it("moves the issue to the status the row's state maps to, and says why", async () => {
    calls.length = 0;
    const synced = await registry().call(
      "ticketing.sync_state",
      { key: "LED-41", state: "handed_back", reason: "the account holds crm-admin which the role profile does not allow" },
      { actor, now: new Date() },
    );

    const data = synced.data as { jira_status: string; moved: boolean };
    expect(data.jira_status).toBe("In Progress");
    expect(data.moved).toBe(true);

    const transition = calls.find((c) => c.method === "POST" && c.path.endsWith("/transitions"));
    expect((transition?.body as { transition: { id: string } }).transition.id).toBe("21");

    // The reason is on the issue too, so the log reads the same in both places.
    const comment = calls.find((c) => c.path.endsWith("/comment"));
    expect(JSON.stringify(comment?.body)).toContain("crm-admin");
  }, 30_000);

  it("reads an issue back and says which ledger state it is asking for", async () => {
    const read = await registry().call("ticketing.get_issue", { key: "LED-41" }, { actor, now: new Date() });
    const data = read.data as { jira_status: string; ledger_state: string | null };
    expect(data.jira_status).toBe("In Review");
    expect(data.ledger_state).toBeTruthy();
  }, 30_000);

  it("maps every ledger state onto a status, and back", () => {
    for (const state of Object.keys(DEFAULT_STATUS_MAP)) {
      expect(DEFAULT_STATUS_MAP[state], `${state} has no Jira status`).toBeTruthy();
    }
    // Several ledger states map to Done, and a change to Done asks for `done`,
    // which the state machine then refuses unless the row is verified.
    expect(ledgerStateFor("Done", DEFAULT_STATUS_MAP)).toBe("done");
    expect(ledgerStateFor("In Progress", DEFAULT_STATUS_MAP)).toBeTruthy();
    expect(ledgerStateFor("Nothing Like This", DEFAULT_STATUS_MAP)).toBeUndefined();
  });

  it("turns a person's change in Jira into a request, not a move", () => {
    const asked = readJiraWebhook({
      webhookEvent: "jira:issue_updated",
      issue: { key: "LED-41" },
      changelog: { items: [{ field: "status", toString: "Done" }] },
    });
    expect(asked).toEqual({ key: "LED-41", asks: "done" });

    // Anything else is not a state change and is ignored.
    expect(
      readJiraWebhook({
        webhookEvent: "jira:issue_updated",
        issue: { key: "LED-41" },
        changelog: { items: [{ field: "summary", toString: "renamed" }] },
      }),
    ).toBeUndefined();
    expect(readJiraWebhook({ webhookEvent: "jira:issue_created", issue: { key: "LED-41" } })).toBeUndefined();
  });
});

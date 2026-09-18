import { describe, expect, it } from "vitest";
import type { Worker } from "@/lib/db/schema";
import { ConnectorRefused, createRegistry, type OpContext } from "@/lib/connectors";
import { createHrisSimulator } from "@/lib/connectors/hris/simulator";
import { verifySlackSignature } from "@/lib/connectors/chat/slack";
import { createHmac } from "node:crypto";

const TODAY = new Date("2026-09-18T12:00:00Z");
const SEPT_10 = new Date("2026-09-10T12:00:00Z");

const agent: Worker = {
  id: "provisioner",
  orgId: "org_damask",
  name: "Provisioner",
  kind: "agent",
  identity: "agent:provisioner",
  slackUserId: null,
  places: ["sheet"],
  canTouch: [
    "idp.create_user",
    "idp.assign_groups",
    "mdm.order_device",
    "facilities.request_badge",
    "facilities.assign_desk",
    "hris.enrol_payroll",
    "hris.background_check",
  ],
  neverWithoutHuman: [],
  role: "worker",
  status: "active",
  createdAt: TODAY,
};

function ctx(overrides: Partial<OpContext> = {}): OpContext {
  return { actor: agent, now: TODAY, ...overrides };
}

describe("WP-4 the HRIS simulator honours as of", () => {
  it("returns the old address as of 10 September and the new one as of today", async () => {
    const hris = createHrisSimulator();
    const before = await hris.ops.get_worker?.run({ id: "priya" }, ctx({ asOf: SEPT_10 }));
    const today = await hris.ops.get_worker?.run({ id: "priya" }, ctx({ asOf: TODAY }));

    const beforeAddress = (before?.data as { address: { line1: string } }).address;
    const todayAddress = (today?.data as { address: { line1: string } }).address;

    expect(beforeAddress.line1).toBe("1200 Guadalupe Street");
    expect(todayAddress.line1).toBe("3401 Red River Street");
    expect(before?.asOf?.toISOString()).toBe(SEPT_10.toISOString());
    expect(today?.asOf?.toISOString()).toBe(TODAY.toISOString());
  });

  it("returns the effective record for the instant asked for through the registry", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const before = await reg.call("hris.get_worker", { id: "priya" }, ctx({ asOf: SEPT_10 }));
    const after = await reg.call("hris.get_worker", { id: "priya" }, ctx({ asOf: TODAY }));
    expect((before.data as { address: { postcode: string } }).address.postcode).toBe("78701");
    expect((after.data as { address: { postcode: string } }).address.postcode).toBe("78705");
  });

  it("carries the role profile the access check compares against", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const profile = await reg.call("hris.get_role_profile", { name: "sales_engineer" }, ctx());
    expect((profile.data as { groups: string[] }).groups).not.toContain("crm-admin");
    expect(profile.evidence.kind).toBe("role_profile");
  });
});

describe("WP-4 the kit refuses at the connector, not in a prompt", () => {
  it("refuses a write the actor may not make", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const stranger: Worker = { ...agent, id: "shipper", name: "Shipper", canTouch: ["shipping.book"] };
    await expect(reg.call("idp.assign_groups", { id: "priya", groups: [] }, ctx({ actor: stranger }))).rejects.toThrow(
      ConnectorRefused,
    );
  });

  it("allows a write the actor may make", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const written = await reg.call("idp.assign_groups", { id: "priya", groups: ["everyone"] }, ctx());
    expect((written.data as { groups: string[] }).groups).toEqual(["everyone"]);
  });

  it("refuses a source whose data policy is not allowed", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const hris = reg.get("hris");
    if (hris) hris.dataPolicy = "pending_review";
    await expect(reg.call("hris.get_worker", { id: "priya" }, ctx())).rejects.toMatchObject({
      code: "data_policy",
    });
    if (hris) hris.dataPolicy = "allowed";
  });

  it("refuses an as of read of a connector that cannot answer one", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    await expect(reg.call("idp.list_groups", {}, ctx({ asOf: SEPT_10 }))).rejects.toMatchObject({ code: "no_as_of" });
  });

  it("refuses an unknown op", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    await expect(reg.call("hris.invent_something", {}, ctx())).rejects.toMatchObject({ code: "unknown_op" });
  });
});

describe("WP-4 every op result carries its provenance", () => {
  it("returns data, source, as of and an evidence draft", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const booked = await reg.call(
      "shipping.book",
      {
        to: { line1: "3401 Red River Street", city: "Austin", state: "TX", postcode: "78705", country: "US" },
        service_level: "two_day",
      },
      ctx({ actor: { ...agent, canTouch: ["shipping.book"] } }),
    );
    expect(booked.source).toBe("shipping.simulator");
    expect(booked.asOf).toBeInstanceOf(Date);
    expect(booked.evidence.kind).toBe("shipping_booking");
    expect(booked.evidence.body.tracking_number).toBeTruthy();
  });

  it("only resolves a tracking number the carrier actually issued", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const shipper = { ...agent, canTouch: ["shipping.book"] };
    const booked = await reg.call(
      "shipping.book",
      {
        to: { line1: "3401 Red River Street", city: "Austin", state: "TX", postcode: "78705", country: "US" },
      },
      ctx({ actor: shipper }),
    );
    const number = (booked.data as { tracking_number: string }).tracking_number;

    const found = await reg.call("shipping.track", { tracking_number: number }, ctx({ actor: shipper }));
    expect((found.data as { found: boolean }).found).toBe(true);

    const invented = await reg.call("shipping.track", { tracking_number: "SW0000000000" }, ctx({ actor: shipper }));
    expect((invented.data as { found: boolean }).found).toBe(false);
  });

  it("refuses a booking to an address the carrier does not serve", async () => {
    const reg = createRegistry({ simulatorsOnly: true });
    await expect(
      reg.call(
        "shipping.book",
        { to: { line1: "nowhere", city: "Austin", state: "TX", postcode: "99999", country: "US" } },
        ctx({ actor: { ...agent, canTouch: ["shipping.book"] } }),
      ),
    ).rejects.toThrow(/does not serve/);
  });
});

describe("WP-4 the documents connector creates a doc and writes sections", () => {
  it("creates a document and writes a section per row", async () => {
    const reg = createRegistry({ simulatorsOnly: true, dataDir: ".ledger-data/test" });
    const writer = { ...agent, canTouch: ["docs.create_doc", "docs.write_section"] };
    const created = await reg.call("docs.create_doc", { title: "Day One: Priya Raman" }, ctx({ actor: writer }));
    const documentId = (created.data as { document_id: string }).document_id;
    expect(documentId).toBeTruthy();

    await reg.call(
      "docs.write_section",
      { document_id: documentId, heading: "Accounts and access", body: "Granted the sales engineer groups." },
      ctx({ actor: writer }),
    );
    await reg.call(
      "docs.write_section",
      { document_id: documentId, heading: "Laptop shipped", body: "Booked to the address as of today." },
      ctx({ actor: writer }),
    );

    const read = await reg.call("docs.read_doc", { document_id: documentId }, ctx({ actor: writer }));
    const sections = (read.data as { sections: { heading: string }[] }).sections;
    expect(sections.map((s) => s.heading)).toEqual(["Accounts and access", "Laptop shipped"]);
  });
});

describe("WP-4 the mail connector never sends", () => {
  it("writes to the sandbox and marks the message undelivered", async () => {
    const reg = createRegistry({ simulatorsOnly: true, dataDir: ".ledger-data/test" });
    const welcomer = { ...agent, canTouch: ["mail.send_sandbox"] };
    const sent = await reg.call(
      "mail.send_sandbox",
      { to: "priya.raman@example.test", subject: "Welcome", body: "See you Monday." },
      ctx({ actor: welcomer }),
    );
    expect((sent.data as { delivered: boolean }).delivered).toBe(false);
    expect(reg.get("mail")?.ops.send_mail).toBeUndefined();
  });
});

describe("WP-4 the tool list an agent sees is its allowed ops only", () => {
  it("filters the registry to the worker's tools", () => {
    const reg = createRegistry({ simulatorsOnly: true });
    const tools = reg.toolsFor(["hris.get_worker", "shipping.book", "idp.assign_groups"]);
    expect(tools.map((t) => t.name).sort()).toEqual(["hris.get_worker", "idp.assign_groups", "shipping.book"]);
    expect(tools.every((t) => t.description.length > 10)).toBe(true);
    expect(tools.every((t) => t.input_schema.type === "object")).toBe(true);
  });
});

describe("WP-4 the Slack signature check", () => {
  it("accepts a correctly signed request and rejects a tampered one", () => {
    const secret = "shhh";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&command=%2Fledger";
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;

    expect(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody })).toEqual({ ok: true });
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody: `${rawBody}&extra=1` }).ok,
    ).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: "1000", signature, rawBody }).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { rowsOf } from "@/lib/db/client";
import { loadWorkflow } from "@/lib/workflow/definition";
import { seededDb } from "./helpers";

describe("WP-1 schema and seed", () => {
  it("loads the Day One cast of six and the workflow", async () => {
    const h = await seededDb();

    // The Day One cast, which is what WP-1's acceptance counts. Later packs add
    // their own workers to the same table, so the assertion is about this cast
    // being present and complete rather than about the size of the table.
    const dayOne = rowsOf<{ id: string; kind: string }>(
      await h.db.execute(
        sql`select id, kind from workers where id in ('maya','dan','priya','provisioner','shipper','welcomer') order by id`,
      ),
    );
    expect(dayOne).toHaveLength(6);
    expect(dayOne.map((w) => w.id)).toEqual(["dan", "maya", "priya", "provisioner", "shipper", "welcomer"]);
    expect(dayOne.filter((w) => w.kind === "person")).toHaveLength(3);
    expect(dayOne.filter((w) => w.kind === "agent")).toHaveLength(3);

    const wf = rowsOf<{ name: string }>(await h.db.execute(sql`select name from workflows order by name`));
    expect(wf.map((w) => w.name)).toEqual(["day_one", "kl_intake", "kl_sourcing"]);
    await h.close();
  });

  it("is idempotent", async () => {
    const h = await seededDb();
    const [before] = rowsOf<{ count: string }>(await h.db.execute(sql`select count(*) as count from workers`));
    const { seed } = await import("@/lib/seed");
    await seed(h);
    const [after] = rowsOf<{ count: string }>(await h.db.execute(sql`select count(*) as count from workers`));
    expect(after?.count).toBe(before?.count);
    await h.close();
  });

  it("parses the Day One workflow into seven rows with the traps declared", async () => {
    const def = loadWorkflow("day_one");
    expect(def.metadata).toMatchObject({ name: "day_one", version: 1, pack: "onboarding", shape: "plan" });
    expect(def.rows).toHaveLength(7);
    expect(def.rows.map((r) => r.key)).toEqual([
      "accounts_access",
      "laptop_shipped",
      "badge_desk",
      "payroll_enrolment",
      "background_check",
      "first_week_schedule",
      "welcome_email",
    ]);
    const welcome = def.rows.find((r) => r.key === "welcome_email");
    expect(welcome?.blocked_by).toHaveLength(6);
    expect(def.approvals.find((a) => a.check === "background_check_cleared_by_human")?.by).toEqual(["dan"]);
  });

  it("carries the address trap in the effective dated HRIS fixture", async () => {
    const { fixture } = await import("@/lib/fixtures");
    const hris = fixture<{ workers: Record<string, { effective_from: string; address: { line1: string } }[]> }>(
      "day_one/hris.json",
    );
    const priya = hris.workers.priya ?? [];
    expect(priya).toHaveLength(2);
    expect(priya[0]?.address.line1).not.toBe(priya[1]?.address.line1);
    const offer = fixture<{ address: { line1: string } }>("day_one/offer_letter.json");
    expect(offer.address.line1).toBe(priya[0]?.address.line1);
  });

  it("carries the role trap in the identity provider fixture", async () => {
    const { fixture } = await import("@/lib/fixtures");
    const idp = fixture<{ users: Record<string, { groups: string[] }> }>("day_one/idp.json");
    const hris = fixture<{ role_profiles: Record<string, { groups: string[] }> }>("day_one/hris.json");
    const jordan = idp.users.jordan?.groups ?? [];
    const profile = hris.role_profiles.sales_engineer?.groups ?? [];
    expect(jordan).toContain("crm-admin");
    expect(profile).not.toContain("crm-admin");
  });
});

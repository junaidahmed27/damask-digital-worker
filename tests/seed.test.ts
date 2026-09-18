import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { rowsOf } from "@/lib/db/client";
import { loadWorkflow } from "@/lib/workflow/definition";
import { seededDb } from "./helpers";

describe("WP-1 schema and seed", () => {
  it("loads six workers and the workflow", async () => {
    const h = await seededDb();
    const [count] = rowsOf<{ count: string }>(await h.db.execute(sql`select count(*) as count from workers`));
    expect(Number(count?.count)).toBe(6);

    const workers = rowsOf<{ id: string; kind: string }>(
      await h.db.execute(sql`select id, kind from workers order by id`),
    );
    expect(workers.map((w) => w.id).sort()).toEqual([
      "dan",
      "maya",
      "priya",
      "provisioner",
      "shipper",
      "welcomer",
    ]);
    expect(workers.filter((w) => w.kind === "person")).toHaveLength(3);
    expect(workers.filter((w) => w.kind === "agent")).toHaveLength(3);

    const wf = rowsOf<{ name: string; version: number }>(
      await h.db.execute(sql`select name, version from workflows`),
    );
    expect(wf).toEqual([{ name: "day_one", version: 1 }]);
    await h.close();
  });

  it("is idempotent", async () => {
    const h = await seededDb();
    const { seed } = await import("@/lib/seed");
    await seed(h);
    const [count] = rowsOf<{ count: string }>(await h.db.execute(sql`select count(*) as count from workers`));
    expect(Number(count?.count)).toBe(6);
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

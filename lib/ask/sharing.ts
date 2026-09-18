import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  columns,
  contracts,
  memberships,
  shares,
  sheets,
  signals,
  templates,
  workers,
  type Share,
  type Worker,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { readSheet } from "@/lib/sheet/model";

/**
 * Sharing. A sheet or a single row can be shared inside the organization or, by
 * explicit grant and a logged scope, with a person at another one. A cross
 * organization row is the first real test of whether a contract travels, so an
 * outside person's edit is a cell transition with their identity on it, exactly
 * like anybody else's.
 *
 * A grant never reaches further than the granter holds.
 */

export type GrantArgs = {
  subject: "sheet" | "row";
  subjectId: string;
  /** An existing worker, or an outside person to create one for. */
  grantee: { id: string } | { email: string; name: string; orgId?: string };
  access: "read" | "comment" | "edit";
  grantedBy: string;
  reason?: string;
  scopes?: string[];
  expiresAt?: Date;
};

export type GrantResult =
  | { ok: true; share: Share; grantee: Worker; created: boolean }
  | { ok: false; reason: string };

export async function share(db: Db, args: GrantArgs): Promise<GrantResult> {
  const [granter] = await db.select().from(workers).where(eq(workers.id, args.grantedBy)).limit(1);
  if (!granter) return { ok: false, reason: "no such granter" };
  if (granter.kind !== "person") return { ok: false, reason: "an agent does not share a sheet; a person does" };

  // A grant never reaches further than the granter's own scopes.
  const granterScopes = await scopesOf(db, granter.id);
  const wanted = args.scopes ?? granterScopes;
  const beyond = wanted.filter((scope) => !granterScopes.includes(scope));
  if (beyond.length > 0) {
    return { ok: false, reason: `${granter.name} cannot grant ${beyond.join(", ")}, which they do not hold themselves` };
  }

  let grantee: Worker | undefined;
  let created = false;

  if ("id" in args.grantee) {
    [grantee] = await db.select().from(workers).where(eq(workers.id, args.grantee.id)).limit(1);
    if (!grantee) return { ok: false, reason: "no such person" };
  } else {
    // An outside person becomes a worker, because everything that touches a row
    // is a worker. Their organization is recorded so the grant is visibly a
    // cross organization one.
    const id = `ext_${args.grantee.email.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    const [existing] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
    if (existing) grantee = existing;
    else {
      const [inserted] = await db
        .insert(workers)
        .values({
          id,
          orgId: args.grantee.orgId ?? null,
          name: args.grantee.name,
          kind: "person",
          identity: `email:${args.grantee.email.toLowerCase()}`,
          places: ["sheet"],
          canTouch: [],
          neverWithoutHuman: [],
          role: "guest",
          status: "active",
        })
        .returning();
      grantee = inserted;
      created = true;
    }
  }
  if (!grantee) return { ok: false, reason: "the person could not be created" };

  const [row] = await db
    .insert(shares)
    .values({
      id: newId("sh"),
      subject: args.subject,
      subjectId: args.subjectId,
      granteeId: grantee.id,
      granteeOrgId: grantee.orgId,
      access: args.access,
      scopes: wanted,
      grantedBy: granter.id,
      reason: args.reason ?? null,
      expiresAt: args.expiresAt ?? null,
    })
    .returning();
  if (!row) return { ok: false, reason: "the share was not written" };

  // The grant is a signal too, because who a row travelled to is part of what
  // happened to it.
  await db.insert(signals).values({
    id: newId("sg"),
    workerId: granter.id,
    kind: "shared",
    payload: {
      subject: args.subject,
      subject_id: args.subjectId,
      to: grantee.id,
      to_org: grantee.orgId,
      access: args.access,
      scopes: wanted,
      reason: args.reason ?? null,
      cross_organization: grantee.orgId !== granter.orgId,
    },
  });

  return { ok: true, share: row, grantee, created };
}

export async function revokeShare(db: Db, shareId: string, actorId: string): Promise<void> {
  await db.update(shares).set({ revokedAt: new Date() }).where(eq(shares.id, shareId));
  await db.insert(signals).values({
    id: newId("sg"),
    workerId: actorId,
    kind: "share_revoked",
    payload: { share_id: shareId },
  });
}

export type Access = { may: "read" | "comment" | "edit" | "none"; via: "member" | "share" | "none"; scopes: string[] };

/**
 * What this person may do with this sheet or row. A member of the organization
 * reads it; anybody else needs a grant, and the grant says how far it goes.
 */
export async function accessTo(
  db: Db,
  args: { workerId: string; subject: "sheet" | "row"; subjectId: string; now?: Date },
): Promise<Access> {
  const now = args.now ?? new Date();
  const [worker] = await db.select().from(workers).where(eq(workers.id, args.workerId)).limit(1);
  if (!worker) return { may: "none", via: "none", scopes: [] };

  const owningOrg = await orgOf(db, args.subject, args.subjectId);
  const isMember =
    worker.orgId !== null &&
    owningOrg !== null &&
    worker.orgId === owningOrg &&
    (await db.select().from(memberships).where(eq(memberships.workerId, worker.id))).length > 0;

  if (isMember) return { may: "edit", via: "member", scopes: await scopesOf(db, worker.id) };

  // A row is reachable through a share on the row, or on the sheet it sits in.
  const subjects: { subject: "sheet" | "row"; subjectId: string }[] = [
    { subject: args.subject, subjectId: args.subjectId },
  ];
  if (args.subject === "row") {
    const sheetId = await sheetOfRow(db, args.subjectId);
    if (sheetId) subjects.push({ subject: "sheet", subjectId: sheetId });
  }

  for (const entry of subjects) {
    const granted = await db
      .select()
      .from(shares)
      .where(
        and(
          eq(shares.granteeId, worker.id),
          eq(shares.subject, entry.subject),
          eq(shares.subjectId, entry.subjectId),
          isNull(shares.revokedAt),
          or(isNull(shares.expiresAt), undefined),
        ),
      );
    const live = granted.filter((row) => !row.expiresAt || row.expiresAt > now);
    const best = live.sort((a, b) => rank(b.access) - rank(a.access))[0];
    if (best) return { may: best.access, via: "share", scopes: best.scopes };
  }

  return { may: "none", via: "none", scopes: [] };
}

export async function sharesOf(db: Db, subject: "sheet" | "row", subjectId: string): Promise<Share[]> {
  return db
    .select()
    .from(shares)
    .where(and(eq(shares.subject, subject), eq(shares.subjectId, subjectId), isNull(shares.revokedAt)));
}

export async function sharedWith(db: Db, workerId: string): Promise<Share[]> {
  return db.select().from(shares).where(and(eq(shares.granteeId, workerId), isNull(shares.revokedAt)));
}

/* --------------------------------------------------------------- templates */

/**
 * Publishing a sheet to the organization's library. A plan that worked twice is
 * worth offering to the next person who asks for something like it, which is what
 * makes the library grow from what a team actually does rather than from what
 * somebody imagined they would do.
 */
export async function publishTemplate(
  db: Db,
  args: { sheetId: string; name: string; description: string; publishedBy: string; visibility?: "org" | "public" },
): Promise<{ ok: true; templateId: string } | { ok: false; reason: string }> {
  const [person] = await db.select().from(workers).where(eq(workers.id, args.publishedBy)).limit(1);
  if (!person || person.kind !== "person") return { ok: false, reason: "a person publishes a template" };

  const view = await readSheet(db, args.sheetId);
  if (!view) return { ok: false, reason: "no such sheet" };

  const definition = {
    metadata: { name: args.name, shape: view.sheet.shape, version: 1 },
    columns: view.columns.map((column) => ({ name: column.name, type: column.type, config: column.config })),
    from: { sheet: view.sheet.id, definitionVersion: view.sheet.definitionVersion },
  };

  const [row] = await db
    .insert(templates)
    .values({
      id: newId("tpl"),
      orgId: person.orgId,
      name: args.name,
      description: args.description,
      definition,
      fromSheetId: args.sheetId,
      publishedBy: person.id,
      visibility: args.visibility ?? "org",
    })
    .onConflictDoNothing()
    .returning();

  if (!row) return { ok: false, reason: `${args.name} is already in the library` };
  return { ok: true, templateId: row.id };
}

export async function library(db: Db, orgId: string | null) {
  return db.select().from(templates).where(orgId ? eq(templates.orgId, orgId) : isNull(templates.orgId));
}

/* ----------------------------------------------------------------- shared */

async function scopesOf(db: Db, workerId: string): Promise<string[]> {
  const rows = await db.select().from(memberships).where(eq(memberships.workerId, workerId));
  const granted = await sharedWith(db, workerId);
  return [...new Set(["org", ...rows.map((r) => `org:${r.orgId}`), ...granted.flatMap((g) => g.scopes)])];
}

async function orgOf(db: Db, subject: "sheet" | "row", subjectId: string): Promise<string | null> {
  if (subject === "sheet") {
    const [sheet] = await db.select().from(sheets).where(eq(sheets.id, subjectId)).limit(1);
    return sheet?.orgId ?? "org_damask";
  }
  const [row] = await db.select().from(contracts).where(eq(contracts.id, subjectId)).limit(1);
  return row ? "org_damask" : null;
}

async function sheetOfRow(db: Db, rowId: string): Promise<string | undefined> {
  const [row] = await db.select().from(contracts).where(eq(contracts.id, rowId)).limit(1);
  if (!row) return undefined;
  const [sheet] = await db.select().from(sheets).where(eq(sheets.runId, row.runId)).limit(1);
  return sheet?.id;
}

function rank(access: Share["access"]): number {
  return { read: 1, comment: 2, edit: 3 }[access];
}

export { columns };

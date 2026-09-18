import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  checkResults,
  contracts,
  evidence as evidenceTable,
  runs,
  transitions,
  workers,
  workflows,
} from "@/lib/db/schema";
import { verifyChainRows, type ChainVerification } from "./hash";

/**
 * The audit export. It answers "who approved Priya's access" from the record
 * rather than from anybody's memory: every row, every transition with its actor
 * and hash, every piece of evidence with its digest, and every approval with the
 * name of the person who gave it.
 */

export type AuditApproval = {
  row: string;
  title: string;
  check: string;
  approvedBy: string;
  approverName: string;
  reason: string | null;
  at: string;
};

export type AuditRow = {
  key: string;
  title: string;
  owner: string;
  ownerKind: string;
  state: string;
  check: string;
  chain: ChainVerification;
  transitions: { seq: number; from: string | null; to: string; actor: string; reason: string | null; at: string; hash: string }[];
  evidence: { kind: string; sha256: string; source: string | null; asOf: string | null; at: string; by: string }[];
  checks: { checkId: string; passed: boolean; at: string; details: Record<string, unknown> }[];
};

export type AuditExport = {
  run: { id: string; goal: string; workflow: string; version: number; requestedBy: string; status: string; startedAt: string };
  generatedAt: string;
  chainsOk: boolean;
  approvals: AuditApproval[];
  rows: AuditRow[];
  counts: { rows: number; done: number; transitions: number; evidence: number; handbacks: number };
};

export async function exportAudit(db: Db, runId: string): Promise<AuditExport> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`no run ${runId}`);
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);

  const rows = await db.select().from(contracts).where(eq(contracts.runId, runId)).orderBy(asc(contracts.position));
  const everyWorker = new Map((await db.select().from(workers)).map((w) => [w.id, w]));

  const out: AuditRow[] = [];
  const approvals: AuditApproval[] = [];
  let transitionCount = 0;
  let evidenceCount = 0;
  let handbacks = 0;

  for (const contract of rows) {
    const history = await db
      .select()
      .from(transitions)
      .where(eq(transitions.contractId, contract.id))
      .orderBy(asc(transitions.seq));
    const items = await db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.contractId, contract.id))
      .orderBy(asc(evidenceTable.recordedAt));
    const results = await db
      .select()
      .from(checkResults)
      .where(eq(checkResults.contractId, contract.id))
      .orderBy(asc(checkResults.recordedAt));

    transitionCount += history.length;
    evidenceCount += items.length;
    handbacks += history.filter((t) => t.toState === "handed_back").length;

    for (const t of history) {
      const cameFromApproval = t.fromState === "awaiting_approval" && t.toState === "verified";
      if (!cameFromApproval) continue;
      approvals.push({
        row: contract.key,
        title: contract.title,
        check: contract.checkId ?? "human_review",
        approvedBy: t.actorId,
        approverName: everyWorker.get(t.actorId)?.name ?? t.actorId,
        reason: t.reason,
        at: t.recordedAt.toISOString(),
      });
    }

    out.push({
      key: contract.key,
      title: contract.title,
      owner: contract.ownerId ?? "unassigned",
      ownerKind: contract.ownerId ? (everyWorker.get(contract.ownerId)?.kind ?? "unknown") : "unassigned",
      state: contract.state,
      check: contract.checkId ?? "human_review",
      chain: verifyChainRows(history),
      transitions: history.map((t) => ({
        seq: t.seq,
        from: t.fromState,
        to: t.toState,
        actor: everyWorker.get(t.actorId)?.name ?? t.actorId,
        reason: t.reason,
        at: t.recordedAt.toISOString(),
        hash: t.hash,
      })),
      evidence: items.map((e) => ({
        kind: e.kind,
        sha256: e.sha256,
        source: e.sourceConnector,
        asOf: e.asOf?.toISOString() ?? null,
        at: e.recordedAt.toISOString(),
        by: everyWorker.get(e.createdBy)?.name ?? e.createdBy,
      })),
      checks: results.map((r) => ({
        checkId: r.checkId,
        passed: r.passed,
        at: r.recordedAt.toISOString(),
        details: r.details,
      })),
    });
  }

  return {
    run: {
      id: run.id,
      goal: run.goal,
      workflow: workflow?.name ?? run.workflowId,
      version: run.workflowVersion,
      requestedBy: everyWorker.get(run.requestedBy)?.name ?? run.requestedBy,
      status: run.status,
      startedAt: run.createdAt.toISOString(),
    },
    generatedAt: new Date().toISOString(),
    chainsOk: out.every((r) => r.chain.ok),
    approvals,
    rows: out,
    counts: {
      rows: rows.length,
      done: rows.filter((r) => r.state === "done").length,
      transitions: transitionCount,
      evidence: evidenceCount,
      handbacks,
    },
  };
}

/** The printable page. Plain HTML so it prints and archives without a build step. */
export function renderAuditPage(audit: AuditExport): string {
  const approvals =
    audit.approvals.length === 0
      ? "<p>No approvals were given in this run.</p>"
      : `<table><thead><tr><th>Row</th><th>Check</th><th>Approved by</th><th>Reason</th><th>When</th></tr></thead><tbody>${audit.approvals
          .map(
            (a) =>
              `<tr><td>${escapeHtml(a.title)}</td><td class="mono">${escapeHtml(a.check)}</td><td><strong>${escapeHtml(
                a.approverName,
              )}</strong></td><td>${escapeHtml(a.reason ?? "")}</td><td>${escapeHtml(a.at)}</td></tr>`,
          )
          .join("")}</tbody></table>`;

  const rows = audit.rows
    .map(
      (row) => `
      <section class="row">
        <h3>${escapeHtml(row.title)} <span class="mono muted">${escapeHtml(row.key)}</span></h3>
        <p class="muted">Owner ${escapeHtml(row.owner)} (${escapeHtml(row.ownerKind)}) &middot; check ${escapeHtml(
          row.check,
        )} &middot; state ${escapeHtml(row.state)} &middot; chain ${row.chain.ok ? "verifies" : "BROKEN"}</p>
        <table><thead><tr><th>#</th><th>From</th><th>To</th><th>Actor</th><th>Reason</th><th>When</th><th>Hash</th></tr></thead><tbody>
          ${row.transitions
            .map(
              (t) =>
                `<tr><td>${t.seq}</td><td class="mono">${escapeHtml(t.from ?? "-")}</td><td class="mono">${escapeHtml(
                  t.to,
                )}</td><td>${escapeHtml(t.actor)}</td><td>${escapeHtml(t.reason ?? "")}</td><td class="muted">${escapeHtml(
                  t.at,
                )}</td><td class="mono muted">${escapeHtml(t.hash.slice(0, 16))}</td></tr>`,
            )
            .join("")}
        </tbody></table>
        <h4>Evidence</h4>
        ${
          row.evidence.length === 0
            ? "<p class='muted'>None.</p>"
            : `<table><thead><tr><th>Kind</th><th>Source</th><th>As of</th><th>By</th><th>Digest</th></tr></thead><tbody>${row.evidence
                .map(
                  (e) =>
                    `<tr><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.source ?? "artefact")}</td><td>${escapeHtml(
                      e.asOf ?? "-",
                    )}</td><td>${escapeHtml(e.by)}</td><td class="mono">${escapeHtml(e.sha256)}</td></tr>`,
                )
                .join("")}</tbody></table>`
        }
      </section>`,
    )
    .join("");

  return `<!doctype html>
<meta charset="utf-8">
<title>Audit: ${escapeHtml(audit.run.goal)}</title>
<style>
  body { font: 13px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; color: #1a1a19; margin: 32px auto; max-width: 980px; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; border-bottom: 1px solid #e4e2dd; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 20px 0 2px; }
  h4 { font-size: 12px; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #6b6a66; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 12px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #ecebe7; vertical-align: top; }
  th { color: #6b6a66; font-weight: 600; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color: #6b6a66; }
  .ok { color: #2f6b45; } .broken { color: #9a2f2f; }
  .row { break-inside: avoid; }
  @media print { body { margin: 0; } }
</style>
<h1>${escapeHtml(audit.run.goal)}</h1>
<p class="muted">
  ${escapeHtml(audit.run.workflow)} v${audit.run.version} &middot; requested by ${escapeHtml(audit.run.requestedBy)} &middot;
  started ${escapeHtml(audit.run.startedAt)} &middot; exported ${escapeHtml(audit.generatedAt)}
</p>
<p>
  ${audit.counts.done} of ${audit.counts.rows} rows done &middot; ${audit.counts.transitions} transitions &middot;
  ${audit.counts.evidence} pieces of evidence &middot; ${audit.counts.handbacks} hand backs &middot;
  <span class="${audit.chainsOk ? "ok" : "broken"}">${audit.chainsOk ? "every hash chain verifies" : "A HASH CHAIN IS BROKEN"}</span>
</p>
<h2>Approvals</h2>
${approvals}
<h2>Rows</h2>
${rows}
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

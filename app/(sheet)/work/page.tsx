import Link from "next/link";
import { readWork } from "@/lib/sheet/read";
import { WorkGrid, type GridRow } from "./WorkGrid";
import { NewRun } from "./NewRun";

export const dynamic = "force-dynamic";

export default async function WorkPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run: requested } = await searchParams;
  const view = await readWork(requested);

  if (!view.run) {
    return (
      <>
        <h1>Work</h1>
        <p className="sub">Contracts across every run. One row is one unit of work.</p>
        <div className="empty">
          No runs yet. Run <code>make demo</code>, or start one here.
        </div>
        <NewRun />
      </>
    );
  }

  const rows: GridRow[] = view.rows.map((row) => ({
    id: row.contract.id,
    key: row.contract.key,
    title: row.contract.title,
    goal: row.contract.goal,
    owner: row.owner ? { id: row.owner.id, name: row.owner.name, kind: row.owner.kind } : null,
    state: row.contract.state,
    checkId: row.contract.checkId,
    evidenceCount: row.evidence.length,
    evidence: row.evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      sha256: e.sha256,
      sourceConnector: e.sourceConnector,
      asOf: e.asOf?.toISOString() ?? null,
      recordedAt: e.recordedAt.toISOString(),
      createdBy: e.createdBy,
      uri: e.uri,
      body: e.body,
    })),
    checks: row.checks.map((c) => ({
      checkId: c.checkId,
      passed: c.passed,
      details: c.details,
      recordedAt: c.recordedAt.toISOString(),
    })),
    history: row.history.map((t) => ({
      seq: t.seq,
      from: t.fromState,
      to: t.toState,
      actorId: t.actorId,
      reason: t.reason,
      recordedAt: t.recordedAt.toISOString(),
      hash: t.hash,
    })),
    blockers: row.blockers,
    deadline: row.contract.deadline?.toISOString() ?? null,
  }));

  const done = rows.filter((r) => r.state === "done").length;

  return (
    <>
      <h1>Work</h1>
      <p className="sub">
        {view.run.workflowName} &middot; {view.run.goal} &middot; {done} of {rows.length} rows done &middot;{" "}
        <Link href={`/runs/${view.run.id}`}>the run log</Link>
        {view.documentUrl && (
          <>
            {" "}
            &middot; <span className="mono">{view.documentUrl}</span>
          </>
        )}
      </p>

      {view.runs.length > 1 && (
        <p className="sub">
          Runs:{" "}
          {view.runs.map((r) => (
            <Link key={r.id} href={`/work?run=${r.id}`} className={r.id === view.run?.id ? "current" : undefined}>
              {r.workflowName} {new Date(r.createdAt).toLocaleTimeString()}{" "}
            </Link>
          ))}
        </p>
      )}

      <WorkGrid rows={rows} runId={view.run.id} />
      <NewRun />
    </>
  );
}

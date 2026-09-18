"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type GridRow = {
  id: string;
  key: string;
  title: string;
  goal: string;
  owner: { id: string; name: string; kind: string } | null;
  state: string;
  checkId: string | null;
  evidenceCount: number;
  evidence: {
    id: string;
    kind: string;
    sha256: string;
    sourceConnector: string | null;
    asOf: string | null;
    recordedAt: string;
    createdBy: string;
    uri: string | null;
    body: Record<string, unknown> | null;
  }[];
  checks: { checkId: string; passed: boolean; details: Record<string, unknown>; recordedAt: string }[];
  history: {
    seq: number;
    from: string | null;
    to: string;
    actorId: string;
    reason: string | null;
    recordedAt: string;
    hash: string;
  }[];
  blockers: { key: string; state: string }[];
  deadline: string | null;
};

const TERMINAL = new Set(["done", "verified"]);

export function WorkGrid({ rows, runId }: { rows: GridRow[]; runId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ rowId: string; message: string; invariant?: number } | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<Record<string, string | null> | null>(null);
  const [pending, startTransition] = useTransition();

  const instants = [...new Set(rows.flatMap((r) => r.history.map((t) => t.recordedAt)))].sort();
  const openRow = rows.find((r) => r.id === open);

  async function typeIntoStatus(row: GridRow, typed: string) {
    setRefusal(null);
    const response = await fetch(`/api/contracts/${row.id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typed }),
    });
    const payload = (await response.json()) as { refusal?: { message: string; invariant?: number } };
    if (!response.ok) {
      setRefusal({
        rowId: row.id,
        message: payload.refusal?.message ?? "that edit was refused",
        invariant: payload.refusal?.invariant,
      });
      return;
    }
    startTransition(() => router.refresh());
  }

  async function decide(row: GridRow, decision: "approve" | "hand_back") {
    const response = await fetch("/api/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract_id: row.id, decision, reason: `${decision} from the sheet` }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setRefusal({ rowId: row.id, message: payload.error ?? "that decision was refused" });
      return;
    }
    startTransition(() => router.refresh());
  }

  async function slideTo(value: string | null) {
    setAsOf(value);
    if (!value) {
      setReplayed(null);
      return;
    }
    const response = await fetch(`/api/replay?run_id=${runId}&as_of=${encodeURIComponent(value)}`);
    const payload = (await response.json()) as { rows: { contractId: string; state: string | null }[] };
    setReplayed(Object.fromEntries(payload.rows.map((r) => [r.contractId, r.state])));
  }

  return (
    <>
      {instants.length > 1 && (
        <div className="slider">
          <label htmlFor="asof">Time</label>
          <input
            id="asof"
            type="range"
            min={0}
            max={instants.length}
            defaultValue={instants.length}
            onChange={(e) => {
              const index = Number(e.target.value);
              void slideTo(index >= instants.length ? null : (instants[index] ?? null));
            }}
          />
          <span className="mono">{asOf ? `as of ${new Date(asOf).toLocaleString()}` : "now"}</span>
          {replayed && <span className="pill">replaying</span>}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th style={{ width: "22%" }}>Row</th>
            <th style={{ width: "12%" }}>Owner</th>
            <th style={{ width: "16%" }}>Status</th>
            <th style={{ width: "20%" }}>Check</th>
            <th style={{ width: "10%" }}>Evidence</th>
            <th style={{ width: "20%" }}>Blocked by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const state = replayed ? (replayed[row.id] ?? "did not exist") : row.state;
            const lastCheck = row.checks[0];
            return (
              <tr key={row.id} className={open === row.id ? "selected" : undefined}>
                <td>
                  <button className="linky" onClick={() => setOpen(open === row.id ? null : row.id)}>
                    {row.title}
                  </button>
                  <div className="muted mono">{row.key}</div>
                </td>
                <td>
                  {row.owner ? (
                    <>
                      {row.owner.name}
                      <div className="muted">{row.owner.kind}</div>
                    </>
                  ) : (
                    <span className="muted">unassigned</span>
                  )}
                </td>
                <td>
                  <StatusCell
                    row={row}
                    state={state}
                    disabled={Boolean(replayed) || pending}
                    onType={(typed) => void typeIntoStatus(row, typed)}
                  />
                  {refusal?.rowId === row.id && (
                    <p className="refusal">
                      {refusal.message}
                      {refusal.invariant ? ` (invariant ${refusal.invariant})` : ""}
                    </p>
                  )}
                  {row.state === "awaiting_approval" && !replayed && (
                    <div className="decide">
                      <button onClick={() => void decide(row, "approve")}>Approve</button>
                      <button onClick={() => void decide(row, "hand_back")}>Hand back</button>
                    </div>
                  )}
                </td>
                <td>
                  <span className="mono">{row.checkId ?? "human_review"}</span>
                  {lastCheck && (
                    <div className={lastCheck.passed ? "good" : "bad"}>{lastCheck.passed ? "passed" : "failed"}</div>
                  )}
                </td>
                <td>{row.evidenceCount}</td>
                <td>
                  {row.blockers.length === 0 ? (
                    <span className="muted">nothing</span>
                  ) : (
                    row.blockers.map((b) => (
                      <div key={b.key} className="mono">
                        {b.key} <span className={TERMINAL.has(b.state) ? "good" : "muted"}>{b.state}</span>
                      </div>
                    ))
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openRow && <EvidenceDrawer row={openRow} onClose={() => setOpen(null)} />}
    </>
  );
}

function StatusCell({
  row,
  state,
  disabled,
  onType,
}: {
  row: GridRow;
  state: string;
  disabled: boolean;
  onType(typed: string): void;
}) {
  const [draft, setDraft] = useState(state);
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        className={`state state-${state}`}
        disabled={disabled}
        title="the status column moves only through the runtime; try typing into it"
        onClick={() => {
          setDraft(row.state);
          setEditing(true);
        }}
      >
        {state}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setEditing(false);
        onType(draft);
      }}
    >
      <input
        autoFocus
        className="statusinput"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== row.state) onType(draft);
        }}
      />
    </form>
  );
}

function EvidenceDrawer({ row, onClose }: { row: GridRow; onClose(): void }) {
  return (
    <aside className="drawer">
      <header>
        <div>
          <strong>{row.title}</strong>
          <div className="muted">{row.goal}</div>
        </div>
        <button onClick={onClose}>Close</button>
      </header>

      <h3>Evidence</h3>
      {row.evidence.length === 0 && <p className="muted">Nothing attached yet.</p>}
      {row.evidence.map((item) => (
        <details key={item.id}>
          <summary>
            <span className="pill">{item.kind}</span> {item.sourceConnector ?? "artefact"}{" "}
            <span className="muted mono">{item.sha256.slice(0, 12)}</span>
            {item.asOf && <span className="muted"> as of {new Date(item.asOf).toLocaleDateString()}</span>}
          </summary>
          <pre>{JSON.stringify(item.body, null, 2)}</pre>
          <div className="muted mono">
            by {item.createdBy} at {new Date(item.recordedAt).toLocaleString()}
          </div>
        </details>
      ))}

      <h3>Checks</h3>
      {row.checks.length === 0 && <p className="muted">Not run yet.</p>}
      {row.checks.map((check, index) => (
        <details key={index}>
          <summary>
            <span className={check.passed ? "good" : "bad"}>{check.passed ? "passed" : "failed"}</span>{" "}
            <span className="mono">{check.checkId}</span>
          </summary>
          <pre>{JSON.stringify(check.details, null, 2)}</pre>
        </details>
      ))}

      <h3>The chain</h3>
      <table className="chain">
        <tbody>
          {row.history.map((t) => (
            <tr key={t.seq}>
              <td className="mono">{t.seq}</td>
              <td className="mono">{t.from ?? "-"}</td>
              <td className="mono">{t.to}</td>
              <td>{t.actorId}</td>
              <td className="muted">{t.reason}</td>
              <td className="muted mono" title={t.hash}>
                {t.hash.slice(0, 8)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}

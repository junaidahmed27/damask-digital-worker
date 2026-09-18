"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type GridColumn = { id: string; name: string; type: string; config: Record<string, unknown> };

export type GridCell = { value: unknown; setBy: string; setFrom: string; at: string } | undefined;

export type GridRowData = {
  rowId: string;
  values: Record<string, GridCell>;
  /** Present when this row is a contract: the status the runtime holds. */
  state?: string;
  title?: string;
  childSheetId?: string | null;
};

export type GridProposal = {
  id: string;
  kind: string;
  payload: { rowId?: string; columnName?: string; value?: unknown; replaces?: unknown };
  proposedBy: string;
  reason: string;
  status: string;
};

export type GridComment = {
  id: string;
  rowId: string;
  columnId: string | null;
  body: string;
  authorId: string;
  createdAt: string;
  mirroredTo: string | null;
};

const READ_ONLY = new Set(["status", "evidence", "formula", "check"]);

export function Grid({
  sheetId,
  shape,
  columns,
  rows,
  proposals,
  comments,
  instants,
}: {
  sheetId: string;
  shape: string;
  columns: GridColumn[];
  rows: GridRowData[];
  proposals: GridProposal[];
  comments: GridComment[];
  instants: string[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ kind: "refusal" | "note"; text: string } | null>(null);
  const [editing, setEditing] = useState<{ rowId: string; column: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [replay, setReplay] = useState<{ asOf: string; rows: GridRowData[] } | null>(null);
  const [commenting, setCommenting] = useState<{ rowId: string; column: string } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [pending, start] = useTransition();

  const pendingByCell = useMemo(() => {
    const map = new Map<string, GridProposal>();
    for (const proposal of proposals) {
      if (proposal.status !== "pending") continue;
      const { rowId, columnName } = proposal.payload;
      if (rowId && columnName) map.set(`${rowId}:${columnName}`, proposal);
    }
    return map;
  }, [proposals]);

  const commentsByCell = useMemo(() => {
    const map = new Map<string, GridComment[]>();
    for (const comment of comments) {
      const column = columns.find((c) => c.id === comment.columnId);
      const key = `${comment.rowId}:${column?.name ?? ""}`;
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [comments, columns]);

  const shown = replay?.rows ?? rows;

  async function save(rowId: string, column: string, raw: string) {
    setEditing(null);
    setMessage(null);
    const response = await fetch(`/api/sheets/${sheetId}/cells`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ row_id: rowId, column, value: parseValue(raw) }),
    });
    const payload = (await response.json()) as {
      error?: string;
      reevaluated?: boolean;
      recomputed?: number;
    };
    if (!response.ok) {
      setMessage({ kind: "refusal", text: payload.error ?? "that edit was refused" });
      start(() => router.refresh());
      return;
    }
    setMessage({
      kind: "note",
      text: [
        payload.reevaluated ? "the row is running again with the new input" : null,
        payload.recomputed ? `${payload.recomputed} formula cell(s) recomputed` : null,
      ]
        .filter(Boolean)
        .join(", ") || "saved",
    });
    start(() => router.refresh());
  }

  async function decide(proposalId: string, decision: "accepted" | "rejected") {
    const response = await fetch(`/api/proposals/${proposalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const payload = (await response.json()) as { error?: string };
    setMessage(
      response.ok
        ? { kind: "note", text: `proposal ${decision}` }
        : { kind: "refusal", text: payload.error ?? "that was refused" },
    );
    start(() => router.refresh());
  }

  async function fill(column: string) {
    setMessage(null);
    const response = await fetch(`/api/sheets/${sheetId}/run-column`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column }),
    });
    const payload = (await response.json()) as { ran?: number; error?: string };
    setMessage(
      response.ok
        ? { kind: "note", text: `ran ${payload.ran ?? 0} row(s)` }
        : { kind: "refusal", text: payload.error ?? "that was refused" },
    );
    start(() => router.refresh());
  }

  async function postComment(rowId: string, column: string) {
    if (!commentDraft.trim()) return;
    await fetch(`/api/sheets/${sheetId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ row_id: rowId, column, body: commentDraft }),
    });
    setCommentDraft("");
    setCommenting(null);
    start(() => router.refresh());
  }

  async function slideTo(index: number) {
    if (index >= instants.length) {
      setReplay(null);
      return;
    }
    const asOf = instants[index];
    if (!asOf) return;
    const response = await fetch(`/api/sheets/${sheetId}?as_of=${encodeURIComponent(asOf)}`);
    const payload = (await response.json()) as { rows: GridRowData[] };
    setReplay({ asOf, rows: payload.rows });
  }

  return (
    <>
      {instants.length > 1 && (
        <div className="slider">
          <label htmlFor="cellslider">Time</label>
          <input
            id="cellslider"
            type="range"
            min={0}
            max={instants.length}
            defaultValue={instants.length}
            onChange={(e) => void slideTo(Number(e.target.value))}
          />
          <span className="mono">{replay ? `as of ${new Date(replay.asOf).toLocaleString()}` : "now"}</span>
          {replay && <span className="pill">replaying cell values</span>}
        </div>
      )}

      {message && <p className={message.kind === "refusal" ? "refusal wide" : "note"}>{message.text}</p>}

      <div className="gridwrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="rowhead">Row</th>
              {columns.map((column) => (
                <th key={column.id}>
                  <span>{column.name}</span>
                  <div className="coltype mono">{column.type}</div>
                  {column.type === "agent_step" && !replay && (
                    <button className="linky" disabled={pending} onClick={() => void fill(column.name)}>
                      run column
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.rowId}>
                <td className="rowhead">
                  <div>{row.title ?? String(row.values.hire?.value ?? row.rowId)}</div>
                  {row.state && <div className={`state state-${row.state}`}>{row.state}</div>}
                  {row.childSheetId && (
                    <a className="linky" href={`/sheets/${row.childSheetId}`}>
                      child sheet
                    </a>
                  )}
                </td>
                {columns.map((column) => {
                  const cell = row.values[column.name];
                  const proposal = pendingByCell.get(`${row.rowId}:${column.name}`);
                  const thread = commentsByCell.get(`${row.rowId}:${column.name}`) ?? [];
                  const isEditing = editing?.rowId === row.rowId && editing.column === column.name;
                  const readOnly = READ_ONLY.has(column.type) || Boolean(replay);

                  return (
                    <td
                      key={column.id}
                      className={proposal ? "proposed" : undefined}
                      title={
                        cell
                          ? `set by ${cell.setBy} from ${cell.setFrom} at ${new Date(cell.at).toLocaleString()}`
                          : "empty"
                      }
                    >
                      {isEditing ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void save(row.rowId, column.name, draft);
                          }}
                        >
                          <input
                            autoFocus
                            className="cellinput"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => void save(row.rowId, column.name, draft)}
                          />
                        </form>
                      ) : (
                        <button
                          className={`cell ${readOnly ? "readonly" : ""}`}
                          onClick={() => {
                            if (column.type === "status") {
                              setMessage({
                                kind: "refusal",
                                text: "the status column moves only through the runtime, never by typing into it",
                              });
                              return;
                            }
                            if (readOnly) return;
                            setDraft(display(cell?.value));
                            setEditing({ rowId: row.rowId, column: column.name });
                          }}
                        >
                          {display(cell?.value) || <span className="muted">empty</span>}
                        </button>
                      )}

                      {cell && (
                        <div className="prov mono">
                          {cell.setBy} · {cell.setFrom}
                        </div>
                      )}

                      {proposal && (
                        <div className="proposal">
                          <div className="muted">
                            {proposal.proposedBy} proposes {display(proposal.payload.value)}
                          </div>
                          <button onClick={() => void decide(proposal.id, "accepted")}>accept</button>
                          <button onClick={() => void decide(proposal.id, "rejected")}>reject</button>
                        </div>
                      )}

                      {thread.length > 0 && (
                        <div className="thread">
                          {thread.map((comment) => (
                            <div key={comment.id}>
                              <strong>{comment.authorId}</strong> {comment.body}
                              {comment.mirroredTo && <span className="pill">in chat</span>}
                            </div>
                          ))}
                        </div>
                      )}

                      {!replay &&
                        (commenting?.rowId === row.rowId && commenting.column === column.name ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void postComment(row.rowId, column.name);
                            }}
                          >
                            <input
                              autoFocus
                              className="cellinput"
                              placeholder="comment"
                              value={commentDraft}
                              onChange={(e) => setCommentDraft(e.target.value)}
                            />
                          </form>
                        ) : (
                          <button
                            className="linky tiny"
                            onClick={() => setCommenting({ rowId: row.rowId, column: column.name })}
                          >
                            comment
                          </button>
                        ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!replay && <AddColumn sheetId={sheetId} shape={shape} onDone={() => start(() => router.refresh())} />}
    </>
  );
}

function AddColumn({ sheetId, shape, onDone }: { sheetId: string; shape: string; onDone(): void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [formula, setFormula] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    const response = await fetch(`/api/sheets/${sheetId}/columns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, type, config: type === "formula" ? { formula } : {} }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "that was refused");
      return;
    }
    setName("");
    setFormula("");
    onDone();
  }

  return (
    <section className="newrun">
      <h2>Add a column</h2>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="column name" />
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {["text", "number", "date", "input", "output", "formula", "owner", "check", "link"].map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {type === "formula" && (
        <input value={formula} onChange={(e) => setFormula(e.target.value)} placeholder="=SUM(rows.amount)" />
      )}
      <button onClick={() => void add()} disabled={!name}>
        Add
      </button>
      {error && <p className="refusal">{error}</p>}
      <p className="muted">
        {shape === "batch"
          ? "A batch sheet takes new rows too; a plan sheet's rows are its contracts."
          : "A plan sheet's rows are its contracts, so rows come from the run."}
      </p>
    </section>
  );
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function parseValue(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

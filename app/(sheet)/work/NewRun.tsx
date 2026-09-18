"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The ask, typed. WP-12 replaces this box with the planner, which drafts a sheet
 * from plain language; until then it instantiates the workflow by name and the
 * rows still wait for a person to contract them.
 */
export function NewRun() {
  const router = useRouter();
  const [goal, setGoal] = useState("Priya starts Monday as a sales engineer in Austin. hire_id=priya");
  const [drafted, setDrafted] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function draft() {
    setMessage(null);
    const response = await fetch("/api/contracts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create_run", workflow: "day_one", goal }),
    });
    const payload = (await response.json()) as { runId?: string; rows?: unknown[]; error?: string };
    if (!response.ok) return setMessage(payload.error ?? "that was refused");
    setDrafted(payload.runId ?? null);
    setMessage(`${payload.rows?.length ?? 0} rows drafted. Nothing has run.`);
    start(() => router.push(`/work?run=${payload.runId}`));
  }

  async function contract() {
    if (!drafted) return;
    const response = await fetch("/api/contracts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "contract", run_id: drafted }),
    });
    const payload = (await response.json()) as { contracted?: string[]; error?: string };
    if (!response.ok) return setMessage(payload.error ?? "that was refused");
    setMessage(`${payload.contracted?.length ?? 0} rows started.`);
    setDrafted(null);
    start(() => router.refresh());
  }

  return (
    <section className="newrun">
      <h2>New plan</h2>
      <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="what needs doing" />
      <button onClick={() => void draft()} disabled={pending}>
        Draft the plan
      </button>
      <button onClick={() => void contract()} disabled={!drafted || pending}>
        Contract the plan
      </button>
      {message && <p className="muted">{message}</p>}
    </section>
  );
}

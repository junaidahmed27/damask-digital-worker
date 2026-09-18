"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Revoke. One write; the state machine refuses the worker as an actor everywhere
 * from that moment, and the revoke function takes its open rows to a person.
 */
export function WorkerRow({ id, name, status }: { id: string; name: string; status: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function toggle() {
    setMessage(null);
    const response = await fetch(`/api/workers/${id}/revoke`, { method: "POST" });
    const payload = (await response.json()) as { worker?: { status: string }; error?: string };
    if (!response.ok) return setMessage(payload.error ?? "that was refused");
    start(() => router.refresh());
  }

  return (
    <>
      <span className={status === "revoked" ? "bad" : "good"}>{status}</span>
      <div>
        <button className="linky" onClick={() => void toggle()} disabled={pending}>
          {status === "revoked" ? "restore" : "revoke"}
        </button>
      </div>
      {message && <p className="refusal">{message}</p>}
      <span hidden>{name}</span>
    </>
  );
}

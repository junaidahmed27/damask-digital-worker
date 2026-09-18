import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { exportAudit } from "@/lib/ledger/audit";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await getDb();

  let audit;
  try {
    audit = await exportAudit(db, id);
  } catch {
    notFound();
  }

  return (
    <>
      <h1>{audit.run.goal}</h1>
      <p className="sub">
        {audit.run.workflow} v{audit.run.version} &middot; requested by {audit.run.requestedBy} &middot;{" "}
        {audit.counts.done} of {audit.counts.rows} rows done &middot; {audit.counts.transitions} transitions &middot;{" "}
        {audit.counts.evidence} pieces of evidence &middot; {audit.counts.handbacks} hand backs &middot;{" "}
        <span className={audit.chainsOk ? "good" : "bad"}>
          {audit.chainsOk ? "every hash chain verifies" : "a hash chain is broken"}
        </span>
        {" · "}
        <Link href={`/api/runs/${id}/audit`}>the printable audit page</Link>
        {" · "}
        <Link href={`/work?run=${id}`}>the sheet</Link>
      </p>

      <h2>Approvals</h2>
      {audit.approvals.length === 0 ? (
        <p className="muted">No approvals were given in this run.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Row</th>
              <th>Check</th>
              <th>Approved by</th>
              <th>Reason</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {audit.approvals.map((a, index) => (
              <tr key={index}>
                <td>{a.title}</td>
                <td className="mono">{a.check}</td>
                <td>
                  <strong>{a.approverName}</strong>
                </td>
                <td className="muted">{a.reason}</td>
                <td className="muted">{new Date(a.at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>The hash chained log</h2>
      {audit.rows.map((row) => (
        <section key={row.key} className="runrow">
          <h3>
            {row.title} <span className="mono muted">{row.key}</span>{" "}
            <span className={row.chain.ok ? "good" : "bad"}>{row.chain.ok ? "chain verifies" : "chain broken"}</span>
          </h3>
          <table>
            <tbody>
              {row.transitions.map((t) => (
                <tr key={t.seq}>
                  <td className="mono" style={{ width: 24 }}>
                    {t.seq}
                  </td>
                  <td className="mono" style={{ width: 170 }}>
                    {t.from ?? "-"}
                  </td>
                  <td className="mono" style={{ width: 170 }}>
                    {t.to}
                  </td>
                  <td style={{ width: 120 }}>{t.actor}</td>
                  <td className="muted">{t.reason}</td>
                  <td className="mono muted" style={{ width: 90 }} title={t.hash}>
                    {t.hash.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

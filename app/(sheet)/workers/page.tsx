import { readWorkers } from "@/lib/sheet/read";
import { WorkerRow } from "./WorkerRow";

export const dynamic = "force-dynamic";

export default async function WorkersPage() {
  const all = await readWorkers();

  return (
    <>
      <h1>Workers</h1>
      <p className="sub">
        People and agents are the same kind of row. Assignment, handoff, revocation and audit are identical for both.
      </p>
      <table>
        <thead>
          <tr>
            <th style={{ width: "18%" }}>Name</th>
            <th style={{ width: "8%" }}>Kind</th>
            <th style={{ width: "14%" }}>Places</th>
            <th style={{ width: "30%" }}>Tools</th>
            <th style={{ width: "16%" }}>Never without a person</th>
            <th style={{ width: "8%" }}>Rows</th>
            <th style={{ width: "6%" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {all.map(({ worker, openRows, doneRows }) => (
            <tr key={worker.id}>
              <td>
                {worker.name}
                <div className="muted mono">{worker.identity ?? worker.id}</div>
              </td>
              <td>{worker.kind}</td>
              <td className="mono">{worker.places.join(", ") || "-"}</td>
              <td className="mono small">{worker.canTouch.join(", ") || "-"}</td>
              <td className="mono small">{worker.neverWithoutHuman.join(", ") || "-"}</td>
              <td>
                {doneRows} done
                <div className="muted">{openRows} open</div>
              </td>
              <td>
                <WorkerRow id={worker.id} name={worker.name} status={worker.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

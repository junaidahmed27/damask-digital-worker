export const dynamic = "force-dynamic";

export default function WorkPage() {
  return (
    <>
      <h1>Work</h1>
      <p className="sub">Contracts across every run. One row is one unit of work.</p>
      <div className="empty">
        No runs yet. Seed the database and start the Day One run with <code>make demo</code>.
      </div>
    </>
  );
}

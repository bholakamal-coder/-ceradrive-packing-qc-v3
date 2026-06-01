// ── /api/setup — Cloudflare Pages Function ───────────────────────────────────
// Creates all three tables on first deploy or if they were accidentally dropped.
// Called once by the client on every init() — idempotent.

/** @param {EventContext} context */
export async function onRequest(context) {
  const DB = context.env.DB;
  await Promise.all([
    DB.prepare(`CREATE TABLE IF NOT EXISTS skus    (part_no  TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`).run(),
    DB.prepare(`CREATE TABLE IF NOT EXISTS orders  (order_no TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`).run(),
    DB.prepare(`CREATE TABLE IF NOT EXISTS cartons (id       TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`).run(),
  ]);
  return Response.json({ ok: true });
}

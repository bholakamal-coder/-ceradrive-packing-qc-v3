// ── /api/cartons — Cloudflare Pages Function ─────────────────────────────────
//
// GET  → returns all cartons as JSON array with updated_at injected into each object
// POST → UPSERTS provided cartons only; optional delete_ids removes explicit deletes
// v8.5.2: removed full-table DELETE+INSERT to prevent stale-device overwrite/data loss.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRow(r) {
  const obj = JSON.parse(r.data || "{}");
  obj.updated_at = obj.updated_at || r.updated_at;
  return obj;
}

/** @param {EventContext} context */
export async function onRequestGet(context) {
  try {
    const DB   = context.env.DB;
    const rows = await DB.prepare(`SELECT data, updated_at FROM cartons`).all();
    return json({ ok: true, cartons: (rows.results || []).map(parseRow) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/** @param {EventContext} context */
export async function onRequestPost(context) {
  try {
    const DB      = context.env.DB;
    const body    = await context.request.json();
    const cartons = Array.isArray(body.cartons) ? body.cartons : [];
    const deletes = Array.isArray(body.delete_ids) ? body.delete_ids : [];
    const now     = new Date().toISOString();

    const stmts = [];
    for (const id of deletes) {
      stmts.push(DB.prepare(`DELETE FROM cartons WHERE id = ?`).bind(String(id)));
    }
    for (const c of cartons) {
      if (!c || !c.id) continue;
      const row = { ...c, updated_at: now };
      stmts.push(
        DB.prepare(`INSERT OR REPLACE INTO cartons (id, data, updated_at) VALUES (?, ?, ?)`).bind(
          String(row.id), JSON.stringify(row), now
        )
      );
    }

    if (stmts.length) await DB.batch(stmts);
    return json({ ok: true, saved: cartons.length, deleted: deletes.length });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

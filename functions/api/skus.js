// ── /api/skus — Cloudflare Pages Function ────────────────────────────────────
//
// GET  → returns all SKUs as JSON array with updated_at injected into each object
// POST → UPSERTS provided SKUs only; optional delete_part_nos removes explicit deletes
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
    const rows = await DB.prepare(`SELECT data, updated_at FROM skus`).all();
    return json({ ok: true, skus: (rows.results || []).map(parseRow) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/** @param {EventContext} context */
export async function onRequestPost(context) {
  try {
    const DB   = context.env.DB;
    const body = await context.request.json();
    const skus = Array.isArray(body.skus) ? body.skus : [];
    const deletes = Array.isArray(body.delete_part_nos) ? body.delete_part_nos : [];
    const now  = new Date().toISOString();

    const stmts = [];
    for (const partNo of deletes) {
      stmts.push(DB.prepare(`DELETE FROM skus WHERE part_no = ?`).bind(String(partNo)));
    }
    for (const s of skus) {
      if (!s || !s.part_no) continue;
      const row = { ...s, updated_at: now };
      stmts.push(
        DB.prepare(`INSERT OR REPLACE INTO skus (part_no, data, updated_at) VALUES (?, ?, ?)`).bind(
          String(row.part_no), JSON.stringify(row), now
        )
      );
    }

    if (stmts.length) await DB.batch(stmts);
    return json({ ok: true, saved: skus.length, deleted: deletes.length });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

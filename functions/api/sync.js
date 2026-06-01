// ── /api/sync — atomic multi-section save for critical workflows ──────────────
// Used by QC completion so order and carton status changes are committed together.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {EventContext} context */
export async function onRequestPost(context) {
  try {
    const DB = context.env.DB;
    const body = await context.request.json();
    const now = new Date().toISOString();
    const stmts = [];

    for (const c of (Array.isArray(body.cartons) ? body.cartons : [])) {
      if (!c || !c.id) continue;
      const row = { ...c, updated_at: now };
      stmts.push(DB.prepare(`INSERT OR REPLACE INTO cartons (id, data, updated_at) VALUES (?, ?, ?)`).bind(String(row.id), JSON.stringify(row), now));
    }

    for (const o of (Array.isArray(body.orders) ? body.orders : [])) {
      if (!o || !o.order_no) continue;
      const row = { ...o, updated_at: now };
      stmts.push(DB.prepare(`INSERT OR REPLACE INTO orders (order_no, data, updated_at) VALUES (?, ?, ?)`).bind(String(row.order_no), JSON.stringify(row), now));
    }

    for (const s of (Array.isArray(body.skus) ? body.skus : [])) {
      if (!s || !s.part_no) continue;
      const row = { ...s, updated_at: now };
      stmts.push(DB.prepare(`INSERT OR REPLACE INTO skus (part_no, data, updated_at) VALUES (?, ?, ?)`).bind(String(row.part_no), JSON.stringify(row), now));
    }

    if (stmts.length) await DB.batch(stmts);
    return json({ ok: true, saved: stmts.length });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

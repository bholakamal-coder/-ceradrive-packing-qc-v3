// ── /api/orders — Cloudflare Pages Function ──────────────────────────────────
//
// GET  → returns all orders as JSON array with updated_at injected into each object
// POST → UPSERTS provided orders only; optional delete_order_nos removes explicit deletes
//
// DATA MODEL: orders(order_no TEXT PK, data TEXT, updated_at TEXT)
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
    const rows = await DB.prepare(`SELECT data, updated_at FROM orders ORDER BY order_no`).all();
    return json({ ok: true, orders: (rows.results || []).map(parseRow) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/** @param {EventContext} context */
export async function onRequestPost(context) {
  try {
    const DB     = context.env.DB;
    const body   = await context.request.json();
    const orders = Array.isArray(body.orders) ? body.orders : [];
    const deletes = Array.isArray(body.delete_order_nos) ? body.delete_order_nos : [];
    const now    = new Date().toISOString();

    const stmts = [];
    for (const orderNo of deletes) {
      stmts.push(DB.prepare(`DELETE FROM orders WHERE order_no = ?`).bind(String(orderNo)));
    }
    for (const o of orders) {
      if (!o || !o.order_no) continue;
      const row = { ...o, updated_at: now };
      stmts.push(
        DB.prepare(`INSERT OR REPLACE INTO orders (order_no, data, updated_at) VALUES (?, ?, ?)`).bind(
          String(row.order_no), JSON.stringify(row), now
        )
      );
    }

    if (stmts.length) await DB.batch(stmts);
    return json({ ok: true, saved: orders.length, deleted: deletes.length });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

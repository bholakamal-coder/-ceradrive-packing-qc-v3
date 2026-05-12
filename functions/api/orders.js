export async function onRequestGet({ request, env }) {
  await ensureTables(env);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (id) {
    const order = await env.DB.prepare(
      "SELECT * FROM orders WHERE id=?"
    ).bind(id).first();

    const { results: items } = await env.DB.prepare(
      "SELECT * FROM order_items WHERE order_id=?"
    ).bind(id).all();

    return Response.json({ order, items: items || [] });
  }

  const { results } = await env.DB.prepare(
    "SELECT * FROM orders ORDER BY id DESC LIMIT 100"
  ).all();

  return Response.json({ orders: results || [] });
}

export async function onRequestPost({ request, env }) {
  await ensureTables(env);

  const { party_name, created_by, items } = await request.json();

  if (!party_name || !items?.length) {
    return Response.json({ error: "Invalid order" }, { status: 400 });
  }

  const now = new Date().toISOString();

  const orderResult = await env.DB.prepare(`
    INSERT INTO orders (party_name, created_by, status, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(party_name, created_by || "", "PENDING", now).run();

  const orderId = orderResult.meta.last_row_id;

  for (const item of items) {
    await env.DB.prepare(`
      INSERT INTO order_items
      (order_id, part_no, make_name, model, qty, packed_qty, weight_per_set)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      orderId,
      item.part_no,
      item.make_name || "",
      item.model || "",
      Number(item.qty || 0),
      0,
      Number(item.weight_per_set || 0)
    ).run();
  }

  return Response.json({ ok: true, order_id: orderId });
}

export async function onRequestDelete({ request, env }) {
  await ensureTables(env);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return Response.json({ error: "Order id required" }, { status: 400 });

  await env.DB.prepare("DELETE FROM carton_items WHERE carton_id IN (SELECT id FROM cartons WHERE order_id=?)").bind(id).run();
  await env.DB.prepare("DELETE FROM cartons WHERE order_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM order_items WHERE order_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM orders WHERE id=?").bind(id).run();

  return Response.json({ ok: true });
}

async function ensureTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_name TEXT,
      created_by TEXT,
      status TEXT,
      created_at TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      part_no TEXT,
      make_name TEXT,
      model TEXT,
      qty INTEGER,
      packed_qty INTEGER DEFAULT 0,
      weight_per_set REAL DEFAULT 0
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cartons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      carton_no TEXT,
      total_cartons TEXT,
      outer_weight REAL,
      expected_weight REAL,
      actual_weight REAL,
      status TEXT,
      created_at TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS carton_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      carton_id INTEGER,
      part_no TEXT,
      make_name TEXT,
      model TEXT,
      qty INTEGER,
      weight_per_set REAL
    )
  `).run();

  try { await env.DB.prepare(`ALTER TABLE order_items ADD COLUMN packed_qty INTEGER DEFAULT 0`).run(); } catch(e) {}
  try { await env.DB.prepare(`ALTER TABLE order_items ADD COLUMN weight_per_set REAL DEFAULT 0`).run(); } catch(e) {}
}

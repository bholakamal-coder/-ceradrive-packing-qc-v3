export async function onRequestGet({ request, env }) {
  await ensureTables(env);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (id) {
    const carton = await env.DB.prepare(`
      SELECT c.*, o.party_name
      FROM cartons c
      LEFT JOIN orders o ON o.id = c.order_id
      WHERE c.id=?
    `).bind(id).first();

    if (!carton) return Response.json({ error: "Carton not found" }, { status: 404 });

    const { results: items } = await env.DB.prepare(
      "SELECT * FROM carton_items WHERE carton_id=?"
    ).bind(id).all();

    carton.items = items || [];
    return Response.json({ carton });
  }

  const { results } = await env.DB.prepare(`
    SELECT c.*, o.party_name
    FROM cartons c
    LEFT JOIN orders o ON o.id = c.order_id
    ORDER BY c.id DESC
    LIMIT 100
  `).all();

  return Response.json({ cartons: results || [] });
}

export async function onRequestPost({ request, env }) {
  await ensureTables(env);

  const { order_id, carton_no, total_cartons, outer_weight, expected_weight, items } = await request.json();

  if (!order_id || !carton_no || !items?.length) {
    return Response.json({ error: "Missing carton data" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const expected = Number(expected_weight || 0);

  const cartonResult = await env.DB.prepare(`
    INSERT INTO cartons
    (order_id, carton_no, total_cartons, outer_weight, expected_weight, actual_weight, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    order_id,
    carton_no,
    total_cartons || "",
    Number(outer_weight || 0),
    expected,
    0,
    "PENDING_QC",
    now
  ).run();

  const cartonId = cartonResult.meta.last_row_id;

  for (const item of items) {
    await env.DB.prepare(`
      INSERT INTO carton_items
      (carton_id, part_no, make_name, model, qty, weight_per_set)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      cartonId,
      item.part_no,
      item.make_name || "",
      item.model || "",
      Number(item.qty || 0),
      Number(item.weight_per_set || 0)
    ).run();

    await env.DB.prepare(`
      UPDATE order_items
      SET packed_qty = COALESCE(packed_qty,0) + ?
      WHERE order_id=? AND part_no=?
    `).bind(Number(item.qty || 0), order_id, item.part_no).run();
  }

  return Response.json({ ok: true, carton_id: cartonId });
}

async function ensureTables(env) {
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

  try { await env.DB.prepare(`ALTER TABLE order_items ADD COLUMN packed_qty INTEGER DEFAULT 0`).run(); } catch(e) {}
}

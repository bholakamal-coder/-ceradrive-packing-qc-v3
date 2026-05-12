export async function onRequestGet({ request, env }) {
  await ensureTables(env);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    const carton = await env.DB.prepare(`
      SELECT c.*, o.party_name
      FROM cartons c
      LEFT JOIN orders o ON o.id = c.order_id
      WHERE c.id = ?
    `).bind(id).first();

    if (!carton) return json({ error: "Carton not found" }, 404);

    const { results: items } = await env.DB.prepare(`
      SELECT * FROM carton_items WHERE carton_id = ?
    `).bind(id).all();

    carton.items = items || [];
    return json({ carton });
  }

  const { results } = await env.DB.prepare(`
    SELECT 
      c.*,
      o.party_name,
      COALESCE(SUM(ci.qty), 0) AS total_qty
    FROM cartons c
    LEFT JOIN orders o ON o.id = c.order_id
    LEFT JOIN carton_items ci ON ci.carton_id = c.id
    GROUP BY c.id
    ORDER BY o.party_name ASC, c.id DESC
    LIMIT 200
  `).all();

  return json({ cartons: results || [] });
}

export async function onRequestPost({ request, env }) {
  await ensureTables(env);

  const body = await request.json();

  const order_id = Number(body.order_id || body.orderId);
  const carton_no = String(body.carton_no || body.cartonNo || "").trim();
  const total_cartons = String(body.total_cartons || body.totalCartons || "").trim();
  const outer_weight = Number(body.outer_weight || body.outerWeight || 0);
  const expected_weight = Number(body.expected_weight || body.expectedWeight || 0);
  const items = Array.isArray(body.items) ? body.items : [];
  const packed_by = body.packed_by || body.user || body.username || "";

  if (!order_id || !carton_no || !items.length) {
    return json({ error: "Missing carton data" }, 400);
  }

  for (const item of items) {
    const part_no = String(item.part_no || item.partNo || "").trim();
    const qty = Number(item.qty || 0);

    if (!part_no || qty <= 0) {
      return json({ error: "Invalid carton item" }, 400);
    }

    const orderItem = await env.DB.prepare(`
      SELECT qty, COALESCE(packed_qty, 0) AS packed_qty
      FROM order_items
      WHERE order_id = ? AND part_no = ?
    `).bind(order_id, part_no).first();

    if (!orderItem) {
      return json({ error: `Item ${part_no} not found in order` }, 400);
    }

    const balance = Number(orderItem.qty || 0) - Number(orderItem.packed_qty || 0);
    if (qty > balance) {
      return json({
        error: `Qty exceeds balance for ${part_no}. Balance: ${balance}`
      }, 400);
    }
  }

  const now = new Date().toISOString();

  const cartonResult = await env.DB.prepare(`
    INSERT INTO cartons
    (order_id, carton_no, total_cartons, outer_weight, expected_weight, actual_weight, status, qc_status, packed_by, sticker_printed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    order_id,
    carton_no,
    total_cartons,
    outer_weight,
    expected_weight,
    0,
    "PENDING_QC",
    "PENDING_QC",
    packed_by,
    0,
    now
  ).run();

  const cartonId = cartonResult.meta.last_row_id;

  for (const item of items) {
    const part_no = String(item.part_no || item.partNo || "").trim();
    const make_name = item.make_name || item.make || "";
    const model = item.model || item.model_name || "";
    const qty = Number(item.qty || 0);
    const weight_per_set = Number(item.weight_per_set || item.weightPerSet || 0);

    await env.DB.prepare(`
      INSERT INTO carton_items
      (carton_id, part_no, make_name, model, qty, weight_per_set)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      cartonId,
      part_no,
      make_name,
      model,
      qty,
      weight_per_set
    ).run();

    await env.DB.prepare(`
      UPDATE order_items
      SET packed_qty = COALESCE(packed_qty, 0) + ?
      WHERE order_id = ? AND part_no = ?
    `).bind(qty, order_id, part_no).run();
  }

  return json({ ok: true, carton_id: cartonId });
}

export async function onRequestPut({ request, env }) {
  await ensureTables(env);

  const body = await request.json();
  const id = Number(body.id || body.carton_id || body.cartonId);
  const actual_weight = Number(body.actual_weight || body.actualWeight || 0);

  if (!id) return json({ error: "Carton id required" }, 400);

  const carton = await env.DB.prepare(`
    SELECT expected_weight FROM cartons WHERE id = ?
  `).bind(id).first();

  if (!carton) return json({ error: "Carton not found" }, 404);

  const expected = Number(carton.expected_weight || 0);
  const diff = Number((actual_weight - expected).toFixed(3));
  const status = Math.abs(diff) <= 0.25 ? "PASS" : "RECHECK";

  await env.DB.prepare(`
    UPDATE cartons
    SET actual_weight = ?, status = ?, qc_status = ?
    WHERE id = ?
  `).bind(actual_weight, status, status, id).run();

  await env.DB.prepare(`
    INSERT INTO qc_records
    (carton_id, expected_weight, actual_weight, difference, status, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    expected,
    actual_weight,
    diff,
    status,
    new Date().toISOString()
  ).run();

  return json({ ok: true, status, difference: diff });
}

export async function onRequestPatch({ request, env }) {
  return onRequestPut({ request, env });
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
      qc_status TEXT,
      packed_by TEXT,
      sticker_printed INTEGER DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS qc_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      carton_id INTEGER,
      expected_weight REAL,
      actual_weight REAL,
      difference REAL,
      status TEXT,
      checked_at TEXT
    )
  `).run();

  const alters = [
    `ALTER TABLE cartons ADD COLUMN total_cartons TEXT`,
    `ALTER TABLE cartons ADD COLUMN outer_weight REAL`,
    `ALTER TABLE cartons ADD COLUMN expected_weight REAL`,
    `ALTER TABLE cartons ADD COLUMN actual_weight REAL`,
    `ALTER TABLE cartons ADD COLUMN status TEXT`,
    `ALTER TABLE cartons ADD COLUMN qc_status TEXT`,
    `ALTER TABLE cartons ADD COLUMN packed_by TEXT`,
    `ALTER TABLE cartons ADD COLUMN sticker_printed INTEGER DEFAULT 0`,
    `ALTER TABLE carton_items ADD COLUMN make_name TEXT`,
    `ALTER TABLE carton_items ADD COLUMN model TEXT`,
    `ALTER TABLE carton_items ADD COLUMN weight_per_set REAL`,
    `ALTER TABLE order_items ADD COLUMN packed_qty INTEGER DEFAULT 0`
  ];

  for (const q of alters) {
    try {
      await env.DB.prepare(q).run();
    } catch (e) {}
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

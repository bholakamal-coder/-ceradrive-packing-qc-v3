export async function onRequestGet({ request, env }) {
  await ensureTable(env);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) return Response.json({ skus: [] });

  const like = `%${q}%`;

  const { results } = await env.DB.prepare(`
    SELECT id, part_no, make_name, model, weight_per_set
    FROM sku_master
    WHERE part_no LIKE ? OR model LIKE ? OR make_name LIKE ?
    ORDER BY part_no
    LIMIT 30
  `).bind(like, like, like).all();

  return Response.json({ skus: results || [] });
}

export async function onRequestPost({ request, env }) {
  await ensureTable(env);

  const { part_no, make_name, model, weight_per_set } = await request.json();

  if (!part_no) {
    return Response.json({ error: "Part no required" }, { status: 400 });
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM sku_master WHERE part_no=?"
  ).bind(part_no).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE sku_master
      SET make_name=?, model=?, weight_per_set=?
      WHERE part_no=?
    `).bind(make_name || "", model || "", Number(weight_per_set || 0), part_no).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO sku_master (part_no, make_name, model, weight_per_set)
      VALUES (?, ?, ?, ?)
    `).bind(part_no, make_name || "", model || "", Number(weight_per_set || 0)).run();
  }

  return Response.json({ ok: true });
}

async function ensureTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sku_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_no TEXT UNIQUE,
      make_name TEXT,
      model TEXT,
      weight_per_set REAL DEFAULT 0
    )
  `).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO sku_master (part_no, make_name, model, weight_per_set) VALUES
    ('101S', 'TATA', 'SUMO', 1.30),
    ('102P', 'MARUTI', '1000 CC', 1.20),
    ('103C', 'TATA', 'INDICA', 1.10),
    ('104P', 'MARUTI', '800 CC', 1.00),
    ('105C', 'TATA', 'TIAGO', 1.15),
    ('105P', 'TATA', 'INDIGO', 1.20),
    ('106P', 'MARUTI', 'WAGON R', 1.18),
    ('107S', 'TATA', 'SAFARI', 1.60),
    ('108P', 'MARUTI', 'BALENO', 1.35),
    ('216C', 'JEEP', 'COMPASS', 1.50),
    ('221P', 'HYUNDAI', 'SANTRO T-3', 1.25)
  `).run();
}

export async function onRequestGet(context) {
  const { DB } = context.env;

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS cartons (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  const rows = await DB.prepare(`
    SELECT data FROM cartons
    ORDER BY updated_at DESC
  `).all();

  const cartons = rows.results.map(r => JSON.parse(r.data));

  return Response.json({
    ok: true,
    cartons
  });
}

export async function onRequestPost(context) {
  const { DB } = context.env;

  const body = await context.request.json();
  const cartons = body.cartons || [];

  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS cartons (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  for (const c of cartons) {
    await DB.prepare(`
      INSERT OR REPLACE INTO cartons (id, data, updated_at)
      VALUES (?, ?, ?)
    `).bind(
      String(c.id),
      JSON.stringify(c),
      new Date().toISOString()
    ).run();
  }

  return Response.json({
    ok: true,
    saved: cartons.length
  });
}

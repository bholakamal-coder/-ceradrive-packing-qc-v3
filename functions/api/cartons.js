export async function onRequestGet(context) {
  try {
    const DB = context.env.DB;

    const result = await DB.prepare(
      "SELECT data FROM cartons ORDER BY updated_at DESC"
    ).all();

    const cartons = result.results.map(r => JSON.parse(r.data));

    return new Response(
      JSON.stringify({
        ok: true,
        cartons
      }),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e.message
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}

export async function onRequestPost(context) {
  try {
    const DB = context.env.DB;

    const body = await context.request.json();
    const cartons = body.cartons || [];

    await DB.prepare(`
      CREATE TABLE IF NOT EXISTS cartons (
        id TEXT PRIMARY KEY,
        data TEXT,
        updated_at TEXT
      )
    `).run();

    for (const c of cartons) {
      await DB.prepare(`
        INSERT OR REPLACE INTO cartons
        (id, data, updated_at)
        VALUES (?, ?, ?)
      `).bind(
        String(c.id),
        JSON.stringify(c),
        new Date().toISOString()
      ).run();
    }

    return new Response(
      JSON.stringify({
        ok: true
      }),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e.message
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}

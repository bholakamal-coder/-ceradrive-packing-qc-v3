export async function onRequestGet({ env }) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_name TEXT,
      created_by TEXT,
      status TEXT,
      created_at TEXT
    )
  `).run();

  const total = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders").first();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE status!='COMPLETED' OR status IS NULL").first();
  const completed = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE status='COMPLETED'").first();

  return Response.json({
    total_orders: total?.c || 0,
    pending_orders: pending?.c || 0,
    completed_orders: completed?.c || 0
  });
}

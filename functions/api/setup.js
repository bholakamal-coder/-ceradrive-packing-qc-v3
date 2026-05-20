export async function onRequest(context){
  const DB=context.env.DB;
  await DB.prepare(`CREATE TABLE IF NOT EXISTS skus (part_no TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS orders (order_no TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS cartons (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  return Response.json({ok:true});
}

export async function onRequestPost({ request, env }) {
  await ensureUsers(env);

  const { username, password } = await request.json();

  const user = await env.DB.prepare(
    "SELECT id, username, role FROM users WHERE username=? AND password=?"
  ).bind(username, password).first();

  if (!user) {
    return Response.json({ error: "Invalid login" }, { status: 401 });
  }

  return Response.json({ user });
}

async function ensureUsers(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT
    )
  `).run();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO users (username, password, role) VALUES
    ('admin', 'Admin123', 'ADMIN'),
    ('packing', 'Pack123', 'ENTRY'),
    ('qc', 'Qc123', 'QC')
  `).run();
}

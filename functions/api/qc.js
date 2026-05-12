export async function onRequestPost({ request, env }) {

  const body = await request.json();

  const carton_id = Number(body.carton_id || body.cartonId);
  const actual_weight = Number(body.actual_weight || body.actualWeight || 0);

  if (!carton_id || !actual_weight) {
    return json({
      error: "Missing QC data"
    }, 400);
  }

  const carton = await env.DB.prepare(`
    SELECT *
    FROM cartons
    WHERE id = ?
  `).bind(carton_id).first();

  if (!carton) {
    return json({
      error: "Carton not found"
    }, 404);
  }

  const expected = Number(carton.expected_weight || 0);

  const difference = Number(
    (actual_weight - expected).toFixed(3)
  );

  const status =
    Math.abs(difference) <= 0.25
      ? "PASS"
      : "RECHECK";

  await env.DB.prepare(`
    UPDATE cartons
    SET
      actual_weight = ?,
      status = ?,
      qc_status = ?
    WHERE id = ?
  `).bind(
    actual_weight,
    status,
    status,
    carton_id
  ).run();

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

  await env.DB.prepare(`
    INSERT INTO qc_records
    (
      carton_id,
      expected_weight,
      actual_weight,
      difference,
      status,
      checked_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    carton_id,
    expected,
    actual_weight,
    difference,
    status,
    new Date().toISOString()
  ).run();

  return json({
    ok: true,
    status,
    difference,
    tolerance: "±0.250 kg"
  });
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}

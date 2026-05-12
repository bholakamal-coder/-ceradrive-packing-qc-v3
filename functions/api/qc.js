export async function onRequestPost({ request, env }) {
  const { carton_id, actual_weight, qc_status } = await request.json();

  if (!carton_id || !actual_weight || !qc_status) {
    return Response.json({ error: "Missing QC data" }, { status: 400 });
  }

  await env.DB.prepare(`
    UPDATE cartons
    SET actual_weight=?, status=?
    WHERE id=?
  `).bind(Number(actual_weight || 0), qc_status, carton_id).run();

  return Response.json({ ok: true });
}

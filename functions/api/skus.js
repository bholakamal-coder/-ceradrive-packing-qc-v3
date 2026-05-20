function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}})}
function normalizeSku(s){return {part_no:String(s.part_no||s.sku||s.SKU||"").trim(),vehicle:String(s.vehicle||s.model||s.Vehicle||s.Model||"").trim(),weight:Number(s.weight||s.Weight||0),mrp:Number(s.mrp||s.MRP||0),dealer:Number(s.dealer||s.Dealer||0),export_price:Number(s.export_price||s.Export||0),active:Number(s.active??1)}}
export async function onRequestGet(context){try{const DB=context.env.DB;await DB.prepare(`CREATE TABLE IF NOT EXISTS skus (part_no TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`).run();let cols=[];try{const info=await DB.prepare(`PRAGMA table_info(skus)`).all();cols=(info.results||[]).map(c=>c.name)}catch(e){}
let skus=[];
if(cols.includes("data")){const rows=await DB.prepare(`SELECT data FROM skus`).all();skus=(rows.results||[]).map(r=>{try{return JSON.parse(r.data)}catch(e){return null}}).filter(Boolean).map(normalizeSku)}
else{const rows=await DB.prepare(`SELECT * FROM skus`).all();skus=(rows.results||[]).map(normalizeSku)}
return json({ok:true,skus})}catch(e){return json({ok:false,error:e.message},500)}}
export async function onRequestPost(context){try{const DB=context.env.DB;const body=await context.request.json();const skus=(body.skus||[]).map(normalizeSku).filter(s=>s.part_no);await DB.prepare(`CREATE TABLE IF NOT EXISTS skus (part_no TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`).run();let cols=[];try{const info=await DB.prepare(`PRAGMA table_info(skus)`).all();cols=(info.results||[]).map(c=>c.name)}catch(e){}
if(!cols.includes("data")){try{await DB.prepare(`ALTER TABLE skus ADD COLUMN data TEXT`).run()}catch(e){}}
if(!cols.includes("updated_at")){try{await DB.prepare(`ALTER TABLE skus ADD COLUMN updated_at TEXT`).run()}catch(e){}}
await DB.prepare(`DELETE FROM skus`).run();
for(const s of skus){await DB.prepare(`INSERT OR REPLACE INTO skus (part_no,data,updated_at) VALUES (?,?,?)`).bind(String(s.part_no),JSON.stringify(s),new Date().toISOString()).run()}
return json({ok:true,saved:skus.length})}catch(e){return json({ok:false,error:e.message},500)}}

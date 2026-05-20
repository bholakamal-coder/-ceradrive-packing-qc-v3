const API={setup:"/api/setup",skus:"/api/skus",orders:"/api/orders",cartons:"/api/cartons"};
const USERS=[{username:"admin",password:"Admin123",role:"ADMIN"},{username:"manager",password:"Manager123",role:"MANAGER"},{username:"packing",password:"Pack123",role:"PACKING"},{username:"qc",password:"Qc123",role:"QC"}];
let state={user:null,screen:"HOME",skus:[],orders:[],cartons:[],orderDraft:[],cartonDraft:[],selectedSku:null,selectedOrderNo:"",brandOn:true};
const QC_TOLERANCE_KG=0.30; // pass range: expected weight +/- 300 grams
function normText(x){return String(x||"").trim().replace(/\s+/g," ")} 
function normStatus(x){return String(x||"").trim().toUpperCase()}
function isQCDone(c){const st=normStatus(c.status);return st==="PASS"||st==="RECHECK"||st==="QC_DONE"||(Number(c.actual_weight||0)>0 && st!=="PENDING_QC")}
function partyKey(x){return normText(x).toLowerCase()}
function parseMaybeDate(x){
 const raw=String(x||"").trim();
 if(!raw)return null;
 const d=new Date(raw);
 return isNaN(d.getTime())?null:d;
}
function fmtDate(x,withTime=false){
 const d=parseMaybeDate(x);
 if(!d)return x?String(x):"-";
 const dd=String(d.getDate()).padStart(2,"0"),mm=String(d.getMonth()+1).padStart(2,"0"),yy=d.getFullYear();
 const date=`${dd}/${mm}/${yy}`;
 if(!withTime)return date;
 let h=d.getHours(),m=String(d.getMinutes()).padStart(2,"0"),ap=h>=12?"PM":"AM";
 h=h%12||12;
 return `${date} ${h}:${m} ${ap}`;
}
function latestFirstValue(x){
 const d=parseMaybeDate(x);
 return d?d.getTime():0;
}
function orderByNo(no){return state.orders.find(o=>String(o.order_no)===String(no))||{}}
const app=document.getElementById("app");init();
async function init(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("/service-worker.js").catch(()=>{});
  }
  await api(API.setup).catch(()=>{});
  await loadAll();

  const remembered=localStorage.getItem("remember_user_v7_2") || localStorage.getItem("remember_user_v7");
  if(remembered){
    const user=USERS.find(u=>u.username===remembered);
    if(user){
      state.user=user;
      state.screen="HOME";
      renderApp();
      return;
    }
  }
  renderLogin();
}
async function api(url,opts={}){const res=await fetch(url,{headers:{"Content-Type":"application/json"},...opts});const text=await res.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}if(!res.ok||data.ok===false)throw new Error(data.error||"API error");return data}
async function loadAll(){
  const localSkus=()=>JSON.parse(localStorage.getItem("skus_v7")||"[]");
  const localOrders=()=>JSON.parse(localStorage.getItem("orders_v7")||"[]");
  const localCartons=()=>JSON.parse(localStorage.getItem("cartons_v7")||"[]");
  try{
    const [s,o,c]=await Promise.all([api(API.skus),api(API.orders),api(API.cartons)]);
    state.skus=Array.isArray(s.skus)?s.skus:[];
    state.orders=Array.isArray(o.orders)?o.orders:[];
    state.cartons=Array.isArray(c.cartons)?c.cartons:[];
    if(!state.skus.length){
      const cached=localSkus();
      if(cached.length){
        state.skus=cached;
        api(API.skus,{method:"POST",body:JSON.stringify({skus:state.skus})}).catch(()=>{});
      }
    }
  }catch(e){
    state.skus=localSkus();
    state.orders=localOrders();
    state.cartons=localCartons();
  }
  localStorage.setItem("skus_v7",JSON.stringify(state.skus||[]));
  localStorage.setItem("orders_v7",JSON.stringify(state.orders||[]));
  localStorage.setItem("cartons_v7",JSON.stringify(state.cartons||[]));
}
function toast(msg){let t=document.getElementById("toast");if(!t){t=document.createElement("div");t.id="toast";t.className="toast";document.body.appendChild(t)}t.textContent=msg;clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.remove(),1800)}
async function saveSkus(){toast("Saving SKU...");localStorage.setItem("skus_v7",JSON.stringify(state.skus));await api(API.skus,{method:"POST",body:JSON.stringify({skus:state.skus})});toast("Saved successfully")}
async function saveOrders(){toast("Saving order...");localStorage.setItem("orders_v7",JSON.stringify(state.orders));await api(API.orders,{method:"POST",body:JSON.stringify({orders:state.orders})});toast("Saved successfully")}
async function saveCartons(){toast("Saving cartons...");localStorage.setItem("cartons_v7",JSON.stringify(state.cartons));await api(API.cartons,{method:"POST",body:JSON.stringify({cartons:state.cartons})});toast("Saved successfully")}
async function saveOrdersSafe(){
 toast("Saving orders safely...");
 localStorage.setItem("orders_v7",JSON.stringify(state.orders));
 let merged=state.orders;
 try{
  const remote=await api(API.orders);
  const map=new Map((remote.orders||[]).map(o=>[String(o.order_no),o]));
  state.orders.forEach(o=>map.set(String(o.order_no),o));
  merged=[...map.values()];
  state.orders=merged;
  localStorage.setItem("orders_v7",JSON.stringify(state.orders));
 }catch(e){}
 await api(API.orders,{method:"POST",body:JSON.stringify({orders:merged})});
 toast("Orders saved");
}
async function saveCartonsSafe(){
 toast("Saving QC safely...");
 localStorage.setItem("cartons_v7",JSON.stringify(state.cartons));
 let merged=state.cartons;
 try{
  const remote=await api(API.cartons);
  const map=new Map((remote.cartons||[]).map(c=>[String(c.id),c]));
  state.cartons.forEach(c=>map.set(String(c.id),c));
  merged=[...map.values()];
  state.cartons=merged;
  localStorage.setItem("cartons_v7",JSON.stringify(state.cartons));
 }catch(e){}
 await api(API.cartons,{method:"POST",body:JSON.stringify({cartons:merged})});
 toast("QC saved");
}
function renderLogin(){
  app.innerHTML=`
    <div class="login-card">
      <img src="assets/logo.jpeg" class="logo" onerror="this.style.display='none'">
      <p class="muted">Packing & QC System V8.0.2</p>

      <input id="loginUser" placeholder="Username">
      <input id="loginPass" type="password" placeholder="Password" onkeydown="if(event.key==='Enter') login()">

      <label style="display:flex;align-items:center;gap:10px;text-align:left;margin-top:14px;font-weight:700">
        <input id="rememberMe" type="checkbox" style="width:auto;margin:0">
        Remember me
      </label>

      <button onclick="login()">LOGIN</button>
    </div>
  `;
}
function login(){
  const u=val("loginUser");
  const p=val("loginPass");
  const user=USERS.find(x=>x.username===u && x.password===p);
  if(!user)return alert("Wrong login");

  state.user=user;

  if(document.getElementById("rememberMe")?.checked){
    localStorage.setItem("remember_user_v7_2",user.username);
    localStorage.setItem("remember_user_v7",user.username);
  }else{
    localStorage.removeItem("remember_user_v7_2");
    localStorage.removeItem("remember_user_v7");
  }

  state.screen="HOME";
  renderApp();
}
function logout(){
  localStorage.removeItem("remember_user_v7_2");
  localStorage.removeItem("remember_user_v7");
  state.user=null;
  renderLogin();
}
function tabs(){
 const r=state.user.role;
 if(r==="ADMIN"||r==="MANAGER")return["HOME","ORDER","PACKING","QC","STICKERS","HISTORY","SKU MASTER"];
 if(r==="PACKING")return["HOME","PACKING","HISTORY"];
 if(r==="QC")return["HOME","QC","STICKERS","HISTORY"];
 return["HOME"];
}

function renderApp(){const t=tabs();app.innerHTML=`<div class="top-nav no-print">${t.map(x=>`<button class="nav-btn ${state.screen===x?'active':''}" onclick="go('${x}')">${x}</button>`).join("")}<button class="nav-btn danger logout-btn" onclick="logout()">LOGOUT</button></div><div id="screenArea"></div>`;renderScreen()}
function go(s){state.screen=s;renderApp()}
function renderScreen(){if(state.screen==="HOME")return renderHome();if(state.screen==="ORDER")return renderOrder();if(state.screen==="PACKING")return renderPacking();if(state.screen==="QC")return renderQC();if(state.screen==="SKU MASTER")return renderSkuMaster();if(state.screen==="STICKERS")return renderStickers();if(state.screen==="HISTORY")return renderHistory()}
function updateOrderCompletion(orderNo,silent=false){const o=state.orders.find(x=>x.order_no===orderNo);if(!o)return;const orderCartons=state.cartons.filter(c=>c.order_no===orderNo);const allPacked=o.items.every((it,i)=>packedQty(orderNo,i)>=Number(it.qty));const allQC=orderCartons.length>0&&orderCartons.every(c=>c.status==="PASS"||c.status==="RECHECK");if(allPacked&&allQC&&o.status!=="COMPLETE"){o.status="COMPLETE";if(!silent)alert("Order Complete: "+o.order_no)}else if(allPacked&&o.status!=="COMPLETE"){o.status="PACKED"}}
function renderHome(){const p=state.orders.filter(o=>o.status==="DRAFT").length,q=state.cartons.filter(c=>c.status==="PENDING_QC").length,pa=state.cartons.filter(c=>c.status==="PASS").length,re=state.cartons.filter(c=>c.status==="RECHECK").length;screen().innerHTML=`<div class="card"><img src="assets/logo.jpeg" class="logo" onerror="this.style.display='none'"><p class="muted">${state.user.role} PANEL</p><div class="grid"><div class="stats">Orders<br><b>${state.orders.length}</b></div><div class="stats">Pending Packing<br><b>${p}</b></div><div class="stats">Pending QC<br><b>${q}</b></div><div class="stats">PASS / RECHECK<br><b>${pa}/${re}</b></div></div></div><div class="menu-grid">${tabs().filter(t=>t!=="HOME").map(t=>`<button class="menu-btn" onclick="go('${t}')"><span>${t}</span><span class="arrow">›</span></button>`).join("")}</div>`}
function renderOrder(){
 screen().innerHTML=`<div class="card"><h1>Order System</h1><p class="muted">Party → SKU → Enter → Qty → Enter → Repeat</p><input id="party" placeholder="Party Name" value="${esc(window.currentParty||"")}" onkeydown="if(event.key==='Enter') focusId('skuSearch')"><input id="skuSearch" placeholder="Search SKU / Vehicle" autocomplete="off" oninput="showSkuResults()" onkeydown="skuEnter(event)"><div id="skuResults"></div><input id="qty" type="number" placeholder="Qty" onkeydown="if(event.key==='Enter') addOrderItem()"><div id="selectedSku"></div><button onclick="addOrderItem()">ADD ITEM</button><hr><h3>Order Excel Import</h3><p class="hint">Columns: Party Name | Part No | Qty</p><input type="file" accept=".xlsx,.xls,.csv" onchange="importOrdersExcel(event)"></div><div id="orderDraftBox"></div><div class="card"><button class="green" onclick="saveOrder()">SAVE ORDER</button></div><div class="card"><h2>Saved Orders</h2>${ordersListHTML()}</div>`;
 renderOrderDraft();
 setTimeout(()=>focusId(window.currentParty?"skuSearch":"party"),50);
}

function skuText(s){return `${s.part_no||""} ${s.vehicle||""}`}
function cleanSearch(x){return String(x||"").toLowerCase().replace(/[^a-z0-9]/g,"")}
function skuMatch(s,q){const raw=String(q||"").toLowerCase().trim();const clean=cleanSearch(raw);return Number(s.active??1)!==0&&(skuText(s).toLowerCase().includes(raw)||cleanSearch(skuText(s)).includes(clean))}
function showSkuResults(){const q=val("skuSearch"),box=document.getElementById("skuResults");state.selectedSku=null;if(!q.trim()){box.innerHTML="";document.getElementById("selectedSku").innerHTML="";return}const list=state.skus.filter(s=>skuMatch(s,q)).slice(0,20);box.innerHTML=list.length?list.map(s=>`<div class="result-item" onclick="selectSku('${attr(s.part_no)}')"><span><b>${esc(s.part_no)}</b> — ${esc(s.vehicle||"")}</span><span>${Number(s.weight||0).toFixed(2)} kg</span></div>`).join(""):`<div class="result-item muted">No SKU found. Check SKU Master data.</div>`}
function skuEnter(e){if(e.key!=="Enter")return;e.preventDefault();const q=val("skuSearch");const m=state.skus.find(s=>skuMatch(s,q));if(!m)return alert("SKU Not Found");selectSku(m.part_no)}
function selectSku(partNo){const s=state.skus.find(x=>String(x.part_no)===String(partNo));if(!s)return;state.selectedSku=s;document.getElementById("skuSearch").value=`${s.part_no} — ${s.vehicle||""}`;document.getElementById("skuResults").innerHTML="";document.getElementById("selectedSku").innerHTML=`<div class="info-box"><b>${esc(s.part_no)}</b> — ${esc(s.vehicle||"")}<br>Weight: ${Number(s.weight||0).toFixed(2)} kg</div>`;focusId("qty")}
function addOrderItem(){
 const party=val("party").trim();window.currentParty=party;
 if(!party)return alert("Party Name required");
 if(!state.selectedSku)return alert("Select SKU");
 const qty=Number(val("qty"));if(!qty)return alert("Enter Qty");
 addDraftItem(state.selectedSku,qty);
 state.selectedSku=null;
 document.getElementById("skuSearch").value="";
 document.getElementById("qty").value="";
 document.getElementById("selectedSku").innerHTML="";
 renderOrderDraft();focusId("skuSearch");
}
function addDraftItem(s,qty){
 const existing=state.orderDraft.find(i=>String(i.part_no).toLowerCase()===String(s.part_no).toLowerCase());
 if(existing)existing.qty+=qty;
 else state.orderDraft.push({part_no:s.part_no,vehicle:s.vehicle||"",qty,weight:Number(s.weight||0)});
}
async function importOrdersExcel(e){
 const file=e.target.files[0];if(!file)return;
 toast("Importing orders...");
 const data=await file.arrayBuffer();const wb=XLSX.read(data);const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
 let party="";const missing=[];state.orderDraft=[];
 rows.forEach((r,i)=>{const p=String(r["Party Name"]||r["Party"]||r["party"]||"").trim();const part=String(r["Part No"]||r["part_no"]||r["SKU"]||"").trim();const qty=Number(r["Qty"]||r["qty"]||0);if(p)party=p;if(!part||!qty)return;const sku=state.skus.find(s=>String(s.part_no).toLowerCase()===part.toLowerCase());if(!sku)missing.push(`Row ${i+2}: ${part}`);else addDraftItem(sku,qty);});
 if(party){document.getElementById("party").value=party;window.currentParty=party;}
 renderOrderDraft();
 if(missing.length)alert("SKU not found:\n"+missing.join("\n"));
 toast("Import complete");
}

function renderOrderDraft(){const box=document.getElementById("orderDraftBox");if(!box)return;let tq=0,tw=0;box.innerHTML=`<div class="card"><h2>Current Order</h2>${!state.orderDraft.length?`<p>No items added.</p>`:state.orderDraft.map((it,i)=>{tq+=Number(it.qty);tw+=Number(it.qty)*Number(it.weight);return`<div class="line order-draft-line"><div><b>${esc(it.part_no)}</b><br>${esc(it.vehicle)}</div><div class="order-qty-box"><label>Qty</label><input class="inline-qty-input" type="number" min="1" step="1" inputmode="numeric" value="${Number(it.qty)||0}" onchange="updateDraftQty(${i},this.value)" oninput="updateDraftQtySilent(${i},this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"><div class="muted">Wt: ${(Number(it.qty)*Number(it.weight)).toFixed(2)} kg</div></div><button class="danger small" onclick="deleteDraftItem(${i})">Delete</button></div>`}).join("")}<hr><h3>Total Qty: ${tq}</h3><h3>Expected Weight: ${tw.toFixed(2)} kg</h3></div>`}
function updateDraftQtySilent(i,v){const qty=Number(v);if(!state.orderDraft[i]||!qty||qty<1)return;state.orderDraft[i].qty=qty}
function updateDraftQty(i,v){const qty=Number(v);if(!state.orderDraft[i])return;if(!qty||qty<1){alert("Enter valid Qty");renderOrderDraft();return}state.orderDraft[i].qty=qty;renderOrderDraft()}
function deleteDraftItem(i){state.orderDraft.splice(i,1);renderOrderDraft()}
function nextOrderNo(){return String(state.orders.length+1).padStart(2,"0")}
async function saveOrder(){const party=val("party").trim();if(!party)return alert("Party Name required");if(!state.orderDraft.length)return alert("Add at least one item");const o={order_no:nextOrderNo(),party,items:state.orderDraft,created_at:new Date().toLocaleString(),status:"DRAFT"};state.orders.push(o);state.orderDraft=[];window.currentParty="";try{await saveOrders();alert("Order Saved: "+o.order_no);renderOrder()}catch(e){alert("Save failed: "+e.message)}}
async function deleteOrder(orderNo){if(!confirm("Delete Order "+orderNo+"?"))return;state.orders=state.orders.filter(o=>o.order_no!==orderNo);state.cartons=state.cartons.filter(c=>c.order_no!==orderNo);await saveOrders();await saveCartons();renderOrder()}
function ordersListHTML(){if(!state.orders.length)return`<p>No saved orders.</p>`;return state.orders.slice().reverse().map(o=>`<div class="line"><div onclick="openOrder('${o.order_no}')"><b>Order ${o.order_no}</b> ${o.status==="COMPLETE"?`<span class="badge complete">COMPLETE</span>`:""}<br>${esc(o.party)}<br>${o.created_at}</div><div>Items: ${o.items.length}<br>Status: ${o.status}</div><button class="danger small" onclick="deleteOrder('${o.order_no}')">Delete</button></div>`).join("")}
function openOrder(orderNo){const o=state.orders.find(x=>x.order_no===orderNo);if(!o)return;screen().innerHTML=`<div class="card"><h1>Order ${o.order_no} ${o.status==="COMPLETE"?`<span class="badge complete">COMPLETE</span>`:""}</h1><p>${esc(o.party)} · ${o.status}</p>${o.items.map(i=>`<div class="line"><div><b>${esc(i.part_no)}</b><br>${esc(i.vehicle)}</div><div>Qty: ${i.qty}</div></div>`).join("")}<button class="secondary" onclick="renderOrder()">Back</button></div>`}
function renderPacking(){
 const pending=state.orders.filter(o=>{updateOrderCompletion(o.order_no,true);return o.status!=="COMPLETE"&&o.items.some((it,i)=>packedQty(o.order_no,i)<Number(it.qty));});
 screen().innerHTML=`<div class="card"><h1>Packing</h1><select id="packOrder" onchange="selectPackOrder(this.value)"><option value="">Select Order</option>${pending.map(o=>`<option value="${o.order_no}" ${state.selectedOrderNo===o.order_no?"selected":""}>${o.order_no} — ${esc(o.party)}</option>`).join("")}</select></div><div id="packingArea"></div><div id="packingStatus">${packingStatusHTML()}</div>`;
 if(state.selectedOrderNo)renderPackingForm();
}

function selectPackOrder(no){state.selectedOrderNo=no;state.cartonDraft=[];renderPacking()}
function selectedOrder(){return state.orders.find(o=>o.order_no===state.selectedOrderNo)}
function packingStatusHTML(){
 const orderNos=[...new Set(state.cartons.map(c=>String(c.order_no||"")).filter(Boolean))];
 if(!orderNos.length)return"";
 const rows=orderNos.map(no=>{
  const o=orderByNo(no);
  const cs=state.cartons.filter(c=>String(c.order_no)===String(no));
  const pending=cs.filter(c=>normStatus(c.status)==="PENDING_QC").length;
  const done=cs.filter(c=>isQCDone(c)).length;
  const total=Math.max(...cs.map(c=>Number(c.total_cartons)||0),cs.length,0);
  const created=o.created_at||cs[0]?.created_at||"";
  const latestQC=Math.max(...cs.map(c=>latestFirstValue(c.qc_at||c.created_at)),0);
  return {no,party:o.party||cs[0]?.party||"",created,latest:latestQC||latestFirstValue(created),pending,done,total};
 }).sort((a,b)=>b.latest-a.latest||Number(b.no)-Number(a.no));
 return`<div class="card"><h2>Packing / QC Status</h2>${rows.map(r=>`<div class="line"><div><b>Order ${esc(r.no)}</b> · <b>${esc(r.party)}</b><br><span class="muted">Date: ${esc(fmtDate(r.created))}</span><br>Total Cartons: ${r.total} | Sent to QC: ${r.pending+r.done} | Pending QC: ${r.pending} | QC Done: ${r.done}</div><div>${r.pending?`<span class="badge pending">PENDING ${r.pending}</span>`:`<span class="badge complete">QC DONE ${r.done}</span>`}</div></div>`).join("")}</div>`;
}
function renderPackingForm(){
  const o=selectedOrder();
  if(!o)return;

  updateOrderCompletion(o.order_no,true);

  const existing=state.cartons.filter(c=>c.order_no===o.order_no);
  const cartonNo=window.currentCartonNo||String(existing.length+1);

  document.getElementById("packingArea").innerHTML=`
    <div class="card">
      <h2>
        ${esc(o.party)} / Order ${o.order_no}
        ${o.status==="COMPLETE"?`<span class="badge complete">COMPLETE</span>`:""}
      </h2>

      ${
        (state.user.role==="ADMIN"||state.user.role==="MANAGER")
        ? `<button class="danger small" onclick="clearPackingForOrder('${o.order_no}')">Clear Packing/QC for this Order</button>`
        : ""
      }

      ${balanceTable(o)}

      <p class="hint">Carton No</p>
      <input
        id="cartonNo"
        placeholder="Carton No"
        value="${cartonNo}"
        inputmode="numeric"
        onkeydown="handleCartonEnter(event)"
      >

      <p class="hint">Empty Carton Weight</p>
      <input
        id="tare"
        type="number"
        step="0.01"
        placeholder="Empty Carton Weight kg"
        value="${window.currentTare||"0.30"}"
        onkeydown="if(event.key==='Enter'){event.preventDefault();focusId('packItem')}"
      >

      <p class="hint">Item Packed</p>
      <select
        id="packItem"
        onkeydown="if(event.key==='Enter'){event.preventDefault();focusId('packQty')}"
      >
        <option value="">Select item</option>

        ${o.items.map((it,i)=>
          balanceQty(o,i)>0
          ? `<option value="${i}">${it.part_no} — Balance ${balanceQty(o,i)}</option>`
          : ""
        ).join("")}
      </select>

      <p class="hint">Packed Qty</p>
      <input
        id="packQty"
        type="number"
        placeholder="Qty"
        inputmode="numeric"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addCartonItem()}"
      >

      <button onclick="addCartonItem()">ADD TO CARTON</button>
    </div>

    <div id="cartonDraftBox"></div>

    <div class="card">
      <button class="green" onclick="sendCartonsToQC()">SEND TO QC</button>
    </div>
  `;

  renderCartonDraft();

  setTimeout(()=>{
    const c=document.getElementById("cartonNo");
    if(c){
      c.focus();
      c.select();
    }
  },50);
}

async function clearPackingForOrder(orderNo){
 if(!confirm("Clear all packing/QC cartons for Order "+orderNo+"?")) return;
 state.cartons=state.cartons.filter(c=>c.order_no!==orderNo);
 const o=state.orders.find(x=>x.order_no===orderNo);
 if(o) o.status="DRAFT";
 await saveOrders();
 await saveCartons();
 renderPacking();
}
function balanceTable(o){
  return`
    <table>
      <tr>
        <th>SKU</th>
        <th>Order</th>
        <th>Packed</th>
        <th>Balance</th>
      </tr>

      ${o.items.map((it,i)=>`
        <tr>
          <td>${it.part_no}</td>
          <td>${it.qty}</td>
          <td>${packedQty(o.order_no,i)}</td>
          <td><b>${balanceQty(o,i)}</b></td>
        </tr>
      `).join("")}
    </table>
  `;
}
function packedQty(no,i){return state.cartons.filter(c=>c.order_no===no).flatMap(c=>c.items||[]).filter(x=>Number(x.order_item_index)===i).reduce((s,x)=>s+Number(x.qty),0)}
function draftQty(i){return state.cartonDraft.filter(x=>Number(x.order_item_index)===i).reduce((s,x)=>s+Number(x.qty),0)}
function balanceQty(o,i){return Number(o.items[i].qty)-packedQty(o.order_no,i)-draftQty(i)}
function addCartonItem(){
  const o=selectedOrder();
  if(!o)return;

  const idx=Number(val("packItem"));
  const qty=Number(val("packQty"));
  const cartonNo=val("cartonNo").trim();
  const tare=Number(val("tare")||0);

  if(!cartonNo)return alert("Enter Carton No");

  window.currentCartonNo=cartonNo;
  window.currentTare=tare;

  if(val("packItem")===""||!qty)return alert("Select item and qty");
  if(qty>balanceQty(o,idx))return alert("Qty exceeds balance");

  const beforeBalance=balanceQty(o,idx);
  const it=o.items[idx];

  state.cartonDraft.push({
    carton_no:cartonNo,
    order_item_index:idx,
    part_no:it.part_no,
    vehicle:it.vehicle,
    qty,
    weight:it.weight,
    tare
  });

  const afterBalance=balanceQty(o,idx);

  if(beforeBalance>0 && afterBalance===0){
    alert("PART COMPLETE: "+it.part_no);
  }

  const fullOrderComplete=o.items.every((item,i)=>balanceQty(o,i)===0);
  if(fullOrderComplete){
    alert("ORDER COMPLETE");
  }

  renderPackingForm();

  setTimeout(()=>{
    const c=document.getElementById("cartonNo");
    if(c){
      c.focus();
      c.select();
    }
  },50);
}
function deleteCartonDraft(i){state.cartonDraft.splice(i,1);renderPackingForm()}
function renderCartonDraft(){const box=document.getElementById("cartonDraftBox");if(!box)return;box.innerHTML=`<div class="card"><h2>Carton Draft</h2>${state.cartonDraft.length===0?"<p>No carton items.</p>":state.cartonDraft.map((i,idx)=>`<div class="line"><div><b>Carton ${i.carton_no}</b><br>${i.part_no} x ${i.qty}</div><div>Gross ${(i.qty*i.weight+i.tare).toFixed(2)} kg</div><button class="danger small" onclick="deleteCartonDraft(${idx})">Delete</button></div>`).join("")}</div>`}
async function sendCartonsToQC(){const o=selectedOrder();if(!o)return;if(!state.cartonDraft.length)return alert("Add carton items");const nos=[...new Set(state.cartonDraft.map(i=>String(i.carton_no)))],total=String(Math.max(...nos.map(n=>Number(n)||0)));nos.forEach(no=>{const items=state.cartonDraft.filter(i=>String(i.carton_no)===no),tare=Number(items[0]?.tare||0),itemWeight=items.reduce((s,i)=>s+i.qty*i.weight,0);state.cartons.push({id:Date.now()+"_"+Math.random().toString(16).slice(2),order_no:o.order_no,party:o.party,carton_no:no,total_cartons:total,items,tare,expected_weight:itemWeight+tare,actual_weight:0,status:"PENDING_QC",packed_by:state.user.username,created_at:new Date().toLocaleString()})});updateOrderCompletion(o.order_no,true);state.cartonDraft=[];state.selectedOrderNo="";window.currentCartonNo="";
  window.currentTare="0.30";try{await saveOrders();await saveCartons();alert("Sent to QC");renderPacking()}catch(e){alert("Save failed: "+e.message)}}
function renderQC(){
 const pending=state.cartons.filter(c=>c.status==="PENDING_QC");const parties=[...new Set(pending.map(c=>c.party))];
 screen().innerHTML=`<div class="card"><h1>QC</h1><select onchange="renderQCCards(this.value)"><option value="">Select Party</option>${parties.map(p=>`<option>${esc(p)}</option>`).join("")}</select></div><div id="qcArea"></div>`;
}
function renderQCCards(party){
 const list=state.cartons.filter(c=>c.party===party&&c.status==="PENDING_QC");
 const allForParty=state.cartons.filter(c=>c.party===party);
 if(!list.length){document.getElementById("qcArea").innerHTML=`<div class="card"><h2>${esc(party)}</h2><h1><span class="badge complete">COMPLETE</span></h1><p>Total Cartons: ${allForParty.length}</p><button class="green" onclick="printPartyStickers('${attr(party)}')">PRINT STICKERS</button><button class="secondary" onclick="generateQCPDF('${attr(party)}')">QC PDF</button></div>`;return;}
 document.getElementById("qcArea").innerHTML=`
  <div class="card"><h2>${esc(party)}</h2><p>Pending QC: ${list.length}</p><p class="hint">Pass range = Expected Weight ± ${QC_TOLERANCE_KG.toFixed(2)} kg. Har carton ke liye actual weight mandatory hai. Photo optional hai.</p></div>
  ${list.map((c,index)=>{
    const expected=Number(c.expected_weight||0);
    const low=expected-QC_TOLERANCE_KG;
    const high=expected+QC_TOLERANCE_KG;
    return `<div class="card qc-card">
      <div class="line">
        <div>
          <h2>Carton ${c.carton_no}/${c.total_cartons}</h2>
          ${(c.items||[]).reduce((s,i)=>s+Number(i.qty),0)} sets<br>
          <b>Expected:</b> ${expected.toFixed(2)} kg<br>
          <b>Pass Range:</b> ${low.toFixed(2)} – ${high.toFixed(2)} kg
        </div>
        <div id="live_${c.id}"><span class="badge pending">NOT WEIGHED</span></div>
      </div>

      <input class="qc-weight-input" id="qc_${c.id}" type="number" step="0.01" inputmode="decimal" placeholder="Actual Weight kg" oninput="liveQC('${c.id}');checkQCButtons()" onkeydown="if(event.key==='Enter'){event.preventDefault();focusNextQC(${index})}">

      <div class="photo-box">
        <p class="hint"><b>Carton Photo</b> — optional. Zarurat ho to weighing machine/carton ki photo click karo</p>
        <input class="qc-photo-input camera-hidden" id="photo_${c.id}" type="file" accept="image/*" capture="environment" onchange="captureQCPhoto('${c.id}', this);checkQCButtons()">
        <button type="button" class="camera-btn" onclick="openCartonCamera('${c.id}')">📷 OPEN CAMERA</button>
        <button type="button" class="small secondary" onclick="openCartonCamera('${c.id}')">Retake</button>
        <div id="photoPreview_${c.id}" class="photo-preview">${c.photo_data?`<img src="${c.photo_data}"><span class="badge pass">PHOTO READY</span>`:`<span class="badge pending">PHOTO OPTIONAL</span>`}</div>
      </div>
    </div>`
  }).join("")}
  <div class="card" id="qcActionButtons" style="display:none"><button class="green" onclick="saveAllQC('${esc(party)}')">SAVE ALL QC</button></div>`;
 setTimeout(()=>focusFirstEmptyQC(),50);
}
function liveQC(id){
 const c=state.cartons.find(x=>x.id===id);if(!c)return;
 const actual=Number(val("qc_"+id)),box=document.getElementById("live_"+id);
 const expected=Number(c.expected_weight||0);
 const low=expected-QC_TOLERANCE_KG, high=expected+QC_TOLERANCE_KG;
 if(!actual){box.innerHTML=`<span class="badge pending">NOT WEIGHED</span><p class="hint">Need ${low.toFixed(2)} – ${high.toFixed(2)} kg</p>`;return}
 const diff=actual-expected;
 let st="PASS", detail="OK";
 if(actual<low){st="RECHECK";detail=`UNDER by ${(low-actual).toFixed(2)} kg`}
 else if(actual>high){st="RECHECK";detail=`OVER by ${(actual-high).toFixed(2)} kg`}
 box.innerHTML=`<span class="badge ${st==="PASS"?"pass":"recheck"}">${st}</span><p>Difference: ${diff.toFixed(2)} kg<br>${detail}</p>`
}
function focusPhoto(index){const photos=[...document.querySelectorAll(".qc-photo-input")];const p=photos[index];if(p){p.focus()}checkQCButtons()}
function focusNextQC(index){const inputs=[...document.querySelectorAll(".qc-weight-input")];const n=inputs[index+1];if(n){n.focus();n.select()}else{checkQCButtons();const b=document.querySelector("#qcActionButtons button");if(b)b.focus()}}
function focusFirstEmptyQC(){const i=[...document.querySelectorAll(".qc-weight-input")].find(x=>!x.value);if(i){i.focus();i.select()}}
function openCartonCamera(id){
 const input=document.getElementById("photo_"+id);
 if(!input)return alert("Camera input not found");
 input.value="";
 input.click();
}
async function captureQCPhoto(id,input){
 const file=input.files&&input.files[0]; if(!file)return;
 const c=state.cartons.find(x=>x.id===id); if(!c)return;
 try{
   const data=await resizeImageToDataURL(file,700,0.60);
   c.photo_data=data;
   c.photo_name=`carton_${c.order_no}_${c.carton_no}_${Date.now()}.jpg`;
   const box=document.getElementById("photoPreview_"+id);
   if(box)box.innerHTML=`<img src="${data}"><span class="badge pass">PHOTO READY</span>`;
   toast("Photo attached");
 }catch(e){alert("Photo capture failed: "+e.message)}
}
function resizeImageToDataURL(file,maxSize=900,quality=0.72){
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error("Could not read photo"));
  reader.onload=()=>{
    const img=new Image();
    img.onerror=()=>reject(new Error("Could not load photo"));
    img.onload=()=>{
      const scale=Math.min(1,maxSize/Math.max(img.width,img.height));
      const canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.round(img.width*scale));
      canvas.height=Math.max(1,Math.round(img.height*scale));
      const ctx=canvas.getContext("2d");
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      resolve(canvas.toDataURL("image/jpeg",quality));
    };
    img.src=reader.result;
  };
  reader.readAsDataURL(file);
 });
}
function checkQCButtons(){
 const inputs=[...document.querySelectorAll(".qc-weight-input")];
 const allWeights=inputs.length>0&&inputs.every(i=>Number(i.value)>0);
 const btn=document.getElementById("qcActionButtons");
 if(btn)btn.style.display=allWeights?"block":"none";
}
async function saveAllQC(party){
 const list=state.cartons.filter(c=>c.party===party&&c.status==="PENDING_QC");
 if(!list.length)return alert("No pending QC cartons");
 for(const c of list){
  const actual=Number(val("qc_"+c.id));
  if(!actual)return alert("Fill actual weight for carton "+c.carton_no);
  c.party=normText(c.party);
  c.actual_weight=actual;
  if(c.photo_data){
    c.qc_photo_taken_at=c.qc_photo_taken_at||new Date().toLocaleString();
  }
  c.qc_by=state.user.username;
  c.qc_at=new Date().toLocaleString();
  c.status=Math.abs(actual-Number(c.expected_weight))<=QC_TOLERANCE_KG?"PASS":"RECHECK";
 }
 [...new Set(list.map(c=>c.order_no))].forEach(no=>updateOrderCompletion(no,true));
 try{
  localStorage.setItem("orders_v7_backup_before_qc",JSON.stringify(state.orders));
  localStorage.setItem("cartons_v7_backup_before_qc",JSON.stringify(state.cartons));
  await saveCartonsSafe();
  await saveOrdersSafe();
  alert("QC Saved");
  state.screen="STICKERS";
  renderApp();
 }catch(e){alert("QC save failed: "+e.message)}
}

function renderSkuMaster(){
  screen().innerHTML=`
    <div class="card">
      <h1>SKU Master V8.0.2</h1>

      <input id="skuPart" placeholder="Part No">
      <input id="skuVehicle" placeholder="Vehicle / Model">
      <input id="skuWeight" type="number" step="0.01" placeholder="Weight per set">
      <input id="skuMRP" type="number" placeholder="MRP">

      <button onclick="addSku()">ADD / UPDATE SKU</button>

      <hr>

      <h3>Excel Import</h3>
      <p class="muted">Columns: Part No, Vehicle, Weight, MRP, Dealer, Export</p>
      <input type="file" id="excelFile" accept=".xlsx,.xls,.csv" onchange="importExcel(event)">
    </div>

    <div class="card">
      <input id="skuFilter" placeholder="Search SKU" oninput="renderSkuList()">
      <div id="skuList"></div>
    </div>
  `;

  renderSkuList();
}
async function addSku(){const part_no=val("skuPart").trim();if(!part_no)return alert("Part No required");const obj={part_no,vehicle:val("skuVehicle"),weight:Number(val("skuWeight")||0),mrp:Number(val("skuMRP")||0),dealer:0,export_price:0,active:1};const idx=state.skus.findIndex(s=>String(s.part_no).toLowerCase()===part_no.toLowerCase());if(idx>=0)state.skus[idx]=obj;else state.skus.push(obj);try{await saveSkus();renderSkuMaster()}catch(e){alert("Save failed: "+e.message)}}
function renderSkuList(){
  const box=document.getElementById("skuList");
  if(!box)return;

  const q=(val("skuFilter")||"").toLowerCase();

  const list=state.skus.filter(s=>
    String(s.part_no).toLowerCase().includes(q) ||
    String(s.vehicle||"").toLowerCase().includes(q)
  );

  if(!list.length){
    box.innerHTML="<p>No SKU found.</p>";
    return;
  }

  box.innerHTML=list.map(s=>`
    <div class="sku-row">
      <div class="sku-part"><b>${esc(s.part_no)}</b></div>
      <div class="sku-vehicle">${esc(s.vehicle||"")}</div>
      <div class="sku-weight">${Number(s.weight||0).toFixed(2)} kg</div>
      <button class="small secondary sku-edit-btn" onclick="editSku('${attr(s.part_no)}')">EDIT</button>
    </div>
  `).join("");
}
function editSku(partNo){
  const s=state.skus.find(x=>
    String(x.part_no).toLowerCase()===String(partNo).toLowerCase()
  );

  if(!s){
    alert("SKU not found");
    return;
  }

  document.getElementById("skuPart").value=s.part_no || "";
  document.getElementById("skuVehicle").value=s.vehicle || "";
  document.getElementById("skuWeight").value=s.weight || "";
  document.getElementById("skuMRP").value=s.mrp || "";

  document.getElementById("skuPart").focus();
  document.getElementById("skuPart").select();

  toast("Editing "+s.part_no);
}
async function importExcel(e){
 const file=e.target.files[0];if(!file)return;toast("Importing...");
 const data=await file.arrayBuffer();const wb=XLSX.read(data);const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
 const imports=[],dups=[];
 rows.forEach((r,i)=>{const part_no=String(r["Part No"]||r["part_no"]||r["SKU"]||"").trim();if(!part_no)return;const obj={part_no,vehicle:String(r["Vehicle"]||r["Model"]||r["vehicle"]||"").trim(),weight:Number(r["Weight"]||r["weight"]||0),mrp:Number(r["MRP"]||r["mrp"]||0),dealer:Number(r["Dealer"]||0),export_price:Number(r["Export"]||0),active:1};if(state.skus.some(s=>String(s.part_no).toLowerCase()===part_no.toLowerCase()))dups.push(obj);else imports.push(obj);});
 let override=false;if(dups.length){override=confirm(`${dups.length} duplicate SKU found. OK = Override Existing, Cancel = Skip Duplicates`)}
 imports.forEach(x=>state.skus.push(x));
 if(override){dups.forEach(x=>{const idx=state.skus.findIndex(s=>String(s.part_no).toLowerCase()===String(x.part_no).toLowerCase());if(idx>=0)state.skus[idx]=x;});}
 await saveSkus();alert(`Import complete. New: ${imports.length}, ${override?"Overridden":"Skipped duplicates"}: ${dups.length}`);renderSkuMaster();
}


function historyId(prefix, orderNo){return String(prefix||"h")+"_"+String(orderNo||"x").replace(/[^a-zA-Z0-9_-]/g,"_")}
function toggleHistoryDetails(id){
 const el=document.getElementById(id);
 if(!el)return;
 const isOpen=el.style.display==="block";
 el.style.display=isOpen?"none":"block";
 const btn=document.querySelector(`[data-toggle="${id}"]`);
 if(btn)btn.textContent=isOpen?"▼ View Details":"▲ Hide Details";
}
function renderHistory(){screen().innerHTML=`<div class="card"><h1>History</h1><input placeholder="Search party/order/carton" oninput="historyList(this.value)"><div id="historyBox"></div></div>`;historyList("")}
function latestOrderQC(orderNo){
 const qcs=state.cartons.filter(c=>String(c.order_no)===String(orderNo)&&c.qc_at).map(c=>c.qc_at);
 return qcs.length?qcs[qcs.length-1]:"-";
}
function historyList(q){
 q=String(q||"").toLowerCase();
 const orders=state.orders.filter(o=>String(o.party).toLowerCase().includes(q)||String(o.order_no).includes(q)||String(o.status).toLowerCase().includes(q));
 const cartons=state.cartons.filter(c=>String(c.party).toLowerCase().includes(q)||String(c.order_no).includes(q)||String(c.carton_no).includes(q)||String(c.status).toLowerCase().includes(q));
 const orderMap=new Map();
 cartons.forEach(c=>{
   const key=String(c.order_no||"");
   if(!orderMap.has(key)){
     const o=state.orders.find(x=>String(x.order_no)===key)||{};
     orderMap.set(key,{order:o,cartons:[]});
   }
   orderMap.get(key).cartons.push(c);
 });
 const groupedQC=[...orderMap.values()].sort((a,b)=>{
   const ao=a.order||{},bo=b.order||{};
   const ad=latestFirstValue(latestOrderQC(ao.order_no||a.cartons[0]?.order_no)||ao.created_at||a.cartons[0]?.created_at);
   const bd=latestFirstValue(latestOrderQC(bo.order_no||b.cartons[0]?.order_no)||bo.created_at||b.cartons[0]?.created_at);
   return bd-ad || Number(bo.order_no||0)-Number(ao.order_no||0);
 });
 const sortedOrders=orders.slice().sort((a,b)=>latestFirstValue(b.created_at)-latestFirstValue(a.created_at)||Number(b.order_no||0)-Number(a.order_no||0));
 document.getElementById("historyBox").innerHTML=`
   <h2>Orders</h2>
   ${sortedOrders.map(o=>{
     const id=historyId("ord",o.order_no);
     const items=o.items||[];
     const totalQty=items.reduce((sum,i)=>sum+Number(i.qty||0),0);
     return `<div class="line history-compact-card"><div class="history-summary-row" onclick="toggleHistoryDetails('${id}')"><div><b>Order ${esc(o.order_no)}</b><br><b>${esc(o.party)}</b><br><span class="muted">Date: ${esc(fmtDate(o.created_at,true))}</span><br><span class="muted">Status: ${esc(o.status||"")} | Items: ${items.length} | Qty: ${totalQty}</span></div><button class="small secondary" data-toggle="${id}" onclick="event.stopPropagation();toggleHistoryDetails('${id}')">▼ View Details</button></div><div id="${id}" class="history-details"><div class="qc-carton-list">${items.length?items.map((i,idx)=>`<div class="qc-carton-row"><b>${idx+1}. ${esc(i.part_no)}</b><br>${esc(i.vehicle||"")} | Qty: ${esc(i.qty||0)} | Weight: ${Number(i.weight||0).toFixed(2)} kg</div>`).join(""):`<div class="qc-carton-row">No item detail</div>`}</div></div></div>`;
   }).join("")}
   <h2>Cartons/QC</h2>
   ${groupedQC.map(g=>{
     const o=g.order||{};
     const first=g.cartons[0]||{};
     const cs=g.cartons.slice().sort((a,b)=>Number(a.carton_no)-Number(b.carton_no));
     const orderNo=o.order_no||first.order_no||"-";
     const party=o.party||first.party||"-";
     const qcDate=latestOrderQC(orderNo);
     const pass=cs.filter(c=>normStatus(c.status)==="PASS").length;
     const recheck=cs.filter(c=>normStatus(c.status)==="RECHECK").length;
     const id=historyId("qc",orderNo);
     return `<div class="line history-compact-card"><div class="history-summary-row" onclick="toggleHistoryDetails('${id}')"><div><b>Order ${esc(orderNo)}</b><br><b>${esc(party)}</b><br><span class="muted">Order Date: ${esc(fmtDate(o.created_at||first.created_at,true))}</span><br><span class="muted">QC Date: ${esc(fmtDate(qcDate,true))}</span><br><span class="muted">Cartons: ${cs.length} | PASS: ${pass} | RECHECK: ${recheck}</span></div><button class="small secondary" data-toggle="${id}" onclick="event.stopPropagation();toggleHistoryDetails('${id}')">▼ View Details</button></div><div id="${id}" class="history-details"><div class="qc-carton-list">${cs.map(c=>`<div class="qc-carton-row"><b>${esc(c.carton_no)}/${esc(c.total_cartons)}</b> — ${esc(c.status||"")}<br>Expected: ${Number(c.expected_weight||0).toFixed(2)} kg | Actual: ${Number(c.actual_weight||0).toFixed(2)} kg<br>${c.photo_data?"📷 Photo Saved":"No photo"}${c.photo_data?`<br><img class="history-photo" src="${c.photo_data}">`:""}</div>`).join("")}</div></div></div>`;
   }).join("")}
 `;
}
function renderStickers(){
 const done=state.cartons.filter(isQCDone).map(c=>{c.status=normStatus(c.status)==="RECHECK"?"RECHECK":"PASS";c.party=normText(c.party);return c});
 const groupMap=new Map();
 done.forEach(c=>{
  const key=String(c.order_no||partyKey(c.party));
  if(!groupMap.has(key)){
   const o=orderByNo(c.order_no);
   groupMap.set(key,{order_no:c.order_no||"-",party:o.party||c.party,created_at:o.created_at||c.created_at||"",cartons:[]});
  }
  groupMap.get(key).cartons.push(c);
 });
 const groups=[...groupMap.values()].sort((a,b)=>latestFirstValue(b.created_at)-latestFirstValue(a.created_at)||Number(b.order_no)-Number(a.order_no));
 screen().innerHTML=`<div class="card"><h1>Stickers</h1><p class="hint">Latest order first. QC complete cartons yaha order-wise dikhenge.</p><label><input type="checkbox" id="stickerLogoToggle" checked style="width:auto"> Print Ceradrive Logo</label>${!groups.length?"<p>No QC completed cartons.</p>":groups.map(g=>{const cs=g.cartons.sort((a,b)=>Number(a.carton_no)-Number(b.carton_no));const total=Math.max(...cs.map(c=>Number(c.total_cartons)||0),cs.length,0);return`<div class="line"><div><b>Order ${esc(g.order_no)}</b> · <b>${esc(g.party)}</b><br><span class="muted">Date: ${esc(fmtDate(g.created_at))}</span><br>Total Cartons: ${total} | QC Done: ${cs.length}<br>${cs.map(c=>`<span class="carton-row">${esc(c.carton_no)}/${esc(c.total_cartons)}</span>`).join("")}</div><button class="small green" onclick="printOrderStickers('${attr(g.order_no)}')">PRINT ORDER</button><button class="small secondary" onclick="generateQCPDF('${attr(g.party)}')">QC PDF</button></div>`}).join("")}</div>`;
}
function printPartyStickers(party){const key=partyKey(party);const list=state.cartons.filter(c=>partyKey(c.party)===key&&isQCDone(c)).sort((a,b)=>Number(a.carton_no)-Number(b.carton_no));if(!list.length)return alert("No QC completed cartons found for "+party);const branding=document.getElementById("stickerLogoToggle")?.checked??true;printStickerList(list,branding)}
function printOrderStickers(orderNo){const list=state.cartons.filter(c=>String(c.order_no)===String(orderNo)&&isQCDone(c)).sort((a,b)=>Number(a.carton_no)-Number(b.carton_no));if(!list.length)return alert("No QC completed cartons found for Order "+orderNo);const branding=document.getElementById("stickerLogoToggle")?.checked??true;printStickerList(list,branding)}
function printStickerList(all,branding=true){const html=`<html><head><title>Stickers</title><style>@page{size:100mm 100mm;margin:0}body{margin:0;font-family:Arial}.sticker{width:100mm;height:100mm;padding:7mm;box-sizing:border-box;border:2px solid #111;page-break-after:always}.top{display:flex;justify-content:space-between}.brandimg{max-width:170px;max-height:55px}.smalln{font-size:24px;font-weight:bold;white-space:nowrap}table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}td,th{border:1px solid #111;padding:4px}.status{text-align:center;border:2px solid #111;margin-top:8px;padding:7px;font-weight:bold}</style></head><body onload="window.print()">${all.map(c=>{const tare=Number(c.tare||0),gross=Number(c.actual_weight||c.expected_weight||0),net=gross-tare;return`<div class="sticker"><div class="top"><div>${branding?`<img src="/assets/logo.jpeg" class="brandimg">`:""}</div><div><span class="smalln">${c.carton_no}/${c.total_cartons}</span></div></div><p><b>CUSTOMER:</b> ${esc(c.party).toUpperCase()}<br><b>Net:</b> ${net.toFixed(2)} kg &nbsp; <b>Tare:</b> ${tare.toFixed(2)} kg<br><b>Gross:</b> ${gross.toFixed(2)} kg</p><table><tr><th>SKU</th><th>MODEL</th><th>QTY</th></tr>${(c.items||[]).map(i=>`<tr><td>${esc(i.part_no)}</td><td>${esc(i.vehicle||"")}</td><td>${i.qty}</td></tr>`).join("")}</table><div class="status">${c.status}</div></div>`}).join("")}</body></html>`;const w=window.open("","_blank");w.document.write(html);w.document.close()}

function generateQCPDF(party){const key=partyKey(party);const list=state.cartons.filter(c=>partyKey(c.party)===key);const html=`<html><head><title>QC Report</title><style>body{font-family:Arial;padding:24px}img{max-width:220px}.qcimg{width:95px;max-height:80px;object-fit:cover}table{width:100%;border-collapse:collapse;margin-top:15px}td,th{border:1px solid #333;padding:8px;font-size:12px}h1{margin-bottom:0}@media print{button{display:none}}</style></head><body><img src="/assets/logo.jpeg"><h1>QC Report</h1><p><b>Party:</b> ${esc(party)}<br><b>Date:</b> ${new Date().toLocaleString()}</p><button onclick="window.print()">Print / Save PDF</button><table><tr><th>Order</th><th>Carton</th><th>SKU / Model</th><th>Qty</th><th>Expected</th><th>Actual</th><th>Diff</th><th>Status</th><th>Photo</th></tr>${list.map(c=>(c.items||[]).map((i,idx)=>`<tr><td>${c.order_no}</td><td>${c.carton_no}/${c.total_cartons}</td><td>${esc(i.part_no)}<br>${esc(i.vehicle||"")}</td><td>${i.qty}</td><td>${Number(c.expected_weight||0).toFixed(2)}</td><td>${Number(c.actual_weight||0).toFixed(2)}</td><td>${(Number(c.actual_weight||0)-Number(c.expected_weight||0)).toFixed(2)}</td><td>${c.status}</td><td>${idx===0&&c.photo_data?`<img class="qcimg" src="${c.photo_data}">`:""}</td></tr>`).join("")).join("")}</table></body></html>`;const w=window.open("","_blank");w.document.write(html);w.document.close()}
function screen(){return document.getElementById("screenArea")}function val(id){return document.getElementById(id)?.value||""}function focusId(id){document.getElementById(id)?.focus()}function esc(v){return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function attr(v){return esc(v).replace(/'/g,"&#39;")}


function handleCartonEnter(event){
  if(event.key!=="Enter")return;

  event.preventDefault();

  const current=val("cartonNo").trim();

  if(!current){
    focusId("cartonNo");
    return;
  }

  if(window.lastCartonNo!==current){
    window.lastCartonNo=current;
    focusId("tare");
  }else{
    focusId("packItem");
  }
}

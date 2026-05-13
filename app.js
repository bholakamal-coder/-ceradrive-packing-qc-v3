const API = {
  login: "/api/login",
  orders: "/api/orders",
  cartons: "/api/cartons",
  qc: "/api/qc",
  sku: "/api/sku"
};

let state = {
  user: JSON.parse(localStorage.getItem("user") || "null"),
  tab: "dashboard",
  orders: [],
  cartons: [],
  skus: [],
  orderItems: [],
  cartonItems: [],
  selectedOrder: null,
  selectedCarton: null,
  logoOn: true
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  injectStyle();
  if (!state.user) return renderLogin();
  await loadAll();
  renderApp();
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || "API error");
  return data;
}

async function loadAll() {
  try {
    const [o, c, s] = await Promise.all([
      api(API.orders).catch(() => ({ orders: [] })),
      api(API.cartons).catch(() => ({ cartons: [] })),
      api(API.sku).catch(() => ({ skus: [] }))
    ]);
    state.orders = o.orders || [];
    state.cartons = c.cartons || [];
    state.skus = s.skus || s.items || [];
  } catch (e) {
    alert(e.message);
  }
}

function renderLogin() {
  document.body.innerHTML = `
    <div class="wrap">
      <div class="card">
        <h1>Ceradrive Dispatch QC V3</h1>
        <p>Order → Packing → QC → Sticker Print</p>
        <h2>Login</h2>
        <input id="u" placeholder="Username" value="admin">
        <input id="p" placeholder="Password" type="password" value="Admin123">
        <button onclick="login()">Login</button>
        <small>admin/Admin123, packing/Pack123, qc/Qc123</small>
      </div>
    </div>`;
}

async function login() {
  try {
    const data = await api(API.login, {
      method: "POST",
      body: JSON.stringify({
        username: val("u"),
        password: val("p")
      })
    });
    state.user = data.user;
    localStorage.setItem("user", JSON.stringify(data.user));
    await loadAll();
    renderApp();
  } catch (e) {
    alert("Login failed: " + e.message);
  }
}

function logout() {
  localStorage.removeItem("user");
  state.user = null;
  renderLogin();
}

function renderApp() {
  document.body.innerHTML = `
    <div class="wrap">
      <div class="card">
        <h1>Ceradrive Dispatch QC V3</h1>
        <p>Order → Packing → QC → Sticker Print</p>
      </div>

      <div class="card top">
        <div>
          <h2>Welcome, ${state.user.username}</h2>
          <p>Role: ${state.user.role}</p>
        </div>
        <button class="danger" onclick="logout()">Logout</button>
      </div>

      <div class="tabs">
        ${tabBtn("dashboard","Dashboard")}
        ${tabBtn("orders","Orders")}
        ${tabBtn("packing","Packing")}
        ${tabBtn("qc","QC")}
        ${tabBtn("sku","SKU Master")}
      </div>

      <div id="main"></div>
    </div>`;
  renderTab();
}

function tabBtn(id, label) {
  return `<button class="${state.tab===id?'active':''}" onclick="setTab('${id}')">${label}</button>`;
}

function setTab(t) {
  state.tab = t;
  renderApp();
}

function renderTab() {
  if (state.tab === "orders") return renderOrders();
  if (state.tab === "packing") return renderPacking();
  if (state.tab === "qc") return renderQC();
  if (state.tab === "sku") return renderSKU();
  renderDashboard();
}

function renderDashboard() {
  const pending = state.cartons.filter(c => (c.status || c.qc_status) === "PENDING_QC").length;
  const pass = state.cartons.filter(c => (c.status || c.qc_status) === "PASS").length;
  const recheck = state.cartons.filter(c => (c.status || c.qc_status) === "RECHECK").length;

  main(`
    <div class="card">
      <h2>Dashboard</h2>
      <div class="grid3">
        <div class="stat">Orders<br><b>${state.orders.length}</b></div>
        <div class="stat">Pending QC<br><b>${pending}</b></div>
        <div class="stat">PASS<br><b>${pass}</b></div>
        <div class="stat">RECHECK<br><b>${recheck}</b></div>
      </div>
    </div>
  `);
}


let tempSku = null;

function showSkuSuggest(inputId, boxId) {
  const q = val(inputId).toLowerCase().trim();
  const box = document.getElementById(boxId);
  if (!q) return box.innerHTML = "";
  const list = state.skus.filter(s =>
    String(s.part_no || s.part || "").toLowerCase().includes(q) ||
    String(s.model || s.model_name || s.item || "").toLowerCase().includes(q)
  ).slice(0, 10);

  box.innerHTML = list.map(s => `
    <div onclick='selectSku(${JSON.stringify(s)})'>
      <b>${s.part_no || s.part}</b> — ${s.model || s.model_name || s.item || ""}
    </div>
  `).join("");
}

function selectSku(s) {
  tempSku = s;
  document.querySelectorAll(".suggest").forEach(x => x.innerHTML = "");
}

function orderSearchKey(e) {
  if (e.key !== "Enter") return;
  const q = val("orderSearch").toLowerCase();
  tempSku = state.skus.find(s =>
    String(s.part_no || s.part || "").toLowerCase().includes(q) ||
    String(s.model || s.model_name || s.item || "").toLowerCase().includes(q)
  );
  document.getElementById("orderQty").focus();
}

function addOrderItem() {
  if (!tempSku) return alert("Select item first");
  const qty = Number(val("orderQty"));
  if (!qty) return alert("Enter qty");

  state.orderItems.push({
    part_no: tempSku.part_no || tempSku.part,
    model: tempSku.model || tempSku.model_name || tempSku.item || "",
    qty,
    weight_per_set: Number(tempSku.weight_per_set || tempSku.weight || 0)
  });

  renderOrders();
}

async function saveOrder() {
  try {
    await api(API.orders, {
      method: "POST",
      body: JSON.stringify({
        party_name: val("party"),
        created_by: state.user.username,
        items: state.orderItems
      })
    });
    state.orderItems = [];
    await loadAll();
    renderOrders();
  } catch (e) {
    alert("Save order failed: " + e.message);
  }
}

function renderPacking() {
  const orderOptions = state.orders.map(o => `<option value="${o.id}">#${o.id} — ${o.party_name}</option>`).join("");
  const o = state.selectedOrder;

  main(`
    <div class="card">
      <h2>Packing Entry</h2>
      <select onchange="selectOrder(this.value)">
        <option>Select Party / Order</option>
        ${orderOptions}
      </select>

      ${o ? `
        <div class="info">
          <b>Party:</b> ${o.party_name}<br>
          <b>Order No:</b> ${o.id}
        </div>
      ` : ""}

      <div class="row3">
        <input id="outerWeight" placeholder="Outer Carton Weight kg" type="number" step="0.01">
        <input id="cartonNo" placeholder="Carton No">
        <input id="totalCartons" placeholder="Total Cartons">
      </div>

      ${o ? packingItemSelector(o) : ""}

      ${itemsTable(state.cartonItems, true)}

      <div class="info">
        Item Weight: <b>${cartonItemWeight().toFixed(2)} kg</b><br>
        Outer Carton Weight: <b>${Number(valSafe("outerWeight")).toFixed(2)} kg</b><br>
        Expected Gross Weight: <b>${expectedWeight().toFixed(2)} kg</b>
      </div>

      <button class="green" onclick="saveCarton()">Save Carton / Send to QC</button>
    </div>
  `);
}

async function selectOrder(id) {
  state.selectedOrder = state.orders.find(o => String(o.id) === String(id));
  state.cartonItems = [];
  renderPacking();
}

function packingItemSelector(o) {
  const items = o.items || o.order_items || [];
  return `
    <h3>Order Items / Balance</h3>
    <table>
      <tr><th>Part</th><th>Item</th><th>Order Qty</th><th>Packed</th><th>Balance</th></tr>
      ${items.map(it => {
        const packed = Number(it.packed_qty || 0);
        const bal = Number(it.qty || 0) - packed;
        return `<tr><td>${it.part_no}</td><td>${it.model || it.model_name || ""}</td><td>${it.qty}</td><td>${packed}</td><td><b>${bal}</b></td></tr>`;
      }).join("")}
    </table>

    <div class="row">
      <select id="packItem">
        <option>Select order item</option>
        ${items.map(it => {
          const packed = Number(it.packed_qty || 0);
          const bal = Number(it.qty || 0) - packed;
          return `<option value="${it.part_no}">${it.part_no} — ${it.model || it.model_name || ""} — Balance ${bal}</option>`;
        }).join("")}
      </select>
      <input id="packQty" placeholder="Qty then Enter" type="number" onkeydown="if(event.key==='Enter') addCartonItem()">
    </div>
  `;
}

function addCartonItem() {
  const part = val("packItem");
  const qty = Number(val("packQty"));
  if (!state.selectedOrder || !part || !qty) return alert("Select item and qty");

  const item = (state.selectedOrder.items || state.selectedOrder.order_items || []).find(x => x.part_no === part);
  const balance = Number(item.qty || 0) - Number(item.packed_qty || 0);
  const already = state.cartonItems.filter(x => x.part_no === part).reduce((a,b)=>a+Number(b.qty),0);

  if (qty + already > balance) {
    return alert(`Qty exceeds balance. Balance: ${balance - already}`);
  }

  state.cartonItems.push({
    part_no: item.part_no,
    model: item.model || item.model_name || "",
    qty,
    weight_per_set: Number(item.weight_per_set || 0)
  });

  renderPacking();
}

function cartonItemWeight() {
  return state.cartonItems.reduce((sum, it) => sum + (Number(it.qty) * Number(it.weight_per_set || 0)), 0);
}

function expectedWeight() {
  return cartonItemWeight() + Number(valSafe("outerWeight"));
}

async function saveCarton() {
  try {
    await api(API.cartons, {
      method: "POST",
      body: JSON.stringify({
        order_id: state.selectedOrder.id,
        carton_no: val("cartonNo"),
        total_cartons: val("totalCartons"),
        outer_weight: Number(valSafe("outerWeight")),
        expected_weight: expectedWeight(),
        packed_by: state.user.username,
        items: state.cartonItems
      })
    });

    state.cartonItems = [];
    await loadAll();
    renderPacking();
  } catch (e) {
    alert("Carton save failed: " + e.message);
  }
}

function renderQC() {
  const parties = [...new Set(state.cartons.map(c => c.party_name).filter(Boolean))];

  main(`
    <div class="card">
      <h2>QC / Recheck</h2>

      <select id="qcParty" onchange="renderQCCartons(this.value)">
        <option>Select Party</option>
        ${parties.map(p => `<option>${p}</option>`).join("")}
      </select>

      <div id="qcCartons"></div>
      <div id="qcDetails"></div>
    </div>
  `);
}

function renderQCCartons(party) {
  const list = state.cartons.filter(c => c.party_name === party);
  document.getElementById("qcCartons").innerHTML = `
    <select onchange="selectCarton(this.value)">
      <option>Select Carton</option>
      ${list.map(c => `<option value="${c.id}">${c.party_name} — Carton ${c.carton_no}/${c.total_cartons || ""} — ${c.status || c.qc_status}</option>`).join("")}
    </select>
  `;
}

async function selectCarton(id) {
  const data = await api(`${API.cartons}?id=${id}`);
  state.selectedCarton = data.carton;
  renderQCDetails();
}

function renderQCDetails() {
  const c = state.selectedCarton;
  const pass = (c.status || c.qc_status) === "PASS";

  document.getElementById("qcDetails").innerHTML = `
    <div class="info">
      <b>Party:</b> ${c.party_name}<br>
      <b>Carton:</b> ${c.carton_no}/${c.total_cartons || ""}<br>
      <b>Expected Weight:</b> ${Number(c.expected_weight || 0).toFixed(2)} kg<br>
      <b>Actual Weight:</b> ${Number(c.actual_weight || 0).toFixed(2)} kg<br>
      <b>Status:</b> ${c.status || c.qc_status}
    </div>

    ${itemsTable(c.items || [], false)}

    <input id="actualWeight" placeholder="Actual Weight kg" type="number" step="0.01" value="${c.actual_weight || ""}">
    <button class="green" onclick="saveQC()">Auto PASS / RECHECK</button>

    <label><input type="checkbox" ${state.logoOn ? "checked" : ""} onchange="state.logoOn=this.checked; renderQCDetails()"> Show Ceradrive Logo on Sticker</label>

    ${pass ? `<button onclick="printSticker()">Print Sticker</button>${stickerHTML(c)}` : `<p class="bad">Sticker only for QC PASS cartons</p>`}
  `;
}

async function saveQC() {
  try {
    const data = await api(API.qc, {
      method: "POST",
      body: JSON.stringify({
        carton_id: state.selectedCarton.id,
        actual_weight: Number(val("actualWeight"))
      })
    });

    await loadAll();
    await selectCarton(state.selectedCarton.id);
    alert(`QC Status: ${data.status} | Difference: ${data.difference} kg`);
  } catch (e) {
    alert("QC failed: " + e.message);
  }
}

function stickerHTML(c) {
  const totalQty = (c.items || []).reduce((a,b)=>a+Number(b.qty),0);
  return `
    <div id="sticker" class="sticker">
      ${state.logoOn ? `<h2>CERADRIVE</h2>` : ""}
      <h3>${c.party_name}</h3>
      <hr>
      <b>Carton No:</b> ${c.carton_no}/${c.total_cartons || ""}<br>
      <b>Items:</b><br>
      ${(c.items || []).map(i => `${i.part_no} ${i.model || ""} — ${i.qty}`).join("<br>")}<br>
      <b>Total Qty:</b> ${totalQty}<br>
      <b>Expected Weight:</b> ${Number(c.expected_weight || 0).toFixed(2)} kg<br>
      <b>Actual Weight:</b> ${Number(c.actual_weight || 0).toFixed(2)} kg<br>
      <b>QC Status:</b> ${c.status || c.qc_status}<br>
      <b>Date/Time:</b> ${new Date().toLocaleString()}
    </div>
  `;
}

function printSticker() {
  window.print();
}

function renderSKU() {
  main(`<div class="card"><h2>SKU Master</h2><p>Admin edit/add pending.</p></div>`);
}

function itemsTable(items, del) {
  return `
    <table>
      <tr><th>Part</th><th>Item</th><th>Qty</th>${del ? "<th>Delete</th>" : ""}</tr>
      ${(items || []).map((it, i) => `
        <tr>
          <td>${it.part_no || ""}</td>
          <td>${it.model || it.model_name || ""}</td>
          <td>${it.qty || ""}</td>
          ${del ? `<td><button class="danger" onclick="deleteItem(${i})">Delete</button></td>` : ""}
        </tr>
      `).join("")}
    </table>
  `;
}

function deleteItem(i) {
  if (state.tab === "orders") state.orderItems.splice(i, 1);
  if (state.tab === "packing") state.cartonItems.splice(i, 1);
  renderTab();
}

function val(id) {
  return document.getElementById(id)?.value || "";
}

function valSafe(id) {
  return document.getElementById(id)?.value || 0;
}

function main(html) {
  document.getElementById("main").innerHTML = html;
}

function injectStyle() {
  const style = document.createElement("style");
  style.innerHTML = `
    body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;color:#111}
    .wrap{max-width:1000px;margin:auto;padding:20px}
    .card{background:white;padding:22px;border-radius:14px;margin:14px 0;box-shadow:0 2px 8px #0001}
    .top{display:flex;justify-content:space-between;align-items:center}
    input,select,button{width:100%;padding:14px;margin:8px 0;border:1px solid #ccc;border-radius:10px;font-size:16px}
    button{background:#304ffe;color:white;font-weight:bold;border:none;cursor:pointer}
    .green{background:#2e7d32}
    .danger{background:#a33}
    .tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
    .tabs button{background:white;color:#111;border:1px solid #ccc}
    .tabs button.active{background:#304ffe;color:white}
    .row{display:grid;grid-template-columns:2fr 1fr;gap:10px}
    .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
    table{width:100%;border-collapse:collapse;margin:12px 0}
    th,td{border:1px solid #ddd;padding:10px;text-align:left}
    th{background:#eee}
    .suggest{position:absolute;background:white;border:1px solid #aaa;z-index:999;width:100%;max-height:220px;overflow:auto}
    .suggest div{padding:12px;border-bottom:1px solid #eee;cursor:pointer}
    .suggest div:hover{background:#eef}
    .searchBox{position:relative}
    .info{background:#f1f5ff;padding:12px;border-radius:10px;margin:10px 0}
    .stat{background:#f1f5ff;padding:20px;border-radius:12px;text-align:center}
    .grid3{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
    .bad{color:#a33;font-weight:bold}
    .sticker{width:360px;border:2px solid #111;padding:18px;margin-top:15px;background:white;color:#111}
    .sticker h2{text-align:center;color:#8b1d1d;letter-spacing:2px}
    @media print{body *{visibility:hidden}#sticker,#sticker *{visibility:visible}#sticker{position:absolute;left:0;top:0}}
  `;
  document.head.appendChild(style);
}

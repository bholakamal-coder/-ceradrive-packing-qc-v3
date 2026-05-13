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
  logoOn: true,
  partyName: "",
  outerWeight: "",
  cartonNo: "",
  totalCartons: ""
};

let tempSku = null;
let suggestionList = [];

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
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }

  if (!res.ok) throw new Error(data.error || "API error");
  return data;
}

async function loadAll() {
  const [o, c, s] = await Promise.all([
    api(API.orders).catch(() => ({ orders: [] })),
    api(API.cartons).catch(() => ({ cartons: [] })),
    api(API.sku + "?q=").catch(() => ({ skus: [] }))
  ]);

  state.orders = o.orders || [];
  state.cartons = c.cartons || [];
  state.skus = dedupeSkus(s.skus || s.items || []);
}

function dedupeSkus(list) {
  const seen = new Set();

  return (list || []).filter(s => {
    const part = String(s.part_no || s.part || "").trim();
    const model = String(s.model || s.model_name || s.item || "").trim();
    const key = `${part}|${model}`.toLowerCase();

    if (!part || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* LOGIN */

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
    </div>
  `;
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

/* MAIN */

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
        ${tabBtn("dashboard", "Dashboard")}
        ${tabBtn("orders", "Orders")}
        ${tabBtn("packing", "Packing")}
        ${tabBtn("qc", "QC")}
        ${tabBtn("sku", "SKU Master")}
      </div>

      <div id="main"></div>
    </div>
  `;

  renderTab();
}

function tabBtn(id, label) {
  return `<button class="${state.tab === id ? "active" : ""}" onclick="setTab('${id}')">${label}</button>`;
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

/* ORDERS */

function renderOrders() {
  main(`
    <div class="card">
      <h2>Admin Order Entry</h2>

      <input id="party" placeholder="Party Name" value="${escapeAttr(state.partyName)}" oninput="state.partyName=this.value">

      <div class="row">
        <div class="searchBox">
          <input id="orderSearch"
            placeholder="Search Part / Model"
            autocomplete="off"
            oninput="showSkuSuggest('orderSearch','orderSuggest')"
            onkeydown="orderSearchKey(event)">
          <div id="orderSuggest" class="suggest"></div>
        </div>

        <input id="orderQty"
          placeholder="Qty then Enter"
          type="number"
          onkeydown="if(event.key==='Enter') addOrderItem()">
      </div>

      ${itemsTable(state.orderItems, true)}

      <button class="green" onclick="saveOrder()">Save Order</button>

      <h3>Saved Orders</h3>

      ${state.orders.map(o => `
        <div class="line">
          <b>#${o.id} — ${o.party_name}</b><br>
          Status: ${o.status || "PENDING"}<br>

          <div class="row">
            <button onclick="viewOrder(${o.id})">View Order</button>
            <button class="danger" onclick="deleteOrder(${o.id})">Delete Order</button>
          </div>
        </div>
      `).join("") || "No orders"}

      <div id="orderViewBox"></div>
    </div>
  `);
}

async function showSkuSuggest(inputId, boxId) {
  const q = val(inputId).toLowerCase().trim();
  const box = document.getElementById(boxId);

  if (!q) {
    suggestionList = [];
    box.innerHTML = "";
    return;
  }

  let list = state.skus.filter(s =>
    String(s.part_no || s.part || "").toLowerCase().includes(q) ||
    String(s.model || s.model_name || s.item || "").toLowerCase().includes(q) ||
    String(s.make_name || "").toLowerCase().includes(q)
  );

  if (!list.length) {
    try {
      const d = await api(API.sku + "?q=" + encodeURIComponent(q));
      list = d.skus || d.items || [];
    } catch {}
  }

  suggestionList = dedupeSkus(list).slice(0, 10);

  box.innerHTML = suggestionList.map((s, i) => `
    <div onclick="selectSkuByIndex(${i})">
      <b>${s.part_no || s.part}</b> — ${s.model || s.model_name || s.item || ""}
    </div>
  `).join("");
}

function selectSkuByIndex(i) {
  const s = suggestionList[i];
  if (!s) return;
  selectSku(s);
}

function selectSku(s) {
  tempSku = s;

  const input = document.getElementById("orderSearch");
  if (input) {
    input.value = `${s.part_no || s.part} - ${s.model || s.model_name || s.item || ""}`;
  }

  document.querySelectorAll(".suggest").forEach(x => x.innerHTML = "");

  const qty = document.getElementById("orderQty");
  if (qty) qty.focus();
}

async function orderSearchKey(e) {
  if (e.key !== "Enter") return;

  e.preventDefault();

  const q = val("orderSearch").toLowerCase().trim();

  tempSku = state.skus.find(s =>
    String(s.part_no || s.part || "").toLowerCase().includes(q) ||
    String(s.model || s.model_name || s.item || "").toLowerCase().includes(q)
  );

  if (!tempSku) {
    try {
      const d = await api(API.sku + "?q=" + encodeURIComponent(q));
      tempSku = dedupeSkus(d.skus || d.items || [])[0];
    } catch {}
  }

  if (!tempSku) {
    alert("Part not found");
    return;
  }

  selectSku(tempSku);
}

function addOrderItem() {
  if (!tempSku) return alert("Select item first");

  const qty = Number(val("orderQty"));
  if (!qty || qty <= 0) return alert("Enter qty");

  state.orderItems.push({
    part_no: tempSku.part_no || tempSku.part,
    model: tempSku.model || tempSku.model_name || tempSku.item || "",
    make_name: tempSku.make_name || "",
    qty,
    weight_per_set: Number(tempSku.weight_per_set || tempSku.weight || 0)
  });

  tempSku = null;
  renderOrders();

  setTimeout(() => {
    const search = document.getElementById("orderSearch");
    if (search) search.focus();
  }, 50);
}

async function saveOrder() {
  try {
    const party = String(state.partyName || val("party")).trim();

    if (!party) return alert("Party name required");
    if (!state.orderItems.length) return alert("Add at least one item");

    await api(API.orders, {
      method: "POST",
      body: JSON.stringify({
        party_name: party,
        created_by: state.user.username,
        items: state.orderItems
      })
    });

    alert("Order saved");

    state.orderItems = [];
    state.partyName = "";
    await loadAll();
    renderOrders();

  } catch (e) {
    alert("Save order failed: " + e.message);
  }
}

async function viewOrder(id) {
  try {
    const data = await api(API.orders + "?id=" + id);
    const order = data.order || {};
    const items = data.items || order.items || [];

    document.getElementById("orderViewBox").innerHTML = `
      <div class="info">
        <h3>Order View</h3>
        <b>Party:</b> ${order.party_name || ""}<br>
        <b>Order No:</b> ${order.id || id}<br>
        <b>Status:</b> ${order.status || "PENDING"}

        <table>
          <tr>
            <th>Part</th>
            <th>Item</th>
            <th>Order Qty</th>
            <th>Packed Qty</th>
            <th>Balance</th>
          </tr>

          ${items.map(it => {
            const packed = Number(it.packed_qty || 0);
            const qty = Number(it.qty || 0);
            const balance = qty - packed;

            return `
              <tr>
                <td>${it.part_no || ""}</td>
                <td>${it.model || it.model_name || ""}</td>
                <td>${qty}</td>
                <td>${packed}</td>
                <td><b>${balance}</b></td>
              </tr>
            `;
          }).join("")}
        </table>
      </div>
    `;
  } catch (e) {
    alert("View order failed: " + e.message);
  }
}

async function deleteOrder(id) {
  if (!confirm("Delete this order?")) return;

  try {
    await api(API.orders + "?id=" + id, {
      method: "DELETE"
    });

    await loadAll();
    renderOrders();

  } catch (e) {
    alert("Delete failed: " + e.message);
  }
}

/* PACKING */

function renderPacking() {
  const orderOptions = state.orders.map(o => `
    <option value="${o.id}" ${state.selectedOrder && String(state.selectedOrder.id) === String(o.id) ? "selected" : ""}>
      #${o.id} — ${o.party_name}
    </option>
  `).join("");

  const o = state.selectedOrder;

  main(`
    <div class="card">
      <h2>Packing Entry</h2>

      <select onchange="selectOrder(this.value)">
        <option value="">Select Party / Order</option>
        ${orderOptions}
      </select>

      ${o ? `
        <div class="info">
          <b>Party:</b> ${o.party_name}<br>
          <b>Order No:</b> ${o.id}
        </div>

        <h3>Order Items / Balance</h3>

        <table>
          <tr>
            <th>Part</th>
            <th>Item</th>
            <th>Order Qty</th>
            <th>Packed</th>
            <th>Balance</th>
          </tr>

          ${(o.items || []).map(it => {
            const packed = Number(it.packed_qty || 0);
            const currentCarton = state.cartonItems
              .filter(x => x.part_no === it.part_no)
              .reduce((a,b)=>a+Number(b.qty || 0),0);

            const bal = Number(it.qty || 0) - packed - currentCarton;

            return `
              <tr>
                <td>${it.part_no}</td>
                <td>${it.model || it.model_name || ""}</td>
                <td>${it.qty}</td>
                <td>${packed}</td>
                <td><b>${bal}</b></td>
              </tr>
            `;
          }).join("")}
        </table>

      ` : ""}

      <div class="row3">

        <input id="outerWeight"
          placeholder="Outer Carton Weight kg"
          inputmode="decimal"
          value="${escapeAttr(state.outerWeight)}"
          oninput="state.outerWeight=this.value; updateExpectedBox()">

        <input id="cartonNo"
          placeholder="Carton No"
          value="${escapeAttr(state.cartonNo)}"
          oninput="state.cartonNo=this.value">

        <input id="totalCartons"
          placeholder="Total Cartons"
          value="${escapeAttr(state.totalCartons)}"
          oninput="state.totalCartons=this.value">

      </div>

      ${o ? `
        <div class="row">

          <select id="packItem"
            onkeydown="
              if(event.key==='Enter'){
                event.preventDefault();
                document.getElementById('packQty').focus();
              }
            ">

            <option value="">Select order item</option>

            ${(o.items || []).map(it => {

              const packed = Number(it.packed_qty || 0);

              const currentCarton = state.cartonItems
                .filter(x => x.part_no === it.part_no)
                .reduce((a,b)=>a+Number(b.qty || 0),0);

              const bal = Number(it.qty || 0) - packed - currentCarton;

              return `
                <option value="${it.part_no}">
                  ${it.part_no} — ${it.model || it.model_name || ""} — Balance ${bal}
                </option>
              `;
            }).join("")}

          </select>

          <input id="packQty"
            placeholder="Qty then Enter"
            type="number"
            onkeydown="
              if(event.key==='Enter'){
                addCartonItem();
                setTimeout(()=>{
                  document.getElementById('cartonNo')?.focus();
                },100);
              }
            ">
        </div>
      ` : ""}

      ${itemsTable(state.cartonItems, true)}

      <div class="info" id="expectedBox">
        ${expectedBoxHTML()}
      </div>

      <button class="green" onclick="saveCarton()">
        Save Carton / Send to QC
      </button>
    </div>
  `);
}

async function selectOrder(id) {
  if (!id) return;

  try {
    const data = await api(API.orders + "?id=" + id);
    state.selectedOrder = data.order || state.orders.find(o => String(o.id) === String(id));
    state.selectedOrder.items = data.items || state.selectedOrder.items || [];
    state.cartonItems = [];
    renderPacking();

  } catch (e) {
    alert("Order load failed: " + e.message);
  }
}

function packingItemSelector(o) {
  const items = o.items || o.order_items || [];

  return `
    <h3>Order Items / Balance</h3>

    <table>
      <tr>
        <th>Part</th>
        <th>Item</th>
        <th>Order Qty</th>
        <th>Packed</th>
        <th>Balance</th>
      </tr>

      ${items.map(it => {
        const packed = Number(it.packed_qty || 0);
        const bal = Number(it.qty || 0) - packed;

        return `
          <tr>
            <td>${it.part_no}</td>
            <td>${it.model || it.model_name || ""}</td>
            <td>${it.qty}</td>
            <td>${packed}</td>
            <td><b>${bal}</b></td>
          </tr>
        `;
      }).join("")}
    </table>

    <div class="row">
      <select id="packItem">
        <option value="">Select order item</option>
        ${items.map(it => {
          const packed = Number(it.packed_qty || 0);
          const bal = Number(it.qty || 0) - packed;

          return `
            <option value="${it.part_no}">
              ${it.part_no} — ${it.model || it.model_name || ""} — Balance ${bal}
            </option>
          `;
        }).join("")}
      </select>

      <input id="packQty"
        placeholder="Qty then Enter"
        type="number"
        onkeydown="if(event.key==='Enter') addCartonItem()">
    </div>
  `;
}

function addCartonItem() {
  const part = val("packItem");
  const qty = Number(val("packQty"));

  if (!state.selectedOrder || !part || !qty) return alert("Select item and qty");

  const item = (state.selectedOrder.items || state.selectedOrder.order_items || []).find(x => x.part_no === part);

  const balance = Number(item.qty || 0) - Number(item.packed_qty || 0);
  const already = state.cartonItems
    .filter(x => x.part_no === part)
    .reduce((a, b) => a + Number(b.qty), 0);

  if (qty + already > balance) {
    return alert(`Qty exceeds balance. Balance: ${balance - already}`);
  }

  state.cartonItems.push({
    part_no: item.part_no,
    model: item.model || item.model_name || "",
    make_name: item.make_name || "",
    qty,
    weight_per_set: Number(item.weight_per_set || 0)
  });

  renderPacking();
}

function cartonItemWeight() {
  return state.cartonItems.reduce((sum, it) => {
    return sum + (Number(it.qty) * Number(it.weight_per_set || 0));
  }, 0);
}

function expectedWeight() {
  return cartonItemWeight() + Number(state.outerWeight || 0);
}

function expectedBoxHTML() {
  return `
    Item Weight: <b>${cartonItemWeight().toFixed(2)} kg</b><br>
    Outer Carton Weight: <b>${Number(state.outerWeight || 0).toFixed(2)} kg</b><br>
    Expected Gross Weight: <b>${expectedWeight().toFixed(2)} kg</b>
  `;
}

function updateExpectedBox() {
  const box = document.getElementById("expectedBox");
  if (box) box.innerHTML = expectedBoxHTML();
}

async function saveCarton() {
  try {
    if (!state.selectedOrder) return alert("Select order");
    if (!state.cartonItems.length) return alert("Add carton items");
    if (!state.cartonNo) return alert("Carton no required");

    await api(API.cartons, {
      method: "POST",
      body: JSON.stringify({
        order_id: state.selectedOrder.id,
        carton_no: state.cartonNo,
        total_cartons: state.totalCartons,
        outer_weight: Number(state.outerWeight || 0),
        expected_weight: expectedWeight(),
        packed_by: state.user.username,
        items: state.cartonItems
      })
    });

    alert("Carton sent to QC");

    state.cartonItems = [];
    state.selectedOrder = null;
    state.outerWeight = "";
    state.cartonNo = "";
    state.totalCartons = "";

    await loadAll();
    renderPacking();

  } catch (e) {
    alert("Carton save failed: " + e.message);
  }
}

/* QC */

function renderQC() {
  const parties = [...new Set(state.cartons.map(c => c.party_name).filter(Boolean))];

  main(`
    <div class="card">
      <h2>QC / Recheck</h2>

      <select id="qcParty" onchange="renderQCCartons(this.value)">
        <option value="">Select Party</option>
        ${parties.map(p => `<option value="${escapeAttr(p)}">${p}</option>`).join("")}
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
      <option value="">Select Carton</option>
      ${list.map(c => `
        <option value="${c.id}">
          ${c.party_name} — Carton ${c.carton_no}/${c.total_cartons || ""} — ${c.status || c.qc_status}
        </option>
      `).join("")}
    </select>
  `;
}

async function selectCarton(id) {
  if (!id) return;

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

    <input id="actualWeight"
      placeholder="Actual Weight kg"
      type="number"
      step="0.01"
      value="${c.actual_weight || ""}">

    <button class="green" onclick="saveQC()">Auto PASS / RECHECK</button>

    <label>
      <input type="checkbox"
        ${state.logoOn ? "checked" : ""}
        onchange="state.logoOn=this.checked; renderQCDetails()">
      Show Ceradrive Logo on Sticker
    </label>

    ${pass
      ? `<button onclick="printSticker()">Print Sticker</button>${stickerHTML(c)}`
      : `<p class="bad">Sticker only for QC PASS cartons</p>`
    }
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
  const totalQty = (c.items || []).reduce((a, b) => a + Number(b.qty), 0);

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

/* SKU */

function renderSKU() {
  main(`
    <div class="card">
      <h2>SKU Master</h2>
      <p>Admin edit/add pending.</p>
    </div>
  `);
}

/* HELPERS */

function itemsTable(items, del) {
  return `
    <table>
      <tr>
        <th>Part</th>
        <th>Item</th>
        <th>Qty</th>
        ${del ? "<th>Delete</th>" : ""}
      </tr>

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

function main(html) {
  document.getElementById("main").innerHTML = html;
}

function escapeAttr(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    .line{background:#f8f9fb;border:1px solid #ddd;border-radius:10px;padding:12px;margin:10px 0}
    .sticker{width:360px;border:2px solid #111;padding:18px;margin-top:15px;background:white;color:#111}
    .sticker h2{text-align:center;color:#8b1d1d;letter-spacing:2px}
    @media print{body *{visibility:hidden}#sticker,#sticker *{visibility:visible}#sticker{position:absolute;left:0;top:0}}
  `;

  document.head.appendChild(style);
}

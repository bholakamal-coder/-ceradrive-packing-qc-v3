const API = {
  login: "/api/login",
  sku: "/api/sku"
};

let state = {
  user: JSON.parse(localStorage.getItem("user") || "null"),
  tab: "dashboard",

  orders: JSON.parse(localStorage.getItem("orders") || "[]"),
  cartons: JSON.parse(localStorage.getItem("cartons") || "[]"),
skus: [],
  orderDraftItems: [],
  cartonDraftItems: [],

  selectedOrderId: "",
  selectedCartonId: "",

  packingCartonNo: "1",
  packingOuterWeight: "0.30"
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  injectStyle();

  if (!state.user) {
    renderLogin();
    return;
  }
loadSkus();
  renderApp();
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "API Error");
  }

  return data;
}
async function loadSkus() {

  try {

    const res = await api(API.sku + "?q=");

    state.skus =
      res.skus ||
      res.items ||
      [];

    console.log(
      "SKUS LOADED",
      state.skus
    );

  } catch (e) {

    console.log(
      "SKU LOAD FAILED",
      e
    );
  }
}
/* LOGIN */

function renderLogin() {
  document.body.innerHTML = `
    <div class="wrap">
      <div class="card">
        <h1>Ceradrive Packing QC V3</h1>

        <input id="u" placeholder="Username" value="admin">
        <input id="p" type="password" placeholder="Password" value="Admin123">

        <button onclick="login()">Login</button>
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

/* APP */

function renderApp() {
  document.body.innerHTML = `
    <div class="wrap">
      <div class="card top">
        <div>
          <h2>Ceradrive Packing QC V3</h2>
          <p>Welcome ${state.user.username}</p>
        </div>

        <button onclick="logout()">Logout</button>
      </div>

      <div class="tabs">
        <button onclick="setTab('dashboard')">Dashboard</button>
        <button onclick="setTab('orders')">Orders</button>
        <button onclick="setTab('packing')">Packing</button>
        <button onclick="setTab('qc')">QC</button>
      </div>

      <div id="main"></div>
    </div>
  `;

  renderTab();
}

function setTab(tab) {
  state.tab = tab;
  renderTab();
}

function renderTab() {
  if (state.tab === "orders") return renderOrders();
  if (state.tab === "packing") return renderPacking();
  if (state.tab === "qc") return renderQC();
  renderDashboard();
}

/* DASHBOARD */

function renderDashboard() {
  const pending = state.cartons.filter(c => c.status === "PENDING_QC").length;
  const pass = state.cartons.filter(c => c.status === "PASS").length;
  const recheck = state.cartons.filter(c => c.status === "RECHECK").length;

  main(`
    <div class="card">
      <h2>Dashboard</h2>

      <div class="grid4">
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
      <h2>Orders</h2>

      <input id="party" placeholder="Party Name">

      <div class="row4">
        <div class="searchBox">
  <input
    id="part"
    placeholder="Search Part / Model"
    autocomplete="off"
    oninput="showSkuSuggest()"
  >
  <div id="skuSuggest" class="suggest"></div>
</div>
        <input id="item" placeholder="Vehicle / Item">
        <input id="qty" type="number" placeholder="Qty">
        <input id="weight" type="number" step="0.01" placeholder="Weight / Set kg">
      </div>

      <button onclick="addOrderItem()">Add Item</button>

      ${orderDraftTable()}

      <button class="green" onclick="saveOrder()">Save Order</button>

      <h3>Saved Orders</h3>

      ${savedOrdersHTML()}
    </div>
  `);
}
function showSkuSuggest() {

  const q =
    val("part")
    .toLowerCase()
    .trim();

  const box =
    document.getElementById(
      "skuSuggest"
    );

  if (!box) return;

  if (!q) {
    box.innerHTML = "";
    return;
  }

  const list =
    state.skus.filter(s =>

      String(
        s.part_no ||
        s.part ||
        ""
      )
      .toLowerCase()
      .includes(q)

      ||

      String(
        s.model ||
        s.item ||
        ""
      )
      .toLowerCase()
      .includes(q)

    ).slice(0, 10);

  box.innerHTML =
    list.map((s, i) => `

      <div onclick="selectSku(${i})">

        <b>
          ${s.part_no || s.part}
        </b>

        —
        ${s.model || s.item || ""}

      </div>

    `).join("");

  window.skuSuggestionList = list;
}

function selectSku(i) {

  const s =
    window.skuSuggestionList[i];

  if (!s) return;

  document.getElementById(
    "part"
  ).value =
    s.part_no ||
    s.part ||
    "";

  document.getElementById(
    "item"
  ).value =
    s.model ||
    s.item ||
    "";

  document.getElementById(
    "weight"
  ).value =
    s.weight ||
    s.weight_per_set ||
    "";

  document.getElementById(
    "skuSuggest"
  ).innerHTML = "";

  document.getElementById(
    "qty"
  ).focus();
}
function addOrderItem() {
  const item = {
    part_no: val("part"),
    model: val("item"),
    qty: Number(val("qty")),
    weight_per_set: Number(val("weight") || 0)
  };

  if (!item.part_no || !item.model || !item.qty) {
    alert("Part, item and qty required");
    return;
  }

  state.orderDraftItems.push(item);

  document.getElementById("part").value = "";
  document.getElementById("item").value = "";
  document.getElementById("qty").value = "";
  document.getElementById("weight").value = "";

  renderOrders();
}

function orderDraftTable() {
  if (!state.orderDraftItems.length) {
    return `<p>No items added.</p>`;
  }

  return `
    <table>
      <tr>
        <th>Part</th>
        <th>Item</th>
        <th>Qty</th>
        <th>Weight / Set</th>
        <th>Delete</th>
      </tr>

      ${state.orderDraftItems.map((it, i) => `
        <tr>
          <td>${it.part_no}</td>
          <td>${it.model}</td>
          <td>${it.qty}</td>
          <td>${it.weight_per_set}</td>
          <td><button class="danger" onclick="deleteOrderDraftItem(${i})">Delete</button></td>
        </tr>
      `).join("")}
    </table>
  `;
}

function deleteOrderDraftItem(i) {
  state.orderDraftItems.splice(i, 1);
  renderOrders();
}

function saveOrder() {
  const party = val("party");

  if (!party) {
    alert("Party required");
    return;
  }

  if (!state.orderDraftItems.length) {
    alert("Add at least one item");
    return;
  }

  const order = {
    id: Date.now(),
    party,
    items: state.orderDraftItems,
    created_at: new Date().toLocaleString()
  };

  state.orders.push(order);
  state.orderDraftItems = [];

  localStorage.setItem("orders", JSON.stringify(state.orders));

  alert("Order saved");
  renderOrders();
}

function savedOrdersHTML() {
  if (!state.orders.length) {
    return `<p>No saved orders.</p>`;
  }

  return state.orders.map(o => `
    <div class="line">
      <b>${o.party}</b><br>
      Order No: ${o.id}<br>
      Items: ${o.items.length}<br>
      Date: ${o.created_at}<br><br>
      <button class="danger" onclick="deleteOrder(${o.id})">Delete Order</button>
    </div>
  `).join("");
}

function deleteOrder(id) {
  if (!confirm("Delete this order?")) return;

  state.orders = state.orders.filter(o => o.id !== id);
  state.cartons = state.cartons.filter(c => c.order_id !== id);

  localStorage.setItem("orders", JSON.stringify(state.orders));
  localStorage.setItem("cartons", JSON.stringify(state.cartons));

  renderOrders();
}

/* PACKING */

function renderPacking() {
  main(`
    <div class="card">
      <h2>Packing</h2>

      ${packingOrderSelect()}

      ${state.selectedOrderId ? packingFormHTML() : ""}
    </div>
  `);
}

function packingOrderSelect() {
  if (!state.orders.length) {
    return `<p>No orders available.</p>`;
  }

  return `
    <select onchange="selectPackingOrder(this.value)">
      <option value="">Select Order</option>

      ${state.orders.map(o => `
        <option value="${o.id}" ${String(state.selectedOrderId) === String(o.id) ? "selected" : ""}>
          ${o.party} — ${o.id}
        </option>
      `).join("")}
    </select>
  `;
}

function selectPackingOrder(id) {
  state.selectedOrderId = id;
  state.cartonDraftItems = [];

  const existing = state.cartons.filter(c => String(c.order_id) === String(id));
  state.packingCartonNo = String(existing.length + 1);
  state.packingOuterWeight = "0.30";

  renderPacking();
}

function getSelectedOrder() {
  return state.orders.find(o => String(o.id) === String(state.selectedOrderId));
}

function packingFormHTML() {
  const order = getSelectedOrder();

  if (!order) return "";

  return `
    <div class="info">
      <b>Party:</b> ${order.party}<br>
      <b>Order No:</b> ${order.id}
    </div>

    ${balanceTable(order)}

    <div class="row3">
      <input id="cartonNo" placeholder="Carton No" value="${state.packingCartonNo}" oninput="state.packingCartonNo=this.value; updateExpectedBox()">
      <input id="outerWeight" placeholder="Outer Weight" value="${state.packingOuterWeight}" oninput="state.packingOuterWeight=this.value; updateExpectedBox()">
      <input readonly placeholder="Total Cartons" value="${getCurrentTotalCartons()}">
    </div>

    <div class="row">
      <select id="packItem">
        <option value="">Select Order Item</option>

        ${order.items.map((it, i) => `
          <option value="${i}">
            ${it.part_no} — ${it.model} — Balance ${getBalance(order.id, i)}
          </option>
        `).join("")}
      </select>

      <input id="packQty" type="number" placeholder="Qty then Enter" onkeydown="if(event.key==='Enter') addCartonItem()">
    </div>

    <button onclick="addCartonItem()">Add to Carton</button>

    ${cartonDraftTable()}

    <div class="info" id="expectedBox">
      ${expectedBoxHTML()}
    </div>

    <button class="green" onclick="saveCartons()">Save Cartons / Send to QC</button>

    ${packedCartonsHTML(order.id)}
  `;
}

function balanceTable(order) {
  return `
    <h3>Order Items / Balance</h3>

    <table>
      <tr>
        <th>Part</th>
        <th>Item</th>
        <th>Order Qty</th>
        <th>Packed</th>
        <th>This Entry</th>
        <th>Balance</th>
      </tr>

      ${order.items.map((it, i) => `
        <tr>
          <td>${it.part_no}</td>
          <td>${it.model}</td>
          <td>${it.qty}</td>
          <td>${getPackedQty(order.id, i)}</td>
          <td>${getDraftQty(i)}</td>
          <td><b>${getBalance(order.id, i)}</b></td>
        </tr>
      `).join("")}
    </table>
  `;
}

function getPackedQty(orderId, itemIndex) {
  return state.cartons
    .filter(c => String(c.order_id) === String(orderId))
    .flatMap(c => c.items || [])
    .filter(it => Number(it.order_item_index) === Number(itemIndex))
    .reduce((sum, it) => sum + Number(it.qty || 0), 0);
}

function getDraftQty(itemIndex) {
  return state.cartonDraftItems
    .filter(it => Number(it.order_item_index) === Number(itemIndex))
    .reduce((sum, it) => sum + Number(it.qty || 0), 0);
}

function getBalance(orderId, itemIndex) {
  const order = state.orders.find(o => String(o.id) === String(orderId));
  if (!order) return 0;

  const item = order.items[itemIndex];
  return Number(item.qty || 0) - getPackedQty(orderId, itemIndex) - getDraftQty(itemIndex);
}

function addCartonItem() {
  const order = getSelectedOrder();
  const itemIndex = Number(val("packItem"));
  const qty = Number(val("packQty"));

  if (!order || val("packItem") === "" || !qty) {
    alert("Select item and qty");
    return;
  }

  const balance = getBalance(order.id, itemIndex);

  if (qty > balance) {
    alert("Qty exceeds balance. Balance: " + balance);
    return;
  }

  const item = order.items[itemIndex];

  state.cartonDraftItems.push({
    carton_no: state.packingCartonNo,
    order_item_index: itemIndex,
    part_no: item.part_no,
    model: item.model,
    qty,
    weight_per_set: Number(item.weight_per_set || 0)
  });

  renderPacking();
}

function getCurrentTotalCartons() {
  const nums = state.cartonDraftItems
    .map(it => Number(it.carton_no || 0))
    .filter(n => n > 0);

  if (!nums.length) return "";

  return Math.max(...nums);
}

function cartonDraftTable() {
  if (!state.cartonDraftItems.length) {
    return `<p>No carton items added.</p>`;
  }

  return `
    <table>
      <tr>
        <th>Carton</th>
        <th>Total</th>
        <th>Part</th>
        <th>Item</th>
        <th>Qty</th>
        <th>Delete</th>
      </tr>

      ${state.cartonDraftItems.map((it, i) => `
        <tr>
          <td>${it.carton_no}</td>
          <td>${getCurrentTotalCartons()}</td>
          <td>${it.part_no}</td>
          <td>${it.model}</td>
          <td>${it.qty}</td>
          <td><button class="danger" onclick="deleteCartonDraftItem(${i})">Delete</button></td>
        </tr>
      `).join("")}
    </table>
  `;
}

function deleteCartonDraftItem(i) {
  state.cartonDraftItems.splice(i, 1);
  renderPacking();
}

function expectedBoxHTML() {
  const map = {};

  state.cartonDraftItems.forEach(it => {
    const no = String(it.carton_no);

    if (!map[no]) {
      map[no] = { qty: 0, itemWeight: 0 };
    }

    map[no].qty += Number(it.qty || 0);
    map[no].itemWeight += Number(it.qty || 0) * Number(it.weight_per_set || 0);
  });

  const cartons = Object.keys(map);

  if (!cartons.length) return "No weight yet.";

  const outer = Number(state.packingOuterWeight || 0);

  return `
    <h3>Carton Wise Weight</h3>

    <table>
      <tr>
        <th>Carton</th>
        <th>Total Qty</th>
        <th>Item Weight</th>
        <th>Outer</th>
        <th>Gross</th>
      </tr>

      ${cartons.map(no => `
        <tr>
          <td>${no}/${getCurrentTotalCartons()}</td>
          <td>${map[no].qty}</td>
          <td>${map[no].itemWeight.toFixed(2)} kg</td>
          <td>${outer.toFixed(2)} kg</td>
          <td><b>${(map[no].itemWeight + outer).toFixed(2)} kg</b></td>
        </tr>
      `).join("")}
    </table>
  `;
}

function updateExpectedBox() {
  const box = document.getElementById("expectedBox");
  if (box) box.innerHTML = expectedBoxHTML();
}

function saveCartons() {
  const order = getSelectedOrder();

  if (!order) {
    alert("Select order");
    return;
  }

  if (!state.cartonDraftItems.length) {
    alert("Add carton items");
    return;
  }

  const cartonNos = [...new Set(state.cartonDraftItems.map(it => String(it.carton_no)))];
  const totalCartons = String(Math.max(...cartonNos.map(n => Number(n || 0))));
  const outer = Number(state.packingOuterWeight || 0);

  cartonNos.forEach(no => {
    const items = state.cartonDraftItems.filter(it => String(it.carton_no) === String(no));

    const itemWeight = items.reduce((sum, it) => {
      return sum + Number(it.qty || 0) * Number(it.weight_per_set || 0);
    }, 0);

    state.cartons.push({
      id: Date.now() + Math.random(),
      order_id: order.id,
      party: order.party,
      carton_no: no,
      total_cartons: totalCartons,
      outer_weight: outer,
      expected_weight: itemWeight + outer,
      actual_weight: 0,
      status: "PENDING_QC",
      items,
      created_at: new Date().toLocaleString()
    });
  });

  localStorage.setItem("cartons", JSON.stringify(state.cartons));

  alert("Cartons sent to QC");

  state.cartonDraftItems = [];
  state.selectedOrderId = "";
  state.packingCartonNo = "1";
  state.packingOuterWeight = "0.30";

  renderPacking();
}

function packedCartonsHTML(orderId) {
  const list = state.cartons.filter(c => String(c.order_id) === String(orderId));

  if (!list.length) return "";

  return `
    <h3>Packed Cartons</h3>

    <table>
      <tr>
        <th>Carton</th>
        <th>Expected</th>
        <th>Actual</th>
        <th>Status</th>
      </tr>

      ${list.map(c => `
        <tr>
          <td>${c.carton_no}/${c.total_cartons}</td>
          <td>${Number(c.expected_weight || 0).toFixed(2)} kg</td>
          <td>${Number(c.actual_weight || 0).toFixed(2)} kg</td>
          <td>${c.status}</td>
        </tr>
      `).join("")}
    </table>
  `;
}

/* QC */

function renderQC() {
  const parties = [...new Set(state.cartons.map(c => c.party).filter(Boolean))];

  main(`
    <div class="card">
      <h2>QC</h2>

      ${!parties.length ? `<p>No cartons for QC.</p>` : `
        <select onchange="renderQCCartons(this.value)">
          <option value="">Select Party</option>

          ${parties.map(p => `
            <option value="${p}">${p}</option>
          `).join("")}
        </select>
      `}

      <div id="qcCartons"></div>
      <div id="qcDetails"></div>
    </div>
  `);
}

function renderQCCartons(party) {
  const list = state.cartons.filter(c => c.party === party);

  document.getElementById("qcCartons").innerHTML = `
    <h3>${party}</h3>

    <table>
      <tr>
        <th>Carton</th>
        <th>Expected</th>
        <th>Actual</th>
        <th>Status</th>
        <th>Open</th>
      </tr>

      ${list.map(c => `
        <tr>
          <td>${c.carton_no}/${c.total_cartons}</td>
          <td>${Number(c.expected_weight || 0).toFixed(2)} kg</td>
          <td>${Number(c.actual_weight || 0).toFixed(2)} kg</td>
          <td>${c.status}</td>
          <td><button onclick="openCartonQC('${c.id}')">Open</button></td>
        </tr>
      `).join("")}
    </table>
  `;
}

function openCartonQC(id) {
  state.selectedCartonId = id;
  renderQCDetails();
}

function getSelectedCarton() {
  return state.cartons.find(c => String(c.id) === String(state.selectedCartonId));
}

function renderQCDetails() {
  const c = getSelectedCarton();

  if (!c) return;

  document.getElementById("qcDetails").innerHTML = `
    <div class="info">
      <b>Party:</b> ${c.party}<br>
      <b>Carton:</b> ${c.carton_no}/${c.total_cartons}<br>
      <b>Expected:</b> ${Number(c.expected_weight || 0).toFixed(2)} kg<br>
      <b>Actual:</b> ${Number(c.actual_weight || 0).toFixed(2)} kg<br>
      <b>Status:</b> ${c.status}
    </div>

    <table>
      <tr>
        <th>Part</th>
        <th>Item</th>
        <th>Qty</th>
      </tr>

      ${(c.items || []).map(it => `
        <tr>
          <td>${it.part_no}</td>
          <td>${it.model}</td>
          <td>${it.qty}</td>
        </tr>
      `).join("")}
    </table>

    <input id="actualWeight" type="number" step="0.01" placeholder="Actual Weight" value="${c.actual_weight || ""}">

    <button class="green" onclick="saveQC()">PASS / RECHECK</button>

    ${c.status === "PASS" ? stickerHTML(c) : `<p class="bad">Sticker only after PASS</p>`}
  `;
}

function saveQC() {
  const c = getSelectedCarton();

  if (!c) return;

  const actual = Number(val("actualWeight"));

  if (!actual) {
    alert("Enter actual weight");
    return;
  }

  const diff = Math.abs(actual - Number(c.expected_weight || 0));

  c.actual_weight = actual;
  c.status = diff <= 0.30 ? "PASS" : "RECHECK";

  localStorage.setItem("cartons", JSON.stringify(state.cartons));

  alert("QC Updated: " + c.status);

  renderQCDetails();
}

function stickerHTML(c) {
  return `
    <button onclick="window.print()">Print Sticker</button>

    <div id="sticker" class="sticker">
      <h2>CERADRIVE</h2>
      <h3>${c.party}</h3>

      <b>Carton:</b> ${c.carton_no}/${c.total_cartons}<br>
      <b>Expected:</b> ${Number(c.expected_weight || 0).toFixed(2)} kg<br>
      <b>Actual:</b> ${Number(c.actual_weight || 0).toFixed(2)} kg<br>
      <b>Status:</b> ${c.status}<br>

      <hr>

      ${(c.items || []).map(i => `
        ${i.part_no} ${i.model} — ${i.qty}
      `).join("<br>")}
    </div>
  `;
}

/* HELPERS */

function main(html) {
  document.getElementById("main").innerHTML = html;
}

function val(id) {
  return document.getElementById(id)?.value || "";
}

function injectStyle() {
  const style = document.createElement("style");

  style.innerHTML = `
    body{
      font-family:Arial,sans-serif;
      background:#f4f6f8;
      margin:0;
      color:#111;
    }

    .wrap{
      max-width:1100px;
      margin:auto;
      padding:30px 20px;
    }

    .card{
      background:white;
      padding:22px;
      border-radius:14px;
      box-shadow:0 2px 10px #0001;
      margin-bottom:18px;
    }

    .top{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:20px;
    }

    input,select,button{
      width:100%;
      padding:13px;
      margin:8px 0;
      border-radius:10px;
      border:1px solid #ccc;
      font-size:16px;
      box-sizing:border-box;
    }

    button{
      background:#304ffe;
      color:white;
      border:none;
      font-weight:bold;
      cursor:pointer;
    }

    .green{
      background:#2e7d32;
    }

    .danger{
      background:#a33;
    }

    .tabs{
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:10px;
      margin-bottom:18px;
    }

    .tabs button{
      background:white;
      color:#111;
      border:1px solid #ddd;
    }

    .row{
      display:grid;
      grid-template-columns:2fr 1fr;
      gap:10px;
    }

    .row3{
      display:grid;
      grid-template-columns:1fr 1fr 1fr;
      gap:10px;
    }

    .row4{
      display:grid;
      grid-template-columns:1fr 1fr 1fr 1fr;
      gap:10px;
    }

    table{
      width:100%;
      border-collapse:collapse;
      margin:12px 0;
    }

    th,td{
      border:1px solid #ddd;
      padding:10px;
      text-align:left;
    }

    th{
      background:#eee;
    }

    .info{
      background:#f1f5ff;
      padding:12px;
      border-radius:10px;
      margin:10px 0;
    }

    .line{
      background:#fafafa;
      border:1px solid #ddd;
      border-radius:10px;
      padding:12px;
      margin:10px 0;
    }

    .stat{
      background:#f1f5ff;
      padding:20px;
      border-radius:12px;
      text-align:center;
    }

    .grid4{
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:10px;
    }

    .bad{
      color:#a33;
      font-weight:bold;
    }

    .sticker{
      width:360px;
      border:2px solid #111;
      padding:18px;
      margin-top:15px;
      background:white;
      color:#111;
    }

    .sticker h2{
      text-align:center;
      letter-spacing:2px;
    }

    @media print{
      body *{visibility:hidden}
      #sticker,#sticker *{visibility:visible}
      #sticker{position:absolute;left:0;top:0}
    }
.searchBox{
position:relative;
}

.suggest{
position:absolute;
top:100%;
left:0;
right:0;
background:white;
border:1px solid #ddd;
border-radius:12px;
max-height:220px;
overflow:auto;
z-index:999;
margin-top:4px;
}

.suggestItem{
padding:10px;
cursor:pointer;
border-bottom:1px solid #f1f1f1;
color:#111;
}

.suggestItem:hover{
background:#f5f7ff;
}
    @media(max-width:800px){
      .row,.row3,.row4,.tabs,.grid4{
        grid-template-columns:1fr;
      }

      .top{
        display:block;
      }
    }
  `;

  document.head.appendChild(style);
}

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
  cartonNo: ""
};

let tempSku = null;
let suggestionList = [];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  injectStyle();

  if (!state.user) {
    renderLogin();
    return;
  }

  await loadAll();
  renderApp();
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...opts
  });

  const text = await res.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }

  if (!res.ok) {
    throw new Error(data.error || "API Error");
  }

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
    const model = String(
      s.model || s.model_name || s.item || ""
    ).trim();

    const key = `${part}|${model}`.toLowerCase();

    if (!part || seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/* LOGIN */

function renderLogin() {
  document.body.innerHTML = `
    <div class="wrap">
      <div class="card">

        <h1>Ceradrive Dispatch QC</h1>

        <input id="u" placeholder="Username" value="admin">

        <input
          id="p"
          type="password"
          placeholder="Password"
          value="Admin123"
        >

        <button onclick="login()">
          Login
        </button>

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

    localStorage.setItem(
      "user",
      JSON.stringify(data.user)
    );

    await loadAll();

    renderApp();

  } catch (e) {
    alert("Login failed");
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
          <h2>
            Welcome ${state.user.username}
          </h2>

          <p>
            ${state.user.role}
          </p>
        </div>

        <button
          class="danger"
          onclick="logout()"
        >
          Logout
        </button>
      </div>

      <div class="tabs">
        ${tabBtn("dashboard","Dashboard")}
        ${tabBtn("orders","Orders")}
        ${tabBtn("packing","Packing")}
        ${tabBtn("qc","QC")}
      </div>

      <div id="main"></div>

    </div>
  `;

  renderTab();
}

function tabBtn(id, label) {
  return `
    <button
      class="${state.tab === id ? "active" : ""}"
      onclick="setTab('${id}')"
    >
      ${label}
    </button>
  `;
}

function setTab(tab) {
  state.tab = tab;
  renderApp();
}

function renderTab() {

  if (state.tab === "orders") {
    renderOrders();
    return;
  }

  if (state.tab === "packing") {
    renderPacking();
    return;
  }

  if (state.tab === "qc") {
    renderQC();
    return;
  }

  renderDashboard();
}

function renderDashboard() {

  const pending = state.cartons.filter(c =>
    (c.status || c.qc_status) === "PENDING_QC"
  ).length;

  const pass = state.cartons.filter(c =>
    (c.status || c.qc_status) === "PASS"
  ).length;

  const recheck = state.cartons.filter(c =>
    (c.status || c.qc_status) === "RECHECK"
  ).length;

  main(`
    <div class="card">

      <h2>Dashboard</h2>

      <div class="grid3">

        <div class="stat">
          Orders
          <br>
          <b>${state.orders.length}</b>
        </div>

        <div class="stat">
          Pending QC
          <br>
          <b>${pending}</b>
        </div>

        <div class="stat">
          PASS
          <br>
          <b>${pass}</b>
        </div>

        <div class="stat">
          RECHECK
          <br>
          <b>${recheck}</b>
        </div>

      </div>

    </div>
  `);
}
/* ORDERS */

function renderOrders() {

  main(`
    <div class="card">

      <h2>Order Entry</h2>

      <input
        id="party"
        placeholder="Party Name"
        value="${escapeAttr(state.partyName)}"
        oninput="state.partyName=this.value"
      >

      <div class="row">

        <div class="searchBox">

          <input
            id="orderSearch"
            placeholder="Search Part / Model"
            autocomplete="off"
            oninput="showSkuSuggest('orderSearch','orderSuggest')"
            onkeydown="orderSearchKey(event)"
          >

          <div
            id="orderSuggest"
            class="suggest"
          ></div>

        </div>

        <input
          id="orderQty"
          type="number"
          placeholder="Qty"
          onkeydown="if(event.key==='Enter') addOrderItem()"
        >

      </div>

      ${itemsTable(state.orderItems, true)}

      <button
        class="green"
        onclick="saveOrder()"
      >
        Save Order
      </button>

      <h3>Saved Orders</h3>

      ${state.orders.map(o => `
        <div class="line">

          <b>
            #${o.id} — ${o.party_name}
          </b>

          <br>

          ${o.status || "PENDING"}

          <div class="row">

            <button onclick="viewOrder(${o.id})">
              View
            </button>

            <button
              class="danger"
              onclick="deleteOrder(${o.id})"
            >
              Delete
            </button>

          </div>

        </div>
      `).join("")}

      <div id="orderViewBox"></div>

    </div>
  `);
}

async function showSkuSuggest(inputId, boxId) {

  const q = val(inputId)
    .toLowerCase()
    .trim();

  const box = document.getElementById(boxId);

  if (!q) {
    suggestionList = [];
    box.innerHTML = "";
    return;
  }

  let list = state.skus.filter(s =>

    String(s.part_no || s.part || "")
      .toLowerCase()
      .includes(q)

    ||

    String(s.model || s.model_name || s.item || "")
      .toLowerCase()
      .includes(q)
  );

  suggestionList = list.slice(0, 10);

  box.innerHTML = suggestionList.map((s, i) => `
    <div onclick="selectSkuByIndex(${i})">

      <b>
        ${s.part_no || s.part}
      </b>

      —

      ${s.model || s.model_name || s.item || ""}

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

  document.getElementById("orderSearch").value =
    `${s.part_no || s.part} - ${s.model || s.model_name || s.item || ""}`;

  document.querySelectorAll(".suggest")
    .forEach(x => x.innerHTML = "");

  document.getElementById("orderQty").focus();
}

async function orderSearchKey(e) {

  if (e.key !== "Enter") return;

  e.preventDefault();

  const q = val("orderSearch")
    .toLowerCase()
    .trim();

  tempSku = state.skus.find(s =>

    String(s.part_no || s.part || "")
      .toLowerCase()
      .includes(q)

    ||

    String(s.model || s.model_name || s.item || "")
      .toLowerCase()
      .includes(q)
  );

  if (!tempSku) {
    alert("Part not found");
    return;
  }

  selectSku(tempSku);
}

function addOrderItem() {

  if (!tempSku) {
    alert("Select item first");
    return;
  }

  const qty = Number(val("orderQty"));

  if (!qty || qty <= 0) {
    alert("Enter qty");
    return;
  }

  state.orderItems.push({

    part_no:
      tempSku.part_no || tempSku.part,

    model:
      tempSku.model ||
      tempSku.model_name ||
      tempSku.item ||
      "",

    qty,

    weight_per_set: Number(
      tempSku.weight_per_set ||
      tempSku.weight ||
      0
    )
  });

  tempSku = null;

  renderOrders();
}

async function saveOrder() {

  try {

    if (!state.partyName.trim()) {
      alert("Party required");
      return;
    }

    if (!state.orderItems.length) {
      alert("Add items");
      return;
    }

    await api(API.orders, {

      method: "POST",

      body: JSON.stringify({

        party_name: state.partyName,

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

    alert("Save failed");
  }
}

async function viewOrder(id) {

  try {

    const data =
      await api(API.orders + "?id=" + id);

    const order =
      data.order || {};

    const items =
      data.items || [];

    document.getElementById(
      "orderViewBox"
    ).innerHTML = `

      <div class="info">

        <h3>
          Order View
        </h3>

        <b>Party:</b>
        ${order.party_name || ""}
        <br>

        <b>Order No:</b>
        ${order.id || id}

        <table>

          <tr>
            <th>Part</th>
            <th>Item</th>
            <th>Qty</th>
            <th>Packed</th>
            <th>Balance</th>
          </tr>

          ${items.map(it => {

            const qty =
              Number(it.qty || 0);

            const packed =
              Number(it.packed_qty || 0);

            const balance =
              qty - packed;

            return `
              <tr>

                <td>
                  ${it.part_no || ""}
                </td>

                <td>
                  ${it.model || ""}
                </td>

                <td>
                  ${qty}
                </td>

                <td>
                  ${packed}
                </td>

                <td>
                  <b>${balance}</b>
                </td>

              </tr>
            `;
          }).join("")}

        </table>

      </div>
    `;

  } catch (e) {

    alert("View failed");
  }
}

async function deleteOrder(id) {

  if (!confirm("Delete order?")) {
    return;
  }

  try {

    await api(API.orders + "?id=" + id, {
      method: "DELETE"
    });

    await loadAll();

    renderOrders();

  } catch (e) {

    alert("Delete failed");
  }
}

/* PACKING */

function getCurrentTotalCartons() {

  const nums = state.cartonItems
    .map(it => Number(it.carton_no || 0))
    .filter(n => n > 0);

  if (!nums.length) {
    return "";
  }

  return Math.max(...nums);
}
/* PACKING */

function renderPacking() {

  const orderOptions = state.orders.map(o => `
    <option value="${o.id}">
      #${o.id} — ${o.party_name}
    </option>
  `).join("");

  const o = state.selectedOrder;

  main(`
    <div class="card">

      <h2>Packing</h2>

      <select onchange="selectOrder(this.value)">
        <option value="">Select Order</option>
        ${orderOptions}
      </select>

      ${o ? `

        <div class="info">

          <b>Party:</b>
          ${o.party_name}

          <br>

          <b>Order No:</b>
          ${o.id}

        </div>

        <div class="row3">

          <input
            id="cartonNo"
            placeholder="Carton No"
            value="${escapeAttr(state.cartonNo)}"
            oninput="state.cartonNo=this.value;updateExpectedBox()"
          >

          <input
            id="outerWeight"
            placeholder="Outer Weight"
            value="${escapeAttr(state.outerWeight)}"
            oninput="state.outerWeight=this.value;updateExpectedBox()"
          >

          <input
            value="${getCurrentTotalCartons()}"
            readonly
            placeholder="Total Cartons"
          >

        </div>

        <div class="row">

          <select id="packItem">

            <option value="">
              Select Item
            </option>

            ${(o.items || []).map(it => `

              <option value="${it.part_no}">

                ${it.part_no}
                —
                ${it.model || ""}
                —
                Balance
                ${Number(it.qty || 0) - Number(it.packed_qty || 0)}

              </option>

            `).join("")}

          </select>

          <input
            id="packQty"
            type="number"
            placeholder="Qty"
            onkeydown="if(event.key==='Enter') addCartonItem()"
          >

        </div>

      ` : ""}

      ${itemsTable(state.cartonItems, true)}

      <div
        class="info"
        id="expectedBox"
      >
        ${expectedBoxHTML()}
      </div>

      <button
        class="green"
        onclick="saveCarton()"
      >
        Save Cartons
      </button>

      ${o ? packingCartonList(o.id) : ""}

    </div>
  `);
}

async function selectOrder(id) {

  if (!id) return;

  try {

    const data =
      await api(API.orders + "?id=" + id);

    state.selectedOrder =
      data.order ||
      state.orders.find(o =>
        String(o.id) === String(id)
      );

    state.selectedOrder.items =
      data.items || [];

    state.cartonItems = [];

    const sameOrder =
      state.cartons.filter(c =>
        String(c.order_id) ===
        String(state.selectedOrder.id)
      );

    state.cartonNo =
      String(sameOrder.length + 1);

    renderPacking();

  } catch (e) {

    alert("Order load failed");
  }
}

function addCartonItem() {

  const part = val("packItem");

  const qty = Number(val("packQty"));

  if (!part || !qty) {
    alert("Select item and qty");
    return;
  }

  const item =
    state.selectedOrder.items.find(
      x => x.part_no === part
    );

  state.cartonItems.push({

    carton_no: state.cartonNo,

    part_no: item.part_no,

    model: item.model || "",

    qty,

    weight_per_set: Number(
      item.weight_per_set || 0
    )
  });

  renderPacking();
}

function expectedBoxHTML() {

  const cartonMap = {};

  state.cartonItems.forEach(it => {

    const no =
      String(it.carton_no || "");

    if (!cartonMap[no]) {
      cartonMap[no] = 0;
    }

    cartonMap[no] +=
      Number(it.qty || 0) *
      Number(it.weight_per_set || 0);
  });

  const cartons =
    Object.keys(cartonMap);

  if (!cartons.length) {
    return "No items added";
  }

  return `

    <h3>
      Carton Wise Weight
    </h3>

    ${cartons.map(no => {

      const itemWt =
        cartonMap[no];

      const outer =
        Number(state.outerWeight || 0);

      const gross =
        itemWt + outer;

      return `

        <div class="line">

          <b>
            Carton No:
          </b>

          ${no}

          <br>

          <b>
            Item Weight:
          </b>

          ${itemWt.toFixed(2)} kg

          <br>

          <b>
            Outer:
          </b>

          ${outer.toFixed(2)} kg

          <br>

          <b>
            Gross:
          </b>

          ${gross.toFixed(2)} kg

        </div>

      `;
    }).join("")}
  `;
}

function updateExpectedBox() {

  const box =
    document.getElementById(
      "expectedBox"
    );

  if (box) {
    box.innerHTML =
      expectedBoxHTML();
  }
}

async function saveCarton() {

  try {

    if (!state.selectedOrder) {
      alert("Select order");
      return;
    }

    if (!state.cartonItems.length) {
      alert("Add items");
      return;
    }

    const cartonNos =
      [...new Set(
        state.cartonItems.map(
          it => String(it.carton_no)
        )
      )];

    const totalCartons =
      String(
        Math.max(
          ...cartonNos.map(n =>
            Number(n || 0)
          )
        )
      );

    for (const cartonNo of cartonNos) {

      const items =
        state.cartonItems.filter(
          it =>
            String(it.carton_no) ===
            String(cartonNo)
        );

      const itemWeight =
        items.reduce((sum, it) => {

          return sum +
            (
              Number(it.qty || 0) *
              Number(it.weight_per_set || 0)
            );

        }, 0);

      const gross =
        itemWeight +
        Number(state.outerWeight || 0);

      await api(API.cartons, {

        method: "POST",

        body: JSON.stringify({

          order_id:
            state.selectedOrder.id,

          carton_no:
            cartonNo,

          total_cartons:
            totalCartons,

          outer_weight:
            Number(state.outerWeight || 0),

          expected_weight:
            gross,

          packed_by:
            state.user.username,

          items
        })
      });
    }

    alert("Cartons sent to QC");

    state.cartonItems = [];

    state.selectedOrder = null;

    state.cartonNo = "";

    state.outerWeight = "";

    await loadAll();

    renderPacking();

  } catch (e) {

    alert("Save failed");
  }
}

function packingCartonList(orderId) {

  const list =
    state.cartons.filter(c =>
      String(c.order_id) ===
      String(orderId)
    );

  if (!list.length) {
    return "";
  }

  return `

    <h3>
      Packed Cartons
    </h3>

    <table>

      <tr>
        <th>Carton</th>
        <th>Expected</th>
        <th>Actual</th>
        <th>Status</th>
      </tr>

      ${list.map(c => `
        <tr>

          <td>
            ${c.carton_no}/${c.total_cartons}
          </td>

          <td>
            ${Number(c.expected_weight || 0).toFixed(2)} kg
          </td>

          <td>
            ${Number(c.actual_weight || 0).toFixed(2)} kg
          </td>

          <td>
            ${c.status || c.qc_status || "PENDING_QC"}
          </td>

        </tr>
      `).join("")}

    </table>
  `;
}

/* QC */

function renderQC() {

  const parties =
    [...new Set(
      state.cartons
        .map(c => c.party_name)
        .filter(Boolean)
    )];

  main(`

    <div class="card">

      <h2>
        QC
      </h2>

      <select
        onchange="renderQCCartons(this.value)"
      >

        <option value="">
          Select Party
        </option>

        ${parties.map(p => `
          <option value="${p}">
            ${p}
          </option>
        `).join("")}

      </select>

      <div id="qcCartons"></div>

      <div id="qcDetails"></div>

    </div>
  `);
}

function renderQCCartons(party) {

  const list =
    state.cartons.filter(
      c => c.party_name === party
    );

  document.getElementById(
    "qcCartons"
  ).innerHTML = `

    <table>

      <tr>
        <th>Carton</th>
        <th>Expected</th>
        <th>Status</th>
        <th>Open</th>
      </tr>

      ${list.map(c => `
        <tr>

          <td>
            ${c.carton_no}/${c.total_cartons}
          </td>

          <td>
            ${Number(c.expected_weight || 0).toFixed(2)} kg
          </td>

          <td>
            ${c.status || c.qc_status}
          </td>

          <td>

            <button onclick="selectCarton(${c.id})">
              Open
            </button>

          </td>

        </tr>
      `).join("")}

    </table>
  `;
}

async function selectCarton(id) {

  const data =
    await api(API.cartons + "?id=" + id);

  state.selectedCarton =
    data.carton;

  renderQCDetails();
}

function renderQCDetails() {

  const c =
    state.selectedCarton;

  if (!c) return;

  document.getElementById(
    "qcDetails"
  ).innerHTML = `

    <div class="info">

      <b>Party:</b>
      ${c.party_name}
      <br>

      <b>Carton:</b>
      ${c.carton_no}/${c.total_cartons}
      <br>

      <b>Expected:</b>
      ${Number(c.expected_weight || 0).toFixed(2)} kg
      <br>

      <b>Actual:</b>
      ${Number(c.actual_weight || 0).toFixed(2)} kg
      <br>

      <b>Status:</b>
      ${c.status || c.qc_status}

    </div>

    ${itemsTable(c.items || [], false)}

    <input
      id="actualWeight"
      type="number"
      step="0.01"
      placeholder="Actual Weight"
      value="${c.actual_weight || ""}"
    >

    <button
      class="green"
      onclick="saveQC()"
    >
      PASS / RECHECK
    </button>
  `;
}

async function saveQC() {

  try {

    await api(API.qc, {

      method: "POST",

      body: JSON.stringify({

        carton_id:
          state.selectedCarton.id,

        actual_weight:
          Number(val("actualWeight"))
      })
    });

    await loadAll();

    await selectCarton(
      state.selectedCarton.id
    );

    alert("QC Updated");

  } catch (e) {

    alert("QC failed");
  }
}

/* HELPERS */

function itemsTable(items, del) {

  return `
    <table>

      <tr>

        <th>Carton</th>

        <th>Total</th>

        <th>Part</th>

        <th>Item</th>

        <th>Qty</th>

        ${del ? "<th>Delete</th>" : ""}

      </tr>

      ${(items || []).map((it, i) => `
        <tr>

          <td>
            ${it.carton_no || ""}
          </td>

          <td>
            ${getCurrentTotalCartons()}
          </td>

          <td>
            ${it.part_no || ""}
          </td>

          <td>
            ${it.model || ""}
          </td>

          <td>
            ${it.qty || ""}
          </td>

          ${
            del
            ? `
              <td>
                <button
                  class="danger"
                  onclick="deleteItem(${i})"
                >
                  Delete
                </button>
              </td>
            `
            : ""
          }

        </tr>
      `).join("")}

    </table>
  `;
}

function deleteItem(i) {

  if (state.tab === "orders") {
    state.orderItems.splice(i, 1);
  }

  if (state.tab === "packing") {
    state.cartonItems.splice(i, 1);
  }

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

  const style =
    document.createElement("style");

  style.innerHTML = `

    body{
      font-family:Arial;
      background:#f4f6f8;
      margin:0;
      color:#111;
    }

    .wrap{
      max-width:1100px;
      margin:auto;
      padding:20px;
    }

    .card{
      background:white;
      padding:22px;
      border-radius:14px;
      margin:14px 0;
      box-shadow:0 2px 8px #0001;
    }

    .top{
      display:flex;
      justify-content:space-between;
      align-items:center;
    }

    input,select,button{
      width:100%;
      padding:14px;
      margin:8px 0;
      border:1px solid #ccc;
      border-radius:10px;
      font-size:16px;
    }

    button{
      background:#304ffe;
      color:white;
      font-weight:bold;
      border:none;
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
    }

    .tabs button{
      background:white;
      color:#111;
      border:1px solid #ccc;
    }

    .tabs button.active{
      background:#304ffe;
      color:white;
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

    .suggest{
      position:absolute;
      background:white;
      border:1px solid #aaa;
      z-index:999;
      width:100%;
      max-height:220px;
      overflow:auto;
    }

    .suggest div{
      padding:12px;
      border-bottom:1px solid #eee;
      cursor:pointer;
    }

    .suggest div:hover{
      background:#eef;
    }

    .searchBox{
      position:relative;
    }

    .info{
      background:#f1f5ff;
      padding:12px;
      border-radius:10px;
      margin:10px 0;
    }

    .stat{
      background:#f1f5ff;
      padding:20px;
      border-radius:12px;
      text-align:center;
    }

    .grid3{
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:10px;
    }

    .line{
      background:#f8f9fb;
      border:1px solid #ddd;
      border-radius:10px;
      padding:12px;
      margin:10px 0;
    }

  `;

  document.head.appendChild(style);
}

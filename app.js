const API = {
  login: "/api/login"
};

let state = {
  user: JSON.parse(localStorage.getItem("user") || "null")
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  injectStyle();

  if (!state.user) {
    renderLogin();
    return;
  }

  renderApp();
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...opts
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "API Error");
  }

  return data;
}

function renderLogin() {
  document.body.innerHTML = `
    <div class="wrap">
      <div class="card">
        <h1>Ceradrive Dispatch QC</h1>

        <input
          id="u"
          placeholder="Username"
          value="admin"
        >

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

    renderApp();

  } catch (e) {

    alert(
      "Login failed: " + e.message
    );
  }
}

function renderApp() {

  document.body.innerHTML = `
    <div class="wrap">

      <div class="card top">

        <div>
          <h2>
            Ceradrive Packing QC V3
          </h2>

          <p>
            Welcome ${state.user.username}
          </p>
        </div>

        <button onclick="logout()">
          Logout
        </button>

      </div>

      <div class="tabs">

        <button onclick="setTab('dashboard')">
          Dashboard
        </button>

        <button onclick="setTab('orders')">
          Orders
        </button>

      </div>

      <div id="main"></div>

    </div>
  `;

  renderTab();
}function setTab(tab) {

  state.tab = tab;

  renderTab();
}

function renderTab() {

  if (state.tab === "orders") {
    renderOrders();
    return;
  }

  renderDashboard();
}

function renderDashboard() {

  main(`
    <div class="card">

      <h2>
        Dashboard
      </h2>

      <p>
        App working properly.
      </p>

    </div>
  `);
}

function renderOrders() {

  main(`
    <div class="card">

      <h2>
        Orders
      </h2>

      <p>
        Orders module ready.
      </p>

    </div>
  `);
}function main(html) {
  document.getElementById("main").innerHTML = html;
}.top{
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.tabs{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;
  margin:10px 0;
}

function val(id) {
  return document.getElementById(id)?.value || "";
}

function injectStyle() {

  const style =
    document.createElement("style");

  style.innerHTML = `
    body{
      font-family:Arial;
      background:#f4f6f8;
      margin:0;
    }

    .wrap{
      max-width:500px;
      margin:auto;
      padding:40px;
    }

    .card{
      background:white;
      padding:25px;
      border-radius:14px;
      box-shadow:0 2px 10px #0001;
    }

    input,button{
      width:100%;
      padding:14px;
      margin:10px 0;
      border-radius:10px;
      border:1px solid #ccc;
      font-size:16px;
    }

    button{
      background:#304ffe;
      color:white;
      border:none;
      font-weight:bold;
    }
  `;

  document.head.appendChild(style);
}

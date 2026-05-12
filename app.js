const $ = (id) => document.getElementById(id);

let user = JSON.parse(localStorage.getItem('packing_qc_user') || 'null');

let orderSelectedSku = null;
let orderItems = [];

let packingOrderItems = [];
let packingSelectedItem = null;
let cartonItems = [];

let currentQcCarton = null;

async function api(path, options = {}) {
  const res = await fetch('/api/' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

window.addEventListener('load', () => {
  if (user) enterApp();

  $('orderSkuSearch')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await selectOrderSku();
      $('orderQty')?.focus();
    }
  });

  $('orderQty')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addOrderItem();
    }
  });

  $('outerWeight')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('packItemSearch')?.focus(); }
  });

  $('packItemSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      selectPackingItem();
      $('packQty')?.focus();
    }
  });

  $('packQty')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCartonItem();
    }
  });

  $('cartonNo')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCarton(); }
  });

  $('outerWeight')?.addEventListener('input', renderCartonItems);
});

async function login() {
  try {
    const username = $('loginUser').value.trim();
    const password = $('loginPass').value.trim();
    const data = await api('login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    user = data.user;
    localStorage.setItem('packing_qc_user', JSON.stringify(user));
    enterApp();
  } catch (e) {
    alert('Login failed: ' + e.message);
  }
}

function logout() {
  localStorage.removeItem('packing_qc_user');
  user = null;
  location.reload();
}

function enterApp() {
  $('loginPage')?.classList.add('hidden');
  $('appPage')?.classList.remove('hidden');
  $('welcome').innerText = 'Welcome, ' + user.username;
  $('roleText').innerText = 'Role: ' + user.role;

  applyRole();
  showTab(user.role === 'ENTRY' ? 'packing' : user.role === 'QC' ? 'qc' : 'dashboard');
}

function applyRole() {
  const role = String(user.role || '').toUpperCase();

  $('tabOrders').style.display = role === 'ADMIN' ? 'block' : 'none';
  $('tabSku').style.display = role === 'ADMIN' ? 'block' : 'none';
  $('tabPacking').style.display = (role === 'ADMIN' || role === 'ENTRY') ? 'block' : 'none';
  $('tabQC').style.display = (role === 'ADMIN' || role === 'QC') ? 'block' : 'none';
}

function showTab(tab) {
  ['dashboard','orders','packing','qc','sku'].forEach(t => {
    $(t + 'Tab')?.classList.toggle('hidden', t !== tab);
    $('tab' + t.charAt(0).toUpperCase() + t.slice(1))?.classList.toggle('active', t === tab);
  });
  refreshAll();
}

async function refreshAll() {
  if (!user) return;
  await Promise.allSettled([
    loadDashboard(),
    loadOrders(),
    loadPackOrders(),
    loadQcCartons(),
    loadSkuList()
  ]);
}

async function loadDashboard() {
  try {
    const d = await api('dashboard');
    $('dashboardData').innerHTML = `
      <div>Total Orders: <b>${d.total_orders || 0}</b></div>
      <div>Pending Orders: <b>${d.pending_orders || 0}</b></div>
      <div>Completed Orders: <b>${d.completed_orders || 0}</b></div>
    `;
  } catch (e) {
    $('dashboardData').innerText = e.message;
  }
}

/* ORDERS */
async function selectOrderSku() {
  const q = $('orderSkuSearch').value.trim();
  if (!q) return;
  try {
    const d = await api('sku?q=' + encodeURIComponent(q));
    const skus = d.skus || [];
    if (!skus.length) return alert('Part not found');
    orderSelectedSku = skus[0];
    $('orderSkuSearch').value = `${orderSelectedSku.part_no} - ${orderSelectedSku.model || ''}`;
    $('orderSelectedSku').innerText = `Selected: ${orderSelectedSku.part_no} ${orderSelectedSku.model || ''}`;
  } catch (e) {
    alert('SKU error: ' + e.message);
  }
}

function addOrderItem() {
  if (!orderSelectedSku) return alert('Search SKU and press Enter first');
  const qty = Number($('orderQty').value || 0);
  if (qty <= 0) return alert('Enter qty');

  orderItems.push({ ...orderSelectedSku, qty });
  orderSelectedSku = null;
  $('orderSkuSearch').value = '';
  $('orderQty').value = '';
  $('orderSelectedSku').innerText = '';
  renderOrderItems();
  $('orderSkuSearch').focus();
}

function removeOrderItem(i) {
  orderItems.splice(i, 1);
  renderOrderItems();
}

function renderOrderItems() {
  $('orderItemsTable').innerHTML = `
    <table>
      <tr><th>Part</th><th>Item</th><th>Qty</th><th>Delete</th></tr>
      ${orderItems.map((x, i) => `
        <tr>
          <td>${x.part_no}</td>
          <td>${x.model || ''}</td>
          <td>${x.qty}</td>
          <td><button class="red" onclick="removeOrderItem(${i})">Delete</button></td>
        </tr>
      `).join('')}
    </table>
  `;
}

async function saveOrder() {
  try {
    const party = $('orderParty').value.trim();
    if (!party) return alert('Party name required');
    if (!orderItems.length) return alert('Add items');

    await api('orders', {
      method: 'POST',
      body: JSON.stringify({ party_name: party, created_by: user.username, items: orderItems })
    });

    alert('Order saved');
    $('orderParty').value = '';
    orderItems = [];
    renderOrderItems();
    await refreshAll();
  } catch (e) {
    alert('Save order failed: ' + e.message);
  }
}

async function loadOrders() {
  try {
    const d = await api('orders');
    $('ordersList').innerHTML = (d.orders || []).map(o => `
      <div class="card">
        <b>${o.party_name}</b> <span class="badge">${o.status || 'PENDING'}</span><br>
        <span class="small">Order #${o.id} • ${o.created_at || ''}</span><br>
        <button class="red" onclick="deleteOrder(${o.id})">Delete Order</button>
      </div>
    `).join('') || 'No orders';
  } catch (e) {
    $('ordersList').innerText = e.message;
  }
}

async function deleteOrder(id) {
  if (!confirm('Delete this order?')) return;
  try {
    await api('orders?id=' + id, { method: 'DELETE' });
    await refreshAll();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

/* PACKING */
async function loadPackOrders() {
  try {
    const d = await api('orders');
    $('packOrder').innerHTML = '<option value="">Select Order / Party</option>' +
      (d.orders || []).map(o => `<option value="${o.id}">#${o.id} - ${o.party_name}</option>`).join('');
  } catch (e) {}
}

async function loadOrderForPacking() {
  const id = $('packOrder').value;
  if (!id) return;

  try {
    const d = await api('orders?id=' + id);
    packingOrderItems = d.items || [];
    cartonItems = [];
    packingSelectedItem = null;
    renderCartonItems();
    $('outerWeight').focus();
  } catch (e) {
    alert('Load order failed: ' + e.message);
  }
}

function selectPackingItem() {
  const q = $('packItemSearch').value.trim().toLowerCase();
  if (!q) return;
  const item = packingOrderItems.find(x =>
    String(x.part_no || '').toLowerCase().includes(q) ||
    String(x.model || '').toLowerCase().includes(q)
  );
  if (!item) return alert('Item not found in selected order');

  packingSelectedItem = item;
  $('packItemSearch').value = `${item.part_no} - ${item.model || ''}`;
  $('packSelectedItem').innerText = `Selected: ${item.part_no} ${item.model || ''}`;
}

function addCartonItem() {
  if (!packingSelectedItem) return alert('Search item and press Enter first');
  const qty = Number($('packQty').value || 0);
  if (qty <= 0) return alert('Enter qty');

  cartonItems.push({ ...packingSelectedItem, qty });
  packingSelectedItem = null;
  $('packItemSearch').value = '';
  $('packQty').value = '';
  $('packSelectedItem').innerText = '';
  renderCartonItems();
  $('packItemSearch').focus();
}

function removeCartonItem(i) {
  cartonItems.splice(i, 1);
  renderCartonItems();
}

function renderCartonItems() {
  if (!$('packItemsTable')) return;
  const itemsWeight = cartonItems.reduce((s, x) => s + (Number(x.weight_per_set || 0) * Number(x.qty || 0)), 0);
  const outer = Number($('outerWeight')?.value || 0);
  const gross = itemsWeight + outer;

  $('packItemsTable').innerHTML = `
    <table>
      <tr><th>Part</th><th>Item</th><th>Qty</th><th>Delete</th></tr>
      ${cartonItems.map((x, i) => `
        <tr>
          <td>${x.part_no}</td>
          <td>${x.model || ''}</td>
          <td>${x.qty}</td>
          <td><button class="red" onclick="removeCartonItem(${i})">Delete</button></td>
        </tr>
      `).join('')}
    </table>
  `;

  $('packWeight').innerHTML = `
    Item Weight: <b>${itemsWeight.toFixed(2)} kg</b><br>
    Outer Carton Weight: <b>${outer.toFixed(2)} kg</b><br>
    Expected Gross Weight: <b>${gross.toFixed(2)} kg</b>
  `;
}

async function saveCarton() {
  try {
    if (!$('packOrder').value) return alert('Select order');
    if (!cartonItems.length) return alert('Add carton items');
    if (!$('cartonNo').value.trim()) return alert('Enter carton no');

    const itemsWeight = cartonItems.reduce((s, x) => s + (Number(x.weight_per_set || 0) * Number(x.qty || 0)), 0);
    const outer = Number($('outerWeight').value || 0);

    await api('cartons', {
      method: 'POST',
      body: JSON.stringify({
        order_id: $('packOrder').value,
        carton_no: $('cartonNo').value.trim(),
        total_cartons: $('totalCartons').value.trim(),
        outer_weight: outer,
        expected_weight: itemsWeight + outer,
        items: cartonItems
      })
    });

    alert('Carton sent to QC');
    cartonItems = [];
    $('cartonNo').value = '';
    renderCartonItems();
    await refreshAll();
  } catch (e) {
    alert('Carton save failed: ' + e.message);
  }
}

/* QC */
async function loadQcCartons() {
  try {
    const d = await api('cartons');
    $('qcCarton').innerHTML = '<option value="">Select Carton</option>' +
      (d.cartons || []).map(c => `<option value="${c.id}">Carton ${c.carton_no} / ${c.total_cartons || ''} - ${c.party_name || ''} - ${c.status}</option>`).join('');
  } catch (e) {}
}

async function loadCartonForQC() {
  const id = $('qcCarton').value;
  if (!id) return;
  try {
    const d = await api('cartons?id=' + id);
    currentQcCarton = d.carton;
    renderQC();
  } catch (e) {
    alert('Load carton failed: ' + e.message);
  }
}

function renderQC() {
  const c = currentQcCarton;
  if (!c) return;

  $('qcDetails').innerHTML = `
    <div class="card">
      <b>${c.party_name || ''}</b><br>
      Carton No: <b>${c.carton_no} / ${c.total_cartons || ''}</b><br>
      Expected Weight: <b>${Number(c.expected_weight || 0).toFixed(2)} kg</b><br>
      Status: <b>${c.status || 'PENDING'}</b>
      <table>
        <tr><th>Part</th><th>Item</th><th>Qty</th></tr>
        ${(c.items || []).map(x => `
          <tr><td>${x.part_no}</td><td>${x.model || ''}</td><td>${x.qty}</td></tr>
        `).join('')}
      </table>
    </div>
  `;
}

async function saveQC(status) {
  if (!currentQcCarton) return alert('Select carton');
  const actual = $('actualWeight').value;
  if (!actual) return alert('Enter actual weight');

  try {
    await api('qc', {
      method: 'POST',
      body: JSON.stringify({ carton_id: currentQcCarton.id, actual_weight: actual, qc_status: status })
    });

    currentQcCarton.actual_weight = actual;
    currentQcCarton.status = status;
    alert('QC saved: ' + status);
    renderQC();
    await loadQcCartons();
  } catch (e) {
    alert('QC save failed: ' + e.message);
  }
}

function printSticker() {
  if (!currentQcCarton) return alert('Select carton');
  const c = currentQcCarton;
  const showLogo = $('showLogo').checked;
  const totalQty = (c.items || []).reduce((s, x) => s + Number(x.qty || 0), 0);
  const itemNames = (c.items || []).map(x => `${x.part_no} ${x.model || ''}`).join('<br>');
  const actual = c.actual_weight || $('actualWeight').value || '';

  const html = `
    <div class="sticker">
      ${showLogo ? '<div class="logo">CERADRIVE</div>' : ''}
      <h2>${c.party_name || ''}</h2>
      <div class="line"></div>
      <b>Carton No:</b> ${c.carton_no} / ${c.total_cartons || ''}<br>
      <b>Items:</b><br>${itemNames}<br>
      <b>Total Qty:</b> ${totalQty}<br>
      <b>Expected Weight:</b> ${Number(c.expected_weight || 0).toFixed(2)} kg<br>
      <b>Actual Weight:</b> ${actual} kg<br>
      <b>QC Status:</b> ${c.status || 'PENDING'}<br>
      <b>Date/Time:</b> ${new Date().toLocaleString()}
    </div>
  `;

  $('stickerPreview').innerHTML = html;
  $('stickerPrintArea').innerHTML = html;
  window.print();
}

/* SKU MASTER */
async function saveSku() {
  try {
    if (!$('skuPart').value.trim()) return alert('Part no required');
    await api('sku', {
      method: 'POST',
      body: JSON.stringify({
        part_no: $('skuPart').value.trim(),
        make_name: $('skuMake').value.trim(),
        model: $('skuModel').value.trim(),
        weight_per_set: $('skuWeight').value || 0
      })
    });
    alert('SKU saved');
    $('skuPart').value = '';
    $('skuMake').value = '';
    $('skuModel').value = '';
    $('skuWeight').value = '';
    loadSkuList();
  } catch (e) {
    alert('SKU save failed: ' + e.message);
  }
}

async function loadSkuList() {
  if (!$('skuList')) return;
  const q = $('skuFind')?.value?.trim() || '';
  try {
    const d = q ? await api('sku?q=' + encodeURIComponent(q)) : { skus: [] };
    $('skuList').innerHTML = (d.skus || []).map(s => `
      <div class="card small">
        <b>${s.part_no}</b> - ${s.model || ''}<br>
        ${s.make_name || ''} | ${s.weight_per_set || 0} kg
      </div>
    `).join('');
  } catch (e) {}
}

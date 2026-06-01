/* ═══════════════════════════════════════════════════════════════════════════
   Ceradrive Packing & QC System — v8.5.3
   Refactored for production quality, maintainability, and scalability.

   ARCHITECTURE OVERVIEW
   ─────────────────────
   1. CONFIG          — constants, API endpoints, user definitions
   2. STATE           — single mutable state object + helpers
   3. PERSISTENCE     — localStorage (saveState/loadState) + server sync
   4. OFFLINE QUEUE   — retry queue for failed API writes
   5. AUTO-REFRESH    — background poll, change detection, safe re-render
   6. UTILITIES       — pure helpers (normText, esc, fmtDate …)
   7. DOMAIN LOGIC    — order/carton/SKU computations, no DOM
   8. AUTH            — login, logout, role-based access
   9. ROUTER          — go(), renderScreen(), tab config
  10. RENDER — ORDER  — order creation, list, edit, open views
  11. RENDER — PACKING— packing form, carton draft, send-to-QC
  12. RENDER — QC     — QC cards, weight entry, save
  13. RENDER — STICKERS— print stickers, dispatch lots, Excel export
  14. RENDER — OTHER  — SKU Master, History, Log
  15. OVERLAY / TOAST — loading overlay, toast notifications
  16. IMPORT / EXPORT — Excel import progress modal
  17. BOOTSTRAP       — init(), event listeners
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════════════════════
   1. CONFIG
   ══════════════════════════════════════════════════════════════ */

/** Cloudflare Pages Functions API endpoints. */
const API = {
  setup:   "/api/setup",
  skus:    "/api/skus",
  orders:  "/api/orders",
  cartons: "/api/cartons",
  sync:    "/api/sync",
};

/**
 * User credentials live in source because this app runs on a private LAN /
 * Cloudflare deployment with no user-management backend.
 * SECURITY NOTE: In a multi-tenant production system move these to env vars
 * or a hashed credential store.
 */
const USERS = [
  { username: "admin",   password: "Kamal@102",   role: "ADMIN"   },
  { username: "manager", password: "Manager123",  role: "MANAGER" },
  { username: "packing", password: "Pack123",     role: "PACKING" },
  { username: "qc",      password: "Qc123",       role: "QC"      },
];

/** QC weight tolerance in kg (±300 g). */
const QC_TOLERANCE_KG = 0.30;

/** Background auto-refresh interval. */
const AUTO_REFRESH_MS = 45_000;

/** localStorage keys — centralised so renames are one-line changes. */
const STORAGE = {
  STATE:         "ceradrive_state_v1",
  STATE_BAK:     "ceradrive_state_v1_bak",
  OFFLINE_QUEUE: "ceradrive_offline_queue_v1",
  REMEMBER_USER: "remember_user_v7_2",
  // Legacy keys (read-only migration)
  LEGACY_ORDERS:  "orders_v7",
  LEGACY_CARTONS: "cartons_v7",
  LEGACY_SKUS:    "skus_v7",
  QC_BACKUP:      "ceradrive_backup_pre_qc",
};
const STATE_VERSION = 3;

/* ══════════════════════════════════════════════════════════════
   2. STATE
   ══════════════════════════════════════════════════════════════ */

/**
 * Single mutable application state.
 * All screens read from / write to this object.
 * The only transient UI state that doesn't belong here (e.g. scroll position)
 * is kept in module-level variables below.
 */
let state = {
  user:          null,       // logged-in user object | null
  screen:        "HOME",     // active tab name
  skus:          [],
  orders:        [],
  cartons:       [],
  orderDraft:    [],         // items being composed in New Order / Edit Order
  cartonDraft:   [], // items being packed before send-to-QC
  selectedSku:   null,       // SKU selected in the order form
  selectedOrderNo: "",       // order number selected in Packing
  brandOn:       true,
};

/**
 * Ephemeral UI state — values that survive within a screen but are never
 * persisted. Kept as module-level vars (not on window) to prevent accidental
 * global namespace pollution.
 */
let _currentParty     = "";   // party name typed in order form
let _editingOrderNo   = null; // order being edited (edit-order mode)
let _selectedPackIdx  = undefined; // index of selected item in packing form
let _nextCartonNo     = "1";  // suggested next carton number
let _currentTare      = "0.30";
let _skuFilterTab     = "all";
let _refreshTimer     = null;
let _centerToastTimer = null;
let _confirmDeleteSKU = null; // two-tap delete guard
let _lastCartonNo     = null; // tracks previous carton# to auto-focus tare on change

/** Root DOM element. All rendering targets this. */
const app = document.getElementById("app");

/* ══════════════════════════════════════════════════════════════
   3. PERSISTENCE  (localStorage ↔ Cloudflare D1)
   ══════════════════════════════════════════════════════════════ */

/**
 * Read the unified state snapshot from localStorage.
 * Returns {skus, orders, cartons} or null.
 */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE.STATE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if ((parsed._v || 0) < 2) return null; // discard pre-v2 format
    return {
      skus:    parsed.skus    || [],
      orders:  parsed.orders  || [],
      cartons: parsed.cartons || [],
    };
  } catch { return null; }
}

/**
 * Write current state to localStorage.
 * Includes a safety guard: never overwrite real data with an empty state,
 * and always writes a rolling backup first.
 */
function saveState() {
  try {
    const isEmpty = state.orders.length === 0 && state.cartons.length === 0;
    if (isEmpty) {
      // Guard: abort if localStorage already contains real data.
      const existing = _parseLocalItem(STORAGE.STATE);
      if (existing && ((existing.orders || []).length > 0 || (existing.cartons || []).length > 0)) {
        console.warn("[saveState] Refused to overwrite existing data with empty state");
        return;
      }
      // Also check legacy key.
      const lo = _parseLocalItem(STORAGE.LEGACY_ORDERS);
      if (Array.isArray(lo) && lo.length > 0) {
        console.warn("[saveState] Refused to overwrite — legacy orders_v7 has data");
        return;
      }
    }
    // Rolling backup before overwrite.
    const prev = localStorage.getItem(STORAGE.STATE);
    if (prev) localStorage.setItem(STORAGE.STATE_BAK, prev);

    localStorage.setItem(STORAGE.STATE, JSON.stringify({
      _v:      STATE_VERSION,
      _saved:  Date.now(),
      skus:    state.skus,
      orders:  state.orders,
      cartons: state.cartons,
    }));
  } catch (e) {
    console.warn("[saveState] localStorage write failed:", e);
  }
}

/**
 * loadAll() — Master data loader on init and login.
 *
 * Priority:
 *   1. Server API (trusted if non-empty or local is empty)
 *   2. localStorage unified key
 *   3. localStorage backup key
 *   4. Legacy keys (orders_v7 / cartons_v7 / skus_v7)
 *   5. QC backup key
 *   6. Seed demo SKUs (fresh install only)
 *
 * Never overwrites local data with an empty API response.
 */
async function loadAll() {
  const local = _loadBestLocal();

  let apiData = null;
  let apiOk   = false;
  try {
    const [s, o, c] = await Promise.all([
      apiGet(API.skus), apiGet(API.orders), apiGet(API.cartons),
    ]);
    apiData = {
      skus:    s.skus    || [],
      orders:  o.orders  || [],
      cartons: c.cartons || [],
    };
    apiOk = true;
  } catch (e) {
    console.warn("[loadAll] API fetch failed:", e.message);
  }

  const localRich = _dataRichness(local?.data);
  const apiRich   = _dataRichness(apiData);

  if (apiOk && apiRich >= localRich && localRich === 0) {
    // Fresh install — use API (may also be empty → seed below)
    _applyData(apiData || { skus: [], orders: [], cartons: [] });
  } else if (apiOk && apiRich > 0 && apiRich >= localRich) {
    _applyData(apiData);
    await flushOfflineQueue().catch(() => {});
  } else if (apiOk && apiRich === 0 && localRich > 0) {
    // API wiped but local has data — restore local to server
    _applyData(local.data);
    console.warn("[loadAll] API returned empty but local has data — restoring to API");
    persistState("all").catch(() => {});
  } else if (local) {
    _applyData(local.data);
    console.log(`[loadAll] Using local data (src:${local.src}, richness:${localRich})`);
    if (apiOk && apiRich === 0) {
      persistState("all").catch(() => {}); // push local to server
    }
  } else {
    // Nothing anywhere — seed demo SKUs
    console.warn("[loadAll] No data found anywhere — fresh install");
    state.skus    = _demoSkus();
    state.orders  = [];
    state.cartons = [];
  }

  // Migrate legacy keys to unified key once
  if (local?.src === "legacy_v7") {
    console.log("[loadAll] Migrating legacy keys to unified state key");
    saveState();
  }

  // Purge orphan cartons (cartons whose order was deleted)
  if (state.orders.length > 0 && purgeOrphanCartons()) {
    persistState("cartons").catch(() => {});
  }

  console.log(`[loadAll] Final: ${state.orders.length} orders, ${state.cartons.length} cartons, ${state.skus.length} SKUs`);

  // Migrate orders that pre-date workflow_status (added in v8.4.0)
  _migrateWorkflowStatus();
}

/** Apply a {skus, orders, cartons} object to live state. */
function _applyData(d) {
  state.skus    = d.skus    || [];
  state.orders  = d.orders  || [];
  state.cartons = d.cartons || [];
}

/** Scan all localStorage locations and return the richest non-empty snapshot. */
function _loadBestLocal() {
  const sources = [
    () => _tryLoadUnified(STORAGE.STATE,     "state_v1"),
    () => _tryLoadUnified(STORAGE.STATE_BAK, "state_v1_bak"),
    () => _tryLoadLegacy(),
    () => _tryLoadQCBackup(),
  ];
  for (const fn of sources) {
    const result = fn();
    if (result) return result;
  }
  return null;
}

function _tryLoadUnified(key, src) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || (p._v || 0) < 2) return null;
    const data = { skus: p.skus || [], orders: p.orders || [], cartons: p.cartons || [] };
    return _dataRichness(data) > 0 ? { src, data } : null;
  } catch { return null; }
}

function _tryLoadLegacy() {
  try {
    const orders  = _parseLocalItem(STORAGE.LEGACY_ORDERS)  || [];
    const cartons = _parseLocalItem(STORAGE.LEGACY_CARTONS) || [];
    const skus    = _parseLocalItem(STORAGE.LEGACY_SKUS)    || [];
    const data = { skus, orders, cartons };
    return _dataRichness(data) > 0 ? { src: "legacy_v7", data } : null;
  } catch { return null; }
}

function _tryLoadQCBackup() {
  try {
    const raw = localStorage.getItem(STORAGE.QC_BACKUP);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p) return null;
    const data = { skus: state.skus || [], orders: p.orders || [], cartons: p.cartons || [] };
    return _dataRichness(data) > 0 ? { src: "qc_backup", data } : null;
  } catch { return null; }
}

/** Richness score used to pick the best data source. */
function _dataRichness(d) {
  if (!d) return 0;
  return (d.orders || []).length * 100
       + (d.cartons || []).length * 10
       + (d.skus    || []).length;
}

function _parseLocalItem(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); }
  catch { return null; }
}

/** Migrate old orders missing workflow_status (pre-v8.4.0). */
function _migrateWorkflowStatus() {
  let migrated = 0;
  state.orders.forEach(o => {
    if (o.workflow_status) return;
    if (o.status === "COMPLETE") { o.workflow_status = "PACKING"; return; }
    const hasCartons = validCartonsForOrder(o).length > 0;
    o.workflow_status = hasCartons ? "PACKING" : "READY_TO_PACK";
    migrated++;
  });
  if (migrated > 0) {
    console.log(`[loadAll] Migrated ${migrated} orders to workflow_status`);
    saveState();
    persistState("orders").catch(() => {});
  }
}

function _demoSkus() {
  return [
    { part_no: "VO101P", vehicle: "SWIFT",  weight: 1.20, mrp: 0, dealer: 0, export_price: 0, active: 1 },
    { part_no: "HP202P", vehicle: "BALENO", weight: 1.45, mrp: 0, dealer: 0, export_price: 0, active: 1 },
    { part_no: "HE303P", vehicle: "CRETA",  weight: 1.60, mrp: 0, dealer: 0, export_price: 0, active: 1 },
    { part_no: "VO404P", vehicle: "I20",    weight: 1.30, mrp: 0, dealer: 0, export_price: 0, active: 1 },
  ];
}

/* ══════════════════════════════════════════════════════════════
   4. OFFLINE QUEUE
   ══════════════════════════════════════════════════════════════ */

function _getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(STORAGE.OFFLINE_QUEUE) || "[]"); }
  catch { return []; }
}

function _setOfflineQueue(q) {
  try { localStorage.setItem(STORAGE.OFFLINE_QUEUE, JSON.stringify(q)); }
  catch {}
}

function enqueueOffline(section) {
  const q = _getOfflineQueue();
  if (!q.includes(section)) q.push(section);
  _setOfflineQueue(q);
  _showOfflineIndicator(true);
}

function dequeueOffline(section) {
  const q = _getOfflineQueue().filter(s => s !== section);
  _setOfflineQueue(q);
  if (!q.length) _showOfflineIndicator(false);
}

/** Exported so the online event listener and loadAll can call it. */
async function flushOfflineQueue() {
  const q = _getOfflineQueue();
  if (!q.length) return;
  console.log("[offlineQueue] Flushing", q);
  for (const section of [...q]) {
    try {
      await _pushSection(section);
      dequeueOffline(section);
      console.log("[offlineQueue] Flushed:", section);
    } catch (e) {
      console.warn("[offlineQueue] Still offline for:", section);
      break; // stop on first failure
    }
  }
}

/** getOfflineQueue exposed for the offline indicator in renderApp. */
function getOfflineQueue() { return _getOfflineQueue(); }

function _showOfflineIndicator(show) {
  const ind = document.getElementById("offlineIndicator");
  if (ind) ind.style.display = show ? "flex" : "none";
}

/* ══════════════════════════════════════════════════════════════
   5. SERVER SYNC  (api helpers + persistState)
   ══════════════════════════════════════════════════════════════ */

/**
 * Generic fetch wrapper.
 * Throws on non-ok responses or api.ok === false.
 */
async function apiFetch(url, opts = {}) {
  const res  = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const text = await res.text();
  let data   = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  if (!res.ok || data.ok === false) throw new Error(data.error || "API error");
  return data;
}

function apiGet(url)        { return apiFetch(url); }
function apiPost(url, body) { return apiFetch(url, { method: "POST", body: JSON.stringify(body) }); }

/** Push one named section to the server. */
async function _pushSection(section) {
  if (section === "skus")    return apiPost(API.skus,    { skus:    state.skus    });
  if (section === "orders")  return apiPost(API.orders,  { orders:  state.orders  });
  if (section === "cartons") return apiPost(API.cartons, { cartons: state.cartons });
  throw new Error("Unknown section: " + section);
}

/**
 * Persist state: write to localStorage immediately, then push to server.
 * On server failure the section is queued for retry on reconnect.
 * @param {string|string[]} sections "all" | "skus" | "orders" | "cartons" | [...]
 * @returns {boolean} true if all server pushes succeeded
 */
async function persistState(sections = "all") {
  saveState();
  const want = sections === "all"
    ? ["skus", "orders", "cartons"]
    : Array.isArray(sections) ? sections : [sections];
  let ok = true;
  for (const s of want) {
    try {
      await _pushSection(s);
      dequeueOffline(s);
    } catch (e) {
      console.warn(`[persistState] API push failed for "${s}" — queued:`, e.message);
      enqueueOffline(s);
      ok = false;
    }
  }
  return ok;
}

/**
 * Safe merge-and-save for orders: fetches remote, merges by order_no (local wins),
 * then posts. Used after QC to minimise last-write-wins conflicts.
 */
async function saveOrdersSafe() {
  saveState();
  let merged = state.orders;
  try {
    const remote  = await apiGet(API.orders);
    const map     = new Map((remote.orders || []).map(o => [String(o.order_no), o]));
    state.orders.forEach(o => map.set(String(o.order_no), o));
    merged         = [...map.values()];
    state.orders   = merged;
    saveState();
  } catch {}
  await apiPost(API.orders, { orders: merged });
}

/** Same pattern for cartons. */
async function saveCartonsSafe() {
  saveState();
  let merged = state.cartons;
  try {
    const remote   = await apiGet(API.cartons);
    const map      = new Map((remote.cartons || []).map(c => [String(c.id), c]));
    state.cartons.forEach(c => map.set(String(c.id), c));
    merged          = [...map.values()];
    state.cartons   = merged;
    saveState();
  } catch {}
  await apiPost(API.cartons, { cartons: merged });
}

/** Atomic save for QC: commits carton + order changes in one backend batch. */
async function saveQCSafe() {
  saveState();
  await apiPost(API.sync, { orders: state.orders, cartons: state.cartons });
}

/* Convenience wrappers used by UI buttons */
async function saveSkus() {
  showCenterOverlay("Saving...");
  const ok = await persistState("skus");
  toast(ok ? "Saved successfully" : "Saved locally — sync failed");
}
async function saveOrders() {
  showCenterOverlay("Saving...");
  const ok = await persistState("orders");
  toast(ok ? "Saved successfully" : "Saved locally — sync failed");
}
async function saveCartons() {
  showCenterOverlay("Saving...");
  const ok = await persistState("cartons");
  toast(ok ? "Saved successfully" : "Saved locally — sync failed");
}

/* ══════════════════════════════════════════════════════════════
   5b. EMERGENCY DATA RECOVERY  (browser console utility)
   ══════════════════════════════════════════════════════════════ */

window.recoverData = async function () {
  console.log("[recoverData] Scanning all storage locations...");
  const sources = [];
  [STORAGE.STATE, STORAGE.STATE_BAK, STORAGE.QC_BACKUP].forEach(k => {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return;
      const p = JSON.parse(raw);
      const d = { skus: p.skus || [], orders: p.orders || [], cartons: p.cartons || [] };
      sources.push({ key: k, richness: _dataRichness(d), data: d, saved: new Date(p._saved || 0).toLocaleString() });
    } catch {}
  });
  try {
    const d = {
      skus:    _parseLocalItem(STORAGE.LEGACY_SKUS)    || [],
      orders:  _parseLocalItem(STORAGE.LEGACY_ORDERS)  || [],
      cartons: _parseLocalItem(STORAGE.LEGACY_CARTONS) || [],
    };
    if (_dataRichness(d) > 0) sources.push({ key: "legacy_v7", richness: _dataRichness(d), data: d, saved: "legacy" });
  } catch {}
  sources.sort((a, b) => b.richness - a.richness);
  console.table(sources.map(s => ({ key: s.key, orders: s.data.orders.length, cartons: s.data.cartons.length, skus: s.data.skus.length, saved: s.saved })));
  if (!sources.length) { console.error("[recoverData] No data found"); return; }
  const best = sources[0];
  if (!confirm(`Recover from "${best.key}"?\n\nOrders: ${best.data.orders.length}\nCartons: ${best.data.cartons.length}\nSKUs: ${best.data.skus.length}\n\nThis will push recovered data to the server.`)) return;
  _applyData(best.data);
  // Force-write bypassing the empty guard
  localStorage.setItem(STORAGE.STATE, JSON.stringify({ _v: STATE_VERSION, _saved: Date.now(), ...best.data }));
  try {
    await apiPost(API.skus,    { skus:    state.skus    });
    await apiPost(API.orders,  { orders:  state.orders  });
    await apiPost(API.cartons, { cartons: state.cartons });
    alert(`✓ Recovery complete!\nOrders: ${state.orders.length}\nCartons: ${state.cartons.length}\nSKUs: ${state.skus.length}\n\nData pushed to server.`);
  } catch (e) {
    alert(`Data restored to localStorage but server push failed: ${e.message}\nData is safe locally.`);
  }
  if (state.user) renderApp();
};

/* ══════════════════════════════════════════════════════════════
   6. AUTO-REFRESH
   ══════════════════════════════════════════════════════════════ */

function startAutoRefresh() {
  stopAutoRefresh();
  _refreshTimer = setInterval(_doRefresh, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

async function _doRefresh() {
  if (!state.user) return;
  if (state.cartonDraft.length > 0) return; // user mid-pack

  try {
    const [s, o, c] = await Promise.all([
      apiGet(API.skus), apiGet(API.orders), apiGet(API.cartons),
    ]);
    const newSkus    = s.skus    || [];
    const newOrders  = o.orders  || [];
    const newCartons = c.cartons || [];

    // Count + ID-fingerprint change detection — O(n) with no serialisation cost.
    // We hash the sorted IDs and row-count for each collection; a changed count
    // or any added/removed/renamed ID triggers a re-render. Content-only edits
    // (e.g. a field update on an existing row) are caught by updated_at in the
    // server payload being newer, which changes the fingerprint via the join.
    const _fp = (arr, idKey) =>
      arr.length + "|" + arr.map(r => (r[idKey] || "") + "~" + (r.updated_at || "")).sort().join(",");
    const changed = (
      _fp(newOrders,  "order_no") !== _fp(state.orders,  "order_no") ||
      _fp(newCartons, "id")       !== _fp(state.cartons, "id")       ||
      _fp(newSkus,    "part_no")  !== _fp(state.skus,    "part_no")
    );

    if (!changed) return;

    // Safety: never replace rich local state with empty server data
    if (_dataRichness({ orders: newOrders, cartons: newCartons, skus: newSkus }) === 0
        && _dataRichness({ orders: state.orders, cartons: state.cartons, skus: state.skus }) > 0) {
      console.warn("[autoRefresh] API returned empty — keeping existing state");
      return;
    }

    _applyData({ skus: newSkus, orders: newOrders, cartons: newCartons });
    purgeOrphanCartons();
    saveState();

    const safeScreens = ["ORDER", "QC", "STICKERS", "HISTORY", "LOG", "SKU MASTER"];
    if (safeScreens.includes(state.screen)) renderScreen();
    _updateStatsBar();
    _showRefreshIndicator();
  } catch {
    // Silently ignore network errors during background poll
  }
}

/** Update the stat numbers in the header bar without a full re-render. */
function _updateStatsBar() {
  const stats = _computeStats();
  const bar   = document.querySelector(".dash-stats-bar");
  if (!bar) return;
  const vals = bar.querySelectorAll(".dash-stat-val");
  if (vals[0]) vals[0].textContent = stats.total;
  if (vals[1]) vals[1].textContent = stats.pendingPacking;
  if (vals[2]) vals[2].textContent = stats.pendingQC;
  if (vals[3]) vals[3].textContent = stats.complete;
}

function _showRefreshIndicator() {
  const ind = document.getElementById("refreshIndicator");
  if (!ind) return;
  ind.classList.add("refresh-flash");
  setTimeout(() => ind.classList.remove("refresh-flash"), 1_800);
}

/* ══════════════════════════════════════════════════════════════
   7. UTILITIES  (pure functions — no side-effects, no DOM)
   ══════════════════════════════════════════════════════════════ */

/** Collapse whitespace and trim. */
function normText(x)   { return String(x || "").trim().replace(/\s+/g, " "); }
/** Upper-case status string. */
function normStatus(x) { return String(x || "").trim().toUpperCase(); }
/** Party key for case-insensitive comparisons. */
function partyKey(x)   { return normText(x).toLowerCase(); }
/** Order number equality (string-safe). */
function sameOrderNo(a, b) { return String(a || "") === String(b || ""); }
/** Party equality (case-insensitive). */
function sameParty(a, b)   { return partyKey(a) === partyKey(b); }

/** Generate a locally-unique ID for cartons. */
function uid() { return Date.now() + "_" + Math.random().toString(16).slice(2); }

/** Parse a date string; return null if invalid. */
function parseMaybeDate(x) {
  const raw = String(x || "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a date for display. */
function fmtDate(x, withTime = false) {
  const d = parseMaybeDate(x);
  if (!d) return x ? String(x) : "-";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  const date = `${dd}/${mm}/${yy}`;
  if (!withTime) return date;
  let h  = d.getHours();
  const m  = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${date} ${h}:${m} ${ap}`;
}

/** Timestamp for sort-latest-first comparisons. */
function latestFirstValue(x) {
  const d = parseMaybeDate(x);
  return d ? d.getTime() : 0;
}

/** Escape HTML special characters — all template literals must use this. */
function esc(v)  { return String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
/** Escape for HTML attribute values that may appear inside single-quote strings. */
function attr(v) { return esc(v).replace(/'/g, "&#39;"); }

/** Read a DOM input value by id, returning "" if missing. */
function val(id) { return document.getElementById(id)?.value || ""; }
/** Focus a DOM element by id (no-op if missing). */
function focusId(id) { document.getElementById(id)?.focus(); }
function focusFirstPackChip() {
  const selected = document.querySelector(".pmf-part-chip.pmf-chip-active");
  const first = document.querySelector(".pmf-part-chip:not([disabled])");
  const target = selected || first || document.getElementById("packQty");
  if (target) { target.focus(); if (target.scrollIntoView) target.scrollIntoView({ block: "center", inline: "nearest" }); }
}
/** Return the #screenArea element. */
function screen() { return document.getElementById("screenArea"); }

/* ══════════════════════════════════════════════════════════════
   8. DOMAIN LOGIC  (business rules, no DOM)
   ══════════════════════════════════════════════════════════════ */

/**
 * Determine whether a QC check has been completed for a carton.
 * PASS / RECHECK / QC_DONE all count as done.
 */
function isQCDone(c) {
  const st = normStatus(c.status);
  return st === "PASS" || st === "RECHECK" || st === "QC_DONE"
    || (Number(c.actual_weight || 0) > 0 && st !== "PENDING_QC");
}

/** Return the uid of an order (handles legacy id field). */
function getOrderUid(o) { return String(o?.order_uid || o?.id || ""); }

/**
 * True if carton c belongs to order o.
 * Primary match: order_no. Secondary: order_uid when both are present.
 * Safety: party cross-check guards against order_no reuse after deletion.
 */
function cartonBelongsToOrder(c, o) {
  if (!c || !o) return false;
  if (c.deleted || c._deleted) return false;
  if (!sameOrderNo(c.order_no, o.order_no)) return false;
  const ou = getOrderUid(o);
  const cu = String(c.order_uid || c.order_id || "");
  if (ou && cu) return ou === cu;
  if (c.party && o.party && !sameParty(c.party, o.party)) return false;
  return true;
}

/** Return all cartons that belong to order o. */
function validCartonsForOrder(o) {
  return state.cartons.filter(c => cartonBelongsToOrder(c, o));
}

/** Deduplicate a list of cartons by id. */
function dedupeCartonsById(list) {
  const map = new Map();
  list.forEach(c => {
    const key = String(c.id || `${c.order_uid || ""}|${c.order_no}|${c.carton_no}|${c.created_at || ""}`);
    if (!map.has(key)) map.set(key, c);
  });
  return [...map.values()];
}

/** Find order by order_no. */
function getOrder(no) { return state.orders.find(o => sameOrderNo(o.order_no, no)) || null; }
/** Selected order in packing screen. */
function selectedOrder() { return getOrder(state.selectedOrderNo); }

/** Next order number (zero-padded, sequential). */
function nextOrderNo() {
  const nums = state.orders.map(o => Number(o.order_no) || 0);
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, "0");
}

/** Qty of item[i] already packed in confirmed cartons for order o. */
function packedQty(o, i) {
  return dedupeCartonsById(validCartonsForOrder(o))
    .flatMap(c => Array.isArray(c.items) ? c.items : [])
    .filter(x => Number(x.order_item_index) === Number(i))
    .reduce((s, x) => s + Math.max(0, Number(x.qty) || 0), 0);
}

/** Qty of item[i] in the current in-progress carton draft. */
function draftQty(i) {
  return state.cartonDraft
    .filter(x => Number(x.order_item_index) === Number(i))
    .reduce((s, x) => s + Math.max(0, Number(x.qty) || 0), 0);
}

/** Remaining qty to pack for item[i] of order o. */
function balanceQty(o, i) {
  const ordered = Number((o.items || [])[i]?.qty) || 0;
  return Math.max(0, ordered - packedQty(o, i) - draftQty(i));
}

/**
 * Remove cartons whose parent order no longer exists.
 * Returns true if anything was removed.
 */
function purgeOrphanCartons() {
  const orderNos = new Set(state.orders.map(o => String(o.order_no)));
  const before   = state.cartons.length;
  state.cartons  = state.cartons.filter(c => orderNos.has(String(c.order_no)));
  return state.cartons.length < before;
}

/**
 * Recompute and update order.status to COMPLETE if all items packed and all QC done.
 * Reverts to DRAFT if over-packed items are corrected.
 */
function updateOrderCompletion(orderNo, silent = false) {
  const o = getOrder(orderNo);
  if (!o) return;
  const cs       = validCartonsForOrder(o);
  const allPacked = (o.items || []).length > 0
    && o.items.every((_, i) => packedQty(o, i) >= Number(o.items[i]?.qty || 0));
  const allQC     = cs.length > 0 && cs.every(c => isQCDone(c));
  if (allPacked && allQC && o.status !== "COMPLETE") {
    o.status = "COMPLETE";
    if (!silent) toast("Order Complete: " + o.order_no);
  } else if (!allPacked && o.status === "COMPLETE") {
    o.status = "DRAFT";
  }
}

/** Compute dashboard stats without touching the DOM. */
function _computeStats() {
  const total          = state.orders.length;
  const pendingPacking = state.orders.filter(o => {
    if (o.status === "COMPLETE") return false;
    const cs = validCartonsForOrder(o);
    return (o.items || []).some((it, i) => {
      const packed = cs.flatMap(c => Array.isArray(c.items) ? c.items : [])
        .filter(x => Number(x.order_item_index) === i)
        .reduce((s, x) => s + Number(x.qty), 0);
      return packed < Number(it.qty || 0);
    });
  }).length;
  const pendingQC = state.orders.reduce((sum, o) =>
    sum + validCartonsForOrder(o).filter(c => normStatus(c.status) === "PENDING_QC").length, 0);
  const complete = state.orders.filter(o => o.status === "COMPLETE").length;
  return { total, pendingPacking, pendingQC, complete };
}

/* ══════════════════════════════════════════════════════════════
   9. AUTH
   ══════════════════════════════════════════════════════════════ */

function renderLogin() {
  app.innerHTML = `
    <div class="login-card">
      <img src="assets/logo.jpeg" class="logo" onerror="this.style.display='none'">
      <p class="muted">Ceradrive Packing &amp; QC — v8.5.3</p>
      <p class="login-role-hint">Select your role then enter password</p>
      <div class="quick-login-grid">
        <button class="quick-role-btn" onclick="prefillUser('packing')">📦<br><span>PACKING</span></button>
        <button class="quick-role-btn" onclick="prefillUser('qc')">✅<br><span>QC</span></button>
        <button class="quick-role-btn" onclick="prefillUser('manager')">📋<br><span>MANAGER</span></button>
        <button class="quick-role-btn quick-role-admin" onclick="prefillUser('admin')">🔑<br><span>ADMIN</span></button>
      </div>
      <div class="login-divider"><span>or type credentials below</span></div>
      <input id="loginUser" placeholder="Username" autocomplete="username"
        onkeydown="if(event.key==='Enter'){event.preventDefault();focusId('loginPass')}">
      <input id="loginPass" type="password" placeholder="Password" autocomplete="current-password"
        onkeydown="if(event.key==='Enter') login()" style="margin-top:10px">
      <label class="checkbox-row" style="margin-top:14px">
        <input id="rememberMe" type="checkbox"> Remember me on this device
      </label>
      <button class="wide-btn" onclick="login()" style="margin-top:12px">LOGIN</button>
    </div>`;
}

/** Pre-fill username field and move focus to password. */
function prefillUser(username) {
  const uEl = document.getElementById("loginUser");
  if (uEl) uEl.value = username;
  document.querySelectorAll(".quick-role-btn").forEach(b => {
    b.classList.toggle("quick-role-active", b.getAttribute("onclick") === `prefillUser('${username}')`);
  });
  setTimeout(() => focusId("loginPass"), 50);
}

/** Alias kept for backward compat (old onclick strings). */
function quickLogin(username) { prefillUser(username); }

async function login() {
  const u    = val("loginUser").trim();
  const p    = val("loginPass");
  if (!u) return toast("Select a role or enter username");
  if (!p) return toast("Enter your password");
  const user = USERS.find(x => x.username === u && x.password === p);
  if (!user) return toast("Wrong username or password");

  state.user = user;
  if (document.getElementById("rememberMe")?.checked) {
    localStorage.setItem(STORAGE.REMEMBER_USER, user.username);
  } else {
    localStorage.removeItem(STORAGE.REMEMBER_USER);
  }

  showCenterOverlay("Loading...");
  await loadAll();
  hideCenterOverlay();
  state.screen = "HOME";
  renderApp();
  startAutoRefresh();
}

function logout() {
  stopAutoRefresh();
  localStorage.removeItem(STORAGE.REMEMBER_USER);
  state.user = null;
  renderLogin();
}

/* ══════════════════════════════════════════════════════════════
   10. ROUTER
   ══════════════════════════════════════════════════════════════ */

/** Tabs available to each role. */
function tabs() {
  const r = state.user?.role;
  if (r === "ADMIN" || r === "MANAGER") return ["ORDER", "PACKING", "QC", "STICKERS", "HISTORY", "SKU MASTER", "LOG"];
  if (r === "PACKING")                  return ["PACKING", "HISTORY", "LOG"];
  if (r === "QC")                       return ["ORDER", "QC", "STICKERS", "HISTORY", "LOG"];
  return ["LOG"];
}

function canAccess(s) { return tabs().includes(s); }

function go(s) {
  if (!canAccess(s)) { toast("Access denied"); return; }
  closeMoreMenu();
  state.screen = s;
  renderApp();
  // Keep the selected page visible immediately after tapping More-menu items.
  requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
}

function tabIcon(t) {
  const icons = { ORDER: "📋", PACKING: "📦", QC: "✅", STICKERS: "🏷️", HISTORY: "📜", "SKU MASTER": "🗄️", LOG: "📝", HOME: "🏠" };
  return `<span class="tab-icon">${icons[t] || ""}</span>`;
}

function renderApp() {
  if (!state.user) { renderLogin(); return; }
  const t = tabs();
  if (state.screen === "HOME" || !t.includes(state.screen)) state.screen = t[0];

  const stats = _computeStats();
  app.innerHTML = `
    <div class="app-shell no-print">
      <div class="brand-bar">
        <img src="assets/logo.jpeg" class="brand-logo" onerror="this.style.display='none'">
        <div class="brand-info">
          <span class="brand-name">Ceradrive Brakes</span>
          <span class="brand-sub">Packing &amp; QC v8.5.3</span>
        </div>
        <div class="brand-right">
          <div id="refreshIndicator" class="refresh-dot" title="Auto-sync active"></div>
          <div id="offlineIndicator" class="offline-pill" style="display:${getOfflineQueue().length ? "flex" : "none"}">⚠ Offline</div>
          <span class="role-chip">${state.user.role}</span>
          <button class="logout-pill" onclick="logout()">⏻ Logout</button>
        </div>
      </div>
      <div class="dash-stats-bar">
        <div class="dash-stat"><span class="dash-stat-icon">📋</span><div><div class="dash-stat-val">${stats.total}</div><div class="dash-stat-lbl">Orders</div></div></div>
        <div class="dash-stat"><span class="dash-stat-icon">📦</span><div><div class="dash-stat-val">${stats.pendingPacking}</div><div class="dash-stat-lbl">Pending Packing</div></div></div>
        <div class="dash-stat"><span class="dash-stat-icon">⏳</span><div><div class="dash-stat-val">${stats.pendingQC}</div><div class="dash-stat-lbl">Pending QC</div></div></div>
        <div class="dash-stat dash-stat-green"><span class="dash-stat-icon">✅</span><div><div class="dash-stat-val">${stats.complete}</div><div class="dash-stat-lbl">Complete</div></div></div>
      </div>
      <nav class="tab-bar" id="mainTabBar">
        ${t.slice(0, 5).map(x => `<button class="tab-btn ${state.screen === x ? "active" : ""}" onclick="go('${x}')">${tabIcon(x)}<span>${x}</span></button>`).join("")}
        ${t.length > 5 ? `
        <div class="tab-more-wrap">
          <button class="tab-btn ${t.slice(5).includes(state.screen) ? "active" : ""}" onclick="toggleMoreMenu()" id="moreTabBtn">
            <span class="tab-icon">⋯</span><span>More</span>
          </button>
          <div class="tab-more-menu" id="moreMenu">
            ${t.slice(5).map(x => `<button class="more-menu-item ${state.screen === x ? "active" : ""}" onclick="go('${x}');closeMoreMenu()">${tabIcon(x)}<span>${x}</span></button>`).join("")}
          </div>
        </div>` : ""}
      </nav>
    </div>
    <div id="screenArea" class="screen-area"></div>`;
  renderScreen();
}

function renderScreen() {
  if (!canAccess(state.screen)) { const t = tabs(); state.screen = t[0] || "LOG"; }
  if (state.screen === "ORDER")       return renderOrder();
  if (state.screen === "PACKING")     return renderPacking();
  if (state.screen === "QC")          return renderQC();
  if (state.screen === "SKU MASTER")  return renderSkuMaster();
  if (state.screen === "STICKERS")    return renderStickers();
  if (state.screen === "HISTORY")     return renderHistory();
  if (state.screen === "LOG")         return renderLog();
}

function toggleMoreMenu() {
  const menu = document.getElementById("moreMenu");
  const btn  = document.getElementById("moreTabBtn");
  if (!menu || !btn) return;

  const willOpen = !menu.classList.contains("open");
  if (!willOpen) { closeMoreMenu(); return; }

  // Use fixed positioning so the menu is never clipped by the horizontal tab bar
  // and stays visible on phone screens without the user scrolling up/down.
  const rect = btn.getBoundingClientRect();
  const menuWidth = Math.min(190, window.innerWidth - 16);
  const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
  const top  = Math.min(window.innerHeight - 12, rect.bottom + 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.right = "auto";
  menu.style.minWidth = `${menuWidth}px`;
  menu.classList.add("open");
}
function closeMoreMenu() {
  const menu = document.getElementById("moreMenu");
  if (!menu) return;
  menu.classList.remove("open");
  menu.style.left = "";
  menu.style.top = "";
}

/* ══════════════════════════════════════════════════════════════
   11. ORDER SCREEN
   ══════════════════════════════════════════════════════════════ */

function renderOrder() {
  screen().innerHTML = `
  <div class="card">
    <div class="card-header"><h2>New Order</h2><p class="muted-sm">Party → SKU → Qty → Add</p></div>
    <div class="form-grid">
      <div class="form-group full">
        <label class="field-label">Party Name</label>
        <input id="party" placeholder="Enter party name" value="${esc(_currentParty)}"
          onkeydown="if(event.key==='Enter') focusId('skuSearch')">
      </div>
      <div class="form-group full">
        <label class="field-label">Search SKU / Vehicle</label>
        <input id="skuSearch" placeholder="Type part no or vehicle model…" autocomplete="off"
          oninput="showSkuResults()" onkeydown="skuEnter(event)">
        <div id="skuResults"></div>
        <div id="selectedSku"></div>
      </div>
      <div class="form-group half">
        <label class="field-label">Quantity</label>
        <input id="qty" type="number" placeholder="0" onkeydown="if(event.key==='Enter') addOrderItem()">
      </div>
      <div class="form-group half form-btn-align">
        <button onclick="addOrderItem()" class="primary-btn">+ Add Item</button>
      </div>
    </div>
    <details class="import-details">
      <summary class="import-summary">📥 Import from Excel</summary>
      <div class="import-body">
        <p class="muted-sm">Columns: Party Name · Part No · Qty</p>
        <input type="file" accept=".xlsx,.xls,.csv" onchange="importOrdersExcel(event)">
      </div>
    </details>
  </div>
  <div id="orderDraftBox"></div>
  <div class="card action-card"><button class="green wide-btn" onclick="saveOrder()">💾 Save Order</button></div>
  <div class="card"><div class="card-header"><h2>Saved Orders</h2></div>${ordersListHTML()}</div>`;
  renderOrderDraft();
  setTimeout(() => focusId(_currentParty ? "skuSearch" : "party"), 50);
}

function showSkuResults() {
  const q   = val("skuSearch").toLowerCase().trim();
  const box = document.getElementById("skuResults");
  state.selectedSku = null;
  if (!q) { box.innerHTML = ""; document.getElementById("selectedSku").innerHTML = ""; return; }
  const list = state.skus
    .filter(s => Number(s.active ?? 1) !== 0
      && (String(s.part_no).toLowerCase().includes(q) || String(s.vehicle || "").toLowerCase().includes(q)))
    .slice(0, 10);
  box.innerHTML = list.map(s =>
    `<div class="result-item" onclick="selectSku('${attr(s.part_no)}')">
       <span><b>${esc(s.part_no)}</b> — ${esc(s.vehicle || "")}</span>
       <span>${Number(s.weight || 0).toFixed(2)} kg</span>
     </div>`).join("");
}

function skuEnter(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = val("skuSearch").toLowerCase().trim();
  const m = state.skus.find(s => Number(s.active ?? 1) !== 0
    && (String(s.part_no).toLowerCase().includes(q) || String(s.vehicle || "").toLowerCase().includes(q)));
  if (!m) return toast("SKU Not Found");
  selectSku(m.part_no);
}

function selectSku(partNo) {
  const s = state.skus.find(x => String(x.part_no) === String(partNo));
  if (!s) return;
  state.selectedSku = s;
  document.getElementById("skuSearch").value  = `${s.part_no} — ${s.vehicle || ""}`;
  document.getElementById("skuResults").innerHTML = "";
  document.getElementById("selectedSku").innerHTML =
    `<div class="info-box"><b>${esc(s.part_no)}</b> — ${esc(s.vehicle || "")}<br>Weight: ${Number(s.weight || 0).toFixed(2)} kg</div>`;
  focusId("qty");
}

function addOrderItem() {
  const party = val("party").trim();
  _currentParty = party;
  if (!party)              return toast("Party Name required");
  if (!state.selectedSku) return toast("Select SKU");
  const qty = Number(val("qty"));
  if (!qty)                return toast("Enter Qty");
  _addDraftItem(state.selectedSku, qty);
  state.selectedSku = null;
  document.getElementById("skuSearch").value  = "";
  document.getElementById("qty").value         = "";
  document.getElementById("selectedSku").innerHTML = "";
  renderOrderDraft();
  focusId("skuSearch");
}

function _addDraftItem(s, qty) {
  const existing = state.orderDraft.find(i => String(i.part_no).toLowerCase() === String(s.part_no).toLowerCase());
  if (existing) existing.qty += qty;
  else state.orderDraft.push({ part_no: s.part_no, vehicle: s.vehicle || "", qty, weight: Number(s.weight || 0) });
}

/** Kept as alias so importOrdersExcel can use it. */
function addDraftItem(s, qty) { _addDraftItem(s, qty); }

async function importOrdersExcel(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  const data = await file.arrayBuffer();
  showImportProgress("Reading file...", 0);
  await _nextTick();
  const wb   = XLSX.read(data);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  let party = "";
  const missing = [], newItems = [], dups = [];
  for (let i = 0; i < rows.length; i++) {
    const r    = rows[i];
    const p    = String(r["Party Name"] || r["Party"] || r["party"] || "").trim();
    const part = String(r["Part No"] || r["part_no"] || r["SKU"] || "").trim();
    const qty  = Number(r["Qty"] || r["qty"] || 0);
    if (p) party = p;
    if (!part || !qty) { updateImportProgress(Math.round(((i + 1) / rows.length) * 80)); continue; }
    const sku = state.skus.find(s => String(s.part_no).toLowerCase() === part.toLowerCase());
    if (!sku) { missing.push(`Row ${i + 2}: ${part}`); }
    else {
      const existing = state.orderDraft.find(x => String(x.part_no).toLowerCase() === String(sku.part_no).toLowerCase());
      if (existing) dups.push({ sku, qty, existing });
      else newItems.push({ sku, qty });
    }
    if (i % 10 === 0) { updateImportProgress(Math.round(((i + 1) / rows.length) * 80)); await _nextTick(); }
  }
  updateImportProgress(85);
  if (dups.length) {
    hideImportProgress();
    const choice = await showImportDuplicateModal(dups.length, "order items");
    showImportProgress("Applying...", 90);
    await _nextTick();
    if (choice === "override") dups.forEach(({ qty, existing }) => { existing.qty = qty; });
    else if (choice === "add") dups.forEach(({ qty, existing }) => { existing.qty += qty; });
  }
  newItems.forEach(({ sku, qty }) => _addDraftItem(sku, qty));
  if (party) { const pel = document.getElementById("party"); if (pel) pel.value = party; _currentParty = party; }
  updateImportProgress(100);
  await new Promise(r => setTimeout(r, 400));
  hideImportProgress();
  renderOrderDraft();
  const dupMsg  = dups.length ? `, Duplicates handled: ${dups.length}` : "";
  const missMsg = missing.length ? `\nNot found: ${missing.join(", ")}` : "";
  toast(`Import complete. New: ${newItems.length}${dupMsg}${missMsg}`);
}

function renderOrderDraft() {
  const box = document.getElementById("orderDraftBox");
  if (!box) return;
  if (!state.orderDraft.length) {
    box.innerHTML = `<div class="card draft-empty"><span class="draft-empty-icon">🛒</span><span class="draft-empty-text">No items added yet</span></div>`;
    return;
  }
  const tq = state.orderDraft.reduce((s, it) => s + Number(it.qty), 0);
  const tw = state.orderDraft.reduce((s, it) => s + Number(it.qty) * Number(it.weight), 0);
  box.innerHTML = `<div class="card draft-card">
    <div class="draft-card-header">
      <div class="draft-header-left"><h2>Order Draft</h2><span class="draft-count-pill">${state.orderDraft.length} SKU</span></div>
      <div class="draft-totals"><span class="draft-total-chip">${tq} pcs</span><span class="draft-total-chip">${tw.toFixed(2)} kg</span></div>
    </div>
    <div class="draft-table-wrap">
      <table class="draft-table">
        <thead><tr>
          <th class="dt-th-part">Part No</th><th class="dt-th-vehicle">Vehicle</th>
          <th class="dt-th-qty">Qty</th><th class="dt-th-wt">Wt</th><th class="dt-th-del"></th>
        </tr></thead>
        <tbody>
          ${state.orderDraft.map((it, i) => `
          <tr class="dt-row">
            <td class="dt-part">${esc(it.part_no)}</td>
            <td class="dt-vehicle">${esc(it.vehicle)}</td>
            <td class="dt-qty">
              <input class="dt-qty-input" type="number" min="1" step="1" inputmode="numeric"
                value="${Number(it.qty) || 0}"
                onchange="updateDraftQty(${i},this.value)"
                oninput="updateDraftQtySilent(${i},this.value)"
                onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">
            </td>
            <td class="dt-wt">${(Number(it.qty) * Number(it.weight)).toFixed(1)}</td>
            <td class="dt-del"><button class="dt-del-btn" onclick="deleteDraftItem(${i})">✕</button></td>
          </tr>`).join("")}
        </tbody>
        <tfoot><tr class="dt-foot">
          <td colspan="2" class="dt-foot-label">Total</td>
          <td class="dt-foot-qty">${tq}</td>
          <td class="dt-foot-wt">${tw.toFixed(1)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>
  </div>`;
}

function updateDraftQtySilent(i, v) {
  const qty = Number(v);
  if (!state.orderDraft[i] || !qty || qty < 1) return;
  state.orderDraft[i].qty = qty;
}
function updateDraftQty(i, v) {
  const qty = Number(v);
  if (!state.orderDraft[i]) return;
  if (!qty || qty < 1) { toast("Enter valid Qty"); renderOrderDraft(); return; }
  state.orderDraft[i].qty = qty;
  renderOrderDraft();
}
function deleteDraftItem(i) { state.orderDraft.splice(i, 1); renderOrderDraft(); }

/** Workflow badge HTML for an order. */
function workflowBadge(o) {
  const ws   = o.workflow_status || "DRAFT";
  const done = o.status === "COMPLETE";
  if (done)                return `<span class="wf-badge wf-complete">✓ Complete</span>`;
  if (ws === "PACKING")    return `<span class="wf-badge wf-packing">📦 Packing</span>`;
  if (ws === "READY_TO_PACK") return `<span class="wf-badge wf-ready">🚀 In Packing</span>`;
  if (ws === "PENDING_QC") return `<span class="wf-badge wf-qc">⏳ QC</span>`;
  return                         `<span class="wf-badge wf-draft">📋 Draft</span>`;
}

function canSendToPacking(o) {
  const ws = o.workflow_status || "DRAFT";
  return (state.user.role === "ADMIN" || state.user.role === "MANAGER")
    && ws === "DRAFT" && o.status !== "COMPLETE";
}
function canRecallFromPacking(o) {
  const ws = o.workflow_status || "DRAFT";
  return (state.user.role === "ADMIN" || state.user.role === "MANAGER")
    && (ws === "READY_TO_PACK" || ws === "PACKING") && o.status !== "COMPLETE";
}

function ordersListHTML() {
  if (!state.orders.length) return `<div class="empty-state">No saved orders yet.</div>`;
  return `<table class="orders-table">
    <thead><tr>
      <th class="ot-no">Order</th><th class="ot-party">Party</th>
      <th class="ot-meta">SKU / Pcs</th><th class="ot-status">Status</th><th class="ot-del"></th>
    </tr></thead>
    <tbody>${state.orders.slice().reverse().map(o => {
      const totalQty = (o.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
      return `<tr class="ot-row ${o.status === "COMPLETE" ? "ot-done" : ""}" onclick="openOrder('${o.order_no}')">
        <td class="ot-no-val"><b>#${esc(o.order_no)}</b><div class="ot-date">${esc(fmtDate(o.created_at))}</div></td>
        <td class="ot-party-val">${esc(o.party)}</td>
        <td class="ot-meta-val">${o.items.length} / ${totalQty}</td>
        <td class="ot-status-val">${workflowBadge(o)}</td>
        <td class="ot-del-val" onclick="event.stopPropagation()">
          <button class="skt-btn skt-del" onclick="deleteOrder('${o.order_no}')">🗑</button>
        </td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
}

function openOrder(orderNo) {
  const o = getOrder(orderNo);
  if (!o) return;
  const totalQty = (o.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
  const totalWt  = (o.items || []).reduce((s, i) => s + Number(i.qty || 0) * Number(i.weight || 0), 0);
  const canEdit  = state.user && (state.user.role === "ADMIN" || state.user.role === "MANAGER");
  const editAllowed = canEdit && o.status !== "COMPLETE";
  screen().innerHTML = `
  <div class="card">
    <div class="oo-header">
      <button class="secondary small" onclick="renderOrder()">← Back</button>
      <div style="flex:1;min-width:0">
        <div class="oo-order-no">Order #${esc(o.order_no)}</div>
        <div class="oo-party">${esc(o.party)}</div>
      </div>
      ${workflowBadge(o)}
    </div>
    <div class="oo-summary">
      <div class="oo-sum-box"><span>${o.items.length}</span><small>SKUs</small></div>
      <div class="oo-sum-box"><span>${totalQty}</span><small>Pcs</small></div>
      <div class="oo-sum-box"><span>${totalWt.toFixed(1)}</span><small>kg</small></div>
    </div>
    <div class="oo-actions-row">
      ${canSendToPacking(o)     ? `<button class="green wide-btn" onclick="sendToPacking('${o.order_no}')">🚀 Send to Packing</button>` : ""}
      ${canRecallFromPacking(o) ? `<button class="secondary wide-btn" onclick="recallFromPacking('${o.order_no}')">↩ Recall from Packing</button>` : ""}
      ${editAllowed             ? `<button class="secondary wide-btn oo-edit-btn" onclick="editOrder('${o.order_no}')">✏️ Edit Order</button>` : ""}
    </div>
    <div class="draft-table-wrap" style="margin-top:8px">
      <table class="draft-table">
        <thead><tr>
          <th style="width:22px">#</th><th class="dt-th-part">Part No</th>
          <th class="dt-th-vehicle">Vehicle</th><th class="dt-th-qty">Qty</th><th class="dt-th-wt">kg</th>
        </tr></thead>
        <tbody>
          ${(o.items || []).map((it, idx) => `
          <tr class="dt-row">
            <td class="dt-num">${idx + 1}</td>
            <td class="dt-part">${esc(it.part_no)}</td>
            <td class="dt-vehicle">${esc(it.vehicle || "")}</td>
            <td class="dt-qty-val">${it.qty}</td>
            <td class="dt-wt">${(Number(it.qty) * Number(it.weight || 0)).toFixed(1)}</td>
          </tr>`).join("")}
        </tbody>
        <tfoot><tr class="dt-foot">
          <td colspan="3" class="dt-foot-label">Total</td>
          <td class="dt-foot-qty">${totalQty}</td>
          <td class="dt-foot-wt">${totalWt.toFixed(1)}</td>
        </tr></tfoot>
      </table>
    </div>
  </div>`;
}

function editOrder(orderNo) {
  const o = getOrder(orderNo);
  if (!o) return;
  const ws         = o.workflow_status || "DRAFT";
  const midPacking = (ws === "PACKING" || ws === "READY_TO_PACK") && validCartonsForOrder(o).length > 0;
  if (midPacking && !confirm(
    `⚠ Order #${orderNo} is currently in PACKING with ${validCartonsForOrder(o).length} carton(s) already packed.\n\nEditing the order (changing items or qty) may cause balance mismatches.\n\nExisting packed cartons are preserved — only order items change.\n\nProceed with editing?`
  )) return;
  state.orderDraft  = o.items.map(x => ({ ...x }));
  _currentParty     = o.party;
  _editingOrderNo   = orderNo;
  screen().innerHTML = `
  <div class="card">
    <div class="oo-header">
      <button class="secondary small" onclick="cancelEditOrder()">← Cancel</button>
      <div style="flex:1;min-width:0">
        <div class="oo-order-no" style="color:var(--orange)">✏️ Editing Order #${esc(o.order_no)}</div>
        <div class="oo-party">${esc(o.party)}</div>
      </div>
      <span class="badge" style="background:var(--orange-lt);color:var(--orange)">EDIT MODE</span>
    </div>
    <div class="edit-order-warn">⚠ Changes update the order. Existing packed cartons are preserved.</div>
  </div>
  <div class="card">
    <div class="card-header"><h2>Edit Order Details</h2></div>
    <div class="form-grid">
      <div class="form-group full">
        <label class="field-label">Party Name</label>
        <input id="party" value="${esc(o.party)}" placeholder="Party name"
          onkeydown="if(event.key==='Enter') focusId('skuSearch')">
      </div>
      <div class="form-group full">
        <label class="field-label">Search &amp; Add SKU</label>
        <input id="skuSearch" placeholder="Type part no or vehicle…"
          oninput="showSkuResults()" onkeydown="skuEnter(event)" autocomplete="off">
        <div id="skuResults"></div>
        <div id="selectedSku"></div>
      </div>
      <div class="form-group half">
        <label class="field-label">Quantity</label>
        <input id="qty" type="number" placeholder="0" onkeydown="if(event.key==='Enter') addOrderItem()">
      </div>
      <div class="form-group half form-btn-align">
        <button onclick="addOrderItem()" class="primary-btn">+ Add Item</button>
      </div>
    </div>
  </div>
  <div id="orderDraftBox"></div>
  <div class="card action-card">
    <button class="green wide-btn" onclick="updateOrder()">💾 Save Changes</button>
    <button class="secondary wide-btn" style="margin-top:8px" onclick="cancelEditOrder()">✕ Cancel</button>
  </div>`;
  renderOrderDraft();
  setTimeout(() => focusId("party"), 50);
}

function cancelEditOrder() {
  const no       = _editingOrderNo;
  _editingOrderNo = null;
  state.orderDraft = [];
  _currentParty    = "";
  if (no) openOrder(no);
  else renderOrder();
}

async function updateOrder() {
  const orderNo = _editingOrderNo;
  if (!orderNo) return toast("No order being edited");
  const o = getOrder(orderNo);
  if (!o) return toast("Order not found");
  const party = val("party").trim();
  if (!party)                  return toast("Party Name required");
  if (!state.orderDraft.length) return toast("Add at least one item");

  // Warn if new qty is less than already-packed qty
  const cartons  = validCartonsForOrder(o);
  const warnings = [];
  state.orderDraft.forEach(ni => {
    const packed = cartons.flatMap(c => c.items || [])
      .filter(ci => String(ci.part_no).toLowerCase() === String(ni.part_no).toLowerCase())
      .reduce((s, ci) => s + Number(ci.qty || 0), 0);
    if (packed > Number(ni.qty)) warnings.push(`${ni.part_no}: ordered ${ni.qty} but ${packed} already packed`);
  });
  if (warnings.length && !confirm(`Warning — packed qty exceeds new order qty:\n\n${warnings.join("\n")}\n\nSave anyway?`)) return;

  o.party      = party;
  o.items      = state.orderDraft.map(x => ({ ...x }));
  o.updated_at = new Date().toISOString();
  cartons.forEach(c => { c.party = party; });
  _editingOrderNo  = null;
  state.orderDraft = [];
  _currentParty    = "";
  saveState();
  try {
    await apiPost(API.orders,  { orders:  state.orders  });
    if (cartons.length) await apiPost(API.cartons, { cartons: state.cartons });
    uiToast(`Order #${orderNo} updated ✓`);
  } catch {
    enqueueOffline("orders");
    if (cartons.length) enqueueOffline("cartons");
    toast("Saved locally — will sync when online");
  }
  openOrder(orderNo);
}

async function saveOrder() {
  const party = val("party").trim();
  if (!party)                  return toast("Party Name required");
  if (!state.orderDraft.length) return toast("Add at least one item");
  const o = {
    order_uid:       uid(),
    order_no:        nextOrderNo(),
    party,
    items:           state.orderDraft.map(x => ({ ...x })),
    created_at:      new Date().toISOString(),
    status:          "DRAFT",
    workflow_status: "DRAFT",
  };
  state.orders.push(o);
  state.orderDraft = [];
  _currentParty    = "";
  try { await saveOrders(); uiToast("Order Saved: " + o.order_no); renderOrder(); }
  catch (e) { toast("Save failed: " + e.message); }
}

async function sendToPacking(orderNo) {
  const o = getOrder(orderNo);
  if (!o) return;
  if (o.workflow_status === "READY_TO_PACK" || o.workflow_status === "PACKING") {
    toast("Already sent to Packing"); return;
  }
  o.workflow_status = "READY_TO_PACK";
  saveState();
  try {
    await apiPost(API.orders, { orders: state.orders });
    uiToast(`Order #${orderNo} sent to Packing ✓`);
    renderOrder();
  } catch {
    enqueueOffline("orders");
    toast("Sent locally — will sync when online");
    renderOrder();
  }
}

async function recallFromPacking(orderNo) {
  const o = getOrder(orderNo);
  if (!o) return;
  if (!confirm(`Recall Order #${orderNo} from Packing?\nAny saved carton drafts for this order will remain.`)) return;
  o.workflow_status = "DRAFT";
  saveState();
  try {
    await apiPost(API.orders, { orders: state.orders });
    toast(`Order #${orderNo} recalled from Packing`);
    renderOrder();
  } catch { enqueueOffline("orders"); renderOrder(); }
}

async function deleteOrder(orderNo) {
  if (!confirm("Delete Order " + orderNo + "?")) return;
  const o = getOrder(orderNo);
  const deleteCartonIds = o ? state.cartons.filter(c => cartonBelongsToOrder(c, o)).map(c => c.id) : [];
  state.orders  = state.orders.filter(x => !sameOrderNo(x.order_no, orderNo));
  if (o) state.cartons = state.cartons.filter(c => !cartonBelongsToOrder(c, o));
  purgeOrphanCartons();
  saveState();
  try {
    await apiPost(API.cartons, { cartons: state.cartons, delete_ids: deleteCartonIds });
    await apiPost(API.orders,  { orders:  state.orders,  delete_order_nos: [orderNo] });
  } catch (e) { toast("Deleted locally — server sync failed: " + e.message); }
  renderOrder();
}

/* ══════════════════════════════════════════════════════════════
   12. PACKING SCREEN
   ══════════════════════════════════════════════════════════════ */

function selectPackOrder(no) {
  state.selectedOrderNo = no;
  state.cartonDraft     = [];
  _selectedPackIdx      = undefined;
  const o = getOrder(no);
  if (o) {
    const sentNos  = validCartonsForOrder(o).map(c => Number(c.carton_no)).filter(n => !isNaN(n));
    const maxSent  = sentNos.length ? Math.max(...sentNos) : 0;
    _nextCartonNo  = String(maxSent + 1);
  } else {
    _nextCartonNo = "1";
  }
  renderPacking();
}

function renderPacking() {
  const packable = state.orders.filter(o => {
    const ws = o.workflow_status || "DRAFT";
    return (ws === "READY_TO_PACK" || ws === "PACKING")
      && o.status !== "COMPLETE"
      && (o.items || []).some((it, i) => packedQty(o, i) < Number(it.qty));
  });
  packable.forEach(o => updateOrderCompletion(o.order_no, true));
  if (packable.length === 1 && !state.selectedOrderNo) state.selectedOrderNo = packable[0].order_no;

  // Mark selected order as PACKING
  if (state.selectedOrderNo) {
    const sel = getOrder(state.selectedOrderNo);
    if (sel && sel.workflow_status === "READY_TO_PACK") {
      sel.workflow_status = "PACKING";
      saveState();
    }
  }

  const allItems   = packable.flatMap(o => o.items || []);
  const totalSets  = allItems.reduce((s, it) => s + Number(it.qty || 0), 0);
  const uniqueSKUs = new Set(allItems.map(it => String(it.part_no).toUpperCase())).size;

  const statusCard = packable.length ? `<div class="packing-status-card">
    <span class="psc-label">PACKING STATUS</span>
    <div class="psc-stats">
      <div class="psc-stat"><span class="psc-val">${totalSets}</span><span class="psc-unit">Total Sets</span></div>
      <div class="psc-divider"></div>
      <div class="psc-stat"><span class="psc-val">${uniqueSKUs}</span><span class="psc-unit">SKU Types</span></div>
      <div class="psc-divider"></div>
      <div class="psc-stat"><span class="psc-val">${packable.length}</span><span class="psc-unit">Orders</span></div>
    </div>
  </div>` : "";

  let pickerHTML;
  if (!packable.length) {
    pickerHTML = `<div class="packing-empty-state">
      <div class="pes-icon">📋</div>
      <div class="pes-title">No orders in Packing queue</div>
      <div class="pes-sub">Go to <b>Orders</b> page and tap <b>🚀 Send to Packing</b> on an order.</div>
    </div>`;
  } else if (packable.length === 1) {
    pickerHTML = _packingOrderCard(packable[0]);
  } else {
    pickerHTML = `<div class="poc-picker-label">Select Order to Pack</div>${packable.map(o => _packingOrderCard(o)).join("")}`;
  }

  screen().innerHTML = `${statusCard}<div class="poc-picker-wrap">${pickerHTML}</div><div id="packingArea"></div>`;
  if (state.selectedOrderNo) renderPackingForm();
}

function _packingOrderCard(o) {
  const p          = _orderProgress(o);
  const isSelected = sameOrderNo(state.selectedOrderNo, o.order_no);
  return `<div class="pack-order-card ${isSelected ? "poc-active" : ""}" onclick="selectPackOrder('${o.order_no}')">
    <div class="poc-top">
      <div class="poc-info">
        <span class="poc-no">Order #${esc(o.order_no)}</span>
        <span class="poc-party">${esc(o.party)}</span>
      </div>
      <div class="poc-right">
        ${_statusChip(p.chip, p.cls)}
        ${isSelected ? `<span class="poc-tick">✓</span>` : ""}
      </div>
    </div>
    <div class="poc-stats">
      <span class="poc-stat"><b>${p.ordered}</b><small>Ordered</small></span>
      <span class="poc-stat poc-stat-packed"><b>${p.packed}</b><small>Packed</small></span>
      <span class="poc-stat poc-stat-bal"><b>${p.balance}</b><small>Balance</small></span>
      ${p.totalCartons ? `<span class="poc-stat"><b>${p.pendingQC}</b><small>Pending QC</small></span>` : ""}
    </div>
    <div class="poc-bars">
      <div class="poc-bar-row">
        <span class="poc-bar-label">Pack</span>
        <div class="poc-bar-track"><div class="poc-bar-fill poc-bar-pack" style="width:${p.packedPct}%"></div></div>
        <span class="poc-bar-pct">${p.packedPct}%</span>
      </div>
      ${p.totalCartons ? `<div class="poc-bar-row">
        <span class="poc-bar-label">QC</span>
        <div class="poc-bar-track"><div class="poc-bar-fill poc-bar-qc" style="width:${p.qcPct}%"></div></div>
        <span class="poc-bar-pct">${p.qcPct}%</span>
      </div>` : ""}
    </div>
  </div>`;
}

/**
 * Compute progress metrics for one order.
 * Replaces the two near-identical functions cdOrderProgress / (inline code in renderApp).
 */
function _orderProgress(o) {
  const ordered      = (o.items || []).reduce((s, it) => s + Number(it.qty || 0), 0);
  const cartons      = validCartonsForOrder(o);
  const packed       = cartons.flatMap(c => Array.isArray(c.items) ? c.items : []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const qcDone       = cartons.filter(c => isQCDone(c)).length;
  const totalCartons = Math.max(new Set(cartons.map(c => String(c.carton_no))).size, ...cartons.map(c => Number(c.total_cartons) || 0), 0);
  const recheck      = cartons.filter(c => normStatus(c.status) === "RECHECK").length;
  const pendingQC    = cartons.filter(c => normStatus(c.status) === "PENDING_QC").length;
  const packedPct    = ordered ? Math.min(100, Math.round((packed / ordered) * 100)) : 0;
  const qcPct        = totalCartons ? Math.min(100, Math.round((qcDone / totalCartons) * 100)) : 0;
  let chip = "NOT STARTED", cls = "chip-muted";
  if (recheck)                                                          { chip = "RECHECK";     cls = "chip-danger";  }
  else if (totalCartons && pendingQC)                                   { chip = "PENDING QC";  cls = "chip-warning"; }
  else if (ordered && packed >= ordered && totalCartons && qcDone >= totalCartons) { chip = "COMPLETE"; cls = "chip-success"; }
  else if (packed > 0)                                                  { chip = "PARTIAL";     cls = "chip-info";    }
  return { ordered, packed, balance: Math.max(0, ordered - packed), totalCartons, qcDone, recheck, pendingQC, packedPct, qcPct, chip, cls };
}

function _statusChip(text, cls) {
  return `<span class="cd-chip ${cls || "chip-muted"}">${text}</span>`;
}

function renderPackingForm() {
  const o = selectedOrder();
  if (!o) return;
  updateOrderCompletion(o.order_no, true);
  const balanceItems = (o.items || []).map((it, i) => ({ ...it, i, balance: balanceQty(o, i) })).filter(x => x.balance > 0);
  const canReset     = state.user.role === "ADMIN" || state.user.role === "MANAGER";
  const preservedCartonNo = _nextCartonNo || "1";

  document.getElementById("packingArea").innerHTML = `
  <div class="pack-mobile-form">
    <div class="pmf-order-bar">
      <div class="pmf-order-info">
        <span class="pmf-party">${esc(o.party)}</span>
        <span class="pmf-orderno">Order #${esc(o.order_no)}</span>
      </div>
      <div class="pmf-order-right">
        ${o.status === "COMPLETE" ? `<span class="badge complete">COMPLETE</span>` : ""}
        ${canReset ? `<button class="danger small pmf-reset-btn" onclick="clearPackingForOrder('${o.order_no}')">↺</button>` : ""}
      </div>
    </div>
    <div class="pmf-fields-row">
      <div class="pmf-field">
        <label class="pmf-label">📦 Carton No</label>
        <input id="cartonNo" class="pmf-input pmf-carton-input" placeholder="e.g. 1"
          value="${esc(preservedCartonNo)}" inputmode="numeric" onkeydown="handleCartonEnter(event)">
      </div>
      <div class="pmf-field pmf-field-tare">
        <label class="pmf-label">⚖️ Tare (kg)</label>
        <input id="tare" class="pmf-input" type="number" step="0.01" placeholder="0.30"
          value="${_currentTare}"
          onkeydown="if(event.key==='Enter'){event.preventDefault();focusId('packQty')}">
      </div>
    </div>
    <div class="pmf-section-label">
      <span>Select Part</span>
      ${balanceItems.length ? `<span class="pmf-balance-count">${balanceItems.length} remaining</span>` : `<span class="badge complete">All Packed ✅</span>`}
    </div>
    ${balanceItems.length === 0 ? "" : `
    <div class="pmf-part-scroll" id="partChipScroll">
      ${balanceItems.map(it => `
        <button class="pmf-part-chip ${_selectedPackIdx === it.i ? "pmf-chip-active" : ""}"
          onclick="selectPackItem(${it.i})" data-idx="${it.i}" tabindex="0">
          <span class="pmf-chip-part">${esc(it.part_no)}</span>
          <span class="pmf-chip-bal" id="chipbal_${it.i}">${it.balance}</span>
        </button>`).join("")}
    </div>`}
    <div class="pmf-qty-add-row">
      <div class="pmf-qty-wrap">
        <label class="pmf-label">Qty</label>
        <input id="packQty" class="pmf-qty-input" type="number" inputmode="numeric" placeholder="0"
          oninput="livePackQty()"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addCartonItem()}">
      </div>
      <button class="pmf-add-btn" onclick="addCartonItem()">
        <span class="pmf-add-icon">➕</span><span>ADD</span>
      </button>
    </div>
    <input id="packItem" type="hidden" value="${_selectedPackIdx ?? ""}">
  </div>
  <div id="cartonDraftBox"></div>
  <div class="pmf-qc-panel" id="sendToQcPanel"></div>`;

  renderCartonDraft();
  if (_selectedPackIdx !== undefined) {
    const pi = document.getElementById("packItem");
    if (pi) pi.value = String(_selectedPackIdx);
  }
}

function selectPackItem(idx) {
  _selectedPackIdx = idx;
  const pi = document.getElementById("packItem");
  if (pi) pi.value = String(idx);
  document.querySelectorAll(".pmf-part-chip").forEach(b => {
    b.classList.toggle("pmf-chip-active", Number(b.getAttribute("data-idx")) === idx);
  });
  document.querySelectorAll(".item-pick-btn").forEach((b, i) => {
    b.classList.toggle("item-pick-active", i === idx || Number(b.getAttribute("data-idx")) === idx);
  });
  setTimeout(() => focusId("packQty"), 50);
}

function addCartonItem() {
  const o = selectedOrder();
  if (!o) return;

  const packItemEl  = document.getElementById("packItem");
  const packItemVal = packItemEl ? packItemEl.value : "";
  const idx         = packItemVal !== "" ? Number(packItemVal) : (_selectedPackIdx !== undefined ? _selectedPackIdx : -1);
  const qty         = Number(val("packQty"));
  const cartonNo    = val("cartonNo").trim();
  const tare        = Number(val("tare") || 0);

  if (!cartonNo)             return toast("Enter Carton No");
  if (idx < 0 || packItemVal === "") return toast("Select a part first");
  if (!qty)                  return toast("Enter Qty");
  if (qty > balanceQty(o, idx)) return toast("Qty exceeds balance");

  const enteredNo = Number(cartonNo);
  if (isNaN(enteredNo) || enteredNo < 1) return toast("Carton No must be a positive number");

  const draftNos  = new Set(state.cartonDraft.map(x => Number(x.carton_no)));
  const sentNos   = new Set(validCartonsForOrder(o).map(c => Number(c.carton_no)));
  const allUsed   = new Set([...draftNos, ...sentNos]);

  if (!allUsed.has(enteredNo)) {
    const maxUsed     = allUsed.size ? Math.max(...allUsed) : 0;
    const expectedNext = maxUsed + 1;
    if (enteredNo > expectedNext) {
      const missing = [];
      for (let n = expectedNext; n < enteredNo; n++) missing.push(n);
      toast(`⚠ Carton ${missing.join(", ")} missing! Expected next: #${expectedNext}`);
      return;
    }
    if (enteredNo < expectedNext && !allUsed.has(enteredNo)) {
      toast(`Carton #${enteredNo} already exists. Use a different number.`);
      return;
    }
  }

  const beforeBalance = balanceQty(o, idx);
  const it            = o.items[idx];
  state.cartonDraft.push({ carton_no: cartonNo, tare, order_item_index: idx, part_no: it.part_no, vehicle: it.vehicle, qty, weight: it.weight });

  if (beforeBalance > 0 && balanceQty(o, idx) === 0) toast("PART COMPLETE: " + it.part_no);
  if (o.items.every((_, i) => balanceQty(o, i) === 0)) toast("ALL ITEMS PACKED — Ready to Send to QC");

  document.getElementById("packQty").value = "";
  _nextCartonNo = cartonNo;
  _currentTare  = String(tare);
  updatePartButtonBalances(o);
  renderCartonDraft();
  setTimeout(() => { const c = document.getElementById("cartonNo"); if (c) { c.focus(); c.select(); } }, 50);
}

function deleteCartonDraft(i) { state.cartonDraft.splice(i, 1); renderCartonDraft(); }
function deleteCartonGroup(cartonNo) {
  state.cartonDraft = state.cartonDraft.filter(x => String(x.carton_no) !== String(cartonNo));
  renderCartonDraft();
}

function updatePartButtonBalances(o) {
  if (!o) o = selectedOrder();
  if (!o) return;
  document.querySelectorAll(".pmf-part-chip").forEach(btn => {
    const i      = Number(btn.getAttribute("data-idx"));
    if (isNaN(i)) return;
    const bal    = balanceQty(o, i);
    const chipBal = btn.querySelector(".pmf-chip-bal");
    if (chipBal) { chipBal.textContent = bal; chipBal.className = "pmf-chip-bal"; }
    btn.style.opacity      = bal <= 0 ? "0.38" : "1";
    btn.style.pointerEvents = bal <= 0 ? "none" : "";
  });
  document.querySelectorAll(".item-pick-btn").forEach(btn => {
    const m = (btn.getAttribute("onclick") || "").match(/selectPackItem\((\d+)\)/);
    if (!m) return;
    const i   = Number(m[1]);
    const bal  = balanceQty(o, i);
    const balEl = btn.querySelector(".ipb-balance");
    if (balEl) balEl.innerHTML = `Balance: <b>${bal}</b>`;
    btn.style.opacity       = bal <= 0 ? "0.38" : "1";
    btn.style.pointerEvents  = bal <= 0 ? "none" : "";
  });
}

function livePackQty() {
  const o = selectedOrder();
  if (!o) return;
  const packItemEl  = document.getElementById("packItem");
  const packItemVal = packItemEl ? packItemEl.value : "";
  const idx = packItemVal !== "" ? Number(packItemVal) : (_selectedPackIdx !== undefined ? _selectedPackIdx : -1);
  if (idx < 0) return;
  const typedQty   = Number(val("packQty") || 0);
  const currentBal = balanceQty(o, idx);
  const afterBal   = Math.max(0, currentBal - typedQty);
  const isOver     = typedQty > currentBal;
  const chipBal    = document.getElementById(`chipbal_${idx}`);
  if (chipBal) {
    if (typedQty > 0 && !isOver) { chipBal.textContent = afterBal; chipBal.className = "pmf-chip-bal pmf-chip-bal-live"; }
    else if (isOver)             { chipBal.textContent = "over!";  chipBal.className = "pmf-chip-bal pmf-chip-bal-over"; }
    else                         { chipBal.textContent = currentBal; chipBal.className = "pmf-chip-bal"; }
  }
}

function renderCartonDraft() {
  const box = document.getElementById("cartonDraftBox");
  if (!box) return;
  if (!state.cartonDraft.length) {
    box.innerHTML = `<div class="card packing-current-empty">
      <span class="pce-icon">📦</span>
      <span class="pce-text">No items packed yet — select a part and qty above</span>
    </div>`;
    const sp = document.getElementById("sendToQcPanel");
    if (sp) sp.innerHTML = "";
    return;
  }
  // Group by carton_no, preserving insertion order
  const order = [], grouped = {};
  state.cartonDraft.forEach((item, globalIdx) => {
    const k = String(item.carton_no);
    if (!grouped[k]) { grouped[k] = []; order.push(k); }
    grouped[k].push({ ...item, globalIdx });
  });
  const totalCartons = order.length;
  box.innerHTML = `<div class="card packing-draft-card">
    <div class="pdc-header">
      <span class="pdc-title">📦 Packed — ${totalCartons} Carton${totalCartons !== 1 ? "s" : ""}</span>
      <span class="pdc-hint muted">Change Carton No above to start a new carton</span>
    </div>
    ${order.map(no => {
      const items      = grouped[no];
      const tare       = Number(items[0]?.tare || 0);
      const itemWeight = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.weight) || 0), 0);
      const gross      = (itemWeight + tare).toFixed(2);
      return `<div class="pdc-carton-group">
        <div class="pdc-carton-header">
          <span class="pdc-carton-label">Carton <b>#${esc(no)}</b></span>
          <span class="pdc-carton-gross">${gross} kg gross</span>
          <button class="danger small pdc-del-carton" onclick="deleteCartonGroup('${esc(no)}')">✕ Remove Carton</button>
        </div>
        <div class="pdc-items">
          ${items.map(i => `<div class="pdc-item-row">
            <span class="pdc-part">${esc(i.part_no)}</span>
            <span class="pdc-vehicle muted">${esc(i.vehicle || "")}</span>
            <span class="pdc-qty">× ${i.qty}</span>
            <span class="pdc-wt muted">${(i.qty * i.weight).toFixed(2)} kg</span>
            <button class="danger small pdc-del-item" onclick="deleteCartonDraft(${i.globalIdx})">✕</button>
          </div>`).join("")}
        </div>
      </div>`;
    }).join("")}
  </div>`;
  const sp = document.getElementById("sendToQcPanel");
  if (sp) sp.innerHTML = `<button class="green wide-btn send-qc-btn" onclick="sendAllCartonsToQC()">
    🚀 SAVE &amp; SEND ALL ${totalCartons} CARTON${totalCartons !== 1 ? "S" : ""} TO QC
  </button>`;
}

async function sendAllCartonsToQC() {
  const o = selectedOrder();
  if (!o) return;
  if (!state.cartonDraft.length) return toast("No items packed yet — add items first");

  const pendingQty = Number(document.getElementById("packQty")?.value || 0);
  if (pendingQty > 0 && !confirm(
    `You have ${pendingQty} qty typed in the Qty field but not added to a carton.\n\nPress OK to ignore it and send to QC anyway.\nPress Cancel to go back and click ADD first.`
  )) { setTimeout(() => focusId("packQty"), 50); return; }

  const grouped = {};
  state.cartonDraft.forEach(item => {
    const k = String(item.carton_no);
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(item);
  });
  const cartonNos = Object.keys(grouped);
  const total     = String(Math.max(...cartonNos.map(n => Number(n) || 0), cartonNos.length));
  const now       = new Date().toISOString();

  cartonNos.forEach(no => {
    const items      = grouped[no];
    const tare       = Number(items[0]?.tare || 0);
    const itemWeight = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.weight) || 0), 0);
    state.cartons.push({
      id:              uid(),
      order_uid:       o.order_uid || "",
      order_no:        o.order_no,
      party:           o.party,
      carton_no:       no,
      total_cartons:   total,
      items,
      tare,
      expected_weight: itemWeight + tare,
      actual_weight:   0,
      status:          "PENDING_QC",
      packed_by:       state.user.username,
      created_at:      now,
    });
  });

  state.cartonDraft    = [];
  _selectedPackIdx     = undefined;
  state.selectedOrderNo = "";
  updateOrderCompletion(o.order_no, true);

  try {
    saveState();
    await apiPost(API.sync, { cartons: state.cartons, orders: state.orders });
    uiToast(`${cartonNos.length} carton${cartonNos.length !== 1 ? "s" : ""} sent to QC ✓`);
    renderPacking();
  } catch (e) { toast("Save failed: " + e.message); }
}

// Aliases for backward compatibility with old onclick strings
async function sendEntireOrderToQC() { return sendAllCartonsToQC(); }
async function sendSelectedToQC()    { return sendAllCartonsToQC(); }

function handleCartonEnter(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const current = val("cartonNo").trim();
  if (!current) { focusId("cartonNo"); return; }
  // New/different carton: enter tare first. Same carton: jump directly to visible part selection/qty.
  if (_lastCartonNo !== current) {
    _lastCartonNo = current;
    focusId("tare");
  } else {
    focusFirstPackChip();
  }
}

async function clearPackingForOrder(orderNo) {
  const o = getOrder(orderNo);
  if (!o) return;
  if (!confirm("Clear all packing/QC cartons for Order " + orderNo + "?")) return;
  state.cartons         = state.cartons.filter(c => !cartonBelongsToOrder(c, o));
  o.status              = "DRAFT";
  o.workflow_status     = "READY_TO_PACK";
  state.cartonDraft     = [];
  _selectedPackIdx       = undefined;
  if (sameOrderNo(state.selectedOrderNo, orderNo)) state.selectedOrderNo = "";
  saveState();
  try {
    await apiPost(API.cartons, { cartons: state.cartons });
    await apiPost(API.orders,  { orders:  state.orders  });
    toast("Packing cleared for Order " + orderNo);
  } catch { enqueueOffline("cartons"); enqueueOffline("orders"); }
  renderPacking();
}

function balanceTable(o) {
  const ghost       = state.cartons.filter(c => sameOrderNo(c.order_no, o.order_no) && !cartonBelongsToOrder(c, o)).length;
  const items       = o.items || [];
  const pendingItems = items.filter((_, i) => balanceQty(o, i) > 0);
  const doneItems    = items.filter((_, i) => balanceQty(o, i) === 0);
  const totalOrdered = items.reduce((s, it) => s + Number(it.qty || 0), 0);
  const totalPacked  = items.reduce((s, _, i) => s + packedQty(o, i), 0);
  const totalDraft   = items.reduce((s, _, i) => s + draftQty(i), 0);
  const overallPct   = totalOrdered ? Math.round(((totalPacked + totalDraft) / totalOrdered) * 100) : 0;

  const rowHTML = (it, i, done) => {
    const ordered = Number(it.qty || 0);
    const packed  = packedQty(o, i);
    const draft   = draftQty(i);
    const bal     = balanceQty(o, i);
    const pct     = ordered ? Math.round(((packed + draft) / ordered) * 100) : 100;
    return `<div class="bal-row ${done ? "bal-row-done" : "bal-row-pending"}">
      <div class="bal-row-main">
        <div class="bal-sku">
          <span class="bal-part">${esc(it.part_no)}</span>
          <span class="bal-vehicle">${esc(it.vehicle || "")}</span>
        </div>
        <div class="bal-nums">
          <span class="bal-num-box"><span class="bal-num-val">${ordered}</span><span class="bal-num-lbl">Order</span></span>
          <span class="bal-num-box"><span class="bal-num-val">${packed}</span><span class="bal-num-lbl">Packed</span></span>
          ${draft ? `<span class="bal-num-box bal-num-draft"><span class="bal-num-val">+${draft}</span><span class="bal-num-lbl">Draft</span></span>` : ""}
          <span class="bal-num-box ${done ? "bal-num-done" : "bal-num-left"}">
            <span class="bal-num-val">${done ? "✓" : bal}</span>
            <span class="bal-num-lbl">${done ? "Done" : "Left"}</span>
          </span>
        </div>
      </div>
      <div class="bal-progress-track"><div class="bal-progress-fill ${done ? "bal-prog-done" : ""}" style="width:${Math.min(pct, 100)}%"></div></div>
    </div>`;
  };

  return `<div class="bal-table">
    ${ghost ? `<div class="bal-ghost-warn">⚠ ${ghost} ghost carton record${ghost > 1 ? "s" : ""} ignored</div>` : ""}
    <div class="bal-header">
      <span class="bal-header-title">Balance — ${pendingItems.length} of ${items.length} remaining</span>
      <span class="bal-header-pct ${overallPct === 100 ? "bal-pct-done" : ""}">${overallPct}%</span>
    </div>
    ${pendingItems.map((item, j) => rowHTML(item, items.indexOf(pendingItems[j]), false)).join("")}
    ${doneItems.length ? `<details class="bal-done-section">
      <summary class="bal-done-toggle">✓ ${doneItems.length} item${doneItems.length > 1 ? "s" : ""} complete — tap to show</summary>
      ${doneItems.map((item, j) => rowHTML(item, items.indexOf(doneItems[j]), true)).join("")}
    </details>` : ""}
  </div>`;
}

/* ══════════════════════════════════════════════════════════════
   13. QC SCREEN
   ══════════════════════════════════════════════════════════════ */

function renderQC() {
  const pendingOrders = state.orders
    .filter(o => validCartonsForOrder(o).some(c => normStatus(c.status) === "PENDING_QC"))
    .slice()
    .sort((a, b) => {
      const aLatest = Math.max(...validCartonsForOrder(a).map(c => latestFirstValue(c.created_at || "")), latestFirstValue(a.created_at), 0);
      const bLatest = Math.max(...validCartonsForOrder(b).map(c => latestFirstValue(c.created_at || "")), latestFirstValue(b.created_at), 0);
      return bLatest - aLatest || Number(b.order_no) - Number(a.order_no);
    });

  let pickerHTML;
  if (!pendingOrders.length) {
    pickerHTML = `<div class="empty-state">✅<br>No cartons pending QC</div>`;
  } else if (pendingOrders.length === 1) {
    const o = pendingOrders[0];
    pickerHTML = `<div class="auto-selected-order">
      <div class="auto-order-label">✅ QC Order</div>
      <div class="auto-order-name">${esc(o.party)}</div>
      <div class="auto-order-no">Order #${esc(o.order_no)}</div>
    </div>`;
  } else {
    pickerHTML = `<div class="picker-label" style="margin-bottom:8px">Select Order for QC</div>
      ${pendingOrders.map(o => `<button class="order-pick-btn" onclick="renderQCCards('${esc(o.order_no)}')">
        <span class="opb-no">Order #${esc(o.order_no)}</span>
        <span class="opb-party">${esc(o.party)}</span>
        <span class="opb-items">${validCartonsForOrder(o).filter(c => normStatus(c.status) === "PENDING_QC").length} cartons</span>
      </button>`).join("")}`;
  }

  screen().innerHTML = `<div class="card labour-card">${pickerHTML}</div><div id="qcArea"></div><div id="qcStatus">${_qcStatusHTML()}</div>`;
  if (pendingOrders.length === 1) renderQCCards(pendingOrders[0].order_no);
}

function renderQCCards(orderNo) {
  const o         = getOrder(orderNo);
  if (!o) return;
  const allForOrder = validCartonsForOrder(o);
  const list        = allForOrder.filter(c => normStatus(c.status) === "PENDING_QC");
  const canRecall   = state.user && (state.user.role === "ADMIN" || state.user.role === "MANAGER");

  if (!list.length) {
    document.getElementById("qcArea").innerHTML = `
    <div class="card qc-complete-card">
      <div class="qcc-icon">✅</div>
      <div class="qcc-title">${esc(o.party)}</div>
      <div class="qcc-sub">Order #${esc(o.order_no)} — All ${allForOrder.length} carton${allForOrder.length !== 1 ? "s" : ""} QC complete</div>
      <div class="qcc-actions">
        <button class="green" onclick="printOrderStickers('${attr(orderNo)}')">🖨️ Print Stickers</button>
        <button class="secondary" onclick="generateQCPDF('${attr(o.party)}')">📄 QC PDF</button>
      </div>
    </div>`;
    return;
  }

  document.getElementById("qcArea").innerHTML = `
  <div class="qc-order-banner">
    <div class="qcb-left">
      <span class="qcb-party">${esc(o.party)}</span>
      <span class="qcb-meta">Order #${esc(o.order_no)} · ${list.length} pending · ±${QC_TOLERANCE_KG.toFixed(2)} kg</span>
    </div>
    <span class="qcb-count">${list.length}</span>
  </div>
  <div class="qc-cards-list">
  ${list.map((c, index) => {
    const expected = Number(c.expected_weight || 0);
    const low      = (expected - QC_TOLERANCE_KG).toFixed(2);
    const high     = (expected + QC_TOLERANCE_KG).toFixed(2);
    const skuCount = (c.items || []).length;
    const totalPcs = (c.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
    const detailId = `qcd_${c.id}`;
    return `<div class="qc-compact-card" id="qccard_${c.id}">
      <div class="qcc-top-row">
        <div class="qcc-carton-id">
          <span class="qcc-no">#${esc(c.carton_no)}</span>
          <span class="qcc-total">/ ${esc(c.total_cartons || "?")}</span>
        </div>
        <div class="qcc-meta-chips">
          <span class="qcc-chip">${skuCount} SKU</span>
          <span class="qcc-chip">${totalPcs} pcs</span>
          <span class="qcc-chip qcc-chip-exp">${expected.toFixed(2)} kg exp</span>
        </div>
        <div class="qcc-status-wrap">
          <div id="live_${c.id}" class="qcc-live"><span class="qc-badge-sm qc-badge-pending">—</span></div>
          ${canRecall ? `<button class="recall-btn" onclick="recallCarton('${c.id}','${attr(orderNo)}')" title="Recall to Packing">↩</button>` : ""}
        </div>
      </div>
      <div class="qcc-weigh-row">
        <label class="qcc-weigh-label">Actual Weight (kg)</label>
        <div class="qcc-weigh-input-wrap">
          <input class="qc-weight-input qcc-weight-input" id="qc_${c.id}"
            type="number" step="0.01" inputmode="decimal"
            placeholder="${low} – ${high}"
            oninput="liveQC('${c.id}');checkQCButtons()"
            onkeydown="if(event.key==='Enter'){event.preventDefault();focusNextQC(${index})}">
        </div>
        <div class="qcc-range">✓ ${low} – ${high}</div>
      </div>
      <details class="qcc-details" id="${detailId}">
        <summary class="qcc-details-toggle">
          <span>SKUs &amp; Photo</span>
          <span class="qcc-detail-chips">${(c.items || []).map(i => `${esc(i.part_no)} ×${i.qty}`).join(" · ")}</span>
        </summary>
        <div class="qcc-detail-body">
          <div class="qcc-sku-list">
            ${(c.items || []).map(i => `<div class="qcc-sku-row">
              <span class="qcc-sku-part">${esc(i.part_no)}</span>
              <span class="qcc-sku-vehicle">${esc(i.vehicle || "")}</span>
              <span class="qcc-sku-qty">×${i.qty}</span>
              <span class="qcc-sku-wt">${(Number(i.qty) * Number(i.weight || 0)).toFixed(2)} kg</span>
            </div>`).join("")}
          </div>
          <div class="qcc-photo-area">
            <input class="qc-photo-input" id="photo_${c.id}" type="file" accept="image/*" capture="environment"
              onchange="captureQCPhoto('${c.id}',this);checkQCButtons()">
            <button type="button" class="camera-btn qcc-camera-btn" onclick="openCartonCamera('${c.id}')">📷 Take Photo</button>
            <div id="photoPreview_${c.id}" class="qcc-photo-preview"></div>
          </div>
        </div>
      </details>
    </div>`;
  }).join("")}
  </div>
  <div class="qc-save-bar" id="qcActionButtons" style="display:none">
    <button id="saveQCBtn" class="green wide-btn" onclick="saveQCOrder('${orderNo}')">
      ✅ SAVE QC — ${list.length} Carton${list.length !== 1 ? "s" : ""}
    </button>
  </div>`;
}

/** Live QC weight feedback — updates badge and card colour in real time. */
function liveQC(id) {
  const c        = state.cartons.find(x => x.id === id);
  if (!c) return;
  const actual   = Number(val("qc_" + id));
  const box      = document.getElementById("live_" + id);
  const card     = document.getElementById("qccard_" + id);
  const input    = document.getElementById("qc_" + id);
  const expected = Number(c.expected_weight || 0);
  const low = expected - QC_TOLERANCE_KG, high = expected + QC_TOLERANCE_KG;
  if (!actual) {
    if (box)   box.innerHTML = `<span class="qc-badge-sm qc-badge-pending">—</span>`;
    if (card)  card.classList.remove("qc-card-pass", "qc-card-recheck");
    if (input) input.classList.remove("qc-input-pass", "qc-input-recheck");
    return;
  }
  const pass   = actual >= low && actual <= high;
  const detail = pass ? "✓" : actual < low ? `▼${(low - actual).toFixed(2)}` : `▲${(actual - high).toFixed(2)}`;
  if (box)   box.innerHTML = `<span class="qc-badge-sm ${pass ? "qc-badge-pass" : "qc-badge-recheck"}">${pass ? "PASS" : "RECHECK"}</span><span class="qc-diff-sm">${detail}</span>`;
  if (card)  { card.classList.toggle("qc-card-pass", pass); card.classList.toggle("qc-card-recheck", !pass); }
  if (input) { input.classList.toggle("qc-input-pass", pass); input.classList.toggle("qc-input-recheck", !pass); }
}

function focusNextQC(index) {
  const inputs = [...document.querySelectorAll(".qc-weight-input")];
  const n      = inputs[index + 1];
  if (n) { n.focus(); n.select(); }
  else   { checkQCButtons(); document.querySelector("#qcActionButtons button")?.focus(); }
}

function focusFirstEmptyQC() {
  const i = [...document.querySelectorAll(".qc-weight-input")].find(x => !x.value);
  if (i) { i.focus(); i.select(); }
}

function checkQCButtons() {
  const inputs    = [...document.querySelectorAll(".qc-weight-input")];
  const allFilled = inputs.length > 0 && inputs.every(i => Number(i.value) > 0);
  const btn       = document.getElementById("qcActionButtons");
  if (btn) {
    btn.style.display = allFilled ? "block" : "none";
    if (allFilled) btn.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function saveQCOrder(orderNo) {
  const o = getOrder(orderNo);
  if (!o) return;
  const list = validCartonsForOrder(o).filter(c => normStatus(c.status) === "PENDING_QC");
  for (const c of list) {
    const w = Number(document.getElementById("qc_" + c.id)?.value || 0);
    if (!w) return toast("Actual weight required for carton " + c.carton_no);
    c.actual_weight = w;
    c.qc_at         = new Date().toISOString();
    const expected  = Number(c.expected_weight || 0);
    c.status = (w >= expected - QC_TOLERANCE_KG && w <= expected + QC_TOLERANCE_KG) ? "PASS" : "RECHECK";
  }
  updateOrderCompletion(orderNo, true);
  // Snapshot backup before QC commit
  try {
    const backup = { _v: STATE_VERSION, _saved: Date.now(), orders: state.orders, cartons: state.cartons };
    localStorage.setItem(STORAGE.QC_BACKUP, JSON.stringify(backup));
  } catch {}
  await saveQCSafe();
  uiToast("QC Saved Successfully");
  renderQC();
}

/** saveAllQC — alias used by party-level QC save. */
async function saveAllQC(party) {
  const list = state.cartons.filter(c => c.party === party && c.status === "PENDING_QC");
  if (!list.length) return toast("No pending QC cartons");
  for (const c of list) {
    const actual = Number(val("qc_" + c.id));
    if (!actual) return toast("Fill actual weight for carton " + c.carton_no);
    c.party         = normText(c.party);
    c.actual_weight = actual;
    if (c.photo_data) c.qc_photo_taken_at = c.qc_photo_taken_at || new Date().toLocaleString();
    c.qc_by  = state.user.username;
    c.qc_at  = new Date().toLocaleString();
    c.status = Math.abs(actual - Number(c.expected_weight)) <= QC_TOLERANCE_KG ? "PASS" : "RECHECK";
  }
  [...new Set(list.map(c => c.order_no))].forEach(no => updateOrderCompletion(no, true));
  try {
    try {
      const backup = { _v: STATE_VERSION, _saved: Date.now(), orders: state.orders, cartons: state.cartons };
      localStorage.setItem(STORAGE.QC_BACKUP, JSON.stringify(backup));
    } catch {}
    await saveQCSafe();
    uiToast("QC Saved Successfully");
    state.screen = "STICKERS";
    renderApp();
  } catch (e) { toast("QC save failed: " + e.message); }
}

async function recallCarton(cartonId, orderNo) {
  const c = state.cartons.find(x => x.id === cartonId);
  if (!c) return;
  if (!confirm(`Recall Carton #${c.carton_no} back to Packing?\n\nThis will remove it from QC pending and allow re-packing.`)) return;
  state.cartons = state.cartons.filter(x => x.id !== cartonId);
  updateOrderCompletion(orderNo, true);
  saveState();
  try {
    await apiPost(API.cartons, { cartons: state.cartons });
    await apiPost(API.orders,  { orders:  state.orders  });
    toast(`Carton #${c.carton_no} recalled — go to Packing to re-pack`);
    renderQCCards(orderNo);
  } catch { enqueueOffline("cartons"); enqueueOffline("orders"); toast("Carton recalled locally — will sync when online"); renderQCCards(orderNo); }
}

function openCartonCamera(id) {
  const input = document.getElementById("photo_" + id);
  if (!input) return toast("Camera input not found");
  input.value = "";
  input.click();
}

async function captureQCPhoto(id, input) {
  const file = input.files?.[0];
  if (!file) return;
  const c = state.cartons.find(x => x.id === id);
  if (!c) return;
  try {
    const data       = await _resizeImageToDataURL(file, 700, 0.60);
    c.photo_data     = data;
    c.photo_name     = `carton_${c.order_no}_${c.carton_no}_${Date.now()}.jpg`;
    const box        = document.getElementById("photoPreview_" + id);
    if (box) box.innerHTML = `<img src="${data}"><span class="badge pass">PHOTO READY</span>`;
    toast("Photo attached");
  } catch (e) { toast("Photo capture failed: " + e.message); }
}

function _resizeImageToDataURL(file, maxSize = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read photo"));
    reader.onload  = () => {
      const img   = new Image();
      img.onerror = () => reject(new Error("Could not load photo"));
      img.onload  = () => {
        const scale  = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width  = Math.max(1, Math.round(img.width  * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function _qcStatusHTML() {
  const rows = state.orders.map(o => {
    const cs = validCartonsForOrder(o);
    if (!cs.length) return null;
    const pending = cs.filter(c => normStatus(c.status) === "PENDING_QC").length;
    const done    = cs.filter(c => isQCDone(c)).length;
    const latest  = Math.max(...cs.map(c => latestFirstValue(c.created_at || "")), latestFirstValue(o.created_at), 0);
    return { o, pending, done, latest, total: [...new Set(cs.map(c => String(c.carton_no)))].length };
  }).filter(Boolean).sort((a, b) => b.latest - a.latest || Number(b.o.order_no) - Number(a.o.order_no));
  if (!rows.length) return "";
  return `<div class="card"><h2>QC Status</h2>${rows.map(r => {
    const cs          = validCartonsForOrder(r.o);
    const recheckList = cs.filter(c => normStatus(c.status) === "RECHECK");
    return `<div class="line">
      <div>
        <b>Order ${esc(r.o.order_no)}</b> · <b>${esc(r.o.party)}</b><br>
        <span class="muted">Date: ${esc(fmtDate(r.o.created_at))}</span><br>
        Total: ${r.total} | Pending QC: ${r.pending} | Done: ${r.done}
        ${recheckList.length ? `<br><span class="recheck-detail">⚠️ Recheck cartons: ${recheckList.map(c => `<b>#${esc(c.carton_no)}</b>`).join(", ")}</span>` : ""}
      </div>
      <div class="status-badges">
        ${r.pending > 0 ? `<span class="badge pending">PENDING ${r.pending}</span>` : ""}
        ${recheckList.length ? `<button class="badge recheck clickable-badge" onclick="goToRecheck('${esc(r.o.order_no)}')">⚠ RECHECK ${recheckList.length}</button>` : `<span class="badge complete">DONE ${r.done}</span>`}
      </div>
    </div>`;
  }).join("")}</div>`;
}

function goToRecheck(orderNo) {
  state.screen = "QC";
  renderApp();
  setTimeout(() => renderQCCards(orderNo), 80);
}

/* ══════════════════════════════════════════════════════════════
   14. STICKERS SCREEN
   ══════════════════════════════════════════════════════════════ */

function renderStickers() {
  const groups = state.orders.map(o => {
    const cartons = validCartonsForOrder(o).filter(isQCDone);
    return cartons.length ? { order_no: o.order_no, party: o.party, created_at: o.created_at, cartons } : null;
  }).filter(Boolean).sort((a, b) =>
    latestFirstValue(b.created_at) - latestFirstValue(a.created_at) || Number(b.order_no) - Number(a.order_no)
  );

  screen().innerHTML = _renderTopbar() + `
  <div class="card stk-settings-card">
    <div class="stk-settings-row">
      <label class="stk-setting-item checkbox-row">
        <input type="checkbox" id="stickerLogoToggle" checked><span>Logo</span>
      </label>
      <div class="stk-size-row">
        <span class="stk-size-label">Label:</span>
        <label class="stk-size-opt"><input type="radio" name="stickerSize" value="100x150" checked><span>100×150</span></label>
        <label class="stk-size-opt"><input type="radio" name="stickerSize" value="100x100"><span>100×100</span></label>
        <label class="stk-size-opt"><input type="radio" name="stickerSize" value="4x6"><span>4×6"</span></label>
      </div>
    </div>
  </div>
  ${!groups.length
    ? `<div class="card"><p class="empty-state">No QC completed cartons yet.</p>
        ${state.cartons.length ? `<p style="text-align:center;font-size:12px;color:var(--text-3);margin-top:8px">
          ${state.cartons.length} carton(s) in system — status: ${[...new Set(state.cartons.map(c => c.status))].join(", ") || "none"}
        </p>
        <button class="secondary wide-btn" style="margin-top:10px" onclick="loadAll().then(()=>renderStickers())">
          🔄 Refresh Data
        </button>` : ""}
       </div>`
    : groups.map(g => {
        const cs           = g.cartons.slice().sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
        const total        = cs.length;
        const passCount    = cs.filter(c => normStatus(c.status) === "PASS").length;
        const recheckCount = cs.filter(c => normStatus(c.status) === "RECHECK").length;
        const o            = getOrder(g.order_no);
        const lots         = (o?.dispatch_lots?.length) ? o.dispatch_lots : null;
        return `<div class="card stk-order-card">
          <div class="stk-order-top">
            <div class="stk-order-meta">
              <div class="stk-order-id">Order <span class="stk-order-no">#${esc(g.order_no)}</span></div>
              <div class="stk-party-name">${esc(g.party)}</div>
              <div class="stk-order-date">${esc(fmtDate(g.created_at))}</div>
            </div>
            <div class="stk-order-counts">
              <div class="stk-count-box"><span class="stk-count-val">${total}</span><span class="stk-count-lbl">Cartons</span></div>
              <div class="stk-count-box stk-count-pass"><span class="stk-count-val">${passCount}</span><span class="stk-count-lbl">Pass</span></div>
              ${recheckCount ? `<div class="stk-count-box stk-count-recheck"><span class="stk-count-val">${recheckCount}</span><span class="stk-count-lbl">Recheck</span></div>` : ""}
            </div>
          </div>
          <div class="stk-carton-chips">
            ${cs.map(c => `<span class="carton-row ${normStatus(c.status) === "RECHECK" ? "carton-recheck" : ""}">${esc(c.carton_no)}</span>`).join("")}
          </div>
          <div class="stk-lots-section">
            <div class="stk-lots-header">
              <span class="stk-lots-label">Dispatch Lots</span>
              <button class="skt-btn skt-edit stk-add-lot-btn" onclick="addDispatchLot('${attr(g.order_no)}')">+ Add Lot</button>
            </div>
            ${lots ? lots.map((lot, li) => `
              <div class="stk-lot-row">
                <div class="stk-lot-info">
                  <span class="stk-lot-name">Lot ${li + 1}: ${esc(lot.name || ("Lot " + (li + 1)))}</span>
                  <span class="stk-lot-range">Cartons ${esc(lot.from)}–${esc(lot.to)} (${Number(lot.to) - Number(lot.from) + 1} cartons)</span>
                </div>
                <div class="stk-lot-btns">
                  <button class="skt-btn" onclick="printLotStickers('${attr(g.order_no)}',${li})">🖨️</button>
                  <button class="skt-btn skt-del" onclick="deleteDispatchLot('${attr(g.order_no)}',${li})">✕</button>
                </div>
              </div>`).join("")
            : `<div class="stk-no-lots">No lots defined — print all cartons together, or add lots for split dispatch</div>`}
          </div>
          <div class="stk-action-row">
            <button class="stk-print-btn green" onclick="printOrderStickers('${attr(g.order_no)}')">🖨️ All Stickers</button>
            <button class="stk-pdf-btn secondary" onclick="generateQCPDF('${attr(g.party)}')">📄 QC PDF</button>
            <button class="stk-xls-btn secondary" onclick="exportDispatchExcel('${attr(g.order_no)}')">📊 Excel</button>
          </div>
        </div>`;
      }).join("")}`;
}

function getStickerSettings() {
  const branding  = document.getElementById("stickerLogoToggle")?.checked ?? true;
  const sizeEl    = document.querySelector('input[name="stickerSize"]:checked');
  const labelSize = sizeEl ? sizeEl.value : "100x150";
  return { branding, labelSize };
}

function printOrderStickers(orderNo) {
  const o    = getOrder(orderNo);
  const list = validCartonsForOrder(o).filter(isQCDone).sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
  if (!list.length) return toast("No QC completed cartons found for Order " + orderNo);
  const { branding, labelSize } = getStickerSettings();
  printStickerList(list, branding, labelSize, null);
}

function printPartyStickers(party) {
  const key  = partyKey(party);
  const list = state.cartons.filter(c => partyKey(c.party) === key && isQCDone(c)).sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
  if (!list.length) return toast("No QC completed cartons found for " + party);
  const { branding, labelSize } = getStickerSettings();
  printStickerList(list, branding, labelSize);
}

/* ── Dispatch Lot Management ─────────────────────────────────── */

function addDispatchLot(orderNo) {
  const o           = getOrder(orderNo);
  if (!o) return;
  const allCartons  = validCartonsForOrder(o).filter(isQCDone).sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
  if (!allCartons.length) return toast("No QC completed cartons");
  const assigned    = new Set((o.dispatch_lots || []).flatMap(l => {
    const arr = [];
    for (let n = Number(l.from); n <= Number(l.to); n++) arr.push(n);
    return arr;
  }));
  const unassigned  = allCartons.filter(c => !assigned.has(Number(c.carton_no)));
  if (!unassigned.length) return toast("All cartons already assigned to dispatch lots");
  const first   = Number(unassigned[0].carton_no);
  const last    = Number(unassigned[unassigned.length - 1].carton_no);
  const fromNo  = prompt(`Dispatch Lot — From Carton No:\n(Unassigned: ${first}–${last})`, String(first));
  if (!fromNo) return;
  const toNo    = prompt(`Dispatch Lot — To Carton No:`, String(last));
  if (!toNo) return;
  const name    = prompt("Dispatch Lot Name / Invoice No (optional):", "Lot " + (((o.dispatch_lots || []).length) + 1));
  if (!o.dispatch_lots) o.dispatch_lots = [];
  o.dispatch_lots.push({ name: name || "", from: fromNo.trim(), to: toNo.trim() });
  saveState();
  persistState("orders").catch(() => {});
  renderStickers();
}

function deleteDispatchLot(orderNo, idx) {
  const o = getOrder(orderNo);
  if (!o || !o.dispatch_lots) return;
  if (!confirm("Remove this dispatch lot?")) return;
  o.dispatch_lots.splice(idx, 1);
  saveState();
  persistState("orders").catch(() => {});
  renderStickers();
}

function printLotStickers(orderNo, lotIdx) {
  const o = getOrder(orderNo);
  if (!o || !o.dispatch_lots?.[lotIdx]) return;
  const lot         = o.dispatch_lots[lotIdx];
  const from        = Number(lot.from), to = Number(lot.to);
  const allCartons  = validCartonsForOrder(o).filter(isQCDone).sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
  const lotCartons  = allCartons.filter(c => Number(c.carton_no) >= from && Number(c.carton_no) <= to);
  if (!lotCartons.length) return toast("No cartons found in range " + from + "–" + to);
  const { branding, labelSize } = getStickerSettings();
  printStickerList(lotCartons, branding, labelSize, { name: lot.name, from, to, total: lotCartons.length });
}

/* ── Sticker HTML generation ─────────────────────────────────── */

function printStickerList(all, branding = true, labelSize = "100x150", lot = null) {
  if (!all || !all.length) { toast("No stickers to print"); return; }
  const sizes = {
    "100x150": { w: "100mm", h: "150mm" },
    "100x100": { w: "100mm", h: "100mm" },
    "4x6":     { w: "101.6mm", h: "152.4mm" },
  };
  const sz          = sizes[labelSize] || sizes["100x150"];
  const totalLabel  = lot ? lot.total : all.length;

  const stickerHTML = all.map((c, stickerIdx) => {
    const tare      = Number(c.tare || 0);
    const gross     = Number(c.actual_weight || c.expected_weight || 0);
    const net       = Math.max(0, gross - tare);
    const totalQty  = (c.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
    const st        = normStatus(c.status || "");
    const isPass    = st === "PASS";
    const stLbl     = isPass ? "✓  PASS" : "⚠  RECHECK";
    const packedBy  = c.packed_by ? "Packed: " + esc(c.packed_by) : "";
    const dispNo    = lot ? (stickerIdx + 1) : Number(c.carton_no);
    return `<div class="sticker">
      <div class="sh">
        <div class="sl">${branding ? `<img src="/assets/logo.jpeg" style="max-height:10mm;max-width:36mm;object-fit:contain" onerror="this.style.display='none'">` : `<span style="font-size:11px;font-weight:900">CERADRIVE</span>`}</div>
        <div class="scn">
          <div class="scb">${dispNo}<span style="font-size:14px;font-weight:700;color:#555">/${totalLabel}</span></div>
          ${lot ? `<div class="scs">${esc(lot.name || "Dispatch Lot")}</div>` : ""}
          <div class="scs">Master #${esc(c.carton_no)}</div>
        </div>
      </div>
      <div class="sp">${esc(c.party)}</div>
      <div class="so">Order #${esc(c.order_no || "")} &nbsp;|&nbsp; ${esc(fmtDate(c.created_at || ""))}</div>
      <div class="sw">
        <div class="swb"><span class="swv">${gross.toFixed(2)}</span><span class="swl">Gross kg</span></div>
        <div class="swb"><span class="swv">${tare.toFixed(2)}</span><span class="swl">Tare kg</span></div>
        <div class="swb"><span class="swv">${net.toFixed(2)}</span><span class="swl">Net kg</span></div>
        <div class="swb"><span class="swv">${totalQty}</span><span class="swl">Pcs</span></div>
      </div>
      <div class="ss">
        <div class="ssh"><span class="ssc sc1">SKU</span><span class="ssc sc2">Model</span><span class="ssc sc3">Qty</span></div>
        ${(c.items || []).map(i => `<div class="ssr"><span class="ssv sv1">${esc(i.part_no)}</span><span class="ssv sv2">${esc(i.vehicle || "")}</span><span class="ssv sv3">${i.qty}</span></div>`).join("")}
        <div class="sst"><span>Total</span><span>${totalQty} pcs</span></div>
      </div>
      <div class="sf">
        <span class="sfp">${packedBy}</span>
        <span class="sfb ${isPass ? "sb-pass" : "sb-rchk"}">${stLbl}</span>
      </div>
    </div>`;
  }).join("");

  const doc = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>Stickers — ${esc(all[0]?.party || "")} (${all.length})</title>
<style>
@page{size:${sz.w} ${sz.h};margin:0!important}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#fff}
.sticker{width:${sz.w};height:${sz.h};padding:4mm 5mm 3mm;display:flex;flex-direction:column;gap:0;page-break-after:always;page-break-inside:avoid;overflow:hidden;background:#fff}
.sh{display:flex;justify-content:space-between;align-items:center;padding-bottom:2mm;border-bottom:.5mm solid #000;margin-bottom:1.5mm;flex-shrink:0}
.sl{display:flex;align-items:center}
.scn{text-align:right;line-height:1}
.scb{font-size:24px;font-weight:900;color:#000;line-height:1}
.scs{font-size:7.5px;color:#555;text-transform:uppercase;letter-spacing:.6px;margin-top:1px}
.sp{font-size:11.5px;font-weight:900;text-transform:uppercase;letter-spacing:.3px;color:#000;margin-bottom:.5mm;flex-shrink:0}
.so{font-size:7.5px;color:#444;margin-bottom:1.5mm;flex-shrink:0}
.sw{display:flex;border:.4mm solid #999;border-radius:1.5mm;overflow:hidden;margin-bottom:1.5mm;flex-shrink:0}
.swb{flex:1;text-align:center;padding:1mm .5mm;border-right:.4mm solid #999}.swb:last-child{border-right:none}
.swv{font-size:11px;font-weight:900;display:block;color:#000;line-height:1}
.swl{font-size:6.5px;color:#666;text-transform:uppercase;letter-spacing:.4px}
.ss{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.ssh{display:flex;border-bottom:.4mm solid #000;padding-bottom:.8mm;margin-bottom:.3mm;flex-shrink:0}
.ssc{font-size:7px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#333}
.sc1{flex:2}.sc2{flex:2}.sc3{flex:1;text-align:right}
.ssr{display:flex;align-items:center;padding:.5mm 0;border-bottom:.3mm solid #e5e5e5}.ssr:last-child{border-bottom:none}
.ssv{font-size:9px;font-weight:700;color:#000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv1{flex:2}.sv2{flex:2;font-weight:500;color:#333}.sv3{flex:1;text-align:right;font-size:10px;font-weight:900}
.sst{display:flex;justify-content:space-between;flex-shrink:0;border-top:.3mm solid #bbb;padding-top:.5mm;margin-top:.5mm;font-size:7px;font-weight:700;color:#444}
.sf{margin-top:auto;padding-top:1.5mm;border-top:.5mm solid #000;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
.sfp{font-size:6.5px;color:#888}
.sfb{font-size:9.5px;font-weight:900;letter-spacing:.8px;padding:.8mm 2.5mm;border-radius:1mm}
.sb-pass{background:#000;color:#fff}.sb-rchk{background:#fff;color:#c00;border:.5mm dashed #c00}
</style></head><body>
${stickerHTML}
<script>window.onload=function(){window.focus();setTimeout(function(){window.print();window.onafterprint=function(){window.close();};},400);};<\/script>
</body></html>`;
  _openPrintWindow(doc, "Stickers", false);
}

/* ── QC PDF ──────────────────────────────────────────────────── */

function generateQCPDF(party) {
  const key  = partyKey(party);
  const list = state.cartons
    .filter(c => partyKey(c.party) === key && (isQCDone(c) || normStatus(c.status) === "PENDING_QC"))
    .sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
  if (!list.length) { toast("No cartons found for " + party); return; }

  const body = `<style>
    *{box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:11px;color:#111}
    .qr-header{display:flex;align-items:center;gap:12px;margin-bottom:8px;border-bottom:1.5px solid #000;padding-bottom:6px}
    .qr-header img{max-height:40px;max-width:120px}
    .qr-title{font-size:16px;font-weight:800;margin-bottom:2px}.qr-meta{font-size:10px;color:#555}
    table{width:100%;border-collapse:collapse;margin-bottom:0;font-size:10px}
    th{background:#111;color:#fff;padding:4px 6px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.04em}
    td{padding:3px 6px;vertical-align:top;border-bottom:.5px solid #ccc}
    .td-carton{font-weight:800;font-size:11px;white-space:nowrap}
    .td-status-pass{background:#d1fae5;color:#065f46;font-weight:800;text-align:center;white-space:nowrap;font-size:9px;padding:2px 4px;border-radius:3px}
    .td-status-recheck{background:#fef3c7;color:#92400e;font-weight:800;text-align:center;white-space:nowrap;font-size:9px;padding:2px 4px;border-radius:3px}
    .td-status-pending{background:#dbeafe;color:#1e40af;font-weight:800;text-align:center;white-space:nowrap;font-size:9px;padding:2px 4px;border-radius:3px}
    .sku-line{display:flex;gap:4px;flex-wrap:wrap;line-height:1.5}
    .sku-chip{background:#f3f4f6;border:1px solid #ddd;border-radius:3px;padding:1px 5px;font-size:9px;white-space:nowrap}
    .td-wt{white-space:nowrap;font-variant-numeric:tabular-nums}
    @media print{@page{margin:10mm 8mm}.report-modal-bar,.no-print{display:none!important}.report-modal-body{padding:0!important}}
  </style>
  <div class="qr-header">
    <img src="/assets/logo.jpeg" onerror="this.style.display='none'">
    <div>
      <div class="qr-title">QC Report — ${esc(party)}</div>
      <div class="qr-meta">Date: ${new Date().toLocaleDateString()} &nbsp;·&nbsp; Total Cartons: ${list.length} &nbsp;·&nbsp; Pass: ${list.filter(c => normStatus(c.status) === "PASS").length} &nbsp;·&nbsp; Recheck: ${list.filter(c => normStatus(c.status) === "RECHECK").length}</div>
    </div>
  </div>
  <table>
    <thead><tr><th style="width:60px">Carton</th><th>SKUs / Items</th><th style="width:80px">Actual Wt</th><th style="width:60px">Status</th></tr></thead>
    <tbody>
      ${list.map(c => {
        const st      = normStatus(c.status || "PENDING_QC");
        const stCls   = st === "PASS" ? "td-status-pass" : st === "RECHECK" ? "td-status-recheck" : "td-status-pending";
        const totalQty = (c.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
        const skuChips = (c.items || []).map(i => `<span class="sku-chip">${esc(i.part_no)} <b>×${i.qty}</b></span>`).join("");
        return `<tr>
          <td class="td-carton">${c.carton_no}<span style="color:#999;font-size:9px">/${c.total_cartons || "?"}</span></td>
          <td><div class="sku-line">${skuChips}</div><div style="color:#888;font-size:9px;margin-top:1px">${totalQty} pcs · exp ${Number(c.expected_weight || 0).toFixed(2)} kg</div></td>
          <td class="td-wt">${Number(c.actual_weight || 0).toFixed(2)} kg<br><span style="color:#888;font-size:9px">diff: ${(Number(c.actual_weight || 0) - Number(c.expected_weight || 0)).toFixed(2)}</span></td>
          <td><span class="${stCls}">${st}</span></td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>`;
  showReportModal(body, `QC Report — ${party}`);
}

/* ── Excel Export ────────────────────────────────────────────── */

function exportDispatchExcel(orderNo) {
  const o       = getOrder(orderNo);
  if (!o) return;
  const cartons = validCartonsForOrder(o).filter(isQCDone).sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
  if (!cartons.length) return toast("No QC completed cartons to export");
  const lots    = o.dispatch_lots || [];

  function getLotInfo(carton_no) {
    const n = Number(carton_no);
    for (let i = 0; i < lots.length; i++) {
      const l          = lots[i];
      if (n >= Number(l.from) && n <= Number(l.to)) {
        const lotCartons = cartons.filter(c => Number(c.carton_no) >= Number(l.from) && Number(c.carton_no) <= Number(l.to));
        const pos        = lotCartons.findIndex(c => String(c.carton_no) === String(carton_no)) + 1;
        return { lot: "Lot " + (i + 1) + (l.name ? " — " + l.name : ""), stickerNo: pos, totalInLot: lotCartons.length };
      }
    }
    const pos = cartons.findIndex(c => String(c.carton_no) === String(carton_no)) + 1;
    return { lot: "All", stickerNo: pos, totalInLot: cartons.length };
  }

  const rows = [["Party", "Order No", "Dispatch Lot", "Master Carton No", "Sticker No", "Total in Lot", "SKU", "Model", "Qty", "Actual Weight (kg)", "QC Status"]];
  cartons.forEach(c => {
    const li = getLotInfo(c.carton_no);
    (c.items || []).forEach(it => {
      rows.push([o.party, o.order_no, li.lot, c.carton_no, li.stickerNo + "/" + li.totalInLot, li.totalInLot, it.part_no, it.vehicle || "", it.qty, Number(c.actual_weight || 0).toFixed(2), normStatus(c.status || "")]);
    });
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dispatch");
  XLSX.writeFile(wb, `Dispatch_${o.order_no}_${o.party.replace(/\s+/g, "_")}.xlsx`);
}

/* ── Report modal ────────────────────────────────────────────── */

function showReportModal(htmlContent, title) {
  document.getElementById("reportModal")?.remove();
  const modal = document.createElement("div");
  modal.id    = "reportModal";
  modal.innerHTML = `
    <div class="report-modal-bar no-print">
      <button class="report-modal-back" onclick="closeReportModal()">← Back</button>
      <span class="report-modal-title">${esc(title)}</span>
      <button class="report-modal-print" onclick="printCurrentReportModal()">🖨️ Print</button>
    </div>
    <div class="report-modal-body" id="reportModalBody"></div>`;
  document.body.appendChild(modal);
  document.getElementById("reportModalBody").innerHTML = htmlContent;
  document.body.style.overflow = "hidden";
}

function closeReportModal() {
  document.getElementById("reportModal")?.remove();
  document.body.style.overflow = "";
}

function printCurrentReportModal() {
  const content = document.getElementById("reportModalBody")?.innerHTML || "";
  _openPrintWindow(content, "QC Report", false);
}

function _openPrintWindow(bodyContent, title, autoprint = true) {
  const win = window.open("", "_blank", "width=820,height=650");
  if (!win) { window.print(); return; } // popup blocked fallback
  if (bodyContent.trim().startsWith("<!DOCTYPE") || bodyContent.trim().startsWith("<html")) {
    win.document.write(bodyContent);
    win.document.close();
    return;
  }
  win.document.write(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif}</style>
</head><body>
${bodyContent}
${autoprint ? `<script>window.onload=function(){setTimeout(function(){window.focus();window.print();window.onafterprint=function(){window.close()};},400)};<\/script>` : ""}
</body></html>`);
  win.document.close();
}

/* Legacy alias */
function printReportWindow() { printCurrentReportModal(); }

/* ══════════════════════════════════════════════════════════════
   15. SKU MASTER SCREEN
   ══════════════════════════════════════════════════════════════ */

function renderSkuMaster() {
  screen().innerHTML = `
  <div class="card">
    <div class="card-header"><h2>Add / Update SKU</h2><p class="muted-sm">Part No is the unique key</p></div>
    <div class="form-grid">
      <div class="form-group"><label class="field-label">Part No *</label><input id="skuPart" placeholder="e.g. VO101P" onkeydown="if(event.key==='Enter')focusId('skuVehicle')"></div>
      <div class="form-group"><label class="field-label">Vehicle / Model</label><input id="skuVehicle" placeholder="e.g. SWIFT" onkeydown="if(event.key==='Enter')focusId('skuWeight')"></div>
      <div class="form-group"><label class="field-label">Weight per Set (kg)</label><input id="skuWeight" type="number" step="0.01" placeholder="0.00" onkeydown="if(event.key==='Enter')focusId('skuMRP')"></div>
      <div class="form-group"><label class="field-label">MRP</label><input id="skuMRP" type="number" placeholder="0" onkeydown="if(event.key==='Enter')addSku()"></div>
      <div class="form-group full"><button onclick="addSku()" class="green wide-btn">+ ADD / UPDATE SKU</button></div>
    </div>
    <details class="import-details">
      <summary class="import-summary">📥 Import from Excel</summary>
      <div class="import-body">
        <p class="muted-sm">Columns: Part No · Vehicle · Weight · MRP · Dealer · Export</p>
        <input type="file" id="excelFile" accept=".xlsx,.xls,.csv" onchange="importExcel(event)">
      </div>
    </details>
  </div>
  <div class="card">
    <div class="sku-filter-row">
      <input id="skuFilter" placeholder="Search part no or vehicle…" oninput="renderSkuList()" style="margin-top:0">
      <div class="sku-filter-tabs">
        <button class="sku-ftab active" id="ftab_all" onclick="setSkuFilterTab('all')">All</button>
        <button class="sku-ftab" id="ftab_active" onclick="setSkuFilterTab('active')">Active</button>
        <button class="sku-ftab" id="ftab_inactive" onclick="setSkuFilterTab('inactive')">Inactive</button>
      </div>
    </div>
    <div id="skuList"></div>
  </div>`;
  renderSkuList();
}

async function addSku() {
  const part_no = val("skuPart").trim();
  if (!part_no) return toast("Part No required");
  const obj = { part_no, vehicle: val("skuVehicle"), weight: Number(val("skuWeight") || 0), mrp: Number(val("skuMRP") || 0), dealer: 0, export_price: 0, active: 1 };
  const idx  = state.skus.findIndex(s => String(s.part_no).toLowerCase() === part_no.toLowerCase());
  if (idx >= 0) state.skus[idx] = obj;
  else state.skus.push(obj);
  try { await saveSkus(); renderSkuMaster(); }
  catch (e) { toast("Save failed: " + e.message); }
}

function setSkuFilterTab(tab) {
  _skuFilterTab = tab;
  ["all", "active", "inactive"].forEach(t => {
    document.getElementById("ftab_" + t)?.classList.toggle("active", t === tab);
  });
  renderSkuList();
}

function renderSkuList() {
  const box = document.getElementById("skuList");
  if (!box) return;
  const q   = (val("skuFilter") || "").toLowerCase();
  let list  = state.skus.filter(s =>
    String(s.part_no).toLowerCase().includes(q) || String(s.vehicle || "").toLowerCase().includes(q)
  );
  if (_skuFilterTab === "active")   list = list.filter(s => Number(s.active ?? 1) !== 0);
  else if (_skuFilterTab === "inactive") list = list.filter(s => Number(s.active ?? 1) === 0);
  if (!list.length) { box.innerHTML = `<p class="muted" style="padding:12px 0">No ${_skuFilterTab === "all" ? "" : _skuFilterTab + " "}SKUs found.</p>`; return; }

  const activeList   = list.filter(s => Number(s.active ?? 1) !== 0);
  const inactiveList = list.filter(s => Number(s.active ?? 1) === 0);

  const tableRows = arr => `<table class="sku-table">
    <thead><tr>
      <th class="skt-part">Part No</th><th class="skt-vehicle">Vehicle</th>
      <th class="skt-weight">kg</th><th class="skt-actions"></th>
    </tr></thead>
    <tbody>${arr.map(s => {
      const isActive = Number(s.active ?? 1) !== 0;
      return `<tr class="skt-row ${isActive ? "" : "skt-inactive"}">
        <td class="skt-part-val"><b>${esc(s.part_no)}</b></td>
        <td class="skt-vehicle-val">${esc(s.vehicle || "")}</td>
        <td class="skt-weight-val">${Number(s.weight || 0).toFixed(2)}</td>
        <td class="skt-actions-val">
          <button class="skt-btn skt-edit" onclick="editSku('${attr(s.part_no)}')" title="Edit">✏</button>
          <button class="skt-btn ${isActive ? "skt-active" : "skt-inactive-btn"}" onclick="toggleSkuActive('${attr(s.part_no)}')" title="${isActive ? "Deactivate" : "Activate"}">${isActive ? "●" : "○"}</button>
          <button class="skt-btn skt-del" onclick="deleteSKUByPart('${attr(s.part_no)}')" title="Delete">🗑</button>
        </td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;

  box.innerHTML = (activeList.length ? tableRows(activeList) : "")
    + (inactiveList.length ? `<div class="sku-section-label">Inactive (${inactiveList.length})</div>${tableRows(inactiveList)}` : "");
}

async function toggleSkuActive(partNo) {
  const s = state.skus.find(x => String(x.part_no).toLowerCase() === String(partNo).toLowerCase());
  if (!s) return toast("SKU not found");
  const wasActive = Number(s.active ?? 1) !== 0;
  s.active = wasActive ? 0 : 1;
  try {
    await saveSkus();
    toast(wasActive ? "SKU deactivated — won't appear in orders" : "SKU activated");
    renderSkuMaster();
  } catch (e) {
    s.active = wasActive ? 1 : 0; // revert
    toast("Save failed: " + e.message);
  }
}

function editSku(partNo) {
  const s = state.skus.find(x => String(x.part_no).toLowerCase() === String(partNo).toLowerCase());
  if (!s) { toast("SKU not found"); return; }
  document.getElementById("skuPart").value    = s.part_no  || "";
  document.getElementById("skuVehicle").value = s.vehicle  || "";
  document.getElementById("skuWeight").value  = s.weight   || "";
  document.getElementById("skuMRP").value     = s.mrp      || "";
  document.getElementById("skuPart").focus();
  document.getElementById("skuPart").select();
  toast("Editing " + s.part_no);
}

function deleteSKUByPart(partNo) {
  const part = String(partNo || "").trim();
  if (!part) return;
  if (_confirmDeleteSKU !== part) {
    _confirmDeleteSKU = part;
    toast("Tap Delete Again");
    setTimeout(() => { if (_confirmDeleteSKU === part) _confirmDeleteSKU = null; }, 2_000);
    return;
  }
  _confirmDeleteSKU = null;
  showCenterOverlay("Deleting...");
  state.skus = state.skus.filter(s => String(s.part_no || "").trim() !== part);
  saveState();
  Promise.resolve(apiPost(API.skus, { skus: state.skus, delete_part_nos: [part] }))
    .catch(e => { console.error(e); enqueueOffline("skus"); })
    .finally(() => {
      try { renderApp(); } catch {}
      setTimeout(() => { hideCenterOverlay(); toast("SKU Deleted"); }, 350);
    });
}

async function importExcel(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  const data = await file.arrayBuffer();
  showImportProgress("Reading file...", 0);
  await _nextTick();
  const wb   = XLSX.read(data);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  const imports = [], dups = [];
  for (let i = 0; i < rows.length; i++) {
    const r       = rows[i];
    const part_no = String(r["Part No"] || r["part_no"] || r["SKU"] || "").trim();
    if (!part_no) { updateImportProgress(Math.round(((i + 1) / rows.length) * 80)); continue; }
    const obj = { part_no, vehicle: String(r["Vehicle"] || r["Model"] || r["vehicle"] || "").trim(), weight: Number(r["Weight"] || r["weight"] || 0), mrp: Number(r["MRP"] || r["mrp"] || 0), dealer: Number(r["Dealer"] || 0), export_price: Number(r["Export"] || 0), active: 1 };
    if (state.skus.some(s => String(s.part_no).toLowerCase() === part_no.toLowerCase())) dups.push(obj);
    else imports.push(obj);
    if (i % 10 === 0) { updateImportProgress(Math.round(((i + 1) / rows.length) * 80)); await _nextTick(); }
  }
  updateImportProgress(85);
  let override = false;
  if (dups.length) {
    hideImportProgress();
    const choice = await showImportDuplicateModal(dups.length, "SKUs");
    override     = (choice === "override");
    showImportProgress("Applying...", 90);
    await _nextTick();
  }
  imports.forEach(x => state.skus.push(x));
  if (override) {
    dups.forEach(x => {
      const idx = state.skus.findIndex(s => String(s.part_no).toLowerCase() === String(x.part_no).toLowerCase());
      if (idx >= 0) state.skus[idx] = x;
    });
  }
  updateImportProgress(95, "Saving...");
  try {
    saveState();
    await apiPost(API.skus, { skus: state.skus });
  } catch (err) {
    hideImportProgress();
    toast("Save failed: " + (err.message || "Unknown error"));
    return;
  }
  updateImportProgress(100, "Done!");
  await new Promise(r => setTimeout(r, 500));
  hideImportProgress();
  toast(`Import complete. New: ${imports.length}, ${override ? "Overridden" : "Skipped"}: ${dups.length}`);
  renderSkuMaster();
}

/* ══════════════════════════════════════════════════════════════
   16. HISTORY SCREEN
   ══════════════════════════════════════════════════════════════ */

function renderHistory() {
  screen().innerHTML = _renderTopbar() + `
  <div class="card history-filter-card">
    <div class="hist-filter-row">
      <input id="histSearch" placeholder="Search party / order" oninput="applyHistoryFilter()" style="flex:1;margin:0">
      <input id="histFrom" type="date" title="From date" onchange="applyHistoryFilter()" style="width:130px;margin:0">
      <input id="histTo" type="date" title="To date" onchange="applyHistoryFilter()" style="width:130px;margin:0">
      <button class="secondary small" onclick="clearHistoryFilter()">✕ Clear</button>
    </div>
  </div>
  <div id="historyBox"></div>`;
  applyHistoryFilter();
}

function clearHistoryFilter() {
  ["histSearch", "histFrom", "histTo"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  applyHistoryFilter();
}

function applyHistoryFilter() {
  const q       = (document.getElementById("histSearch")?.value || "").toLowerCase().trim();
  const fromVal = document.getElementById("histFrom")?.value || "";
  const toVal   = document.getElementById("histTo")?.value   || "";
  const fromTs  = fromVal ? new Date(fromVal).setHours(0, 0, 0, 0) : 0;
  const toTs    = toVal   ? new Date(toVal).setHours(23, 59, 59, 999) : Infinity;
  _historyList(q, fromTs, toTs);
}

function _historyId(prefix, orderNo) { return String(prefix || "h") + "_" + String(orderNo || "x").replace(/[^a-zA-Z0-9_-]/g, "_"); }

function toggleHistoryDetails(id) {
  const el  = document.getElementById(id);
  if (!el) return;
  const isOpen = el.style.display === "block";
  el.style.display = isOpen ? "none" : "block";
  const btn = document.querySelector(`[data-toggle="${id}"]`);
  if (btn) btn.textContent = isOpen ? "▼ View Details" : "▲ Hide Details";
}

function _historyList(q, fromTs, toTs) {
  q      = String(q || "").toLowerCase();
  fromTs = fromTs ?? 0;
  toTs   = toTs   ?? Infinity;
  const inRange = d => { if (!fromTs && toTs === Infinity) return true; const t = latestFirstValue(d); return t >= fromTs && t <= toTs; };

  const orders       = state.orders.filter(o =>
    (String(o.party).toLowerCase().includes(q) || String(o.order_no).includes(q) || String(o.status || "").toLowerCase().includes(q))
    && inRange(o.created_at)
  ).slice().sort((a, b) => latestFirstValue(b.created_at) - latestFirstValue(a.created_at) || Number(b.order_no || 0) - Number(a.order_no || 0));

  const groupedQC = orders.map(o => ({ order: o, cartons: validCartonsForOrder(o) })).filter(g => g.cartons.length);
  const box       = document.getElementById("historyBox");
  if (!box) return;

  box.innerHTML =
    `<div class="hist-section-label">Orders (${orders.length})</div>`
    + orders.map(o => {
        const id       = _historyId("ord", o.order_no);
        const items    = o.items || [];
        const totalQty = items.reduce((s, i) => s + Number(i.qty || 0), 0);
        return `<div class="line history-compact-card">
          <div class="history-summary-row" onclick="toggleHistoryDetails('${id}')">
            <div><b>Order ${esc(o.order_no)}</b> &nbsp;${workflowBadge(o)}<br><b>${esc(o.party)}</b><br><span class="muted">${esc(fmtDate(o.created_at, true))} · ${items.length} SKU · ${totalQty} pcs</span></div>
            <button class="small secondary" onclick="event.stopPropagation();toggleHistoryDetails('${id}')">▼</button>
          </div>
          <div id="${id}" class="history-details">
            <div class="qc-carton-list">
              ${items.length ? items.map((i, idx) => `<div class="qc-carton-row"><b>${idx + 1}. ${esc(i.part_no)}</b> — ${esc(i.vehicle || "")} · Qty: ${i.qty || 0}</div>`).join("") : "<div class='qc-carton-row'>No items</div>"}
            </div>
          </div>
        </div>`;
      }).join("")
    + `<div class="hist-section-label" style="margin-top:10px">Cartons / QC (${groupedQC.length})</div>`
    + groupedQC.map(g => {
        const o        = g.order;
        const cs       = g.cartons.slice().sort((a, b) => Number(a.carton_no) - Number(b.carton_no));
        const unique   = [...new Set(cs.map(c => String(c.carton_no)))];
        const pass     = cs.filter(c => normStatus(c.status) === "PASS").length;
        const recheck  = cs.filter(c => normStatus(c.status) === "RECHECK").length;
        const id       = _historyId("qc", o.order_no);
        return `<div class="line history-compact-card">
          <div class="history-summary-row" onclick="toggleHistoryDetails('${id}')">
            <div><b>Order ${esc(o.order_no)}</b> · <b>${esc(o.party)}</b><br><span class="muted">${esc(fmtDate(o.created_at, true))} · ${unique.length} cartons · <span style="color:var(--green)">✓${pass}</span>${recheck ? ` · <span style="color:var(--orange)">⚠${recheck}</span>` : ""}</span></div>
            <button class="small secondary" onclick="event.stopPropagation();toggleHistoryDetails('${id}')">▼</button>
          </div>
          <div id="${id}" class="history-details">
            <div class="qc-carton-list">
              ${cs.map(c => `<div class="qc-carton-row">
                <b>${esc(c.carton_no)}/${esc(c.total_cartons)}</b>
                <span class="badge ${normStatus(c.status) === "PASS" ? "complete" : normStatus(c.status) === "RECHECK" ? "recheck" : "pending"}">${normStatus(c.status)}</span><br>
                Exp:${Number(c.expected_weight || 0).toFixed(2)} kg · Act:${Number(c.actual_weight || 0).toFixed(2)} kg
                ${c.photo_data ? `<br><img class="history-photo" src="${c.photo_data}">` : ""}
              </div>`).join("")}
            </div>
          </div>
        </div>`;
      }).join("");
}

/* ══════════════════════════════════════════════════════════════
   17. LOG SCREEN
   ══════════════════════════════════════════════════════════════ */

function renderLog() {
  const entries = [];
  state.orders.slice().sort((a, b) => latestFirstValue(b.created_at) - latestFirstValue(a.created_at)).forEach(o => {
    entries.push({ time: o.created_at, type: "ORDER", label: `Order ${o.order_no} created`, detail: `Party: ${o.party} | Items: ${(o.items || []).length} | Status: ${o.status}`, cls: "log-order" });
  });
  state.cartons.slice().sort((a, b) => latestFirstValue(b.created_at) - latestFirstValue(a.created_at)).forEach(c => {
    entries.push({ time: c.created_at, type: "PACKED", label: `Carton ${c.carton_no} packed`, detail: `Order ${c.order_no} | ${c.party} | Expected: ${Number(c.expected_weight || 0).toFixed(2)} kg`, cls: "log-pack" });
    if (c.qc_at) entries.push({ time: c.qc_at, type: c.status || "QC", label: `Carton ${c.carton_no} QC → ${c.status || "?"}`, detail: `Order ${c.order_no} | ${c.party} | Actual: ${Number(c.actual_weight || 0).toFixed(2)} kg`, cls: normStatus(c.status) === "PASS" ? "log-pass" : normStatus(c.status) === "RECHECK" ? "log-recheck" : "log-qc" });
  });
  entries.sort((a, b) => latestFirstValue(b.time) - latestFirstValue(a.time));
  screen().innerHTML = `
    <div class="card">
      <div class="card-header"><h2>Activity Log</h2><p class="muted-sm">All orders, packing, and QC events — latest first</p></div>
      <input placeholder="Search log…" oninput="filterLog(this.value,${JSON.stringify(entries).replace(/</g, "\u003c")})">
    </div>
    <div id="logList">${_renderLogEntries(entries)}</div>`;
}

function _renderLogEntries(entries) {
  if (!entries.length) return `<div class="card"><p class="muted">No activity yet.</p></div>`;
  return entries.map(e => `
    <div class="log-row ${e.cls || ""}">
      <div class="log-dot"></div>
      <div class="log-body">
        <div class="log-top"><span class="log-type-chip">${e.type}</span><span class="log-time">${fmtDate(e.time, true)}</span></div>
        <div class="log-label">${esc(e.label)}</div>
        <div class="log-detail">${esc(e.detail)}</div>
      </div>
    </div>`).join("");
}

function filterLog(q, entries) {
  q = String(q || "").toLowerCase();
  const filtered = q ? entries.filter(e => (e.label + e.detail + e.type).toLowerCase().includes(q)) : entries;
  const box      = document.getElementById("logList");
  if (box) box.innerHTML = _renderLogEntries(filtered);
}

/* ══════════════════════════════════════════════════════════════
   18. OVERLAY / TOAST
   ══════════════════════════════════════════════════════════════ */

function showCenterOverlay(message) {
  let wrap = document.getElementById("centerOverlay");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id        = "centerOverlay";
    wrap.innerHTML = '<div class="center-overlay-box" id="centerOverlayText"></div>';
    document.body.appendChild(wrap);
  }
  const txt = document.getElementById("centerOverlayText");
  if (txt) txt.innerText = message;
  wrap.className = "center-overlay show";
}

function hideCenterOverlay() {
  const wrap = document.getElementById("centerOverlay");
  if (wrap) wrap.className = "center-overlay";
}

function toast(msg) {
  showCenterOverlay(msg);
  clearTimeout(_centerToastTimer);
  _centerToastTimer = setTimeout(() => hideCenterOverlay(), 1_800);
}

/** Persistent success toast (self-removes, not a blocker). */
function uiToast(msg) {
  const t   = document.createElement("div");
  t.className = "save-toast";
  t.innerText  = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1_800);
}

/* ══════════════════════════════════════════════════════════════
   19. IMPORT PROGRESS & DUPLICATE MODAL
   ══════════════════════════════════════════════════════════════ */

function showImportProgress(label, pct) {
  let wrap = document.getElementById("importProgressOverlay");
  if (!wrap) {
    wrap    = document.createElement("div");
    wrap.id = "importProgressOverlay";
    wrap.innerHTML = `
      <div class="import-progress-box">
        <div class="import-progress-title" id="importProgressLabel">Importing...</div>
        <div class="import-progress-track"><div class="import-progress-fill" id="importProgressFill" style="width:0%"></div></div>
        <div class="import-progress-pct" id="importProgressPct">0%</div>
      </div>`;
    document.body.appendChild(wrap);
  }
  wrap.className = "import-progress-overlay show";
  const lbl  = document.getElementById("importProgressLabel");
  const fill = document.getElementById("importProgressFill");
  const perc = document.getElementById("importProgressPct");
  if (lbl)  lbl.textContent  = label || "Importing...";
  if (fill) fill.style.width = (pct || 0) + "%";
  if (perc) perc.textContent = (pct || 0) + "%";
}

function updateImportProgress(pct, label) {
  const fill = document.getElementById("importProgressFill");
  const perc = document.getElementById("importProgressPct");
  const lbl  = document.getElementById("importProgressLabel");
  if (fill) fill.style.width = Math.min(pct, 100) + "%";
  if (perc) perc.textContent = Math.min(pct, 100) + "%";
  if (label && lbl) lbl.textContent = label;
}

function hideImportProgress() {
  const wrap = document.getElementById("importProgressOverlay");
  if (wrap) wrap.className = "import-progress-overlay";
}

function showImportDuplicateModal(count, type) {
  return new Promise(resolve => {
    document.getElementById("importDupModal")?.remove();
    const wrap    = document.createElement("div");
    wrap.id       = "importDupModal";
    wrap.className = "import-dup-overlay show";
    wrap.innerHTML = `
      <div class="import-dup-box">
        <div class="import-dup-icon">⚠️</div>
        <div class="import-dup-title">Duplicate ${type} found</div>
        <div class="import-dup-msg"><b>${count}</b> duplicate part number${count > 1 ? "s" : ""} already exist${count === 1 ? "s" : ""}.<br>What would you like to do?</div>
        <div class="import-dup-actions">
          <button class="import-dup-btn override" data-choice="override">Override Existing</button>
          <button class="import-dup-btn skip"     data-choice="skip">Skip Duplicates</button>
          ${type === "order items" ? `<button class="import-dup-btn add" data-choice="add">Add to Existing Qty</button>` : ""}
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const _close = choice => {
      wrap.className = "import-dup-overlay";
      setTimeout(() => wrap.remove(), 300);
      resolve(choice);
    };
    wrap.querySelectorAll(".import-dup-btn").forEach(btn =>
      btn.addEventListener("click", () => _close(btn.dataset.choice), { once: true })
    );
  });
}

/* ══════════════════════════════════════════════════════════════
   20. MISC HELPERS (topbar, field validation, etc.)
   ══════════════════════════════════════════════════════════════ */

function _renderTopbar() {
  return `
  <div class="topbar">
    <img src="assets/logo.jpeg" alt="Ceradrive">
    <div>
      <div style="font-weight:700;font-size:16px;">Ceradrive Brakes</div>
      <div style="font-size:12px;color:#6b7280;">QC Packing System v8.5.3</div>
    </div>
  </div>`;
}

function setFieldError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("field-error");
  let err = document.getElementById(id + "_err");
  if (!err) { err = document.createElement("div"); err.id = id + "_err"; err.className = "field-error-text"; el.parentNode.appendChild(err); }
  err.innerText = msg;
}
function clearFieldError(id) {
  document.getElementById(id)?.classList.remove("field-error");
  document.getElementById(id + "_err")?.remove();
}

/** Yield to the browser event loop (for progress UI updates during sync work). */
function _nextTick() { return new Promise(r => setTimeout(r, 0)); }

/* ══════════════════════════════════════════════════════════════
   21. BOOTSTRAP
   ══════════════════════════════════════════════════════════════ */

async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
  await apiFetch(API.setup).catch(() => {});
  await loadAll();

  // Clear v7 legacy auto-login key that bypassed password checks
  localStorage.removeItem("remember_user_v7");

  const remembered = localStorage.getItem(STORAGE.REMEMBER_USER);
  if (remembered) {
    const user = USERS.find(u => u.username === remembered);
    if (user) {
      state.user   = user;
      state.screen = "HOME";
      renderApp();
      startAutoRefresh();
      return;
    }
    // Stale or invalid — clear and show login
    localStorage.removeItem(STORAGE.REMEMBER_USER);
  }
  renderLogin();
}

/* ── Global event listeners ──────────────────────────────────── */

// Flush offline queue when connectivity returns
window.addEventListener("online", () => {
  console.log("[offlineQueue] Back online — flushing queue");
  flushOfflineQueue().then(() => {
    if (!_getOfflineQueue().length) toast("Back online — all data synced ✓");
  });
});

window.addEventListener("offline", () => _showOfflineIndicator(true));

// Close the "More" tab menu when clicking outside it
document.addEventListener("click", e => {
  const wrap = document.querySelector(".tab-more-wrap");
  if (wrap && !wrap.contains(e.target)) closeMoreMenu();
});

/* ── Kick it off ─────────────────────────────────────────────── */
init();

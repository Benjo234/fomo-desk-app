(function () {
  "use strict";

  const TOKEN_KEY = "desk_app_token";
  const SB_KEY_STORE = "desk_sb_apikey";
  const SB_URL_STORE = "desk_sb_url";
  const SOURCE_KEY = "desk_source_mode"; // "supabase" | "local" | "demo" | "api" | "none"
  const SNAPSHOT_BASE_KEY = "desk_snapshot_base";
  const DEFAULT_SUPABASE_URL = "https://oygjjaqzxkptothhaeat.supabase.co";
  const POLL_MS = 15000;
  const RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];
  const BOT_ORDER = ["scanner", "analyst", "brain", "executor", "risk"];
  const BOT_LABELS = {
    scanner: "Scanner",
    analyst: "Analyst",
    brain: "Brain",
    executor: "Executor",
    risk: "Risk",
  };

  const state = {
    tab: "home",
    subview: null, // { type: "coin" | "audit", mint }
    range: "LIVE",
    activityFilter: "all", // "all" | "trades" | "rejected"
    loading: true,
    error: null,
    authError: null,
    waitingForDesk: false,
    retryIn: 15,
    lastUpdatedText: null,
    isExample: false,
    sourceMode: "auto",
    snapshotBase: "./api",
    data: {
      state: null,
      charts: {},
      activity: null,
      account: null,
      settings: null,
      decisions: {},
      coins: {},
      audits: {},
      screenPayload: null,
    },
    demoBundle: null,
    prevBalanceStr: null,
    searchQuery: "",
    activeScreenBlobUrl: null,
    screenVisibleSlot: 0,
    zoomScale: 1,
    copyPicksTime: localStorage.getItem("desk_copy_picks_time") || "09:00",
    offlineForced: false,
  };

  // --- Safe credential helpers (read-only only, never service role) ---
  function decodeJwtPayload(tok) {
    try {
      const parts = String(tok || "").split(".");
      if (parts.length !== 3) return null;
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      return JSON.parse(atob(pad));
    } catch (_) {
      return null;
    }
  }

  function isForbiddenCredential(val) {
    const s = String(val || "").trim();
    if (!s) return false;
    if (s.indexOf("sb_" + "secret_") === 0) return true;
    const payload = decodeJwtPayload(s);
    if (payload && String(payload.role || "").toLowerCase() === "service_role") return true;
    return false;
  }

  function saveCredentials({ token, apikey, url }) {
    if (isForbiddenCredential(token) || isForbiddenCredential(apikey)) {
      toast("Refused: privileged key cannot be stored on phone");
      return false;
    }
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token.trim());
      if (apikey) localStorage.setItem(SB_KEY_STORE, apikey.trim());
      if (url) localStorage.setItem(SB_URL_STORE, url.trim().replace(/\/+$/, ""));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearCredentials() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(SB_KEY_STORE);
      localStorage.removeItem(SB_URL_STORE);
      localStorage.removeItem(SOURCE_KEY);
    } catch (_) {}
  }

  function parseHashParams(rawHash) {
    const cleaned = String(rawHash || "").replace(/^#/, "");
    if (!cleaned) return null;
    const params = new URLSearchParams(cleaned);
    const tok = params.get("t");
    const apikey = params.get("k") || params.get("apikey");
    const sbUrl = params.get("u") || params.get("sb");
    return { params, tok, apikey, sbUrl };
  }

  function captureHashToken() {
    const parsed = parseHashParams(window.location.hash || "");
    if (!parsed) return;
    const { params, tok, apikey, sbUrl } = parsed;
    if (tok || apikey || sbUrl) {
      const ok = saveCredentials({ token: tok, apikey, url: sbUrl });
      if (ok && apikey && tok) {
        try { localStorage.setItem(SOURCE_KEY, "supabase"); } catch (_) {}
      }
      params.delete("t");
      params.delete("k");
      params.delete("apikey");
      params.delete("u");
      params.delete("sb");
      const rest = params.toString();
      const nextUrl =
        window.location.pathname +
        window.location.search +
        (rest ? "#" + rest : "");
      try {
        window.history.replaceState(null, "", nextUrl);
      } catch (_) {}
    }
  }

  function getAppToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; }
  }

  function getSbApiKey() {
    try { return localStorage.getItem(SB_KEY_STORE) || ""; } catch (_) { return ""; }
  }

  function getSbUrl() {
    try {
      return (localStorage.getItem(SB_URL_STORE) || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
    } catch (_) {
      return DEFAULT_SUPABASE_URL;
    }
  }

  function hasSupabaseCredentials() {
    return Boolean(getAppToken() && getSbApiKey() && getSbUrl());
  }

  function detectInitialSource() {
    const q = new URLSearchParams(window.location.search);
    if (q.get("demo") === "1") { state.sourceMode = "demo"; return; }
    if (q.get("source") === "none") { state.sourceMode = "none"; return; }
    if (q.get("source") === "local") {
      state.sourceMode = "local";
      state.snapshotBase = q.get("base") || "./api";
      return;
    }
    if (q.get("source") === "api") { state.sourceMode = "api"; return; }
    if (q.get("source") === "supabase") { state.sourceMode = "supabase"; return; }

    if (hasSupabaseCredentials()) {
      state.sourceMode = "supabase";
      return;
    }
    const saved = localStorage.getItem(SOURCE_KEY);
    if (saved === "demo" || saved === "local" || saved === "api" || saved === "supabase") {
      state.sourceMode = saved;
      state.snapshotBase = localStorage.getItem(SNAPSHOT_BASE_KEY) || "./api";
      return;
    }
    state.sourceMode = "auto";
  }

  // --- DOM & formatting helpers ---
  const $ = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function fmtMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "$0.00";
    return "$" + v.toFixed(2);
  }

  function fmtCompactMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
    return sign + "$" + abs.toFixed(2);
  }

  function fmtInt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return Math.round(v).toLocaleString("en-US");
  }

  function fmtPrice(p) {
    const v = Number(p);
    if (!Number.isFinite(v)) return "—";
    if (v >= 1) return "$" + v.toFixed(2);
    if (v >= 0.01) return "$" + v.toFixed(4);
    return "$" + v.toFixed(6);
  }

  function fmtShortTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(11, 16) || String(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // --- Fetchers ---
  async function fetchJson(url, withAuth, opts) {
    const headers = { Accept: "application/json" };
    const method = (opts && opts.method) || "GET";
    if (withAuth) {
      const tok = getAppToken();
      if (tok) headers["Authorization"] = "Bearer " + tok;
    }
    let body;
    if (opts && opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { method, headers, body, cache: "no-store" });
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const payload = await res.json();
        if (payload && (payload.detail || payload.message)) {
          detail = String(payload.detail || payload.message);
        }
      } catch (_) {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.indexOf("json") >= 0) return res.json();
    return res.text();
  }

  async function loadFromSupabase() {
    const tok = getAppToken();
    const apikey = getSbApiKey();
    const sbUrl = getSbUrl();
    if (!tok || !apikey || !sbUrl) {
      throw Object.assign(new Error("Read credentials not configured"), { status: 401, code: "NO_CREDS" });
    }
    if (isForbiddenCredential(tok) || isForbiddenCredential(apikey)) {
      clearCredentials();
      throw Object.assign(new Error("Privileged key refused"), { status: 403 });
    }
    const endpoint = sbUrl + "/rest/v1/rpc/desk_snapshots";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        apikey,
        Authorization: "Bearer " + apikey,
      },
      body: JSON.stringify({ p_token: tok }),
      cache: "no-store",
    });
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const p = await res.json();
        if (p && (p.message || p.hint)) detail = p.message || detail;
      } catch (_) {}
      throw Object.assign(new Error(detail), { status: res.status });
    }
    const rows = await res.json();
    state.isExample = false;
    state.authError = null;
    if (!Array.isArray(rows) || !rows.length) {
      state.waitingForDesk = true;
      state.data.state = null;
      state.error = null;
      return;
    }
    const byKey = {};
    let latestTs = null;
    rows.forEach((row) => {
      if (!row || !row.key) return;
      byKey[row.key] = row.body;
      if (row.updated_at && (!latestTs || row.updated_at > latestTs)) {
        latestTs = row.updated_at;
      }
    });
    if (!byKey.state) {
      state.waitingForDesk = true;
      state.data.state = null;
      state.error = null;
      return;
    }
    state.waitingForDesk = false;
    state.data.state = byKey.state;
    if (byKey.activity) state.data.activity = byKey.activity;
    if (byKey.account) state.data.account = byKey.account;
    if (byKey.settings) state.data.settings = byKey.settings;
    RANGES.forEach((r) => {
      if (byKey["chart/" + r]) state.data.charts[r] = byKey["chart/" + r];
    });
    BOT_ORDER.forEach((b) => {
      if (byKey["bots/" + b + "/decisions"]) state.data.decisions[b] = byKey["bots/" + b + "/decisions"];
    });
    Object.keys(byKey).forEach((k) => {
      if (k.indexOf("coin/") === 0 && byKey[k]) {
        state.data.coins[k.slice(5)] = byKey[k];
      } else if (k.indexOf("audit/") === 0 && byKey[k]) {
        state.data.audits[k.slice(6)] = byKey[k];
      }
    });
    state.data.screenPayload = byKey["screen.jpg"] || null;
    state.error = null;
    state.lastUpdatedText = fmtShortTime(
      (byKey.state && byKey.state.updatedAt) || latestTs || new Date().toISOString()
    );
  }

  async function loadFromDemo() {
    if (!state.demoBundle) {
      state.demoBundle = await fetchJson("./demo.json", false);
    }
    const b = state.demoBundle;
    state.isExample = true;
    state.waitingForDesk = false;
    state.authError = null;
    state.data.state = b.state;
    state.data.charts = b.charts || {};
    state.data.activity = b.activity;
    state.data.account = b.account;
    state.data.settings = b.settings;
    state.data.decisions = b.decisions || {};
    state.data.coins = b.coins || {};
    state.data.audits = b.audits || {};
    state.data.screenPayload = null;
    state.error = null;
    state.lastUpdatedText = fmtShortTime(b.state.updatedAt);
  }

  async function loadFromLocalSnapshots() {
    const base = state.snapshotBase.replace(/\/+$/, "");
    const st = await fetchJson(base + "/state.json", false);
    const [chart, act, acc, set] = await Promise.all([
      fetchJson(base + "/chart/" + state.range + ".json", false).catch(() => null),
      fetchJson(base + "/activity.json", false).catch(() => null),
      fetchJson(base + "/account.json", false).catch(() => null),
      fetchJson(base + "/settings.json", false).catch(() => null),
    ]);
    state.isExample = false;
    state.waitingForDesk = false;
    state.authError = null;
    state.data.state = st;
    if (chart) state.data.charts[state.range] = chart;
    if (act) state.data.activity = act;
    if (acc) state.data.account = acc;
    if (set) state.data.settings = set;
    state.data.screenPayload = null;
    state.error = null;
    state.lastUpdatedText = fmtShortTime(st.updatedAt || new Date().toISOString());
    Promise.all(
      BOT_ORDER.map((name) =>
        fetchJson(base + "/bots/" + name + "/decisions.json", false)
          .then((d) => { state.data.decisions[name] = d; })
          .catch(() => {})
      )
    ).then(() => {
      if (state.tab === "bots") render();
    });
  }

  async function loadFromApi() {
    const st = await fetchJson("/api/state", true);
    const [chart, act, acc, set] = await Promise.all([
      fetchJson("/api/chart?range=" + encodeURIComponent(state.range), true).catch(() => null),
      fetchJson("/api/activity", true).catch(() => null),
      fetchJson("/api/account", true).catch(() => null),
      fetchJson("/api/settings", true).catch(() => null),
    ]);
    state.isExample = false;
    state.waitingForDesk = false;
    state.authError = null;
    state.data.state = st;
    if (chart) state.data.charts[state.range] = chart;
    if (act) state.data.activity = act;
    if (acc) state.data.account = acc;
    if (set) state.data.settings = set;
    state.data.screenPayload = null;
    state.error = null;
    state.lastUpdatedText = fmtShortTime(st.updatedAt || new Date().toISOString());
  }

  async function loadCoinDetail(mint) {
    if (!mint) return null;
    if (state.data.coins[mint]) return state.data.coins[mint];
    if (state.isExample || state.sourceMode === "supabase") return null;
    try {
      const url =
        state.sourceMode === "api"
          ? "/api/coin/" + encodeURIComponent(mint)
          : state.snapshotBase.replace(/\/+$/, "") + "/coin/" + encodeURIComponent(mint) + ".json";
      const c = await fetchJson(url, state.sourceMode === "api");
      state.data.coins[mint] = c;
      return c;
    } catch (_) {
      return null;
    }
  }

  async function loadAuditDetail(mint) {
    if (!mint) return null;
    if (state.data.audits[mint]) return state.data.audits[mint];
    if (state.isExample || state.sourceMode === "supabase") return null;
    try {
      const url =
        state.sourceMode === "api"
          ? "/api/audit/" + encodeURIComponent(mint)
          : state.snapshotBase.replace(/\/+$/, "") + "/audit/" + encodeURIComponent(mint) + ".json";
      const a = await fetchJson(url, state.sourceMode === "api");
      state.data.audits[mint] = a;
      return a;
    } catch (_) {
      return null;
    }
  }

  async function refreshData() {
    if (state.offlineForced) {
      state.error = { time: state.lastUpdatedText || fmtShortTime(new Date().toISOString()) };
      renderBanners();
      return;
    }
    try {
      if (state.sourceMode === "demo") {
        await loadFromDemo();
      } else if (state.sourceMode === "supabase") {
        await loadFromSupabase();
      } else if (state.sourceMode === "local") {
        await loadFromLocalSnapshots();
      } else if (state.sourceMode === "api") {
        await loadFromApi();
      } else if (state.sourceMode === "none") {
        state.isExample = false;
        state.waitingForDesk = false;
        state.data.state = null;
        state.error = null;
      } else {
        // auto: Supabase if credentials exist, else local ./api/state.json, else waiting-for-setup
        if (hasSupabaseCredentials()) {
          state.sourceMode = "supabase";
          await loadFromSupabase();
        } else {
          try {
            state.snapshotBase = "./api";
            await loadFromLocalSnapshots();
            state.sourceMode = "local";
          } catch (_) {
            state.sourceMode = "none";
            state.isExample = false;
            state.data.state = null;
            state.error = null;
          }
        }
      }
      state.loading = false;
      state.retryIn = 15;
    } catch (e) {
      state.loading = false;
      if (e && (e.status === 401 || e.status === 403)) {
        state.authError = e.message || "Read credential rejected";
        state.error = state.data.state
          ? { message: state.authError, time: state.lastUpdatedText || "—" }
          : null;
      } else {
        state.error = {
          message: e && e.message ? e.message : "offline",
          time: state.lastUpdatedText || "—",
        };
      }
    }
    render();
  }

  // --- Odometer ---
  function renderOdometerHtml(valueStr) {
    const prev = state.prevBalanceStr || valueStr;
    const reduce = prefersReducedMotion();
    const chars = valueStr.split("");
    let digitIdx = 0;
    const html = chars
      .map((ch, i) => {
        if (!/[0-9]/.test(ch)) {
          return `<span class="odo-static">${esc(ch)}</span>`;
        }
        const d = Number(ch);
        const prevCh = prev[i];
        const prevD = /[0-9]/.test(prevCh) ? Number(prevCh) : d;
        const delay = reduce ? 0 : digitIdx * 30;
        digitIdx += 1;
        const digits = "0123456789".split("").map((n) => `<span>${n}</span>`).join("");
        return (
          `<span class="odo-digit-wrap" data-target="${d}" data-prev="${prevD}" data-delay="${delay}">` +
          `<span class="odo-digit-track" style="transform:translateY(-${prevD * 10}%)">${digits}</span>` +
          `</span>`
        );
      })
      .join("");
    state.prevBalanceStr = valueStr;
    return html;
  }

  function animateOdometers() {
    requestAnimationFrame(() => {
      document.querySelectorAll(".odo-digit-wrap").forEach((el) => {
        const target = Number(el.dataset.target || 0);
        const delay = Number(el.dataset.delay || 0);
        const track = el.querySelector(".odo-digit-track");
        if (!track) return;
        track.style.transitionDelay = delay + "ms";
        track.style.transform = `translateY(-${target * 10}%)`;
      });
    });
  }

  // --- Charts (<canvas>, devicePixelRatio aware) ---
  function sizeCanvas(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 358;
    const h = cssHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawLineChart(canvas, chartData) {
    if (!canvas) return;
    const { ctx, w, h } = sizeCanvas(canvas, 184);
    ctx.clearRect(0, 0, w, h);
    const pts = (chartData && chartData.points) || [];
    const startVal = Number((chartData && chartData.startValue) || (pts[0] && pts[0].value) || 36);

    if (pts.length <= 1) {
      const sy = Math.round(h * 0.56);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(235, 235, 245, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
      ctx.restore();

      const anchorVal = pts.length === 1 ? Number(pts[0].value) : startVal;
      ctx.fillStyle = "rgba(0, 211, 90, 0.24)";
      ctx.beginPath();
      ctx.arc(14, sy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#00d35a";
      ctx.beginPath();
      ctx.arc(14, sy, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '500 12px "SF Mono", ui-monospace, monospace';
      ctx.fillStyle = "rgba(235, 235, 245, 0.65)";
      ctx.fillText(`Night start · ${fmtMoney(anchorVal)}`, 30, sy - 10);
      ctx.font = '400 12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = "rgba(235, 235, 245, 0.38)";
      ctx.fillText("Awaiting trades · line updates live", 30, sy + 20);
      return;
    }

    const topPad = 48;
    const botPad = 14;
    const vals = pts.map((p) => Number(p.value)).concat([startVal]);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    if (maxV - minV < 0.01) {
      minV -= 1;
      maxV += 1;
    }
    const span = maxV - minV;
    const yFor = (v) => topPad + ((maxV - v) / span) * (h - topPad - botPad);
    const xFor = (i) => (i / (pts.length - 1)) * (w - 16) + 8;

    // Dashed start line
    const sy = yFor(startVal);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(235, 235, 245, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
    ctx.restore();

    // Gradient under line
    const grad = ctx.createLinearGradient(0, topPad, 0, h);
    grad.addColorStop(0, "rgba(0, 211, 90, 0.26)");
    grad.addColorStop(1, "rgba(0, 211, 90, 0.0)");
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xFor(i);
      const y = yFor(Number(p.value));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(pts.length - 1), h - botPad);
    ctx.lineTo(xFor(0), h - botPad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Main green line
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xFor(i);
      const y = yFor(Number(p.value));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#00d35a";
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // End dot
    const lastX = xFor(pts.length - 1);
    const lastY = yFor(Number(pts[pts.length - 1].value));
    ctx.fillStyle = "#00d35a";
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Strictly trade marks (bought / sold / stopped) — never rejected rows
    const rawMarks = (chartData && chartData.marks) || [];
    const marks = rawMarks.filter((m) =>
      m && (m.kind === "bought" || m.kind === "sold" || m.kind === "stopped")
    );
    const tsList = pts.map((p) => new Date(p.ts).getTime());
    const minT = tsList[0];
    const maxT = tsList[tsList.length - 1];
    const rowOccupied = [];
    const markColors = { blue: "#0a84ff", green: "#00d35a", red: "#ff453a" };

    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
    marks.forEach((m, idx) => {
      const mt = new Date(m.ts).getTime();
      let x = w * ((idx + 1) / (marks.length + 1));
      if (Number.isFinite(mt) && maxT > minT) {
        x = ((mt - minT) / (maxT - minT)) * (w - 40) + 20;
      }
      const label = String(m.label || "");
      const tw = ctx.measureText(label).width + 12;
      const x1 = Math.max(2, Math.min(w - tw - 2, x - tw / 2));
      const x2 = x1 + tw;
      let row = 0;
      while (row < 3) {
        const slots = rowOccupied[row] || [];
        const hit = slots.some((s) => !(x2 + 6 < s.x1 || x1 - 6 > s.x2));
        if (!hit) break;
        row += 1;
      }
      if (row >= 3) return;
      rowOccupied[row] = rowOccupied[row] || [];
      rowOccupied[row].push({ x1, x2 });
      const py = 14 + row * 18;
      const col = markColors[m.color] || "#0a84ff";

      ctx.fillStyle = "rgba(28, 28, 30, 0.94)";
      ctx.beginPath();
      ctx.roundRect(x1, py - 11, tw, 15, 6);
      ctx.fill();

      ctx.fillStyle = col;
      ctx.fillText(label, x1 + 6, py);
    });
  }

  function drawCandleChart(canvas, coin) {
    if (!canvas || !coin) return;
    const { ctx, w, h } = sizeCanvas(canvas, 204);
    ctx.clearRect(0, 0, w, h);
    const candles = (coin.candles || []).filter((c) => Number.isFinite(Number(c.price)));
    if (!candles.length) {
      ctx.font = '400 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = "rgba(235, 235, 245, 0.45)";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for 1-minute candles", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }
    if (candles.length === 1) {
      const p = Number(candles[0].price);
      const cy = Math.round(h * 0.48);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(235, 235, 245, 0.2)";
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "#00d35a";
      ctx.beginPath();
      ctx.arc(w / 2, cy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '500 12px "SF Mono", ui-monospace, monospace';
      ctx.fillStyle = "rgba(235, 235, 245, 0.65)";
      ctx.textAlign = "center";
      ctx.fillText(`${fmtPrice(p)} · 1 sample so far`, w / 2, cy + 24);
      ctx.textAlign = "left";
      return;
    }

    const prices = candles.map((c) => Number(c.price));
    if (coin.exitLine) prices.push(Number(coin.exitLine));
    const minP = Math.min(...prices) * 0.96;
    const maxP = Math.max(...prices) * 1.04;
    const span = Math.max(1e-12, maxP - minP);
    const yFor = (p) => 16 + ((maxP - p) / span) * (h - 32);

    ctx.font = '500 10px "SF Mono", ui-monospace, monospace';
    ctx.fillStyle = "rgba(235, 235, 245, 0.36)";
    ctx.fillText(fmtPrice(Math.max(...candles.map((c) => Number(c.price)))), 2, 12);

    // Orange dashed exit line
    if (coin.exitLine) {
      const ey = yFor(Number(coin.exitLine));
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "#ff9f0a";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, ey);
      ctx.lineTo(w, ey);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "#ff9f0a";
      ctx.fillText("Stop " + fmtPrice(coin.exitLine), 2, Math.max(12, ey - 5));
    }

    const step = w / Math.max(1, candles.length);
    const bw = Math.max(4, Math.min(18, step * 0.55));
    candles.forEach((c, i) => {
      const open = i === 0 ? Number(c.price) : Number(candles[i - 1].price);
      const close = Number(c.price);
      const up = close >= open;
      const col = up ? "#00d35a" : "#ff453a";
      const x = i * step + (step - bw) / 2;
      const y1 = yFor(open);
      const y2 = yFor(close);
      const top = Math.min(y1, y2);
      const bh = Math.max(3, Math.abs(y2 - y1));
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + bw / 2, top - 4);
      ctx.lineTo(x + bw / 2, top + bh + 4);
      ctx.stroke();

      ctx.fillStyle = col;
      ctx.fillRect(x, top, bw, bh);
    });
  }

  function renderScoreRingSvg(score) {
    const s = Math.max(0, Math.min(100, Number(score) || 0));
    const r = 18;
    const circ = 2 * Math.PI * r;
    const dash = (s / 100) * circ;
    const col = s >= 70 ? "#00d35a" : "#ff9f0a";
    return `
      <svg width="46" height="46" viewBox="0 0 46 46">
        <circle cx="23" cy="23" r="${r}" fill="none" stroke="#2c2c2e" stroke-width="4"/>
        <circle cx="23" cy="23" r="${r}" fill="none" stroke="${col}" stroke-width="4"
          stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" stroke-linecap="round"
          transform="rotate(-90 23 23)"/>
        <text x="23" y="27" text-anchor="middle" fill="#fff" font-size="12" font-weight="700"
          font-family="SF Mono, ui-monospace, monospace">${Math.round(s)}</text>
      </svg>`;
  }

  // --- Banners, status dot, loading ---
  function renderBanners() {
    const err = $("error-banner");
    if (state.error) {
      err.textContent = `Desk offline · retrying in ${state.retryIn}s · last update ${state.error.time}`;
      err.hidden = false;
    } else {
      err.hidden = true;
    }
    const demo = $("demo-banner");
    demo.hidden = !state.isExample;

    const sdot = $("nav-status-dot");
    if (sdot) {
      sdot.classList.remove("live", "waiting", "offline");
      if (state.error) sdot.classList.add("offline");
      else if (state.data.state && !state.isExample) sdot.classList.add("live");
      else if (state.waitingForDesk) sdot.classList.add("waiting");
    }

    const avatar = $("avatar-initials");
    if (avatar) {
      const handle = (state.data.account && state.data.account.fomoHandle) || "daddybenny";
      const clean = String(handle).replace(/^@/, "").toUpperCase();
      avatar.textContent = clean.slice(0, 2) || "DB";
    }
  }

  function renderLoadingSkeleton() {
    return `
      <div class="stack">
        <div class="skel" style="height:74px;width:62%;"></div>
        <div class="skel" style="height:22px;width:44%;"></div>
        <div class="skel" style="height:190px;"></div>
        <div class="skel" style="height:220px;border-radius:22px;"></div>
        <div class="skel" style="height:132px;"></div>
      </div>`;
  }

  function renderWaitingSetup() {
    const waitingDesk = state.waitingForDesk;
    const authErr = state.authError;
    const title = authErr
      ? "Reader credential issue"
      : waitingDesk
        ? "Waiting for desk"
        : "Connect live desk";
    const desc = authErr
      ? `Supabase refused the read token (${esc(authErr)}). Open your latest setup link or paste it below.`
      : waitingDesk
        ? "Connected to Supabase (read-only). The snapshots table is ready and polling every 15s for the desk's first publish."
        : "Open the setup link from Grok Bot or paste your read-only setup link below so your phone can stream live snapshots.";

    return `
      <div class="card" style="padding:18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="font-size:20px;font-weight:600;letter-spacing:-0.01em;">${title}</div>
          <span class="mono-pill ${waitingDesk ? "green" : authErr ? "red" : "muted"}">${waitingDesk ? "Connected" : authErr ? "Auth" : "Setup"}</span>
        </div>
        <p style="color:var(--secondary);margin:10px 0 14px;font-size:14px;">${desc}</p>
        <div class="btn-row" style="margin-top:0;">
          <button class="btn btn-primary" id="btn-open-connect" type="button">${waitingDesk ? "Refresh now" : "Paste setup link"}</button>
          <button class="btn btn-secondary" id="btn-start-demo" type="button">Preview example</button>
        </div>
      </div>
      <div class="section-head"><h2 class="section-title">Home</h2></div>
      <div class="empty-card">Waiting for the first trade</div>`;
  }

  // --- HOME ---
  function renderHome() {
    const st = state.data.state;
    if (!st) return renderWaitingSetup();
    const isPaper = String(st.mode || "PAPER").toUpperCase() === "PAPER";
    const pct = Number(st.todayPct || 0);
    const pctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    const mult = st.multiplier != null ? `${Number(st.multiplier).toFixed(2)}×` : "1.00×";
    const lane = st.lane || { bot: null, action: "Idle" };
    const laneColor = lane.bot ? ({
      scanner: "var(--cyan)", analyst: "var(--yellow)", brain: "var(--purple)",
      executor: "var(--green)", risk: "var(--pink)",
    }[lane.bot] || "var(--text)") : "var(--secondary)";
    const laneLabel = lane.bot ? `${BOT_LABELS[lane.bot] || lane.bot} · ${lane.action}` : "Idle";
    const scr = st.screen || {};
    const frameLabel = scr.fresh
      ? `<span class="dot" style="background:var(--red);"></span><span>Live · Bot's computer</span>`
      : `<span class="dot" style="background:var(--secondary);"></span><span>Last frame ${esc(scr.updatedAt ? fmtShortTime(scr.updatedAt) : "none")}</span>`;

    const last = st.lastOrder;
    const lastHtml = last
      ? `<div style="min-width:0;flex:1;">
           <div style="font-weight:600;font-size:14px;line-height:1.25;">
             ${last.side === "sell" ? "Sold" : "Bought"} ${esc(last.symbol || (last.mint || "").slice(0, 6))} · ${last.usd != null ? fmtMoney(last.usd) : (last.pct ? last.pct + "%" : "—")} · ${last.checks && last.checks.screen ? "verified" : esc(last.status || "queued")}
           </div>
           <div class="act-sub">Plan B frame poll · every ${scr.planBIntervalS || 15}s</div>
         </div>
         <div class="order-checks">
           <span class="check-chip ${last.checks && last.checks.screen ? "ok" : ""}">screen</span>
           <span class="check-chip ${last.checks && last.checks.api ? "ok" : ""}">api</span>
           <span class="check-chip ${last.checks && last.checks.chain ? "ok" : ""}">chain</span>
         </div>`
      : `<div class="act-sub">No order clicked yet</div>`;

    const bots = st.bots || [];
    const runningCount = bots.filter((b) => !b.paused).length || bots.length || 5;
    const actPreview = filterBySearch(st.activityPreview || []);

    return `
      <section>
        <div class="balance-row">
          <div class="balance-odo num" id="balance-odo" aria-label="${esc(fmtMoney(st.balance))}" data-balance="${esc(fmtMoney(st.balance))}">${renderOdometerHtml(fmtMoney(st.balance))}</div>
          ${isPaper ? `<span class="paper-pill">PAPER</span>` : ""}
        </div>
        <div class="delta-row">
          <span class="today-pct num ${pct < 0 ? "neg" : ""}">${esc(pctStr)} today</span>
          <span class="mult-pill num">${esc(mult)}</span>
        </div>

        <div class="chart-wrap">
          <canvas id="home-chart" class="chart-canvas"></canvas>
          <div class="range-switch">
            ${RANGES.map((r) => `<button class="range-btn ${state.range === r ? "active" : ""}" data-range="${r}" type="button">${r}</button>`).join("")}
          </div>
        </div>

        <div class="live-screen-card">
          <div class="screen-frame-box" id="live-screen-tap">
            <img id="screen-img-0" alt="Bot screen slot 0">
            <img id="screen-img-1" alt="Bot screen slot 1">
            <div class="screen-empty-msg" id="screen-empty-msg">
              <div>${scr.available ? "Loading frame…" : "No screen frame yet"}</div>
              <div class="screen-empty-sub">Updates every 15s during click runs</div>
            </div>
            <div class="screen-overlay-top">
              <div class="screen-pill">${frameLabel}</div>
              <div class="screen-pill" style="color:${laneColor};">${esc(laneLabel)}</div>
            </div>
          </div>
          <div class="live-screen-foot">${lastHtml}</div>
        </div>

        <div class="section-head">
          <h2 class="section-title">Bots · ${runningCount} running</h2>
          <button class="link-btn" data-go-tab="bots" type="button">See all</button>
        </div>
        <div class="bots-carousel">
          ${bots.map(renderBotMiniCard).join("")}
        </div>

        <div class="section-head">
          <h2 class="section-title">Activity</h2>
          <button class="link-btn" data-go-tab="activity" type="button">See all</button>
        </div>
        ${actPreview.length ? `<div class="list-card">${actPreview.slice(0, 5).map(renderActivityRow).join("")}</div>` : `<div class="empty-card">Waiting for the first trade</div>`}
      </section>`;
  }

  function renderBotMiniCard(b) {
    const name = b.name;
    const label = BOT_LABELS[name] || name;
    let body = "";
    if (name === "scanner") {
      const feed = (b.feed || []).slice(0, 3).map((f) =>
        f.verdict === "kill"
          ? `<div class="feed-kill"><span class="strike">${esc(f.symbol)}</span><span class="reason">${esc(f.reason)}</span></div>`
          : `<div class="feed-pass">${esc(f.symbol)} → Analyst</div>`
      ).join("");
      body = `<div class="scanner-feed">${feed || `<div class="act-sub">${esc(b.subtitle || "Watching PumpSwap")}</div>`}</div>`;
    } else if (name === "analyst") {
      const layers = b.layers || [null, null, null, null, null, null, null, null];
      const strips = layers.slice(0, 8).map((v) =>
        `<span class="layer-strip ${v === true ? "ok" : v === false ? "bad" : ""}"></span>`
      ).join("");
      body = `
        <div class="layer-strips">${strips}</div>
        <div class="score-row">
          ${renderScoreRingSvg(b.score != null ? b.score : (b.last && b.last.score) || 0)}
          <div style="min-width:0;">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(b.subtitle || "Social: off")}</div>
            <div class="act-sub">Green from 70</div>
          </div>
        </div>`;
    } else if (name === "brain") {
      body = `
        <div class="num" style="font-size:18px;font-weight:600;">${esc(b.title)}</div>
        <div class="act-sub">${esc(b.subtitle || "80+ = full size")}</div>`;
    } else if (name === "executor") {
      body = `
        <div><span class="mono-pill green">${esc(b.subtitle || "Idle")}</span></div>
        <div class="act-sub">1 order at a time</div>`;
    } else {
      const sp = b.stopPct || 22;
      const tr = b.trailPct || 40;
      body = `
        <div style="font-weight:600;">${esc(b.title)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <span class="mono-pill red">stop -${sp}%</span>
          <span class="mono-pill green">trail ${tr}%</span>
        </div>`;
    }
    return `
      <article class="bot-mini-card" data-go-tab="bots">
        <div class="bot-head">
          <div class="bot-name"><span class="dot" style="background:${esc(b.color)};"></span><span>${esc(label)}</span></div>
          <span class="bot-count">${esc(b.title)}</span>
        </div>
        ${body}
      </article>`;
  }

  // --- BOTS TAB ---
  function renderBotsTab() {
    const st = state.data.state;
    if (!st) return renderWaitingSetup();
    return `
      <div class="stack">
        ${(st.bots || []).map((b) => {
          const dec = (state.data.decisions[b.name] && state.data.decisions[b.name].decisions) || [];
          const rows = dec.slice(0, 20).map((d) => {
            const coinObj = d.mint ? state.data.coins[d.mint] : null;
            const sym = d.symbol || (coinObj && (coinObj.symbol || coinObj.name)) || (d.mint || "").slice(0, 6);
            const hasAudit = d.mint && state.data.audits[d.mint];
            const openKind = hasAudit ? "audit" : "coin";
            return `
            <div class="decision-row">
              <div class="decision-left" ${d.mint ? `data-open-kind="${openKind}" data-mint="${esc(d.mint)}"` : ""}>
                <span style="font-weight:600;">${esc(sym)}</span>
                <span class="act-sub" style="display:inline;"> · ${esc(d.reason || d.verdict || d.status || (d.score != null ? "score " + d.score : ""))}</span>
              </div>
              ${d.link ? `<a class="fomo-chip" href="${esc(d.link)}" target="_blank" rel="noopener noreferrer"><span class="fomo-chip-inner">Open on FOMO</span></a>` : ""}
            </div>`;
          }).join("");
          const dotColor = b.paused ? "var(--secondary)" : "var(--green)";
          return `
            <section class="card">
              <div class="bot-head">
                <div>
                  <div class="bot-name"><span class="dot" style="background:${esc(b.color)};"></span><span>${esc(BOT_LABELS[b.name] || b.name)}</span></div>
                  <div class="act-sub"><span class="dot" style="background:${dotColor};width:6px;height:6px;margin-right:5px;"></span>${b.paused ? "Paused" : esc(b.status)} · ${esc(b.title)}</div>
                </div>
                <button class="switch-btn" data-toggle-bot="${esc(b.name)}" data-locked="${b.pauseLocked ? "1" : "0"}" type="button" aria-label="Pause ${esc(b.name)}">
                  <span class="switch-track ${b.paused ? "paused" : ""} ${b.pauseLocked ? "locked" : ""}">
                    <span class="switch-knob"></span>
                  </span>
                </button>
              </div>
              ${b.pauseLocked ? `<div class="act-sub" style="color:var(--orange);margin-top:6px;">Risk pause locked while a position is open</div>` : ""}
              <div style="margin-top:10px;">${rows || `<div class="act-sub">No decisions logged yet</div>`}</div>
              <div style="margin-top:6px;">
                <button class="link-btn" data-go-settings="1" type="button">Settings ›</button>
              </div>
            </section>`;
        }).join("")}
      </div>`;
  }

  // --- ACTIVITY TAB ---
  function filterBySearch(rows) {
    const q = state.searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.title || ""} ${r.subtitle || ""} ${r.mint || ""}`.toLowerCase().includes(q)
    );
  }

  function renderActivityRow(r) {
    const isTrade = r.kind === "bought" || r.kind === "sold" || r.kind === "stopped";
    const hasAudit = r.mint && state.data.audits[r.mint];
    const openKind = isTrade ? "coin" : (hasAudit ? "audit" : "coin");
    const rightCls = r.kind === "sold" ? "pos" : r.kind === "stopped" ? "neg" : "";
    return `
      <div class="act-row">
        <div class="act-main" data-open-kind="${openKind}" data-mint="${esc(r.mint || "")}">
          <div class="act-title">${esc(r.title)}</div>
          <div class="act-sub">${esc(r.subtitle || (r.ts ? fmtShortTime(r.ts) : ""))}</div>
        </div>
        <div class="act-right-col">
          ${r.value ? `<div class="act-right num ${rightCls}">${esc(r.value)}</div>` : ""}
          ${r.link ? `<a class="fomo-chip" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer"><span class="fomo-chip-inner">Open on FOMO</span></a>` : ""}
        </div>
      </div>`;
  }

  function renderActivityTab() {
    if (!state.data.state && !state.data.activity) return renderWaitingSetup();
    const act = state.data.activity;
    let rows = filterBySearch((act && act.rows) || []);
    if (state.activityFilter === "trades") {
      rows = rows.filter((r) => r.kind === "bought" || r.kind === "sold" || r.kind === "stopped");
    } else if (state.activityFilter === "rejected") {
      rows = rows.filter((r) => r.kind === "rejected");
    }
    const seg = `
      <div class="seg-filter" role="tablist" aria-label="Activity filter">
        ${[
          ["all", "All"],
          ["trades", "Trades"],
          ["rejected", "Rejected"],
        ].map(([k, lbl]) =>
          `<button class="seg-btn ${state.activityFilter === k ? "active" : ""}" data-act-filter="${k}" type="button">${lbl}</button>`
        ).join("")}
      </div>`;
    if (!rows.length) {
      return `${seg}<div class="empty-card">Nothing yet tonight</div>`;
    }
    return `${seg}<div class="list-card">${rows.map(renderActivityRow).join("")}</div>`;
  }

  // --- AUDIT SUBSCREEN ---
  function renderAuditScreen(mint) {
    const a = state.data.audits[mint];
    const c = state.data.coins[mint];
    if (!a) {
      return `
        <button class="link-btn" data-back="1" type="button">‹ Back</button>
        <div class="empty-card" style="margin-top:10px;">
          <div>No 8-layer audit recorded for ${esc((c && (c.name || c.symbol)) || mint.slice(0, 8))}</div>
          ${c && c.link ? `<div style="margin-top:14px;"><a class="btn btn-primary" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">Open on FOMO</a></div>` : ""}
        </div>`;
    }
    const discs = (a.layers || []).map((L) => {
      const cls = L.pass === true ? "ok" : L.pass === false ? "bad" : "grey";
      const icon = L.pass === true ? "✓" : L.pass === false ? "✕" : String(L.n);
      const valText = L.value || "";
      const isMutedVal = valText === "not checked" || !valText;
      return `
        <div class="disc-cell">
          <div class="disc ${cls}">${icon}</div>
          <div class="disc-name">${esc(L.name || "Layer " + L.n)}</div>
          <div class="disc-val ${isMutedVal ? "muted" : ""}">${esc(valText)}</div>
        </div>`;
    }).join("");
    return `
      <div>
        <button class="link-btn" data-back="1" type="button">‹ Back</button>
        <div class="coin-top" style="margin-top:4px;">
          <div>
            <h1 style="margin:0;font-size:22px;">${esc(a.name || (c && c.name) || a.symbol || mint.slice(0, 8))}</h1>
            <div class="act-sub">${esc(a.symbol || (c && c.symbol) || "")} · Score ${esc(a.score != null ? a.score : "—")}</div>
          </div>
          ${renderScoreRingSvg(a.score || 0)}
        </div>
        <div class="audit-discs">
          <div class="audit-beam"></div>
          ${discs}
        </div>
        <div class="card">
          <div style="font-weight:600;">${esc((a.social && a.social.label) || "Social: off")}</div>
          ${a.reason ? `<div class="act-sub" style="color:var(--red);margin-top:4px;">Stopped: ${esc(a.reason)}</div>` : ""}
        </div>
        ${a.link ? `<div style="margin-top:12px;"><a class="btn btn-primary" style="width:100%;" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Open on FOMO</a></div>` : ""}
      </div>`;
  }

  // --- COIN SUBSCREEN ---
  function renderCoinScreen(mint) {
    const c = state.data.coins[mint];
    const st = state.data.state;
    const isPaper = !st || String(st.mode || "PAPER").toUpperCase() === "PAPER";
    if (!c) {
      return `
        <button class="link-btn" data-back="1" type="button">‹ Back</button>
        <div class="empty-card" style="margin-top:10px;">Coin details unavailable for ${esc(mint.slice(0, 8))}…</div>`;
    }
    const chg = c.changeSinceEntry;
    const chgStr = chg == null ? "" : `${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg).toFixed(2)}% since entry`;
    const pos = c.position;
    const hasAudit = Boolean(c.shield || state.data.audits[mint]);
    const shieldLabel = c.shield || "No audit";
    const shieldClass = c.shield ? "blue" : "muted";
    return `
      <div>
        <button class="link-btn" data-back="1" type="button">‹ Back</button>
        <div class="coin-top" style="margin-top:6px;">
          <div style="min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <h1 style="margin:0;font-size:22px;">${esc(c.name || c.symbol || mint.slice(0, 8))}</h1>
              ${isPaper ? `<span class="paper-pill" style="margin-top:0;">PAPER</span>` : ""}
            </div>
            <div class="act-sub">${esc(c.symbol || "Coin")} · ${esc(c.chain || "Solana")} · ${esc(c.age || "—")}</div>
          </div>
          ${hasAudit
            ? `<button class="mono-pill ${shieldClass}" data-open-kind="audit" data-mint="${esc(mint)}" type="button" style="border:0;cursor:pointer;min-height:36px;">${esc(shieldLabel)}</button>`
            : `<span class="mono-pill muted" style="min-height:32px;">${esc(shieldLabel)}</span>`}
        </div>

        <div class="price-big num">${fmtPrice(c.price)}</div>
        ${chgStr ? `<div class="today-pct num ${chg < 0 ? "neg" : ""}">${esc(chgStr)}</div>` : ""}

        <div class="chart-wrap">
          <canvas id="coin-candle-chart" class="candle-canvas"></canvas>
        </div>

        <div class="tiles-grid">
          <div class="tile"><div class="tile-k">Market cap</div><div class="tile-v num">${c.marketCap != null ? fmtCompactMoney(c.marketCap) : "—"}</div></div>
          <div class="tile"><div class="tile-k">Liquidity</div><div class="tile-v num">${c.liquidity != null ? fmtCompactMoney(c.liquidity) : "—"}</div></div>
          <div class="tile"><div class="tile-k">Holders</div><div class="tile-v num">${c.holders != null ? fmtInt(c.holders) : "—"}</div></div>
        </div>

        <div class="card" style="margin-top:12px;">
          ${pos
            ? `<div style="font-weight:600;">Your position · ${fmtMoney(pos.size_usd)} in · Executor</div>
               <div class="act-sub">Entry ${fmtPrice(pos.entry_price)} · Stop ${fmtPrice(pos.stop_price)}</div>`
            : `<div class="act-sub">No open position</div>`}
        </div>

        <div class="btn-row" style="${pos ? "" : "grid-template-columns:1fr;"}">
          ${c.link ? `<a class="btn btn-primary" href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">Open on FOMO</a>` : `<span></span>`}
          ${pos ? `<button class="btn btn-danger" id="btn-sell-now" data-mint="${esc(mint)}" data-symbol="${esc(c.symbol || "coin")}" type="button">Sell now</button>` : ""}
        </div>
      </div>`;
  }

  // --- ACCOUNT TAB ---
  function findSettingSpec(key) {
    const groups = (state.data.settings && state.data.settings.groups) || {};
    for (const g of Object.keys(groups)) {
      const hit = (groups[g] || []).find((item) => item.key === key || item.name === key);
      if (hit) return hit;
    }
    return null;
  }

  function settingRowHtml(item) {
    const hasRange = item.min != null && item.max != null;
    const typ = item.type || "";
    let controls = "";
    if (typ === "mode") {
      controls = `<div class="act-sub">Current: ${esc(item.value || "PAPER")} · use the switch above (type LIVE to confirm)</div>`;
    } else if (typ === "enum" && item.choices) {
      const opts = item.choices.map((c) =>
        `<option value="${esc(c)}" ${String(item.value) === String(c) ? "selected" : ""}>${esc(c)}</option>`
      ).join("");
      controls = `<select class="setting-num" data-setting-key="${esc(item.key)}">${opts}</select>`;
    } else if (typ === "bool") {
      const on = item.value === true || item.value === "true";
      controls = `<select class="setting-num" data-setting-key="${esc(item.key)}">
        <option value="true" ${on ? "selected" : ""}>true</option>
        <option value="false" ${!on ? "selected" : ""}>false</option>
      </select>`;
    } else if (typ === "time") {
      controls = `<input class="setting-num" type="time" value="${esc(item.value)}" data-setting-key="${esc(item.key)}">`;
    } else {
      controls = `
        ${hasRange ? `<input type="range" min="${item.min}" max="${item.max}" step="${typ === "int" ? 1 : "any"}" value="${esc(item.value)}" data-setting-range="${esc(item.key)}" aria-label="${esc(item.name)} slider">` : ""}
        <input class="setting-num" type="${hasRange ? "number" : "text"}" ${hasRange ? `min="${item.min}" max="${item.max}" step="${typ === "int" ? 1 : "any"}"` : ""} value="${esc(item.value)}" data-setting-key="${esc(item.key)}">`;
    }
    return `
      <div class="setting-row">
        <div class="setting-head">
          <span style="font-weight:500;">${esc(item.name)}</span>
          <span class="act-sub">${hasRange ? `${item.min}–${item.max}` : typ === "mode" ? "PAPER / LIVE" : esc(typ)}</span>
        </div>
        <div class="setting-controls">${controls}</div>
      </div>`;
  }

  async function commitSetting(key, raw) {
    const spec = findSettingSpec(key);
    if (spec && spec.type === "mode") {
      toast("Use the PAPER / LIVE switch (type LIVE to confirm)");
      return false;
    }
    if (spec && spec.min != null && spec.max != null) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
        toast((spec.name || key) + " out of range (" + spec.min + "–" + spec.max + ")");
        if (spec) {
          document.querySelectorAll(`[data-setting-key="${key}"]`).forEach((el) => { el.value = spec.value; });
          document.querySelectorAll(`[data-setting-range="${key}"]`).forEach((el) => { el.value = spec.value; });
        }
        return false;
      }
    }
    if (state.sourceMode === "api") {
      try {
        const result = await fetchJson("/api/settings", true, { method: "POST", body: { key, value: raw } });
        if (result && result.ok && state.data.settings && state.data.settings.groups) {
          const groups = state.data.settings.groups;
          for (const g of Object.keys(groups)) {
            groups[g].forEach((item) => {
              if (item.key === key) item.value = result.new != null ? result.new : raw;
            });
          }
        }
        toast((spec && spec.name) || key);
        return true;
      } catch (err) {
        toast((err && err.message) || "setting refused");
        return false;
      }
    }
    if (state.isExample) {
      toast("Example data is read-only");
      return false;
    }
    toast("Send 'set " + key + " to " + raw + "' in Telegram");
    return false;
  }

  function renderAccountTab() {
    const acc = state.data.account || {
      mode: "PAPER",
      fomoHandle: "daddybenny",
      profileUrl: null,
      signupUrl: null,
      push: { channel: "telegram", planB: "Telegram only", connected: false },
      copyPicks: "off",
    };
    const set = state.data.settings;
    const isPaper = String(acc.mode || "PAPER").toUpperCase() === "PAPER";
    const cashVal = state.data.state && state.data.state.balance != null
      ? state.data.state.balance
      : (state.data.state && state.data.state.paperStartCash) || 36;
    const groups = (set && set.groups) || {};
    const groupHtml = Object.keys(groups).map((g) => `
      <details class="card" ${g === "risk" || g === "desk" ? "open" : ""}>
        <summary style="font-weight:600;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;">
          <span>${esc(g)}</span><span class="act-sub">${groups[g].length} settings</span>
        </summary>
        ${groups[g].map((item) => settingRowHtml(item)).join("")}
      </details>`).join("");

    const sourceLabel = state.isExample
      ? "Example preview"
      : state.sourceMode === "supabase"
        ? (state.waitingForDesk ? "Supabase · waiting for desk" : "Supabase · read-only")
        : state.sourceMode === "local"
          ? "Local snapshot files"
          : state.sourceMode === "api"
            ? "Desk API"
            : "Not connected";

    return `
      <div class="stack">
        <section class="card">
          <div class="bot-head">
            <div style="min-width:0;">
              <div style="font-weight:600;">Live desk connection</div>
              <div class="act-sub">${esc(sourceLabel)}${state.lastUpdatedText ? " · " + esc(state.lastUpdatedText) : ""}</div>
            </div>
            <button class="pill-btn accent-blue" id="btn-open-connect" type="button">${hasSupabaseCredentials() ? "Update link" : "Connect"}</button>
          </div>
          <div class="btn-row" style="margin-top:10px;">
            <button class="btn btn-secondary" id="btn-refresh-now" type="button">Refresh now</button>
            ${hasSupabaseCredentials() ? `<button class="btn btn-secondary" id="btn-clear-creds" type="button">Disconnect</button>` : `<button class="btn btn-secondary" id="btn-start-demo" type="button">Preview example</button>`}
          </div>
        </section>

        <section class="card">
          <div class="bot-head">
            <div>
              <div style="font-weight:600;">Trading mode</div>
              <div class="act-sub">${isPaper ? "PAPER (simulated fills, never clicks final Buy)" : "LIVE"}</div>
            </div>
            <button class="pill-btn" id="btn-toggle-mode" type="button">${isPaper ? "Switch to LIVE" : "Switch to PAPER"}</button>
          </div>
          <div class="setting-row" style="margin-top:10px;">
            <div class="setting-head"><span>Cash</span><span class="num" style="font-weight:600;">${fmtMoney(cashVal)}</span></div>
          </div>
        </section>

        <section class="card">
          <div style="font-weight:600;margin-bottom:10px;">FOMO Links</div>
          <div class="btn-row" style="margin-top:0;">
            ${acc.profileUrl ? `<a class="btn btn-secondary" href="${esc(acc.profileUrl)}" target="_blank" rel="noopener noreferrer">Your FOMO profile</a>` : `<button class="btn btn-secondary" disabled>Profile pending</button>`}
            <button class="btn btn-primary" id="btn-invite-friend" data-url="${esc(acc.signupUrl || "")}" type="button">Invite a friend</button>
          </div>
        </section>

        <section class="card">
          <div style="font-weight:600;">Copy picks</div>
          <div class="act-sub" style="margin-top:2px;">How often to refresh leaderboard picks</div>
          <div class="range-switch" style="margin-top:8px;">
            ${["off", "24h", "12h", "6h"].map((opt) =>
              `<button class="range-btn ${(acc.copyPicks || "off") === opt ? "active" : ""}" data-copypicks="${opt}" type="button">${opt}</button>`
            ).join("")}
          </div>
          <div class="setting-row">
            <div class="setting-head">
              <span>Run time</span>
              <input class="setting-num" id="copy-picks-time" type="time" value="${esc(state.copyPicksTime)}">
            </div>
          </div>
        </section>

        <section class="card">
          <div class="bot-head">
            <div>
              <div style="font-weight:600;">Pushes</div>
              <div class="act-sub">${esc((acc.push && acc.push.planB) || "Telegram only")} · ${acc.push && acc.push.connected ? "connected" : "not connected"}</div>
            </div>
            <button class="pill-btn" id="btn-test-push" type="button">Send test push</button>
          </div>
          <div style="margin-top:10px;">
            <button class="btn btn-secondary" id="btn-enable-webpush" style="width:100%;" type="button">Enable notifications</button>
          </div>
        </section>

        <section class="card">
          <div class="bot-head">
            <div>
              <div style="font-weight:600;">Watch in Grok Bot</div>
              <div class="act-sub">Open your own computer preview</div>
            </div>
            <button class="pill-btn accent-blue" id="btn-watch-desk" type="button">Open</button>
          </div>
        </section>

        <div class="section-head" style="margin-bottom:2px;"><h2 class="section-title">Settings (STEP 12)</h2></div>
        ${groupHtml || `<div class="empty-card">Settings load once snapshots are connected</div>`}
      </div>`;
  }

  // --- Render root + bind ---
  function render() {
    renderBanners();
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", !state.subview && b.dataset.tab === state.tab);
    });
    const root = $("view-root");
    if (state.loading) {
      root.innerHTML = renderLoadingSkeleton();
      return;
    }
    if (state.subview) {
      root.innerHTML = state.subview.type === "coin"
        ? renderCoinScreen(state.subview.mint)
        : renderAuditScreen(state.subview.mint);
    } else if (state.tab === "home") {
      root.innerHTML = renderHome();
    } else if (state.tab === "bots") {
      root.innerHTML = renderBotsTab();
    } else if (state.tab === "activity") {
      root.innerHTML = renderActivityTab();
    } else {
      root.innerHTML = renderAccountTab();
    }

    if (!state.subview && state.tab === "home" && state.data.state) {
      animateOdometers();
      drawLineChart($("home-chart"), state.data.charts[state.range] || state.data.charts.LIVE);
      refreshScreenImage();
    }
    if (state.subview && state.subview.type === "coin") {
      drawCandleChart($("coin-candle-chart"), state.data.coins[state.subview.mint]);
    }
  }

  // --- Double-buffered Live Screen (Supabase base64 OR local/API JPEG) ---
  function showScreenDataUrl(srcUrl) {
    const nextSlot = state.screenVisibleSlot === 0 ? 1 : 0;
    const nextImg = $("screen-img-" + nextSlot);
    const curImg = $("screen-img-" + state.screenVisibleSlot);
    if (!nextImg) return;
    nextImg.onload = () => {
      nextImg.classList.add("visible");
      if (curImg) curImg.classList.remove("visible");
      if (state.activeScreenBlobUrl && state.activeScreenBlobUrl.indexOf("blob:") === 0) {
        URL.revokeObjectURL(state.activeScreenBlobUrl);
      }
      state.activeScreenBlobUrl = srcUrl;
      state.screenVisibleSlot = nextSlot;
      const emptyMsg = $("screen-empty-msg");
      if (emptyMsg) emptyMsg.hidden = true;
    };
    nextImg.src = srcUrl;
  }

  function refreshScreenImage() {
    const st = state.data.state;
    if (!st || state.isExample) return;
    const sp = state.data.screenPayload;
    if (state.sourceMode === "supabase" && sp && sp.available && sp.data) {
      showScreenDataUrl("data:image/jpeg;base64," + sp.data);
      return;
    }
    if (!st.screen || !st.screen.available) return;
    const url =
      state.sourceMode === "api"
        ? "/api/screen.jpg?ts=" + Date.now()
        : state.snapshotBase.replace(/\/+$/, "") + "/screen.jpg?ts=" + Date.now();
    const headers = {};
    if (state.sourceMode === "api" && getAppToken()) {
      headers["Authorization"] = "Bearer " + getAppToken();
    }
    fetch(url, { headers, cache: "no-store" })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob) return;
        showScreenDataUrl(URL.createObjectURL(blob));
      })
      .catch(() => {});
  }

  // --- Sheets & Modals ---
  function openSheet(html) {
    $("sheet-box").innerHTML = html;
    $("sheet-backdrop").hidden = false;
  }

  function closeSheet() {
    $("sheet-backdrop").hidden = true;
    $("sheet-box").innerHTML = "";
  }

  function openConnectSheet() {
    openSheet(`
      <h3 style="margin:0 0 6px;">Connect live desk</h3>
      <div class="act-sub" style="margin-bottom:12px;">Paste your setup link from Grok Bot, or enter your read-only credential and publishable key.</div>
      <input id="connect-link-input" class="sheet-input" placeholder="Paste full setup link (#t=...&k=...)" autocomplete="off" spellcheck="false">
      <input id="connect-token-input" class="sheet-input" placeholder="Or reader token" value="${esc(getAppToken())}" autocomplete="off" spellcheck="false">
      <input id="connect-apikey-input" class="sheet-input" placeholder="Or Supabase publishable key" value="${esc(getSbApiKey())}" autocomplete="off" spellcheck="false">
      <div class="btn-row">
        <button class="btn btn-secondary" id="sheet-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="sheet-save-connect" type="button">Connect</button>
      </div>`);
  }

  function openScreenModal() {
    const st = state.data.state;
    const img = $("modal-img");
    const ph = $("modal-placeholder");
    state.zoomScale = 1;
    img.style.transform = "scale(1)";
    if (state.activeScreenBlobUrl) {
      img.src = state.activeScreenBlobUrl;
      img.hidden = false;
      ph.hidden = true;
    } else {
      img.hidden = true;
      ph.hidden = false;
    }
    const fomoBtn = $("screen-modal-fomo");
    const link = st && ((st.screen && st.screen.coinLink) || (st.lastOrder && st.lastOrder.link));
    if (link) {
      fomoBtn.href = link;
      fomoBtn.hidden = false;
    } else {
      fomoBtn.hidden = true;
    }
    $("screen-modal").hidden = false;
  }

  // --- Event delegation ---
  document.addEventListener("click", async (e) => {
    const t = e.target;

    if (t.closest("[data-tab]")) {
      state.tab = t.closest("[data-tab]").dataset.tab;
      state.subview = null;
      render();
      return;
    }
    if (t.closest("[data-go-tab]")) {
      state.tab = t.closest("[data-go-tab]").dataset.goTab;
      state.subview = null;
      render();
      return;
    }
    if (t.closest("[data-go-settings]")) {
      state.tab = "account";
      state.subview = null;
      render();
      return;
    }
    if (t.closest("[data-act-filter]")) {
      state.activityFilter = t.closest("[data-act-filter]").dataset.actFilter;
      render();
      return;
    }
    if (t.closest("#btn-avatar") || t.closest("#btn-open-account-setup")) {
      state.tab = "account";
      state.subview = null;
      render();
      return;
    }
    if (t.closest("#btn-home-title")) {
      state.tab = "home";
      state.subview = null;
      render();
      return;
    }
    if (t.closest("#btn-search")) {
      $("search-bar").hidden = !$("search-bar").hidden;
      if (!$("search-bar").hidden) $("search-input").focus();
      return;
    }
    if (t.closest("#search-clear")) {
      state.searchQuery = "";
      $("search-input").value = "";
      $("search-bar").hidden = true;
      render();
      return;
    }
    if (t.closest("#btn-bell")) {
      state.tab = "activity";
      state.subview = null;
      $("bell-dot").hidden = true;
      render();
      return;
    }
    if (t.closest("#btn-open-connect")) {
      if (state.waitingForDesk && t.closest("#btn-open-connect").textContent === "Refresh now") {
        await refreshData();
        return;
      }
      openConnectSheet();
      return;
    }
    if (t.closest("#sheet-save-connect")) {
      const linkRaw = (($("connect-link-input") || {}).value || "").trim();
      let tok = (($("connect-token-input") || {}).value || "").trim();
      let apikey = (($("connect-apikey-input") || {}).value || "").trim();
      let sbUrl = "";
      if (linkRaw) {
        const hashIdx = linkRaw.indexOf("#");
        const frag = hashIdx >= 0 ? linkRaw.slice(hashIdx + 1) : linkRaw;
        const p = parseHashParams("#" + frag);
        if (p) {
          if (p.tok) tok = p.tok;
          if (p.apikey) apikey = p.apikey;
          if (p.sbUrl) sbUrl = p.sbUrl;
        }
      }
      if (!tok || !apikey) {
        toast("Paste your setup link or both token + publishable key");
        return;
      }
      if (!saveCredentials({ token: tok, apikey, url: sbUrl || getSbUrl() })) return;
      try { localStorage.setItem(SOURCE_KEY, "supabase"); } catch (_) {}
      state.sourceMode = "supabase";
      state.loading = true;
      closeSheet();
      render();
      await refreshData();
      return;
    }
    if (t.closest("#btn-refresh-now")) {
      state.loading = true;
      render();
      await refreshData();
      toast(state.data.state ? "Refreshed" : "Still waiting for desk");
      return;
    }
    if (t.closest("#btn-clear-creds")) {
      clearCredentials();
      state.sourceMode = "none";
      state.data.state = null;
      state.waitingForDesk = false;
      state.authError = null;
      render();
      toast("Disconnected");
      return;
    }
    if (t.closest("#btn-start-demo")) {
      state.sourceMode = "demo";
      await refreshData();
      return;
    }
    if (t.closest("#btn-exit-demo")) {
      state.isExample = false;
      state.data.state = null;
      state.sourceMode = hasSupabaseCredentials() ? "supabase" : "auto";
      await refreshData();
      return;
    }
    if (t.closest("[data-range]")) {
      state.range = t.closest("[data-range]").dataset.range;
      await refreshData();
      return;
    }
    if (t.closest("#live-screen-tap")) {
      openScreenModal();
      return;
    }
    if (t.closest("#screen-modal-close")) {
      $("screen-modal").hidden = true;
      return;
    }
    if (t.closest("#zoom-in")) {
      state.zoomScale = Math.min(3, state.zoomScale + 0.5);
      $("modal-img").style.transform = `scale(${state.zoomScale})`;
      return;
    }
    if (t.closest("#zoom-out")) {
      state.zoomScale = Math.max(1, state.zoomScale - 0.5);
      $("modal-img").style.transform = `scale(${state.zoomScale})`;
      return;
    }
    if (t.closest("#zoom-reset")) {
      state.zoomScale = 1;
      $("modal-img").style.transform = "scale(1)";
      return;
    }
    if (t.closest("[data-back]")) {
      state.subview = null;
      render();
      return;
    }
    if (t.closest("[data-open-kind]")) {
      const el = t.closest("[data-open-kind]");
      const kind = el.dataset.openKind;
      const mint = el.dataset.mint;
      if (!mint) return;
      if (kind === "coin") {
        await loadCoinDetail(mint);
        state.subview = { type: "coin", mint };
      } else {
        await loadAuditDetail(mint);
        state.subview = { type: "audit", mint };
      }
      render();
      return;
    }
    if (t.closest("#btn-sell-now")) {
      const btn = t.closest("#btn-sell-now");
      const mint = btn.dataset.mint;
      const sym = btn.dataset.symbol;
      openSheet(`
        <h3 style="margin:0 0 8px;">Sell ${esc(sym)}</h3>
        <div class="act-sub" style="margin-bottom:12px;">Select share to queue for Executor</div>
        <div class="range-switch" style="margin-bottom:14px;">
          <button class="range-btn active" data-sell-pct="25" type="button">25%</button>
          <button class="range-btn" data-sell-pct="50" type="button">50%</button>
          <button class="range-btn" data-sell-pct="100" type="button">100%</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="sheet-cancel" type="button">Cancel</button>
          <button class="btn btn-danger" id="sheet-confirm-sell" data-mint="${esc(mint)}" data-pct="25" type="button">Confirm sell</button>
        </div>`);
      return;
    }
    if (t.closest("[data-sell-pct]")) {
      const p = t.closest("[data-sell-pct]").dataset.sellPct;
      document.querySelectorAll("[data-sell-pct]").forEach((b) => b.classList.toggle("active", b.dataset.sellPct === p));
      const cbtn = $("sheet-confirm-sell");
      if (cbtn) cbtn.dataset.pct = p;
      return;
    }
    if (t.closest("#sheet-cancel") || t === $("sheet-backdrop")) {
      closeSheet();
      return;
    }
    if (t.closest("#sheet-confirm-sell")) {
      const cbtn = t.closest("#sheet-confirm-sell");
      const mint = cbtn.dataset.mint;
      const pct = Number(cbtn.dataset.pct || 100);
      if (state.sourceMode === "api") {
        try {
          await fetch("/api/sell/" + encodeURIComponent(mint), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + getAppToken(),
            },
            body: JSON.stringify({ pct, confirm: true }),
          });
          toast(`Queued ${pct}% sell`);
        } catch (_) {
          toast("Use Telegram: sell " + pct + "%");
        }
      } else {
        toast(`Plan B static view: send 'sell ${pct}%' in Telegram`);
      }
      closeSheet();
      return;
    }
    if (t.closest("#btn-invite-friend")) {
      const url = t.closest("#btn-invite-friend").dataset.url;
      if (!url) {
        toast("Signup URL loads with snapshots");
        return;
      }
      if (navigator.share) {
        try {
          await navigator.share({ title: "FOMO", url });
          return;
        } catch (_) {}
      }
      try {
        await navigator.clipboard.writeText(url);
        toast("Link copied");
      } catch (_) {
        toast(url);
      }
      return;
    }
    if (t.closest("#btn-toggle-mode")) {
      openSheet(`
        <h3 style="margin:0 0 8px;">Switch to LIVE</h3>
        <div class="act-sub" style="margin-bottom:10px;">Requires 1 full PAPER night, STEP 15 passed, and typing LIVE below.</div>
        <input id="live-confirm-input" class="sheet-input" placeholder="Type LIVE">
        <div class="btn-row">
          <button class="btn btn-secondary" id="sheet-cancel" type="button">Cancel</button>
          <button class="btn btn-danger" id="sheet-confirm-live" type="button">Confirm</button>
        </div>`);
      return;
    }
    if (t.closest("#sheet-confirm-live")) {
      const val = ($("live-confirm-input") || {}).value || "";
      if (val.trim() !== "LIVE") {
        toast("Type LIVE to confirm");
        return;
      }
      toast("LIVE gated until full PAPER night + STEP 15");
      closeSheet();
      return;
    }
    if (t.closest("[data-toggle-bot]")) {
      const b = t.closest("[data-toggle-bot]");
      if (b.dataset.locked === "1") {
        toast("Risk cannot pause while a position is open");
        return;
      }
      toast("Plan B: send 'pause " + b.dataset.toggleBot + "' in Telegram");
      return;
    }
    if (t.closest("#btn-test-push")) {
      toast("Plan B: test pushes go through Telegram");
      return;
    }
    if (t.closest("#btn-enable-webpush")) {
      toast("Plan B: Telegram only (home screen web push deferred)");
      return;
    }
    if (t.closest("#btn-watch-desk")) {
      state.tab = "home";
      state.subview = null;
      render();
      openScreenModal();
      return;
    }
    if (t.closest("[data-copypicks]")) {
      const opt = t.closest("[data-copypicks]").dataset.copypicks;
      if (state.data.account) state.data.account.copyPicks = opt;
      render();
      toast("Copy picks: " + opt);
      return;
    }
  });

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "search-input") {
      state.searchQuery = t.value;
      render();
    } else if (t.dataset && t.dataset.settingRange) {
      const num = document.querySelector(`[data-setting-key="${t.dataset.settingRange}"]`);
      if (num) num.value = t.value;
    } else if (t.dataset && t.dataset.settingKey) {
      const slider = document.querySelector(`[data-setting-range="${t.dataset.settingKey}"]`);
      if (slider) slider.value = t.value;
    } else if (t.id === "copy-picks-time") {
      state.copyPicksTime = t.value;
      try { localStorage.setItem("desk_copy_picks_time", t.value); } catch (_) {}
    }
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    const key = t.dataset.settingKey || t.dataset.settingRange;
    if (!key) return;
    commitSetting(key, t.value);
  });

  // --- Service Worker ---
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  // --- Init + 15s poll ---
  captureHashToken();
  detectInitialSource();
  window.__DESK_APP__ = {
    state,
    refreshData,
    render,
    commitSetting,
    findSettingSpec,
    setSubView: async (type, mint) => {
      if (type === "coin") await loadCoinDetail(mint);
      if (type === "audit") await loadAuditDetail(mint);
      state.subview = { type, mint };
      render();
    },
    setErrorPreview: (on) => {
      state.offlineForced = !!on;
      state.error = on ? { time: state.lastUpdatedText || "23:18" } : null;
      renderBanners();
    },
  };

  render();
  refreshData();
  setInterval(() => {
    if (state.error) {
      state.retryIn = state.retryIn <= 1 ? 15 : state.retryIn - 1;
      renderBanners();
    }
  }, 1000);
  setInterval(() => {
    if (state.sourceMode === "supabase" || state.sourceMode === "local" || state.sourceMode === "api") {
      refreshData();
    }
  }, POLL_MS);
})();

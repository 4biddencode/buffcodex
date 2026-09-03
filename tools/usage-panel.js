/**
 * Buffcodex usage panel — injected into the ChatGPT desktop app's webview.
 *
 * The app renders its bottom-left account menu as a Radix popover inside the
 * local webview. This script watches for that popover opening and mounts a
 * "Buffcodex" section at the top of it, listing every configured bridge
 * account with live status + burn (polled from the bridge's /usage endpoint).
 *
 * Served by the bridge at GET /usage.js and also copied into the app bundle
 * by tools/patch-chatgpt-app.sh as webview/assets/usage-panel.js.
 */
(() => {
  "use strict";

  // Bridge URL: same host when served from the bridge; localhost
  // default when loaded from inside the app bundle.
  const BRIDGE = (() => {
    try {
      if (location.origin.startsWith("http://127.0.0.1") || location.origin.startsWith("http://localhost")) {
        if (location.port === "17999") return location.origin;
      }
    } catch {}
    return "http://127.0.0.1:17999";
  })();

  const PANEL_ID = "buffcodex-usage-panel";
  const POLL_MS = 10_000;

  let latest = null; // last /usage payload
  let timer = null;

  const style = document.createElement("style");
  style.textContent = `
#${PANEL_ID} { padding: 8px 10px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 12px; color: rgba(255,255,255,0.72); }
#${PANEL_ID} .bcx-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; font-weight:600; font-size:11px; letter-spacing:0.04em; text-transform:uppercase; color:rgba(255,255,255,0.5); }
#${PANEL_ID} .bcx-title a { color:rgba(255,255,255,0.4); text-decoration:none; font-weight:400; text-transform:none; letter-spacing:0; }
#${PANEL_ID} .bcx-row { display:flex; align-items:center; gap:8px; padding:3px 0; line-height:1.35; }
#${PANEL_ID} .bcx-dot { width:8px; height:8px; border-radius:50%; flex:none; background:#6b7280; }
#${PANEL_ID} .bcx-dot.ok { background:#22c55e; }
#${PANEL_ID} .bcx-dot.error { background:#ef4444; }
#${PANEL_ID} .bcx-dot.cooldown { background:#f59e0b; }
#${PANEL_ID} .bcx-dot.queued { background:#3b82f6; animation:bcx-pulse 1.2s ease-in-out infinite; }
@keyframes bcx-pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
#${PANEL_ID} .bcx-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${PANEL_ID} .bcx-meta { margin-left:auto; flex:none; color:rgba(255,255,255,0.45); font-variant-numeric:tabular-nums; }
#${PANEL_ID} .bcx-err { color:#f87171; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; }
#${PANEL_ID} .bcx-bar { height:3px; border-radius:2px; background:rgba(255,255,255,0.12); margin-top:2px; overflow:hidden; }
#${PANEL_ID} .bcx-bar > i { display:block; height:100%; background:#22c55e; border-radius:2px; transition:width .4s ease; }
`;
  document.documentElement.appendChild(style);

  function fmtTokens(n) {
    if (!n) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return String(n);
  }

  /** Fraction of the account's 1h free window elapsed (0..1). */
  function windowFraction(acc) {
    const exp = acc?.session?.expiresAtMs || 0;
    if (!exp || exp <= Date.now()) return 0;
    return Math.max(0, Math.min(1, (exp - Date.now()) / 3_600_000));
  }

  function render() {
    const host = document.getElementById(PANEL_ID);
    if (!host) return;
    const accounts = latest?.accounts ?? [];
    const rows = accounts.map(acc => {
      const status = acc.status || "ok";
      const meta = status === "queued"
        ? `#${(acc.session?.position ?? 0) + 1} in queue`
        : `${fmtTokens(acc.usage?.totalTokens ?? 0)} tok · ${(acc.usage?.requestCount ?? 0)} req`;
      const frac = Math.round(windowFraction(acc) * 100);
      const err = status === "error" && acc.lastError
        ? `<div class="bcx-err" title="${escapeAttr(acc.lastError)}">${escapeHtml(acc.lastError)}</div>`
        : "";
      return `<div class="bcx-row">
        <span class="bcx-dot ${escapeAttr(status)}" title="${escapeAttr(status)}"></span>
        <div style="flex:1;min-width:0">
          <div class="bcx-name">${escapeHtml(acc.name)} <span style="color:rgba(255,255,255,0.35)">${escapeHtml(acc.maskedToken || "")}</span></div>
          <div class="bcx-bar" title="free session window: ${frac}% left"><i style="width:${frac}%"></i></div>
          ${err}
        </div>
        <span class="bcx-meta" title="${escapeAttr(status)}">${escapeHtml(meta)}</span>
      </div>`;
    }).join("");
    host.innerHTML = `<div class="bcx-title">Buffcodex accounts</div>${rows || "<div class='bcx-row'>no accounts — is the bridge running?</div>"}`;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  async function poll() {
    try {
      const res = await fetch(`${BRIDGE}/usage`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      latest = await res.json();
    } catch {
      latest = latest; // keep last known; rows will look stale but panel stays
    }
    render();
  }

  function ensurePanel(menu) {
    let panel = document.getElementById(PANEL_ID);
    if (panel && menu.contains(panel)) return;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
    }
    // Insert at the very top of the popover content.
    const content = menu.querySelector("[role=group], [data-radix-popper-content-wrapper] > div") || menu;
    content.insertBefore(panel, content.firstChild);
    render();
  }

  // Watch for the account menu popover appearing anywhere in the DOM.
  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const menu = n.matches?.("[role=menu],[data-radix-popper-content-wrapper]") ? n
          : n.querySelector?.("[role=menu]");
        if (menu) { ensurePanel(menu.closest("[data-radix-popper-content-wrapper]") || menu); return; }
      }
    }
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    poll();
    timer = setInterval(poll, POLL_MS);
    // Re-render promptly on any menu open: Radix reuses nodes.
    document.addEventListener("pointerdown", () => setTimeout(render, 60), true);
  }

  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);

  // Dev hook for debugging from the app's devtools.
  window.__buffcodexPanel = { poll, get latest() { return latest; }, stop: () => { clearInterval(timer); observer.disconnect(); } };
})();

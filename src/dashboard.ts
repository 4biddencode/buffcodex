/**
 * Zero-dependency dashboard served at "/" — live per-account usage, add/remove accounts,
 * and bridge status. Polls /usage every 5s. The bottom-left panel is the launcher's
 * "show usage" analog: every account's burn picture at a glance.
 */

const REFRESH_MS = 5_000;

interface UsageAccount {
  name: string;
  maskedToken: string;
  status: string;
  lastError?: string;
  session?: { status: string; position: number; queueDepth: number };
  runs: Array<{ agentId: string; inflight: number; requestCount: number }>;
  usage: {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    lastRequestAtMs?: number;
  };
}

interface UsagePayload {
  startedAtMs: number;
  accounts: UsageAccount[];
  notifications?: Array<{
    id: string; atMs: number; level: "info" | "warn" | "error";
    kind: string; account?: string; modelId?: string; message: string;
  }>;
  premiumSessionLimit?: number;
}

export function renderDashboard(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buffcodex — Freebuff bridge for Codex</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2333; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #3fb950; --warn: #d29922; --err: #f85149;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 20px 120px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h1 .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--err); margin-right: 8px; }
  h1 .dot.ok { background: var(--accent); }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill.ok { background: rgba(63,185,80,.15); color: var(--accent); }
  .pill.queued { background: rgba(210,153,34,.15); color: var(--warn); }
  .pill.cooldown, .pill.error { background: rgba(248,81,73,.15); color: var(--err); }
  .mono { font-family: var(--mono); font-size: 12px; }
  .muted { color: var(--muted); }
  .bar { height: 6px; border-radius: 4px; background: var(--panel2); overflow: hidden; min-width: 120px; }
  .bar > div { height: 100%; border-radius: 4px; transition: width .4s ease; }
  button { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button:hover { border-color: var(--muted); }
  button.primary { background: #238636; border-color: #2ea043; }
  input[type=text] { background: var(--panel2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 7px 10px; font-family: var(--mono); font-size: 12px; width: 320px; }
  input[type=text]:focus { outline: 1px solid var(--accent); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .msg { margin-top: 8px; font-size: 12px; min-height: 16px; }
  .msg.err { color: var(--err); }
  .msg.ok { color: var(--accent); }

  /* ── Bottom-left usage dock ("show usage") ─────────────────────────── */
  #usage-dock { position: fixed; left: 16px; bottom: 16px; z-index: 50; width: 320px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0,0,0,.45); overflow: hidden; }
  #usage-dock header { display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; cursor: pointer; user-select: none; }
  #usage-dock header .title { font-weight: 600; font-size: 13px; }
  #usage-dock header .toggle { color: var(--muted); font-size: 11px; }
  #usage-dock .body { padding: 0 14px 12px; display: block; }
  #usage-dock.collapsed .body { display: none; }
  .acct-row { padding: 8px 0; border-top: 1px solid var(--border); }
  .acct-row:first-child { border-top: 0; }
  .acct-line { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
  .acct-name { font-weight: 600; font-size: 12px; }
  .acct-meta { color: var(--muted); font-size: 11px; font-family: var(--mono); }
  .usage-note { color: var(--muted); font-size: 11px; margin-top: 8px; }
  #notifications { position: fixed; top: 16px; right: 16px; z-index: 60; width: 340px;
    display: flex; flex-direction: column; gap: 8px; }
  .note { background: var(--panel); border: 1px solid var(--border); border-left: 4px solid var(--accent);
    border-radius: 8px; padding: 10px 12px; font-size: 12px; box-shadow: 0 6px 18px rgba(0,0,0,.4);
    animation: slide-in .18s ease; }
  .note.warn { border-left-color: var(--warn); }
  .note.error { border-left-color: var(--err); }
  .note .kind { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
  @keyframes slide-in { from { transform: translateX(30px); opacity: 0; } to { transform: none; opacity: 1; } }
  .premium-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px;
    background: rgba(210,153,34,.18); color: var(--warn); font-size: 10px; font-weight: 700;
    text-transform: uppercase; }
  .renew-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px;
    background: rgba(63,185,80,.15); color: var(--accent); font-size: 10px; font-weight: 700; }
</style>
</head>
<body>
<main>
  <h1><span class="dot" id="health-dot"></span>Buffcodex</h1>
  <p class="sub">Codex → Freebuff bridge · all free models · multi-account pool</p>

  <div class="card">
    <h2>Accounts</h2>
    <table>
      <thead><tr><th>Account</th><th>Status</th><th>Free session</th><th>Requests</th><th>Tokens (in / out)</th><th></th></tr></thead>
      <tbody id="accounts-rows"><tr><td colspan="6" class="muted">loading…</td></tr></tbody>
    </table>
    <div class="row" style="margin-top:14px">
      <input type="text" id="new-token" placeholder="Paste a Freebuff auth token…" autocomplete="off">
      <button class="primary" id="add-btn">Add account</button>
      <span class="muted">Get a token at <span class="mono">freebuff.llm.pm</span> or via the freebuff CLI.</span>
    </div>
    <div class="msg" id="account-msg"></div>
  </div>

  <div class="card">
    <h2>Bridge</h2>
    <div class="row">
      <span class="muted">Codex route:</span><span class="mono">http://127.0.0.1:${port}/v1</span>
      <span class="muted">·</span>
      <span class="muted">install with</span><span class="mono">buffcodex codex install</span>
    </div>
    <div class="row" style="margin-top:6px">
      <span class="muted">Health:</span><a class="mono" href="/healthz">/healthz</a>
      <span class="muted">·</span><span class="muted">Usage API:</span><a class="mono" href="/usage">/usage</a>
    </div>
  </div>
</main>

<div id="notifications"></div>

<aside id="usage-dock">
  <header id="usage-toggle">
    <span class="title">⚡ Usage</span>
    <span class="toggle" id="usage-updated">…</span>
  </header>
  <div class="body" id="usage-body">
    <div class="muted">loading…</div>
  </div>
</aside>

<script>
  const REFRESH_MS = ${REFRESH_MS};
  const dock = document.getElementById("usage-dock");
  const dockBody = document.getElementById("usage-body");
  const dockUpdated = document.getElementById("usage-updated");
  const rows = document.getElementById("accounts-rows");
  const healthDot = document.getElementById("health-dot");
  const msg = document.getElementById("account-msg");

  document.getElementById("usage-toggle").addEventListener("click", () => dock.classList.toggle("collapsed"));
  if (localStorage.getItem("buffcodex-dock-collapsed") === "1") dock.classList.add("collapsed");
  new MutationObserver(() => {
    localStorage.setItem("buffcodex-dock-collapsed", dock.classList.contains("collapsed") ? "1" : "0");
  }).observe(dock, { attributes: true });

  function fmt(n) { return (n ?? 0).toLocaleString("en-US"); }
  function ago(ms) { if (!ms) return "—"; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? s.toFixed(0) + "s ago" : Math.round(s / 60) + "m ago"; }

  // Freebuff free tier reference: remaining-burn bar shows this account's share of the
  // pool's recent traffic. No upstream quota endpoint exists, so "remaining" is expressed
  // as time since the account last served a request (cool-down picture) + relative load.
  function accountDockHtml(a) {
    const status = a.status === "ok" ? '<span class="pill ok">ok</span>'
      : a.status === "queued" ? '<span class="pill queued">queued</span>'
      : '<span class="pill ' + a.status + '">' + a.status + "</span>";
    const poolTokens = poolTotalTokens();
    const share = poolTokens > 0 ? Math.round(100 * (a.usage.totalTokens / poolTokens)) : 0;
    const autoRenew = a.session && a.session.status === "active" || a.session && a.session.status === "disabled";
    return '<div class="acct-row">' +
      '<div class="acct-line"><span class="acct-name">' + a.name + " " + status +
      (autoRenew ? '<span class="renew-badge" title="Free sessions renew automatically just before server-side expiry">auto-renew</span>' : "") +
      "</span>" +
      '<span class="acct-meta">' + fmt(a.usage.totalTokens) + " tok</span></div>" +
      '<div class="bar" title="share of pool traffic ' + share + '%"><div style="width:' + share + '%;background:' +
      (share > 60 ? "var(--err)" : share > 35 ? "var(--warn)" : "var(--accent)") + '"></div></div>' +
      '<div class="acct-line" style="margin-top:5px;margin-bottom:0">' +
      '<span class="acct-meta">' + a.usage.requestCount + " req · in " + fmt(a.usage.inputTokens) + " / out " + fmt(a.usage.outputTokens) + "</span>" +
      '<span class="acct-meta" title="time since this account last served a request (rest = more remaining quota)">' + ago(a.usage.lastRequestAtMs) + "</span></div>" +
      (a.lastError ? '<div class="acct-meta" style="color:var(--err)">' + escapeHtml(a.lastError).slice(0, 90) + "</div>" : "") +
      "</div>";
  }

  let poolTokens = 0;
  function poolTotalTokens() { return poolTokens; }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const seenNotes = new Set();
  function showNotifications(notes) {
    const host = document.getElementById("notifications");
    for (const note of notes) {
      if (!note || seenNotes.has(note.id)) continue;
      seenNotes.add(note.id);
      const el = document.createElement("div");
      el.className = "note " + (note.level === "error" ? "error" : note.level === "warn" ? "warn" : "info");
      el.innerHTML = '<div class="kind">' + escapeHtml(note.kind) + (note.account ? " · " + escapeHtml(note.account) : "") + "</div>" +
        escapeHtml(note.message).slice(0, 220);
      host.appendChild(el);
      setTimeout(() => el.remove(), 9000);
    }
    while (host.children.length > 4) host.removeChild(host.firstChild);
  }

      showNotifications(payload.notifications || []);

      rows.innerHTML = accounts.map(a => "<tr>" +
        '<td><span class="mono">' + a.name + "</span><br><span class='muted mono'>" + escapeHtml(a.maskedToken) + "</span></td>" +
        "<td>" + (a.status === "ok" ? '<span class="pill ok">ok</span>' : '<span class="pill ' + a.status + '">' + a.status + "</span>") + "</td>" +
        '<td class="mono">' + (a.session ? escapeHtml(a.session.status) + (a.session.position ? " (#" + a.session.position + ")" : "") : "—") + "</td>" +
        '<td class="mono">' + fmt(a.usage.requestCount) + "</td>" +
        '<td class="mono">' + fmt(a.usage.inputTokens) + " / " + fmt(a.usage.outputTokens) + "</td>" +
        '<td><button data-remove="' + a.name + '" ' + (accounts.length <= 1 ? "disabled" : "") + ">Remove</button></td>" +
        "</tr>").join("");
      for (const button of rows.querySelectorAll("[data-remove]")) {
        button.addEventListener("click", () => removeAccount(button.dataset.remove));
      }
    } catch (error) {
      healthDot.classList.remove("ok");
      dockUpdated.textContent = "offline";
    }
  }

  async function removeAccount(name) {
    if (!confirm("Remove " + name + " from the pool?")) return;
    msg.className = "msg"; msg.textContent = "Removing " + name + "…";
    const result = await fetch("/accounts", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "remove", name }) });
    const body = await result.json().catch(() => ({}));
    if (result.ok && body.ok) { msg.className = "msg ok"; msg.textContent = name + " removed."; }
    else { msg.className = "msg err"; msg.textContent = body.error || ("remove failed (" + result.status + ")"); }
    refresh();
  }

  document.getElementById("add-btn").addEventListener("click", async () => {
    const token = document.getElementById("new-token").value.trim();
    msg.className = "msg"; msg.textContent = "";
    if (!token) { msg.className = "msg err"; msg.textContent = "Paste a token first."; return; }
    msg.textContent = "Validating and adding…";
    const result = await fetch("/accounts", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", token }) });
    const body = await result.json().catch(() => ({}));
    if (result.ok && body.ok) {
      msg.className = "msg ok"; msg.textContent = body.name + " added (" + body.accounts + " total).";
      document.getElementById("new-token").value = "";
    } else {
      msg.className = "msg err"; msg.textContent = body.error || ("add failed (" + result.status + ")");
    }
    refresh();
  });

  refresh();
  setInterval(refresh, REFRESH_MS);
</script>
</body>
</html>`;
}

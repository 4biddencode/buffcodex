/**
 * The ChatGPT-app injection script, embedded as a string so the compiled binary
 * serves it at GET /usage.js without needing the file on disk. Kept in sync with
 * tools/usage-panel.js — the patch script (tools/patch-chatgpt-app.sh) embeds the
 * file itself into the app bundle, while the bridge serves this copy.
 */
export const usagePanelScript = String.raw`
(() => {
  "use strict";
  const BRIDGE = "http://127.0.0.1:17999";
  const PANEL_ID = "buffcodex-usage-panel";
  const POLL_MS = 10000;
  let latest = null;
  let timer = null;
  const style = document.createElement("style");
  style.textContent = "#BCXID{padding:8px 10px 10px;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px;color:rgba(255,255,255,.72)}#BCXID .bcx-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:rgba(255,255,255,.5)}#BCXID .bcx-title a{color:rgba(255,255,255,.4);text-decoration:none;font-weight:400;text-transform:none;letter-spacing:0}#BCXID .bcx-row{display:flex;align-items:center;gap:8px;padding:3px 0;line-height:1.35}#BCXID .bcx-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#6b7280}#BCXID .bcx-dot.ok{background:#22c55e}#BCXID .bcx-dot.error{background:#ef4444}#BCXID .bcx-dot.cooldown{background:#f59e0b}#BCXID .bcx-dot.queued{background:#3b82f6;animation:bcx-pulse 1.2s ease-in-out infinite}@keyframes bcx-pulse{0%,100%{opacity:1}50%{opacity:.35}}#BCXID .bcx-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#BCXID .bcx-meta{margin-left:auto;flex:none;color:rgba(255,255,255,.45);font-variant-numeric:tabular-nums}#BCXID .bcx-err{color:#f87171;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}#BCXID .bcx-bar{height:3px;border-radius:2px;background:rgba(255,255,255,.12);margin-top:2px;overflow:hidden}#BCXID .bcx-bar>i{display:block;height:100%;background:#22c55e;border-radius:2px;transition:width .4s ease}".split("#BCXID").join("#"+PANEL_ID);
  document.documentElement.appendChild(style);
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function fmtTokens(n){if(!n)return"0";if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return String(n)}
  function windowFraction(acc){const exp=acc&&acc.session&&acc.session.expiresAtMs||0;if(!exp||exp<=Date.now())return 0;return Math.max(0,Math.min(1,(exp-Date.now())/36e5))}
  function render(){
    const host=document.getElementById(PANEL_ID);
    if(!host)return;
    const accounts=(latest&&latest.accounts)||[];
    host.innerHTML='<div class="bcx-title">Buffcodex accounts</div>'+
      (accounts.map(acc=>{
        const status=acc.status||"ok";
        const meta=status==="queued"?("#"+((acc.session&&acc.session.position||0)+1)+" in queue"):(fmtTokens(acc.usage&&acc.usage.totalTokens||0)+" tok \u00b7 "+(acc.usage&&acc.usage.requestCount||0)+" req");
        const frac=Math.round(windowFraction(acc)*100);
        const err=status==="error"&&acc.lastError?('<div class="bcx-err" title="'+esc(acc.lastError)+'">'+esc(acc.lastError)+"</div>"):"";
        return '<div class="bcx-row"><span class="bcx-dot '+esc(status)+'" title="'+esc(status)+'"></span><div style="flex:1;min-width:0"><div class="bcx-name">'+esc(acc.name)+' <span style="color:rgba(255,255,255,.35)">'+esc(acc.maskedToken||"")+'</span></div><div class="bcx-bar" title="free session window: '+frac+'% left"><i style="width:'+frac+'%"></i></div>'+err+'</div><span class="bcx-meta">'+esc(meta)+"</span></div>";
      }).join("")||'<div class="bcx-row">no accounts \u2014 is the bridge running?</div>');
  }
  async function poll(){
    try{const res=await fetch(BRIDGE+"/usage",{cache:"no-store"});if(!res.ok)throw new Error(String(res.status));latest=await res.json()}catch(e){}
    render();
  }
  function ensurePanel(menu){
    let panel=document.getElementById(PANEL_ID);
    if(panel&&menu.contains(panel))return;
    if(!panel){panel=document.createElement("div");panel.id=PANEL_ID}
    const content=menu.querySelector("[role=group],[data-radix-popper-content-wrapper] > div")||menu;
    content.insertBefore(panel,content.firstChild);
    render();
  }
  const observer=new MutationObserver(muts=>{
    for(const m of muts){
      for(const n of m.addedNodes){
        if(!(n instanceof HTMLElement))continue;
        const menu=n.matches&&n.matches("[role=menu],[data-radix-popper-content-wrapper]")?n:(n.querySelector&&n.querySelector("[role=menu]"));
        if(menu){ensurePanel(menu.closest("[data-radix-popper-content-wrapper]")||menu);return}
      }
    }
  });
  function start(){
    observer.observe(document.body,{childList:true,subtree:true});
    poll();
    timer=setInterval(poll,POLL_MS);
    document.addEventListener("pointerdown",()=>setTimeout(render,60),true);
  }
  if(document.body)start();else document.addEventListener("DOMContentLoaded",start);
  window.__buffcodexPanel={poll,get latest(){return latest},stop(){clearInterval(timer);observer.disconnect()}};
})();
`;

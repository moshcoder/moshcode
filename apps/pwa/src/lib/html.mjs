// Server-rendered views sharing the moshcode brand (from the design artifact):
// blacked-out ground, poison "moshcoding green", uppercase heavy sans, mono for data.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

export const BRAND_CSS = `
:root{
  color-scheme:dark;
  --bg:#070806;--bg-tint:#0b0d08;--surface:#101208;--surface-2:#15180d;
  --line:#23281a;--line-2:#333a25;--text:#edf2e4;--dim:#969d85;--faint:#5d6350;
  --acid:#a6ff1a;--acid-2:#bcff52;--acid-ink:#0a1400;--volt:#16e0ff;--danger:#ff0050;--warn:#ffc233;
  --glow:rgba(166,255,26,.14);
  --mono:ui-monospace,"JetBrains Mono","SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:"Helvetica Neue",Helvetica,system-ui,-apple-system,Arial,sans-serif;
  --maxw:1120px;--r:12px;
}
*{box-sizing:border-box}
body{margin:0;background:
  radial-gradient(760px 440px at 88% -10%,var(--glow),transparent 62%),
  repeating-linear-gradient(0deg,transparent 0 3px,rgba(255,255,255,.012) 3px 4px),
  var(--bg);
  color:var(--text);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 24px}
a{color:inherit;text-decoration:none}
::selection{background:var(--acid);color:var(--acid-ink)}
h1,h2,h3{margin:0;font-family:var(--sans);font-weight:800;text-transform:uppercase;letter-spacing:-.01em;text-wrap:balance}
.label{font-family:var(--mono);font-size:.64rem;letter-spacing:.2em;text-transform:uppercase;color:var(--faint)}
.mono{font-family:var(--mono)}
.dim{color:var(--dim)}.faint{color:var(--faint)}.acid{color:var(--acid)}
.pill{font-family:var(--mono);font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;padding:3px 9px;border-radius:999px;border:1px solid var(--line-2);color:var(--dim);white-space:nowrap}
.pill.on{color:var(--acid);border-color:color-mix(in srgb,var(--acid) 45%,var(--line));background:color-mix(in srgb,var(--acid) 10%,transparent)}
.pill.volt{color:var(--volt);border-color:color-mix(in srgb,var(--volt) 45%,var(--line))}
.pill.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
.btn{font-family:var(--mono);font-size:.8rem;font-weight:600;padding:10px 16px;border-radius:8px;cursor:pointer;border:1px solid var(--line-2);background:transparent;color:var(--text);display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:border-color .14s,background .14s,transform .05s;white-space:nowrap;text-align:center}
.btn:hover{border-color:var(--faint);background:var(--surface)}
.btn:active{transform:translateY(1px)}
.btn.acid{background:var(--acid);color:var(--acid-ink);border-color:var(--acid);font-weight:700}
.btn.acid:hover{background:var(--acid-2);border-color:var(--acid-2)}
.btn.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--line))}
.btn.danger:hover{background:color-mix(in srgb,var(--danger) 14%,transparent);border-color:var(--danger)}
.btn.block{width:100%}
.btn:focus-visible{outline:2px solid var(--acid);outline-offset:2px}
input,textarea,select{font-family:var(--mono);font-size:.85rem;color:var(--text);background:var(--bg);border:1px solid var(--line-2);border-radius:9px;padding:11px 13px;width:100%}
input:focus,textarea:focus{outline:none;border-color:var(--acid)}
input::placeholder,textarea::placeholder{color:var(--faint)}
label.field{display:block;margin-bottom:14px}
label.field span{display:block;font-family:var(--mono);font-size:.66rem;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-bottom:6px}
.card{border:1px solid var(--line);border-radius:var(--r);background:linear-gradient(180deg,var(--surface),var(--bg-tint))}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line)}
.card-head .h{font-family:var(--mono);font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.card-body{padding:18px}
.bar{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar-inner{display:flex;align-items:center;gap:16px;height:60px}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--sans);font-weight:800;text-transform:uppercase;letter-spacing:-.02em;font-size:1.12rem}
.brand .mark{width:22px;height:22px;border-radius:5px;background:var(--acid);color:var(--acid-ink);display:grid;place-items:center;font-family:var(--mono);font-weight:800;font-size:.9rem;box-shadow:0 0 0 3px var(--glow)}
.brand .app{font-family:var(--mono);font-weight:600;font-size:.62rem;letter-spacing:.22em;color:var(--faint);text-transform:uppercase;border:1px solid var(--line-2);padding:2px 6px;border-radius:5px}
.bar-right{margin-left:auto;display:flex;align-items:center;gap:12px}
.bal-chip{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.78rem;border:1px solid var(--line-2);border-radius:8px;padding:7px 11px}
.bal-chip b{color:var(--acid);font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:1.55fr .95fr;gap:22px;align-items:start}
.col{display:flex;flex-direction:column;gap:22px}
.section-title{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
.section-title h2{font-size:1.24rem}
.section-title .count{font-family:var(--mono);font-size:.74rem;color:var(--acid)}
.beat{width:8px;height:8px;border-radius:50%;background:var(--acid);display:inline-block;box-shadow:0 0 0 0 var(--glow);animation:beat 1.7s ease-out infinite}
@keyframes beat{0%{box-shadow:0 0 0 0 currentColor}70%,100%{box-shadow:0 0 0 8px transparent}}
@media (prefers-reduced-motion:reduce){.beat{animation:none}}
.notice{border:1px solid var(--line-2);border-radius:9px;padding:11px 14px;font-family:var(--mono);font-size:.78rem;margin-bottom:16px}
.notice.err{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--line))}
.notice.ok{color:var(--acid);border-color:color-mix(in srgb,var(--acid) 45%,var(--line))}
.divider{display:flex;align-items:center;gap:12px;color:var(--faint);font-family:var(--mono);font-size:.66rem;letter-spacing:.2em;text-transform:uppercase;margin:18px 0}
.divider::before,.divider::after{content:"";height:1px;background:var(--line);flex:1}
footer{border-top:1px solid var(--line);padding:26px 0;margin-top:40px}
.foot{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center;font-family:var(--mono);font-size:.74rem;color:var(--faint)}
.foot .metal b{color:var(--acid);font-weight:600}
@media (max-width:940px){.grid{grid-template-columns:1fr}}
`;

/** Full HTML document with the brand shell. */
export function page({ title = "moshcode ▸ app", body = "", head = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#070806">
<title>${esc(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>${BRAND_CSS}</style>
${head}
</head>
<body>${body}
<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}</script>
</body>
</html>`;
}

export function appBar(user, balance) {
  return `<header class="bar"><div class="wrap bar-inner">
    <a class="brand" href="/"><span class="mark">M</span>MOSHCODE<span class="app">app</span></a>
    <div class="bar-right">
      ${user ? `<span class="bal-chip">◆ <b>${balance.toLocaleString()}</b> cr</span>
      <a class="btn" href="/settings">Settings</a>
      <form method="post" action="/auth/logout" style="margin:0"><button class="btn">Sign out</button></form>`
      : `<a class="btn acid" href="/">Sign in</a>`}
    </div>
  </div></header>`;
}

export const footer = `<footer><div class="wrap foot">
  <div class="brand" style="font-size:.9rem"><span class="mark" style="width:18px;height:18px;font-size:.75rem">M</span>MOSHCODE</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap"><a href="https://moshcode.sh">moshcode.sh</a><a href="/">Approvals</a><a href="/settings">Settings</a></div>
  <div class="metal">no bugs, only <b>features</b>. 🤘</div>
</div></footer>`;

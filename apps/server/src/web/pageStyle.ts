// Shared look for the pages the server renders itself (/admin, /account, /signup).
// Calm and muted: flat surfaces, one soft accent, no gradients or glow. Values mirror
// the app's design tokens so a person moving between the web player and these pages
// sees the same product.

export const PAGE_CSS = String.raw`
*{box-sizing:border-box;margin:0;padding:0}
:root{color-scheme:dark;--bg:#0e0e11;--bg-2:#131317;--surface:#18181d;--surface-2:#1f1f26;--surface-3:#272730;
  --line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.15);--text:#ececf0;--muted:#a3a3b0;--faint:#85858f;
  --accent:#a39dda;--accent-ink:#17151f;--accent-soft:rgba(163,157,218,.14);--accent-line:rgba(163,157,218,.38);
  --danger:#e8909f;--danger-soft:rgba(232,144,159,.1);--danger-line:rgba(232,144,159,.34);
  --ok:#86c9a6;--ok-soft:rgba(134,201,166,.12);--warn:#dcbc78;--warn-soft:rgba(220,188,120,.1);--warn-line:rgba(220,188,120,.32);
  --radius:14px;--radius-sm:10px;
  --font:Inter,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;
  --mono:"Cascadia Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:var(--accent);text-underline-offset:3px}
a:hover{color:var(--text)}
h1{font-size:1.65rem;line-height:1.2;font-weight:700;letter-spacing:-.02em}
h2{font-size:1.05rem;line-height:1.3;font-weight:650}
h3{font-size:.95rem;font-weight:650}
p{max-width:68ch}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[hidden]{display:none!important}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:12px;top:-60px;z-index:50;padding:10px 14px;border-radius:var(--radius-sm);background:var(--accent);color:var(--accent-ink);font-weight:650;text-decoration:none}
.skip:focus{top:12px}
code,.mono{font-family:var(--mono);font-size:.88em}
code{background:var(--surface-3);padding:2px 7px;border-radius:7px;overflow-wrap:anywhere}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:.85rem}

/* buttons and fields */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border-radius:var(--radius-sm);
  border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);font-weight:600;font-size:.92rem;cursor:pointer;
  text-decoration:none;transition:background .15s,border-color .15s;-webkit-tap-highlight-color:transparent}
.btn:hover{background:var(--surface-3);color:var(--text)}
.btn:disabled,.btn[aria-disabled=true]{opacity:.5;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{background:#b3aee3;border-color:#b3aee3;color:var(--accent-ink)}
.btn.danger{background:transparent;border-color:var(--danger-line);color:var(--danger)}
.btn.danger:hover{background:var(--danger-soft);color:var(--danger)}
.btn.quiet{background:transparent;border-color:transparent;color:var(--muted)}
.btn.quiet:hover{background:var(--surface-2);color:var(--text)}
.btn.block{width:100%}
.field{display:flex;flex-direction:column;gap:6px;min-width:0}
.field>label,.lbl{font-size:.82rem;font-weight:600;color:var(--muted)}
input[type=text],input[type=password],input[type=url],input[type=email],input[type=number],input[type=search],input:not([type]),select,textarea{
  width:100%;min-height:44px;padding:10px 13px;border-radius:var(--radius-sm);border:1px solid var(--line-2);background:var(--bg);color:var(--text);font-size:1rem}
textarea{min-height:140px;font-family:var(--mono);font-size:.88rem;line-height:1.5;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input:disabled,select:disabled{opacity:.55}
input::placeholder{color:var(--faint)}
.help{font-size:.8rem;color:var(--faint)}
.check{display:flex;align-items:center;gap:10px;min-height:44px;cursor:pointer;font-size:.92rem}
.check input{width:20px;height:20px;accent-color:var(--accent);flex:none}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:14px;align-items:start}
.form-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.seg{display:inline-flex;max-width:100%;padding:3px;border-radius:12px;background:var(--bg);border:1px solid var(--line-2);gap:2px}
.seg button{min-height:40px;padding:0 16px;border-radius:9px;border:0;background:none;color:var(--muted);font-weight:600;cursor:pointer}
.seg button[aria-checked=true]{background:var(--surface-3);color:var(--text)}
.switch{position:relative;flex:none;width:52px;height:32px;border-radius:99px;border:1px solid var(--line-2);background:var(--bg);cursor:pointer;padding:0;transition:background .15s}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:var(--muted);transition:transform .15s,background .15s}
.switch[aria-checked=true]{background:var(--accent-soft);border-color:var(--accent-line)}
.switch[aria-checked=true]::after{transform:translateX(20px);background:var(--accent)}
.switch:disabled{opacity:.5}
.switch-wrap{display:inline-flex;align-items:center;justify-content:center;min-width:52px;min-height:44px}
.switch::before{content:"";position:absolute;inset:-7px -4px}
.plugin-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-bottom:16px}
.plugin-tools input[type=search]{flex:1 1 220px;width:auto}
.plugin-tools .seg{flex:none}

/* surfaces */
.card{padding:20px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--line);margin-bottom:16px}
.card>h2{margin-bottom:4px}
.card>.hint,.hint{color:var(--muted);font-size:.9rem;margin-bottom:14px}
.card>*:last-child{margin-bottom:0}
.banner{padding:12px 14px;border-radius:var(--radius-sm);border:1px solid var(--line-2);background:var(--surface);font-size:.9rem;margin-bottom:16px;display:flex;gap:10px;align-items:flex-start}
.banner.warn{border-color:var(--warn-line);background:var(--warn-soft);color:var(--warn)}
.banner.error{border-color:var(--danger-line);background:var(--danger-soft);color:var(--danger)}
.banner.ok{border-color:rgba(134,201,166,.3);background:var(--ok-soft);color:var(--ok)}
.badge{display:inline-flex;align-items:center;min-height:22px;padding:0 9px;border-radius:99px;font-size:.74rem;font-weight:650;background:var(--surface-3);color:var(--muted);white-space:nowrap}
.badge.accent{background:var(--accent-soft);color:var(--accent)}
.badge.ok{background:var(--ok-soft);color:var(--ok)}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.badge.danger{background:var(--danger-soft);color:var(--danger)}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.stat{padding:16px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--line)}
.stat b{display:block;font-size:1.5rem;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.stat span{color:var(--muted);font-size:.82rem}
.list{list-style:none;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);margin-bottom:16px;overflow:hidden}
.item{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;padding:14px 16px}
.item+.item{border-top:1px solid var(--line)}
.item .grow{flex:1 1 220px;min-width:0}
.item .name{font-weight:600;overflow-wrap:anywhere}
.item .sub{color:var(--muted);font-size:.84rem;overflow-wrap:anywhere}
.item .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.actions{display:flex;flex-wrap:wrap;gap:8px}
.avatar{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:700}
.avatar.off{background:var(--surface-3);color:var(--faint)}
.kv{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:8px 18px;font-size:.92rem}
.kv dt{color:var(--muted)}
.kv dd{min-width:0;overflow-wrap:anywhere}
.bar{height:6px;border-radius:99px;background:var(--surface-3);overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:var(--accent)}
.bar.busy i{width:35%;animation:slide 1.3s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
.empty{padding:28px 18px;text-align:center;color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:16px}
.toolbar input{max-width:320px}
.page-head{margin-bottom:22px}
.page-head p{color:var(--muted);margin-top:4px}
.status{margin-top:12px;font-size:.9rem;min-height:1.4em}
.status.bad{color:var(--danger)}.status.good{color:var(--ok)}

/* dialog and toasts */
dialog{margin:auto;width:min(480px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:22px;border-radius:var(--radius);
  border:1px solid var(--line-2);background:var(--surface);color:var(--text);box-shadow:0 24px 70px rgba(0,0,0,.6)}
dialog::backdrop{background:rgba(5,5,8,.66)}
dialog h2{margin-bottom:6px}
dialog .body{display:flex;flex-direction:column;gap:14px;margin:14px 0}
dialog .row-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end}
#toasts{position:fixed;left:12px;right:12px;bottom:16px;z-index:60;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.toast{pointer-events:auto;max-width:min(460px,100%);padding:12px 16px;border-radius:var(--radius-sm);background:var(--surface-3);border:1px solid var(--line-2);
  box-shadow:0 12px 36px rgba(0,0,0,.5);font-size:.92rem}
.toast.err{border-color:var(--danger-line);color:var(--danger)}

/* sign-in */
.center{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:20px}
.center .card{width:min(420px,100%);margin:0;padding:28px}
.brand{display:flex;align-items:center;gap:11px;font-weight:700;font-size:1.05rem;text-decoration:none;color:var(--text)}
.brand small{display:block;font-weight:600;font-size:.7rem;color:var(--faint);letter-spacing:.09em;text-transform:uppercase}
.stack{display:flex;flex-direction:column;gap:14px}

/* app shell: sidebar on wide screens, a scrolling tab strip on narrow ones */
.shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh;min-height:100dvh}
.side{padding:20px 12px;border-right:1px solid var(--line);background:var(--bg-2);display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;height:100dvh;overflow-y:auto}
.side .brand{padding:0 10px 18px}
.nav-link{display:flex;align-items:center;min-height:44px;padding:0 12px;border-radius:var(--radius-sm);border:0;background:none;color:var(--muted);font-weight:600;
  font-size:.93rem;cursor:pointer;text-align:left;text-decoration:none;width:100%;white-space:nowrap}
.nav-link:hover{background:var(--surface-2);color:var(--text)}
.nav-link[aria-current=page]{background:var(--surface-3);color:var(--text)}
.nav-link .dot{margin-left:auto;width:8px;height:8px;border-radius:50%;background:var(--warn)}
.side .spacer{flex:1;min-height:12px}
.side .me{padding:10px 12px;font-size:.84rem;color:var(--muted);border-top:1px solid var(--line);margin-top:8px;overflow-wrap:anywhere}
.main{padding:32px clamp(16px,4vw,44px) 72px;max-width:1040px;width:100%}
@media (max-width:820px){
  .shell{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .side{position:static;height:auto;flex-direction:row;align-items:center;gap:4px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line);overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
  .side .brand{padding:0 10px 0 2px;flex:none}.side .brand small{display:none}
  .nav-link{width:auto;flex:none;padding:0 14px}
  .side .spacer,.side .me{display:none}
  .main{padding-top:22px}
  h1{font-size:1.45rem}
  .kv{grid-template-columns:1fr;gap:2px}.kv dd{margin-bottom:10px}
  .item .actions{width:100%}
  .item .actions .btn{flex:1 1 auto}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.bar.busy i{width:100%;opacity:.5}}
`;
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.js";

/** Direct link to the latest Windows installer on GitHub Releases. */
const DEFAULT_DOWNLOAD = "https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-Setup.exe";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const GRADIENT = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#ff4f8b"/><stop offset=".5" stop-color="#8b6bff"/><stop offset="1" stop-color="#3ee0d0"/>
</linearGradient>`;

function logo(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <defs>${GRADIENT}<linearGradient id="gl" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
  <rect x="1" y="1" width="22" height="22" rx="7" fill="url(#g)"/><rect x="1" y="1" width="22" height="22" rx="7" fill="url(#gl)"/>
  <g fill="#fff"><rect x="5.75" y="6" width="1.9" height="12" rx=".95"/><rect x="8.65" y="7.4" width="1.9" height="9.2" rx=".95"/>
  <rect x="11.55" y="8.8" width="1.9" height="6.4" rx=".95"/><rect x="14.45" y="10.1" width="1.9" height="3.8" rx=".95"/>
  <rect x="17.35" y="11.05" width="1.9" height="1.9" rx=".95"/></g></svg>`;
}

const ICONS = {
  streams: `<path d="M4 12a8 8 0 0 1 16 0M7.5 12a4.5 4.5 0 0 1 9 0"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 13.5V20"/>`,
  server: `<rect x="4" y="4" width="16" height="6.5" rx="2"/><rect x="4" y="13.5" width="16" height="6.5" rx="2"/><path d="M8 7.25h.01M8 16.75h.01" stroke-width="2.6"/>`,
  sync: `<path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>`,
  plug: `<path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0Z"/><path d="M12 16v6"/>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7.5"/>`,
  copy: `<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>`,
  download: `<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>`,
};

function icon(name: keyof typeof ICONS, size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--text:#f5f5f7;--muted:#a3a3b2;--faint:#6e6e80;--line:rgba(255,255,255,.09);
  --grad:linear-gradient(135deg,#ff4f8b,#8b6bff 52%,#3ee0d0)}
html{background:#07070a}
body{min-height:100vh;color:var(--text);overflow-x:hidden;
  font:15px/1.55 Inter,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.bg{position:fixed;inset:0;z-index:-1;overflow:hidden;background:#07070a}
.blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55;animation:drift 22s ease-in-out infinite alternate}
.b1{width:620px;height:620px;left:-160px;top:-200px;background:#8b6bff}
.b2{width:520px;height:520px;right:-140px;top:10%;background:#ff4f8b;opacity:.35;animation-duration:26s}
.b3{width:560px;height:560px;left:30%;bottom:-300px;background:#3ee0d0;opacity:.28;animation-duration:30s}
.grain{position:absolute;inset:0;background:radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px) 0 0/3px 3px}
@keyframes drift{to{transform:translate(60px,40px) scale(1.08)}}
header{display:flex;align-items:center;justify-content:space-between;max-width:1180px;margin:0 auto;padding:22px 24px}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:1.15rem;letter-spacing:-.01em;text-decoration:none}
.brand svg{filter:drop-shadow(0 6px 18px rgba(139,107,255,.55))}
.nav-link{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;font-weight:650;font-size:.9rem;
  text-decoration:none;background:rgba(255,255,255,.07);border:1px solid var(--line)}
.nav-link:hover{background:rgba(255,255,255,.12)}
.nav{display:flex;gap:10px}
.nav-link.primary{background:var(--grad);border-color:transparent;color:#fff;box-shadow:0 8px 22px rgba(139,107,255,.4)}
.nav-link.primary:hover{filter:brightness(1.08)}
.btn + .btn{margin-top:10px}
@media (max-width:520px){.nav-link:not(.primary){display:none}}
main{display:grid;grid-template-columns:1.1fr .9fr;gap:56px;align-items:center;max-width:1180px;margin:0 auto;padding:28px 24px 64px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-size:.78rem;font-weight:700;
  letter-spacing:.04em;color:#e4dcff;background:rgba(139,107,255,.16);border:1px solid rgba(139,107,255,.35)}
.dot{width:7px;height:7px;border-radius:50%;background:#3ddc97;box-shadow:0 0 0 4px rgba(61,220,151,.18)}
h1{font-size:clamp(2.4rem,5vw,3.9rem);line-height:1.02;letter-spacing:-.045em;font-weight:850;margin:20px 0 18px}
h1 span{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{color:var(--muted);font-size:1.08rem;max-width:46ch}
.features{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:30px 0}
.feature{display:flex;gap:12px;align-items:flex-start;padding:14px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.feature .ic{flex:none;display:grid;place-items:center;width:38px;height:38px;border-radius:11px;color:#fff;background:var(--grad);
  box-shadow:0 8px 20px rgba(139,107,255,.3)}
.feature b{display:block;font-size:.93rem}
.feature small{color:var(--muted);font-size:.82rem}
.player{display:flex;align-items:center;gap:14px;max-width:440px;padding:14px;border-radius:18px;
  background:rgba(20,20,26,.7);border:1px solid var(--line);backdrop-filter:blur(16px);box-shadow:0 20px 50px rgba(0,0,0,.45)}
.art{width:56px;height:56px;border-radius:12px;flex:none;background:var(--grad)}
.np{flex:1;min-width:0}.np b{display:block;font-size:.92rem}.np small{color:var(--muted)}
.bar{height:4px;border-radius:9px;background:rgba(255,255,255,.12);margin-top:9px;overflow:hidden}
.bar i{display:block;height:100%;width:38%;background:var(--grad);animation:prog 14s linear infinite}
@keyframes prog{from{width:8%}to{width:96%}}
.eq{display:flex;align-items:flex-end;gap:3px;height:24px}
.eq i{width:4px;border-radius:3px;background:#b7a6ff;animation:eq 1s ease-in-out infinite alternate}
.eq i:nth-child(2){animation-delay:-.4s}.eq i:nth-child(3){animation-delay:-.7s}.eq i:nth-child(4){animation-delay:-.2s}
@keyframes eq{from{height:20%}to{height:100%}}
.card{position:relative;padding:30px;border-radius:24px;background:rgba(16,16,21,.82);border:1px solid rgba(255,255,255,.1);
  box-shadow:0 30px 80px rgba(0,0,0,.55);backdrop-filter:blur(24px)}
.card::before{content:"";position:absolute;inset:-1px;border-radius:25px;padding:1px;background:var(--grad);opacity:.5;
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.card h2{font-size:1.45rem;letter-spacing:-.02em}
.card .sub{color:var(--muted);font-size:.9rem;margin:4px 0 18px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
label{display:block;font-size:.8rem;font-weight:650;color:var(--muted);margin:14px 0 6px}
input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.13);background:rgba(0,0,0,.38);
  color:var(--text);font:inherit;transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:#8b6bff;box-shadow:0 0 0 4px rgba(139,107,255,.22)}
.hint{font-size:.76rem;color:var(--faint);margin-top:6px}
.btn{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;margin-top:22px;padding:14px 20px;border:0;
  border-radius:999px;font:inherit;font-weight:750;color:#fff;cursor:pointer;text-decoration:none;background:var(--grad);
  background-size:160% 160%;box-shadow:0 12px 30px rgba(139,107,255,.42);transition:transform .12s,background-position .4s,filter .2s}
.btn:hover{background-position:100% 0;filter:brightness(1.06)}
.btn:active{transform:scale(.985)}
.btn:disabled{opacity:.55;cursor:default}
.btn.ghost{background:rgba(255,255,255,.07);border:1px solid var(--line);box-shadow:none}
.error{margin-top:16px;padding:11px 13px;border-radius:12px;font-size:.88rem;color:#ffb3c2;background:rgba(255,79,139,.1);
  border:1px solid rgba(255,79,139,.32)}
.legal{text-align:center;font-size:.78rem;color:var(--faint);margin-top:14px}
.done{text-align:center}
.tick{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 14px;border-radius:50%;color:#fff;background:var(--grad);
  box-shadow:0 14px 34px rgba(139,107,255,.5);animation:pop .45s cubic-bezier(.2,1.4,.4,1)}
@keyframes pop{from{transform:scale(.4);opacity:0}}
.steps{list-style:none;text-align:left;display:grid;gap:10px;margin:20px 0 4px;counter-reset:s}
.steps li{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.04);
  border:1px solid var(--line);counter-increment:s}
.steps li::before{content:counter(s);flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;
  font-size:.8rem;font-weight:800;background:rgba(139,107,255,.22);color:#d8cfff}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:8px;cursor:pointer;color:var(--text);
  font:600 .84rem "Cascadia Mono",ui-monospace,monospace;background:rgba(255,255,255,.09);border:1px solid var(--line)}
.chip:hover{background:rgba(255,255,255,.15)}
footer{text-align:center;color:var(--faint);font-size:.8rem;padding:0 24px 32px}
[hidden]{display:none!important}
@media (max-width:900px){main{grid-template-columns:1fr;gap:36px;padding-top:8px}.features{grid-template-columns:1fr}
  .player{display:none}.row2{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

function page(opts: { signup: Config["signup"]; open: boolean; download: string; nonce: string }): string {
  const { signup, open, download, nonce } = opts;
  const dl = escapeHtml(download);
  const inviteField =
    signup?.mode === "invite"
      ? `<label for="invite">Invite code</label>
         <input id="invite" name="inviteCode" required autocomplete="off" spellcheck="false" placeholder="From the person who invited you">`
      : "";
  const form = open
    ? `<form id="signup" class="card" novalidate>
        <h2>Create your account</h2>
        <p class="sub">${signup?.mode === "invite" ? "This server is invite-only." : "Free on this server."} Takes a few seconds.</p>
        <div class="row2">
          <div><label for="name">Your name</label>
            <input id="name" name="displayName" autocomplete="name" maxlength="80" placeholder="Optional"></div>
          <div><label for="username">Username</label>
            <input id="username" name="username" required autocomplete="username" maxlength="48"
              pattern="[A-Za-z0-9_.@-]+" spellcheck="false" placeholder="e.g. alex"></div>
        </div>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required minlength="10" autocomplete="new-password"
          placeholder="At least 10 characters">
        <label for="confirm">Repeat password</label>
        <input id="confirm" type="password" required minlength="10" autocomplete="new-password">
        ${inviteField}
        <p id="error" class="error" role="alert" hidden></p>
        <button class="btn" type="submit">Create account</button>
        <p class="legal">Your account lives on this server, run by its owner — not by a company.</p>
      </form>`
    : `<div class="card"><h2>Sign-up is closed</h2>
        <p class="sub">Ask the person who runs this server to create an account for you. Already have one?</p>
        <a class="btn" href="/app/">${icon("streams", 18)} Sign in on the web</a>
        <a class="btn ghost" href="${dl}" rel="noopener">${icon("download", 18)} Download for Windows</a></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cadence — create your account</title><meta name="robots" content="noindex">
<meta name="theme-color" content="#07070a">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(logo(64))}">
<style>${STYLE}</style></head>
<body>
<div class="bg" aria-hidden="true"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="grain"></div></div>
<header>
  <a class="brand" href="/">${logo(34)} Cadence</a>
  <nav class="nav">
    <a class="nav-link" href="${dl}" rel="noopener">${icon("download", 16)} Get the app</a>
    <a class="nav-link primary" href="/app/">${icon("streams", 16)} Open web player</a>
  </nav>
</header>
<main>
  <section>
    <span class="eyebrow"><span class="dot"></span> Self-hosted music</span>
    <h1>All your music.<br><span>One app. Your server.</span></h1>
    <p class="lead">Cadence brings Spotify, Apple Music and your own files into one beautiful player — with your
      library and history kept on a server you own.</p>
    <div class="features">
      <div class="feature"><span class="ic">${icon("streams")}</span><div><b>Every service</b><small>Spotify, Apple Music & local files in one queue</small></div></div>
      <div class="feature"><span class="ic">${icon("server")}</span><div><b>Yours to host</b><small>No company in the middle</small></div></div>
      <div class="feature"><span class="ic">${icon("sync")}</span><div><b>Synced history</b><small>Pick up on any computer</small></div></div>
      <div class="feature"><span class="ic">${icon("plug")}</span><div><b>Plugins</b><small>Extend it however you like</small></div></div>
    </div>
    <div class="player" aria-hidden="true">
      <div class="art"></div>
      <div class="np"><b>Now playing</b><small>Your music, wherever it lives</small><div class="bar"><i></i></div></div>
      <div class="eq"><i></i><i></i><i></i><i></i></div>
    </div>
  </section>

  <section>
    ${form}
    <div id="done" class="card done" hidden>
      <div class="tick">${icon("check", 30)}</div>
      <h2>You're in, <span id="who"></span>!</h2>
      <p class="sub">Your account is ready.</p>
      <ol class="steps">
        <li><span>Listen right now in the web player — just sign in.</span></li>
        <li><span>Or install the Windows app and connect to
          <button type="button" class="chip" id="host" title="Copy">${icon("copy", 13)} <span></span></button></span></li>
        <li><span>Use the same username and password everywhere.</span></li>
      </ol>
      <a class="btn" href="/app/">${icon("streams", 18)} Open the web player</a>
      <a class="btn ghost" href="${dl}" rel="noopener">${icon("download", 18)} Download for Windows</a>
    </div>
  </section>
</main>
<footer>Cadence · open source · <a href="https://github.com/Hornet-Linux/cadence-music" rel="noopener">GitHub</a></footer>
<script nonce="${nonce}">
(() => {
  const hostChip = document.getElementById("host");
  hostChip.querySelector("span").textContent = location.host;
  hostChip.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.host); hostChip.lastElementChild.textContent = "Copied!";
      setTimeout(() => (hostChip.lastElementChild.textContent = location.host), 1500); } catch {}
  });
  const form = document.getElementById("signup");
  if (!form) return;
  const err = document.getElementById("error");
  const messages = {
    invalid_username: "Usernames can use letters, numbers, dots, dashes, underscores and @.",
    weak_password: "Use a password of at least 10 characters.",
    username_taken: "That username is taken — try another.",
    invalid_invite_code: "That invite code isn't right.",
    signup_closed: "Sign-up has just been closed on this server.",
    too_many_attempts: "Too many attempts. Try again in a while.",
  };
  const show = (m) => { err.textContent = m; err.hidden = false; };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    if (!/^[A-Za-z0-9_.@-]{1,48}$/.test(String(data.username))) return show(messages.invalid_username);
    if (String(data.password).length < 10) return show(messages.weak_password);
    if (data.password !== document.getElementById("confirm").value) return show("The passwords don't match.");
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Creating your account…";
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return show(messages[body.error] || "Something went wrong. Please try again.");
      // The page doesn't need a session; sign out of the one sign-up created.
      fetch("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer " + body.token } });
      document.getElementById("who").textContent = body.user.displayName || body.user.username;
      form.hidden = true;
      document.getElementById("done").hidden = false;
    } catch {
      show("Couldn't reach the server. Check your connection and try again.");
    } finally {
      button.disabled = false;
      button.textContent = "Create account";
    }
  });
})();
</script></body></html>`;
}

/** Public landing page with sign-up (when the owner enables it). */
export function registerSignupPage(
  app: FastifyInstance,
  deps: { config: Config; signup: () => Config["signup"]; signupOpen: () => boolean },
): void {
  const download = deps.config.appDownloadUrl ?? DEFAULT_DOWNLOAD;
  const handler = async (_req: unknown, reply: FastifyReply) => {
    const nonce = randomBytes(16).toString("base64");
    return reply
      .type("text/html; charset=utf-8")
      .header(
        "Content-Security-Policy",
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
          "img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .send(page({ signup: deps.signup(), open: deps.signupOpen(), download, nonce }));
  };
  app.get("/", handler);
  app.get("/signup", handler);
}

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.js";

const DEFAULT_DOWNLOAD = "https://github.com/Hornet-Linux/cadence-music/releases/latest";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const LOGO = `<svg width="72" height="72" viewBox="0 0 24 24" aria-hidden="true">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff4f8b"/><stop offset=".5" stop-color="#8b6bff"/><stop offset="1" stop-color="#3ee0d0"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="22" height="22" rx="7" fill="url(#g)"/>
  <g fill="#fff">
    <rect x="5.75" y="6" width="1.9" height="12" rx=".95"/><rect x="8.65" y="7.4" width="1.9" height="9.2" rx=".95"/>
    <rect x="11.55" y="8.8" width="1.9" height="6.4" rx=".95"/><rect x="14.45" y="10.1" width="1.9" height="3.8" rx=".95"/>
    <rect x="17.35" y="11.05" width="1.9" height="1.9" rx=".95"/>
  </g>
</svg>`;

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:grid;place-items:center;padding:32px 16px;color:#f5f5f7;
  font:15px/1.5 Inter,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;
  background:radial-gradient(900px 500px at 15% -10%,rgba(139,107,255,.35),transparent 70%),
    radial-gradient(700px 500px at 100% 110%,rgba(62,224,208,.22),transparent 70%),#08080b}
main{width:min(440px,100%)}
.brand{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;margin-bottom:28px}
.brand svg{filter:drop-shadow(0 12px 30px rgba(139,107,255,.55))}
h1{font-size:2rem;font-weight:800;letter-spacing:-.03em}
.tag{color:#a3a3b2;max-width:36ch}
.card{background:rgba(20,20,25,.85);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:26px;
  box-shadow:0 24px 60px rgba(0,0,0,.5);backdrop-filter:blur(20px)}
h2{font-size:1.15rem;margin-bottom:16px}
label{display:block;font-size:.82rem;color:#a3a3b2;margin:14px 0 6px}
input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid rgba(255,255,255,.14);
  background:rgba(0,0,0,.35);color:#f5f5f7;font:inherit}
input:focus{outline:none;border-color:#8b6bff;box-shadow:0 0 0 3px rgba(139,107,255,.25)}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:22px;padding:12px 18px;
  border:0;border-radius:999px;font:inherit;font-weight:700;color:#fff;cursor:pointer;text-decoration:none;
  background:linear-gradient(135deg,#ff4f8b,#8b6bff 55%,#3ee0d0);box-shadow:0 10px 26px rgba(139,107,255,.4)}
.btn:disabled{opacity:.55;cursor:default}
.btn.ghost{background:rgba(255,255,255,.08);box-shadow:none;border:1px solid rgba(255,255,255,.12)}
.hint{font-size:.8rem;color:#6e6e80;margin-top:6px}
.error{margin-top:14px;padding:10px 12px;border-radius:10px;font-size:.88rem;color:#ff9db0;
  background:rgba(255,92,124,.1);border:1px solid rgba(255,92,124,.3)}
.steps{margin:6px 0 0 20px;color:#c9c9d6;display:grid;gap:8px}
code{background:rgba(255,255,255,.1);padding:1px 7px;border-radius:6px;font-family:"Cascadia Mono",ui-monospace,monospace}
.foot{text-align:center;color:#6e6e80;font-size:.8rem;margin-top:20px}
[hidden]{display:none!important}`;

function page(opts: { signup: Config["signup"]; open: boolean; download: string; nonce: string }): string {
  const { signup, open, download, nonce } = opts;
  const inviteField =
    signup?.mode === "invite"
      ? `<label for="invite">Invite code</label>
         <input id="invite" name="inviteCode" required autocomplete="off" spellcheck="false">`
      : "";
  const form = open
    ? `<form id="signup" class="card" novalidate>
        <h2>Create your account</h2>
        <label for="name">Your name <span class="hint">(optional)</span></label>
        <input id="name" name="displayName" autocomplete="name" maxlength="80">
        <label for="username">Username</label>
        <input id="username" name="username" required autocomplete="username" maxlength="48"
          pattern="[A-Za-z0-9_.@-]+" spellcheck="false">
        <p class="hint">Letters, numbers, dots, dashes, underscores and @.</p>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required minlength="10" autocomplete="new-password">
        <label for="confirm">Repeat password</label>
        <input id="confirm" type="password" required minlength="10" autocomplete="new-password">
        ${inviteField}
        <p id="error" class="error" role="alert" hidden></p>
        <button class="btn" type="submit">Create account</button>
      </form>`
    : `<div class="card"><h2>Sign-up is closed</h2>
        <p class="tag">Ask the person who runs this server to create an account for you.</p></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cadence — sign up</title><meta name="robots" content="noindex">
<style>${STYLE}</style></head>
<body><main>
  <div class="brand">${LOGO}<h1>Cadence</h1>
    <p class="tag">Your music from Spotify, Apple Music and more — in one app, on a server you own.</p></div>
  ${form}
  <div id="done" class="card" hidden>
    <h2>You're in 🎉</h2>
    <ol class="steps">
      <li>Install Cadence on your computer.</li>
      <li>Open it and, in the setup wizard, connect to <code id="host"></code>.</li>
      <li>Sign in as <code id="who"></code>.</li>
    </ol>
    <a class="btn" href="${escapeHtml(download)}" rel="noopener">Download Cadence</a>
  </div>
  <p class="foot">Already have an account? <a href="${escapeHtml(download)}" style="color:#a3a3b2">Get the app</a> and sign in.</p>
</main>
<script nonce="${nonce}">
(() => {
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
    if (data.password !== document.getElementById("confirm").value) return show("The passwords don't match.");
    if (String(data.password).length < 10) return show(messages.weak_password);
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return show(messages[body.error] || "Something went wrong. Please try again.");
      // The page doesn't need a session; sign out of the one sign-up created.
      fetch("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer " + body.token } });
      document.getElementById("host").textContent = location.host;
      document.getElementById("who").textContent = body.user.username;
      form.hidden = true;
      document.getElementById("done").hidden = false;
    } catch {
      show("Couldn't reach the server. Check your connection and try again.");
    } finally {
      button.disabled = false;
    }
  });
})();
</script></body></html>`;
}

/** Public landing page with sign-up (when the owner enables it). */
export function registerSignupPage(
  app: FastifyInstance,
  deps: { config: Config; signupOpen: () => boolean },
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
      .send(page({ signup: deps.config.signup, open: deps.signupOpen(), download, nonce }));
  };
  app.get("/", handler);
  app.get("/signup", handler);
}

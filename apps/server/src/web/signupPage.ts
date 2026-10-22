import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.js";
import { escapeHtml, logoSvg, sendPage } from "./pageKit.js";

/** Direct link to the latest Windows installer on GitHub Releases. */
const DEFAULT_DOWNLOAD = "https://github.com/Hornet-Linux/cadence-music/releases/latest/download/Cadence-Setup.exe";

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
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

// Page-specific styles; the colours, buttons and fields come from the shared sheet.
const CSS = `
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:1080px;margin:0 auto;padding:18px clamp(16px,4vw,32px)}
.top nav{display:flex;gap:8px}
.land{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:clamp(28px,6vw,72px);align-items:start;max-width:1080px;margin:0 auto;padding:clamp(12px,4vw,40px) clamp(16px,4vw,32px) 56px}
.land h1{font-size:clamp(1.9rem,4.4vw,2.9rem);line-height:1.1;letter-spacing:-.03em;margin-bottom:14px}
.lead{color:var(--muted);font-size:1.05rem;max-width:44ch}
.points{list-style:none;display:grid;gap:14px;margin-top:28px}
.points li{display:flex;gap:14px;align-items:flex-start}
.points .ic{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:var(--accent-soft);color:var(--accent)}
.points b{display:block;font-size:.95rem}.points span{color:var(--muted);font-size:.88rem}
.panel{padding:26px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--line)}
.panel h2{font-size:1.3rem;letter-spacing:-.01em}
.panel .sub{color:var(--muted);font-size:.92rem;margin:4px 0 18px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.panel .field{margin-top:14px}.row2 .field{margin-top:0}
.panel .btn.block{margin-top:20px}.panel .btn.block+.btn.block{margin-top:10px}
.legal{text-align:center;font-size:.8rem;color:var(--faint);margin-top:14px}
.done{text-align:center}
.tick{display:grid;place-items:center;width:56px;height:56px;margin:0 auto 14px;border-radius:50%;background:var(--ok-soft);color:var(--ok)}
.steps{list-style:none;text-align:left;display:grid;gap:10px;margin:18px 0 4px;counter-reset:s}
.steps li{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:var(--radius-sm);background:var(--bg);border:1px solid var(--line);counter-increment:s}
.steps li::before{content:counter(s);flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;font-size:.8rem;font-weight:700;background:var(--accent-soft);color:var(--accent)}
.chip{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 10px;border-radius:8px;cursor:pointer;font:600 .84rem var(--mono);background:var(--surface-3);border:1px solid var(--line-2);color:var(--text)}
.chip:hover{background:var(--surface-2)}
.foot{text-align:center;color:var(--faint);font-size:.82rem;padding:0 24px 32px}
@media (max-width:860px){.land{grid-template-columns:minmax(0,1fr)}.row2{grid-template-columns:1fr}.top nav .btn.quiet{display:none}}
`;

function body(opts: { signup: Config["signup"]; open: boolean; download: string }): string {
  const { signup, open, download } = opts;
  const dl = escapeHtml(download);
  const inviteField =
    signup?.mode === "invite"
      ? `<div class="field"><label for="invite">Invite code</label>
         <input id="invite" name="inviteCode" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="From the person who invited you"></div>`
      : "";
  const form = open
    ? `<form id="signup" class="panel" novalidate>
        <h2>Create your account</h2>
        <p class="sub">${signup?.mode === "invite" ? "This server is invite-only." : "Free on this server."} It takes a few seconds.</p>
        <div class="row2">
          <div class="field"><label for="name">Your name</label>
            <input id="name" name="displayName" autocomplete="name" maxlength="80" placeholder="Optional"></div>
          <div class="field"><label for="username">Username</label>
            <input id="username" name="username" required autocomplete="username" maxlength="48" autocapitalize="none"
              pattern="[A-Za-z0-9_.@\\-]+" spellcheck="false" placeholder="e.g. alex"></div>
        </div>
        <div class="field"><label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="10" autocomplete="new-password"
            aria-describedby="pw-help"><span class="help" id="pw-help">At least 10 characters.</span></div>
        <div class="field"><label for="confirm">Repeat password</label>
          <input id="confirm" type="password" required minlength="10" autocomplete="new-password"></div>
        ${inviteField}
        <p id="error" class="banner error" role="alert" hidden style="margin:16px 0 0"></p>
        <button class="btn primary block" type="submit">Create account</button>
        <p class="legal">Your account lives on this server, run by its owner, not by a company.</p>
      </form>`
    : `<div class="panel"><h2>Sign-up is closed</h2>
        <p class="sub">Ask the person who runs this server to create an account for you. Already have one?</p>
        <a class="btn primary block" href="/app/">${icon("streams", 18)} Sign in on the web</a>
        <a class="btn block" href="${dl}" rel="noopener">${icon("download", 18)} Download for Windows</a></div>`;

  return `<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="/">${logoSvg(30)} Cadence</a>
  <nav aria-label="Main">
    <a class="btn quiet" href="${dl}" rel="noopener">${icon("download", 16)} Get the app</a>
    <a class="btn quiet" href="/account">Account</a>
    <a class="btn" href="/app/">${icon("streams", 16)} Web player</a>
  </nav>
</header>
<main class="land" id="main">
  <section>
    <h1>All your music, one app, on your server.</h1>
    <p class="lead">Cadence brings Spotify, Apple Music and your own files into one player, with your library and history kept on a server you own.</p>
    <ul class="points">
      <li><span class="ic">${icon("streams")}</span><div><b>Every service</b><span>Spotify, Apple Music and local files in one queue.</span></div></li>
      <li><span class="ic">${icon("server")}</span><div><b>Yours to host</b><span>No company in the middle.</span></div></li>
      <li><span class="ic">${icon("sync")}</span><div><b>Synced history</b><span>Pick up on any device.</span></div></li>
      <li><span class="ic">${icon("plug")}</span><div><b>Plugins</b><span>Extend it however you like.</span></div></li>
    </ul>
  </section>
  <section>
    ${form}
    <div id="done" class="panel done" hidden>
      <div class="tick">${icon("check", 28)}</div>
      <h2>You're in, <span id="who"></span>!</h2>
      <p class="sub">Your account is ready.</p>
      <ol class="steps">
        <li><span>Listen right now in the web player. Just sign in.</span></li>
        <li><span>Or install the app and connect to
          <button type="button" class="chip" id="host" title="Copy">${icon("copy", 13)} <span></span></button></span></li>
        <li><span>Use the same username and password everywhere.</span></li>
      </ol>
      <a class="btn primary block" href="/app/">${icon("streams", 18)} Open the web player</a>
      <a class="btn block" href="${dl}" rel="noopener">${icon("download", 18)} Download for Windows</a>
    </div>
  </section>
</main>
<footer class="foot">Cadence · open source · <a href="https://github.com/Hornet-Linux/cadence-music" rel="noopener">GitHub</a>${open ? ` · <a href="/account">Manage your account</a>` : ""}</footer>`;
}

const SCRIPT = String.raw`
(() => {
  const hostChip = document.getElementById("host");
  hostChip.querySelector("span").textContent = location.host;
  hostChip.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.host); hostChip.lastElementChild.textContent = "Copied!";
      setTimeout(() => (hostChip.lastElementChild.textContent = location.host), 1500); } catch (e) {}
  });
  const form = document.getElementById("signup");
  if (!form) return;
  const invite = form.querySelector("#invite");
  if (invite) {
    // A shared link can carry the code: /signup?invite=CODE
    const fromLink = new URLSearchParams(location.search).get("invite");
    if (fromLink) { invite.value = fromLink; }
    history.replaceState(null, "", location.pathname);
  }
  const err = document.getElementById("error");
  const messages = {
    invalid_username: "Usernames can use letters, numbers, dots, dashes, underscores and @.",
    weak_password: "Use a password of at least 10 characters.",
    username_taken: "That username is taken. Try another.",
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
    } catch (e2) {
      show("Couldn't reach the server. Check your connection and try again.");
    } finally {
      button.disabled = false;
      button.textContent = "Create account";
    }
  });
})();`;

/** Public landing page with sign-up (when the owner enables it). */
export function registerSignupPage(
  app: FastifyInstance,
  deps: { config: Config; signup: () => Config["signup"]; signupOpen: () => boolean },
): void {
  const download = deps.config.appDownloadUrl ?? DEFAULT_DOWNLOAD;
  const handler = async (_req: unknown, reply: FastifyReply) =>
    sendPage(reply, {
      title: "Cadence: create your account",
      body: body({ signup: deps.signup(), open: deps.signupOpen(), download }),
      script: SCRIPT,
      css: CSS,
    });
  app.get("/", handler);
  app.get("/signup", handler);
}
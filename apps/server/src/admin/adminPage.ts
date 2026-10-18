import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

// The admin panel at /admin: a small self-contained page that talks to the
// /api/admin endpoints with an admin's session token. All user data is put in
// the DOM with textContent, never as HTML.

const LOGO = `<svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#ff4f8b"/><stop offset=".5" stop-color="#8b6bff"/><stop offset="1" stop-color="#3ee0d0"/></linearGradient></defs>
<rect x="1" y="1" width="22" height="22" rx="7" fill="url(#g)"/><g fill="#fff"><rect x="5.75" y="6" width="1.9" height="12" rx=".95"/>
<rect x="8.65" y="7.4" width="1.9" height="9.2" rx=".95"/><rect x="11.55" y="8.8" width="1.9" height="6.4" rx=".95"/>
<rect x="14.45" y="10.1" width="1.9" height="3.8" rx=".95"/><rect x="17.35" y="11.05" width="1.9" height="1.9" rx=".95"/></g></svg>`;

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--text:#f5f5f7;--muted:#a3a3b2;--faint:#6e6e80;--line:rgba(255,255,255,.09);--card:rgba(18,18,24,.85);
  --grad:linear-gradient(135deg,#ff4f8b,#8b6bff 52%,#3ee0d0);--danger:#ff5c7c;--ok:#3ddc97}
html{background:#07070a}
body{min-height:100vh;color:var(--text);font:14.5px/1.5 Inter,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;background:radial-gradient(900px 500px at 0% -10%,rgba(139,107,255,.22),transparent 70%),
  radial-gradient(700px 500px at 100% 0%,rgba(62,224,208,.12),transparent 70%),#07070a}
button,input,select{font:inherit;color:inherit}
.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
aside{padding:22px 14px;border-right:1px solid var(--line);background:rgba(10,10,14,.6);display:flex;flex-direction:column;gap:4px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.05rem;padding:0 8px 18px}
.brand small{display:block;font-weight:600;font-size:.72rem;color:var(--faint);letter-spacing:.08em;text-transform:uppercase}
.tab{display:block;width:100%;text-align:left;padding:10px 12px;border-radius:10px;border:0;background:none;color:var(--muted);
  font-weight:600;cursor:pointer}
.tab:hover{background:rgba(255,255,255,.05);color:var(--text)}
.tab.on{background:rgba(255,255,255,.09);color:var(--text)}
.spacer{flex:1}
.me{font-size:.85rem;color:var(--muted);padding:10px 12px;border-top:1px solid var(--line)}
main{padding:34px 40px 60px;max-width:1100px}
h1{font-size:1.8rem;letter-spacing:-.03em;margin-bottom:4px}
.sub{color:var(--muted);margin-bottom:26px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:28px}
.stat{padding:18px;border-radius:16px;background:var(--card);border:1px solid var(--line)}
.stat b{display:block;font-size:1.9rem;letter-spacing:-.03em}
.stat span{color:var(--muted);font-size:.85rem}
.card{padding:22px;border-radius:18px;background:var(--card);border:1px solid var(--line);margin-bottom:18px}
.card h2{font-size:1.1rem;margin-bottom:4px}
.card p.hint{color:var(--muted);font-size:.88rem;margin-bottom:14px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding:8px 10px;font-weight:700}
td{padding:11px 10px;border-top:1px solid var(--line);vertical-align:middle}
td small{display:block;color:var(--faint);font-size:.8rem}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.74rem;font-weight:700;background:rgba(255,255,255,.08);color:var(--muted)}
.pill.admin{background:rgba(139,107,255,.22);color:#d8cfff}
.pill.sso{background:rgba(62,224,208,.16);color:#9ff0e8}
.actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid var(--line);
  background:rgba(255,255,255,.07);font-weight:650;font-size:.85rem;cursor:pointer;white-space:nowrap}
.btn:hover{background:rgba(255,255,255,.13)}
.btn.primary{background:var(--grad);border-color:transparent;color:#fff;box-shadow:0 8px 20px rgba(139,107,255,.35)}
.btn.danger{color:#ffb3c2;border-color:rgba(255,92,124,.35);background:rgba(255,92,124,.08)}
.btn:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
label{display:block;font-size:.78rem;font-weight:650;color:var(--muted);margin-bottom:5px}
input,select{padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.35);min-width:180px}
input:focus,select:focus{outline:none;border-color:#8b6bff;box-shadow:0 0 0 3px rgba(139,107,255,.22)}
.seg{display:inline-flex;padding:3px;border-radius:12px;background:rgba(255,255,255,.07);border:1px solid var(--line);gap:2px}
.seg button{padding:8px 14px;border-radius:9px;border:0;background:none;color:var(--muted);font-weight:650;cursor:pointer}
.seg button.on{background:#0b0b0e;color:var(--text);box-shadow:0 2px 8px rgba(0,0,0,.4)}
code{font-family:"Cascadia Mono",ui-monospace,monospace;background:rgba(255,255,255,.09);padding:2px 8px;border-radius:7px}
.toast{position:fixed;right:22px;bottom:22px;padding:12px 16px;border-radius:12px;background:#15151b;border:1px solid var(--line);
  box-shadow:0 18px 40px rgba(0,0,0,.5);font-weight:600;transition:opacity .2s}
.toast.err{border-color:rgba(255,92,124,.45);color:#ffb3c2}
.login{min-height:100vh;display:grid;place-items:center;padding:20px}
.login .card{width:min(400px,100%)}
.login input{width:100%;margin-bottom:12px}
.login .btn{width:100%;padding:12px}
.error{color:#ffb3c2;font-size:.88rem;margin-bottom:12px}
[hidden]{display:none!important}
@media (max-width:800px){.shell{grid-template-columns:1fr}aside{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}
  .spacer,.me{display:none}main{padding:24px 18px}}`;

const SCRIPT = String.raw`
(() => {
  const TOKEN = "cadence-admin-token";
  const $ = (s) => document.querySelector(s);
  let token = sessionStorage.getItem(TOKEN);
  let me = null;

  // Build DOM safely: text always goes through textContent.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function toast(message, isError) {
    const t = h("div", { class: "toast" + (isError ? " err" : ""), role: "status" }, message);
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  }

  const messages = {
    invalid_credentials: "Wrong username or password.",
    too_many_attempts: "Too many attempts. Try again later.",
    invalid_username: "Usernames can use letters, numbers, dots, dashes, underscores and @.",
    weak_password: "Passwords need at least 10 characters.",
    username_taken: "That username is taken.",
    last_admin: "There must always be at least one admin.",
    cannot_demote_self: "You can't remove your own admin rights.",
    cannot_delete_self: "You can't delete your own account here.",
    invalid_invite_code: "Invite codes use 6-64 letters, numbers, dashes or underscores.",
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts.headers || {}) },
    });
    if (res.status === 401) { signOut(); throw new Error("Your session expired. Sign in again."); }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(messages[body.error] || body.message || ("Request failed (" + res.status + ")"));
    return body;
  }

  function signOut() {
    sessionStorage.removeItem(TOKEN);
    token = null;
    renderLogin();
  }

  // ---- Sign-in --------------------------------------------------------------
  function renderLogin(error) {
    $("#app").replaceChildren(
      h("div", { class: "login" },
        h("form", { class: "card", onsubmit: login },
          h("div", { class: "brand" }, document.querySelector("#logo").content.cloneNode(true),
            h("div", null, "Cadence", h("small", null, "Admin"))),
          error ? h("p", { class: "error" }, error) : null,
          h("label", { for: "u" }, "Username"),
          h("input", { id: "u", name: "username", autocomplete: "username", required: true }),
          h("label", { for: "p" }, "Password"),
          h("input", { id: "p", name: "password", type: "password", autocomplete: "current-password", required: true }),
          h("button", { class: "btn primary", type: "submit" }, "Sign in"))));
  }

  async function login(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return renderLogin(messages[body.error] || "Couldn't sign in.");
      if (!body.user.isAdmin) {
        fetch("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer " + body.token } });
        return renderLogin("That account isn't an admin.");
      }
      token = body.token;
      sessionStorage.setItem(TOKEN, token);
      start();
    } catch { renderLogin("Couldn't reach the server."); }
  }

  // ---- Shell ----------------------------------------------------------------
  const views = { overview: renderOverview, users: renderUsers, signup: renderSignup };
  let current = "overview";

  async function start() {
    try { me = await api("/api/me"); } catch { return; }
    if (!me.isAdmin) return renderLogin("That account isn't an admin.");
    $("#app").replaceChildren(
      h("div", { class: "shell" },
        h("aside", null,
          h("div", { class: "brand" }, document.querySelector("#logo").content.cloneNode(true), h("div", null, "Cadence", h("small", null, "Admin"))),
          ...Object.keys(views).map((v) => h("button", { class: "tab", "data-view": v, onclick: () => show(v) },
            { overview: "Overview", users: "People", signup: "Sign-up" }[v])),
          h("a", { class: "tab", href: "/app/" }, "Open web player ↗"),
          h("div", { class: "spacer" }),
          h("div", { class: "me" }, "Signed in as ", h("b", null, me.username)),
          h("button", { class: "tab", onclick: async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch {} signOut(); } }, "Sign out")),
        h("main", { id: "view" })));
    show(current);
  }

  function show(view) {
    current = view;
    document.querySelectorAll(".tab[data-view]").forEach((t) => t.classList.toggle("on", t.dataset.view === view));
    $("#view").replaceChildren(h("p", { class: "sub" }, "Loading…"));
    views[view]().catch((err) => $("#view").replaceChildren(h("p", { class: "error" }, err.message)));
  }

  const when = (ms) => (ms ? new Date(ms).toLocaleString() : "—");

  // ---- Overview -------------------------------------------------------------
  async function renderOverview() {
    const o = await api("/api/admin/overview");
    const stat = (n, label) => h("div", { class: "stat" }, h("b", null, n), h("span", null, label));
    $("#view").replaceChildren(
      h("h1", null, "Overview"),
      h("p", { class: "sub" }, "Cadence server " + o.version + (o.publicUrl ? " · " + o.publicUrl : "")),
      h("div", { class: "grid" },
        stat(o.users, "accounts"), stat(o.admins, "admins"), stat(o.activeSessions, "active sessions (7 days)"),
        stat(o.plays, "plays recorded"), stat(o.tracks, "tracks in the server library")),
      h("div", { class: "card" },
        h("h2", null, "Sign-up"),
        h("p", { class: "hint" }, o.signup.mode === "closed" ? "Closed — only admins can add people."
          : o.signup.mode === "open" ? "Open — anyone with the link can create an account."
          : "Invite-only."),
        o.signup.mode === "invite" ? h("p", null, "Invite code: ", h("code", null, o.signup.inviteCode)) : null),
      h("div", { class: "card" },
        h("h2", null, "Single sign-on"),
        h("p", { class: "hint" }, o.oidc ? "Configured: " + o.oidc.name + " (" + o.oidc.issuer + ")"
          : "Not configured. Set OIDC_* in the server's .env (setup.sh can do it); in-panel setup is coming.")),
      h("div", { class: "card" },
        h("h2", null, "Library"),
        h("p", { class: "hint" }, "Rescan the server's music folder for new or removed files."),
        h("button", { class: "btn", onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await api("/api/library/scan?wait=1", { method: "POST" }); toast("Scan done: " + r.total + " tracks (" + r.added + " new)"); renderOverview(); }
          catch (err) { toast(err.message, true); } finally { e.target.disabled = false; }
        } }, "Rescan library")));
  }

  // ---- People ---------------------------------------------------------------
  async function renderUsers() {
    const { items } = await api("/api/admin/users");
    const act = (label, fn, cls) => h("button", { class: "btn" + (cls ? " " + cls : ""), onclick: async () => {
      try { await fn(); } catch (err) { toast(err.message, true); }
    } }, label);

    const rows = items.map((u) => h("tr", null,
      h("td", null, h("b", null, u.displayName || u.username), h("small", null, "@" + u.username + (u.email ? " · " + u.email : ""))),
      h("td", null, u.isAdmin ? h("span", { class: "pill admin" }, "Admin") : h("span", { class: "pill" }, "Member"), " ",
        u.signIn !== "password" ? h("span", { class: "pill sso" }, "SSO") : null),
      h("td", null, when(u.lastSeenAt), h("small", null, u.plays + " plays · " + u.sessions + " sessions")),
      h("td", null, h("div", { class: "actions" },
        u.id === me.id ? h("span", { class: "pill" }, "You") : [
          act(u.isAdmin ? "Remove admin" : "Make admin", async () => {
            await api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ isAdmin: !u.isAdmin }) });
            toast((u.isAdmin ? "Removed admin from " : "Made admin: ") + u.username); renderUsers();
          }),
          act("Reset password", async () => {
            const password = prompt("New password for " + u.username + " (at least 10 characters):");
            if (!password) return;
            await api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ password }) });
            toast("Password reset; " + u.username + " was signed out everywhere");
          }),
          act("Sign out", async () => {
            const r = await api("/api/admin/users/" + u.id + "/sign-out", { method: "POST" });
            toast("Ended " + r.signedOut + " session(s)"); renderUsers();
          }),
          act("Delete", async () => {
            if (!confirm("Delete " + u.username + " and their listening history? This can't be undone.")) return;
            await api("/api/admin/users/" + u.id, { method: "DELETE" });
            toast("Deleted " + u.username); renderUsers();
          }, "danger"),
        ]))));

    const form = h("form", { class: "row", onsubmit: async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      try {
        await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: d.username, password: d.password, displayName: d.displayName, isAdmin: d.isAdmin === "on" }) });
        toast("Created " + d.username); renderUsers();
      } catch (err) { toast(err.message, true); }
    } },
      h("div", null, h("label", { for: "nu" }, "Username"), h("input", { id: "nu", name: "username", required: true })),
      h("div", null, h("label", { for: "nd" }, "Name (optional)"), h("input", { id: "nd", name: "displayName" })),
      h("div", null, h("label", { for: "np" }, "Password"), h("input", { id: "np", name: "password", type: "password", required: true, minlength: "10" })),
      h("label", { style: "display:flex;gap:6px;align-items:center;margin:0 0 12px" }, h("input", { type: "checkbox", name: "isAdmin", style: "min-width:0" }), "Admin"),
      h("button", { class: "btn primary", type: "submit" }, "Add person"));

    $("#view").replaceChildren(
      h("h1", null, "People"),
      h("p", { class: "sub" }, items.length + " account" + (items.length === 1 ? "" : "s") + " on this server."),
      h("div", { class: "card" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Person"), h("th", null, "Role"), h("th", null, "Last seen"), h("th", null, ""))),
        h("tbody", null, rows))),
      h("div", { class: "card" }, h("h2", null, "Add someone"), h("p", { class: "hint" }, "Creates a password account. They can change nothing here unless you make them an admin."), form));
  }

  // ---- Sign-up --------------------------------------------------------------
  async function renderSignup() {
    const o = await api("/api/admin/overview");
    let mode = o.signup.mode;
    const code = h("input", { id: "code", value: o.signup.inviteCode || "", placeholder: "Leave empty to generate one" });
    const codeRow = h("div", { hidden: mode !== "invite" }, h("label", { for: "code" }, "Invite code"), code);
    const seg = h("div", { class: "seg", role: "radiogroup" },
      ...["closed", "invite", "open"].map((m) => h("button", { type: "button", class: m === mode ? "on" : "", onclick: (e) => {
        mode = m;
        seg.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
        e.target.classList.add("on");
        codeRow.hidden = mode !== "invite";
      } }, { closed: "Closed", invite: "Invite-only", open: "Open" }[m])));
    const link = location.origin + "/";
    $("#view").replaceChildren(
      h("h1", null, "Sign-up"),
      h("p", { class: "sub" }, "Who can create an account at " + link),
      h("div", { class: "card" },
        h("h2", null, "Who can sign up"),
        h("p", { class: "hint" }, "Closed: only admins add people. Invite-only: people need the code. Open: anyone with the link."),
        seg,
        h("div", { style: "margin-top:16px" }, codeRow),
        h("div", { style: "margin-top:18px" }, h("button", { class: "btn primary", onclick: async () => {
          try {
            const r = await api("/api/admin/signup", { method: "PUT", body: JSON.stringify({ mode, inviteCode: code.value }) });
            toast(r.mode === "invite" ? "Saved. Invite code: " + r.inviteCode : "Saved: sign-up is " + r.mode);
            renderSignup();
          } catch (err) { toast(err.message, true); }
        } }, "Save"))),
      h("div", { class: "card" }, h("h2", null, "Share"), h("p", { class: "hint" }, "Send people this link" + (mode === "invite" ? " and the invite code." : "."),
        h("br"), h("code", null, link))));
  }

  if (token) start(); else renderLogin();
})();`;

export function registerAdminPage(app: FastifyInstance): void {
  const handler = async (_req: unknown, reply: import("fastify").FastifyReply) => {
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
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cadence admin</title>
<meta name="robots" content="noindex"><style>${STYLE}</style></head>
<body><template id="logo">${LOGO}</template><div id="app"></div>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`);
  };
  app.get("/admin", handler);
  app.get("/admin/", handler);
}

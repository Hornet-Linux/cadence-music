import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { PAGE_CSS } from "./pageStyle.js";

/** The Cadence mark in one flat colour: five level bars on a rounded square. */
export function logoSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="1" y="1" width="22" height="22" rx="7" fill="#a39dda"/><g fill="#17151f"><rect x="5.75" y="6" width="1.9" height="12" rx=".95"/><rect x="8.65" y="7.4" width="1.9" height="9.2" rx=".95"/><rect x="11.55" y="8.8" width="1.9" height="6.4" rx=".95"/><rect x="14.45" y="10.1" width="1.9" height="3.8" rx=".95"/><rect x="17.35" y="11.05" width="1.9" height="1.9" rx=".95"/></g></svg>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface PageOptions {
  title: string;
  /** Markup placed inside <body> before the script. */
  body: string;
  /** Inline script (gets the CSP nonce). */
  script?: string;
  /** Extra CSS appended after the shared styles. */
  css?: string;
  lang?: string;
}

/**
 * Sends a self-contained page with a strict Content-Security-Policy: no external
 * resources, one nonce'd inline script, no framing. Everything the script shows
 * from the server goes in as text, never as markup.
 */
export function sendPage(reply: FastifyReply, opts: PageOptions) {
  const nonce = randomBytes(16).toString("base64");
  const icon = `data:image/svg+xml,${encodeURIComponent(logoSvg(64))}`;
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
    .send(`<!doctype html><html lang="${opts.lang ?? "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0e0e11">
<title>${escapeHtml(opts.title)}</title><meta name="robots" content="noindex">
<link rel="icon" href="${icon}"><style>${PAGE_CSS}${opts.css ?? ""}</style></head>
<body><template id="logo">${logoSvg(30)}</template>${opts.body}
${opts.script ? `<script nonce="${nonce}">${opts.script}</script>` : ""}</body></html>`);
}

/**
 * Browser-side helpers shared by the admin panel and the account page: building
 * DOM safely, calling the API with the session token, dialogs, toasts, formatting.
 * (Plain ES2019 so it runs in any WebView. No template literals: this sits inside one.)
 */
export const CLIENT_KIT = String.raw`
const TOKEN_KEY = "cadence-page-token";
const $ = (s) => document.querySelector(s);
let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY); } catch (e) {}
function setToken(t) {
  token = t;
  try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
}

// Build DOM safely: text always goes through text nodes.
function h(tag, attrs) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of Array.prototype.slice.call(arguments, 2).flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(message, isError) {
  let box = $("#toasts");
  if (!box) { box = h("div", { id: "toasts", "aria-live": "polite", role: "status" }); document.body.append(box); }
  const t = h("div", { class: "toast" + (isError ? " err" : "") }, message);
  box.append(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3500);
}

const messages = {
  invalid_credentials: "Wrong username or password.",
  too_many_attempts: "Too many attempts. Try again later.",
  account_disabled: "This account has been switched off. Ask the server owner.",
  invalid_username: "Usernames can use letters, numbers, dots, dashes, underscores and @.",
  weak_password: "Passwords need at least 10 characters.",
  wrong_password: "That isn't your current password.",
  same_password: "Choose a password that is different from the current one.",
  no_password: "This account signs in with single sign-on, so it has no password to change.",
  confirm_mismatch: "That doesn't match your username.",
  username_taken: "That username is taken.",
  last_admin: "There must always be at least one admin who can sign in.",
  cannot_demote_self: "You can't remove your own admin rights.",
  cannot_delete_self: "You can't delete your own account here. Use your Account page.",
  cannot_disable_self: "You can't switch off your own account.",
  invalid_invite_code: "Invite codes use 6-64 letters, numbers, dashes or underscores.",
  invalid_config: "That isn't a JSON object, or it is too large.",
  set_by_environment: "That address is set by the server's environment (JELLYFIN_URL) and can't be changed here.",
  invalid_url: "That isn't a valid web address. Use http:// or https:// and nothing after the host.",
  invalid_name: "Give it a name.",
  invalid_model: "Enter a model name.",
  invalid_key: "That API key isn't valid.",
  invalid_provider: "That address isn't valid. Use http:// or https:// with no password, query or fragment.",
  not_found: "That no longer exists. Refresh the page.",
};

let onSignedOut = () => {};
async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(path, {
    ...opts,
    // A JSON content type on a request with no body is rejected by the server, so only send it with one.
    headers: { ...(opts.body != null ? { "content-type": "application/json" } : {}), authorization: "Bearer " + token, ...(opts.headers || {}) },
  });
  if (res.status === 401) { setToken(null); onSignedOut(); throw new Error("Your session ended. Sign in again."); }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(messages[body.error] || body.message || ("Request failed (" + res.status + ")"));
  return body;
}

const nf = new Intl.NumberFormat();
const num = (n) => nf.format(n);
function bytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
}
function span(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return d + "d " + hr + "h";
  if (hr) return hr + "h " + m + "m";
  return m + "m";
}
function when(ms) { return ms ? new Date(ms).toLocaleString() : "—"; }
function ago(ms) {
  if (!ms) return "never";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
  return new Date(ms).toLocaleDateString();
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch (e) { toast("Couldn't copy. Select the text and copy it yourself.", true); }
}
function randomPassword() {
  const a = new Uint8Array(15);
  crypto.getRandomValues(a);
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(a, (x) => chars[x % chars.length]).join("");
}

// A modal form. Resolves with the entered values, or null if cancelled.
// fields: { name, label, type, value, help, required, minlength, autocomplete, generate, checkbox }
function ask(o) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { "aria-labelledby": "dlg-title" });
    const inputs = {};
    const err = h("p", { class: "status bad", role: "alert" });
    const body = h("div", { class: "body" }, o.text ? h("p", { class: "muted" }, o.text) : null);
    for (const f of o.fields || []) {
      const id = "dlg-" + f.name;
      const input = h("input", { id, name: f.name, type: f.checkbox ? "checkbox" : (f.type || "text"), value: f.value || "",
        required: f.required, minlength: f.minlength, autocomplete: f.autocomplete || "off", spellcheck: "false", placeholder: f.placeholder });
      if (f.checkbox) input.checked = !!f.value;
      inputs[f.name] = input;
      if (f.checkbox) { body.append(h("label", { class: "check" }, input, f.label)); continue; }
      const gen = f.generate ? h("button", { class: "btn", type: "button", onclick: () => { input.type = "text"; input.value = randomPassword(); input.focus(); } }, "Generate") : null;
      body.append(h("div", { class: "field" }, h("label", { for: id }, f.label),
        gen ? h("div", { style: "display:flex;gap:8px" }, input, gen) : input, f.help ? h("span", { class: "help" }, f.help) : null));
    }
    const finish = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const form = h("form", { method: "dialog", onsubmit: (e) => {
      e.preventDefault();
      const values = {};
      for (const [k, el] of Object.entries(inputs)) values[k] = el.type === "checkbox" ? el.checked : el.value;
      if (o.validate) { const msg = o.validate(values); if (msg) { err.textContent = msg; return; } }
      finish(values);
    } },
      h("h2", { id: "dlg-title" }, o.title), body, err,
      h("div", { class: "row-actions" },
        h("button", { class: "btn quiet", type: "button", onclick: () => finish(null) }, o.cancel || "Cancel"),
        h("button", { class: "btn " + (o.danger ? "danger" : "primary"), type: "submit" }, o.confirm || "OK")));
    dlg.append(form);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector("input:not([type=checkbox])") || dlg.querySelector("button[type=submit]");
    if (first) first.focus();
  });
}

// Sign-in form shared by the admin panel and the account page.
function signInView(root, o) {
  const err = h("p", { class: "banner error", role: "alert", hidden: !o.error }, o.error || "");
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { err.textContent = messages[body.error] || body.message || "Couldn't sign in."; err.hidden = false; return; }
      if (o.adminOnly && !body.user.isAdmin) {
        fetch("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer " + body.token } });
        err.textContent = "That account isn't an admin."; err.hidden = false; return;
      }
      setToken(body.token);
      o.done();
    } catch (e2) { err.textContent = "Couldn't reach the server."; err.hidden = false; }
    finally { btn.disabled = false; }
  } },
    err,
    h("div", { class: "field" }, h("label", { for: "u" }, "Username"),
      h("input", { id: "u", name: "username", autocomplete: "username", required: true, autocapitalize: "none", spellcheck: "false" })),
    h("div", { class: "field" }, h("label", { for: "p" }, "Password"),
      h("input", { id: "p", name: "password", type: "password", autocomplete: "current-password", required: true })),
    h("button", { class: "btn primary block", type: "submit" }, "Sign in"));
  root.replaceChildren(
    h("main", { class: "center", id: "main" },
      h("div", { class: "card stack" },
        h("div", { class: "brand" }, $("#logo").content.cloneNode(true), h("div", null, "Cadence", h("small", null, o.label))),
        h("p", { class: "muted" }, o.intro),
        form,
        o.footer || null)));
  $("#u").focus();
}
`;
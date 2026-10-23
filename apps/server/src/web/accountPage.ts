import type { FastifyInstance, FastifyReply } from "fastify";
import { CLIENT_KIT, sendPage } from "./pageKit.js";

// The account page at /account: the signed-in person's own password, devices, data and
// connections, usable from any browser or phone (the app has the same sections in Settings).

const CSS = `
.acct{max-width:720px;margin:0 auto;padding:22px clamp(16px,4vw,32px) 80px}
.acct-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:26px}
.acct-top nav{display:flex;gap:8px;flex-wrap:wrap}
.danger-zone{border-color:var(--danger-line)}
`;

const SCRIPT = `(() => {\n${CLIENT_KIT}\n` + String.raw`
let account = null;
const root = $("#app");
onSignedOut = () => showSignIn();

function showSignIn(error) {
  signInView(root, { label: "Account", intro: "Sign in to manage your password, devices and data.", error, done: start,
    footer: h("p", { class: "small muted" }, "Signed in with single sign-on? Use ", h("a", { href: "/app/" }, "the web player"), " to sign in, then come back here.") });
}

function section(title, hint) {
  const rest = Array.prototype.slice.call(arguments, 2);
  return h("section", { class: "card" }, h("h2", null, title), hint ? h("p", { class: "hint" }, hint) : null, rest);
}
function fieldOf(label, input, help) {
  return h("div", { class: "field" }, h("label", { for: input.id }, label), input, help ? h("span", { class: "help" }, help) : null);
}
function saying() {
  const el = h("p", { class: "status", role: "status" });
  el.say = (text, bad) => { el.textContent = text; el.className = "status " + (bad ? "bad" : "good"); };
  return el;
}
const guard = (fn) => async () => { try { await fn(); } catch (err) { toast(err.message, true); } };

async function start() {
  try { account = await api("/api/me/account"); } catch (e) { return; }
  draw();
}

function draw() {
  const u = account.user;
  const top = h("div", { class: "acct-top" },
    h("div", { class: "brand" }, $("#logo").content.cloneNode(true), h("div", null, "Cadence", h("small", null, "Account"))),
    h("nav", { "aria-label": "Account links" },
      h("a", { class: "btn", href: "/app/" }, "Open web player"),
      u.isAdmin ? h("a", { class: "btn", href: "/admin" }, "Admin panel") : null,
      h("button", { class: "btn", type: "button", onclick: async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch (e) {} setToken(null); showSignIn(); } }, "Sign out")));

  // Profile
  const nameInput = h("input", { id: "dn", value: u.displayName || "", maxlength: "80", autocomplete: "name", placeholder: u.username });
  const profile = section("Profile", null,
    h("dl", { class: "kv", style: "margin-bottom:16px" },
      h("dt", null, "Username"), h("dd", null, "@" + u.username),
      h("dt", null, "Role"), h("dd", null, u.isAdmin ? "Admin" : "Member"),
      h("dt", null, "Member since"), h("dd", null, new Date(account.createdAt).toLocaleDateString()),
      h("dt", null, "Signs in with"), h("dd", null, [account.signIn.password ? "Password" : null, account.signIn.sso ? account.signIn.sso + " (single sign-on)" : null].filter(Boolean).join(" and ") || "—"),
      h("dt", null, "Library"), h("dd", null, num(account.counts.plays) + " plays · " + num(account.counts.likes) + " liked songs · " + num(account.counts.playlists) + " playlists")),
    fieldOf("Display name", nameInput, "Shown to you in the apps. Leave empty to use your username."),
    h("div", { class: "form-actions" }, h("button", { class: "btn primary", type: "button", onclick: guard(async () => {
      const r = await api("/api/me", { method: "PATCH", body: JSON.stringify({ displayName: nameInput.value }) });
      account.user = r; toast("Saved"); draw();
    }) }, "Save name")));

  render(top, profile, passwordSection(), devicesSection(), servicesSection(), dataSection(), dangerSection());
}

function render() {
  const nodes = Array.prototype.slice.call(arguments);
  root.replaceChildren(h("a", { class: "skip", href: "#acct" }, "Skip to content"), h("main", { class: "acct", id: "acct" }, nodes));
}

function passwordSection() {
  if (!account.signIn.password) {
    return section("Password", "You sign in with " + (account.signIn.sso || "single sign-on") + ", so there's no Cadence password to change. Manage it with your identity provider.");
  }
  const status = saying();
  const cur = h("input", { id: "pw0", type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { id: "pw1", type: "password", autocomplete: "new-password", required: true, minlength: "10" });
  const again = h("input", { id: "pw2", type: "password", autocomplete: "new-password", required: true, minlength: "10" });
  const form = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    if (next.value.length < 10) return status.say("Use at least 10 characters.", true);
    if (next.value !== again.value) return status.say("The new passwords don't match.", true);
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const r = await api("/api/me/password", { method: "POST", body: JSON.stringify({ currentPassword: cur.value, newPassword: next.value }) });
      form.reset();
      status.say("Password changed." + (r.signedOut ? " " + r.signedOut + " other device" + (r.signedOut === 1 ? " was" : "s were") + " signed out." : ""));
      refreshDevices();
    } catch (err) { status.say(err.message, true); }
    finally { btn.disabled = false; }
  } },
    fieldOf("Current password", cur), fieldOf("New password", next, "At least 10 characters."), fieldOf("Repeat new password", again),
    h("div", { class: "form-actions", style: "margin-top:0" }, h("button", { class: "btn primary", type: "submit" }, "Change password")), status);
  return section("Password", "Changing it signs you out on every other device.", form);
}

let devicesBox = null;
function devicesSection() {
  devicesBox = h("div", null, h("p", { class: "muted" }, "Loading…"));
  refreshDevices();
  return section("Devices", "Where you're signed in. Sign out anything you don't recognise.", devicesBox);
}
async function refreshDevices() {
  if (!devicesBox) return;
  try {
    const { items } = await api("/api/me/sessions");
    const others = items.filter((s) => !s.current);
    devicesBox.replaceChildren(
      h("ul", { class: "list" }, items.map((s) => h("li", { class: "item" },
        h("div", { class: "grow" },
          h("div", { class: "name" }, s.device, s.current ? h("span", { class: "badge ok", style: "margin-left:8px" }, "This device") : null),
          h("div", { class: "sub" }, "Active " + ago(s.lastUsedAt) + " · signed in " + when(s.createdAt) + (s.ip ? " · " + s.ip : ""))),
        s.current ? null : h("button", { class: "btn", type: "button", onclick: guard(async () => {
          await api("/api/me/sessions/" + encodeURIComponent(s.id), { method: "DELETE" }); toast("Signed out"); refreshDevices();
        }) }, "Sign out")))),
      others.length ? h("button", { class: "btn", type: "button", onclick: guard(async () => {
        const r = await api("/api/me/sessions/sign-out-others", { method: "POST" });
        toast("Signed out " + r.signedOut + " other device" + (r.signedOut === 1 ? "" : "s")); refreshDevices();
      }) }, "Sign out all other devices") : h("p", { class: "muted small" }, "No other devices are signed in."));
  } catch (err) { devicesBox.replaceChildren(h("p", { class: "status bad" }, err.message)); }
}

function servicesSection() {
  const jf = account.connections.jellyfin;
  return section("Connected services", "Music services you linked through this server.",
    h("ul", { class: "list" },
      h("li", { class: "item" },
        h("div", { class: "grow" }, h("div", { class: "name" }, "Jellyfin"),
          h("div", { class: "sub" }, jf ? "Signed in as " + jf.userName + (jf.serverName ? " on " + jf.serverName : "") : "Not connected")),
        h("a", { class: "btn", href: "/app/" }, "Manage in the app"))),
    h("p", { class: "help" }, "Spotify and Apple Music connect on each device from the app's Settings; Cadence keeps no copy of those sign-ins on the server."));
}

function dataSection() {
  const exportBtn = h("button", { class: "btn", type: "button", onclick: guard(async () => {
    exportBtn.disabled = true;
    try {
      const res = await fetch("/api/me/export", { headers: { authorization: "Bearer " + token } });
      if (res.status === 401) { setToken(null); return showSignIn("Your session ended. Sign in again."); }
      if (!res.ok) throw new Error("Couldn't prepare your data (" + res.status + ").");
      const blob = await res.blob();
      const a = h("a", { href: URL.createObjectURL(blob), download: "cadence-" + account.user.username + ".json" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Downloaded your data");
    } finally { exportBtn.disabled = false; }
  }) }, "Download my data");
  const histBtn = h("button", { class: "btn danger", type: "button", onclick: guard(async () => {
    const ok = await ask({ title: "Delete your listening history?", danger: true, confirm: "Delete history",
      text: "This removes all " + num(account.counts.plays) + " plays recorded on this server, on every device. Liked songs and playlists stay. It can't be undone." });
    if (!ok) return;
    const r = await api("/api/me/history", { method: "DELETE" });
    account.counts.plays = 0; toast("Deleted " + num(r.deleted) + " plays"); draw();
  }) }, "Delete my listening history");
  return section("Your data", "Everything this server keeps about you is yours to take or erase.",
    h("div", { class: "stack" },
      h("div", null, h("p", { class: "muted", style: "margin-bottom:10px" }, "A JSON file with your profile, listening history, liked songs, playlists and connections. It never includes passwords or access tokens."), exportBtn),
      h("div", null, h("p", { class: "muted", style: "margin-bottom:10px" }, "Clear the plays that power Home, most played and recommendations."), histBtn)));
}

function dangerSection() {
  const btn = h("button", { class: "btn danger", type: "button", onclick: guard(async () => {
    const hasPw = account.signIn.password;
    const v = await ask({ title: "Delete your account?", danger: true, confirm: "Delete my account",
      text: "This permanently removes your account, history, liked songs and playlists from this server. Download your data first if you want a copy.",
      fields: [hasPw ? { name: "password", label: "Your password", type: "password", required: true, autocomplete: "current-password" }
        : { name: "confirm", label: "Type your username (" + account.user.username + ")", required: true }] });
    if (!v) return;
    await api("/api/me/delete-account", { method: "POST", body: JSON.stringify(v) });
    setToken(null);
    root.replaceChildren(h("main", { class: "center" }, h("div", { class: "card stack" }, h("h2", null, "Your account was deleted"), h("p", { class: "muted" }, "Everything tied to it is gone from this server."), h("a", { class: "btn", href: "/" }, "Done"))));
  }) }, "Delete my account");
  const s = section("Delete account", account.user.isAdmin ? "You're an admin. If you're the only one, make someone else an admin first." : "Removes you and everything tied to you from this server.", btn);
  s.classList.add("danger-zone");
  return s;
}

if (token) start(); else showSignIn();
})();`;

export function registerAccountPage(app: FastifyInstance): void {
  const handler = async (_req: unknown, reply: FastifyReply) =>
    sendPage(reply, { title: "Your Cadence account", body: '<div id="app"></div>', script: SCRIPT, css: CSS });
  app.get("/account", handler);
  app.get("/account/", handler);
}
// Browser code for the admin panel, part 1: shell, overview and people.
// It sits inside a String.raw template, so it uses no template literals.
export const ADMIN_A = String.raw`
let me = null;
const VIEWS = [
  ["overview", "Overview"], ["users", "People"], ["signup", "Sign-up"], ["library", "Library"], ["jellyfin", "Jellyfin"],
  ["ai", "AI providers"], ["sso", "Single sign-on"], ["plugins", "Plugins"], ["activity", "Activity"],
];
let current = "overview";
let restartPending = false;

function pageHead(title, sub) {
  return h("div", { class: "page-head" }, h("h1", { id: "page-title", tabindex: "-1" }, title), sub ? h("p", null, sub) : null);
}
function card(title, hint) {
  const rest = Array.prototype.slice.call(arguments, 2);
  return h("section", { class: "card" }, title ? h("h2", null, title) : null, hint ? h("p", { class: "hint" }, hint) : null, rest);
}
function field(label, input, help) {
  return h("div", { class: "field" }, h("label", { for: input.id }, label), input, help ? h("span", { class: "help" }, help) : null);
}
function saying() {
  const el = h("p", { class: "status", role: "status" });
  el.say = (text, bad) => { el.textContent = text; el.className = "status " + (bad ? "bad" : "good"); };
  return el;
}
function guard(fn) { return async () => { try { await fn(); } catch (err) { toast(err.message, true); } }; }
function button(label, fn, cls) { return h("button", { class: "btn" + (cls ? " " + cls : ""), type: "button", onclick: guard(fn) }, label); }

// ---- Sign-in and shell ---------------------------------------------------
onSignedOut = () => showSignIn();
function showSignIn(error) {
  signInView($("#app"), { label: "Admin", intro: "Sign in with an admin account to manage this server.", adminOnly: true, error, done: start,
    footer: h("p", { class: "small muted" }, "Not an admin? ", h("a", { href: "/account" }, "Go to your account"), ".") });
}

async function start() {
  try { me = await api("/api/me"); } catch (e) { return; }
  if (!me.isAdmin) { setToken(null); return showSignIn("That account isn't an admin."); }
  $("#app").replaceChildren(
    h("a", { class: "skip", href: "#view" }, "Skip to content"),
    h("div", { class: "shell" },
      h("nav", { class: "side", "aria-label": "Admin sections" },
        h("div", { class: "brand" }, $("#logo").content.cloneNode(true), h("div", null, "Cadence", h("small", null, "Admin"))),
        VIEWS.map((v) => h("a", { class: "nav-link", href: "#/" + v[0], "data-view": v[0] }, v[1], v[0] === "plugins" ? h("span", { class: "dot", id: "restart-dot", hidden: !restartPending, title: "Restart needed" }) : null)),
        h("div", { class: "spacer" }),
        h("a", { class: "nav-link", href: "/app/" }, "Open web player"),
        h("a", { class: "nav-link", href: "/account" }, "My account"),
        h("div", { class: "me" }, "Signed in as ", h("b", null, me.username)),
        h("button", { class: "nav-link", type: "button", onclick: async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch (e) {} setToken(null); showSignIn(); } }, "Sign out")),
      h("main", { id: "view", tabindex: "-1" })));
  window.addEventListener("hashchange", route);
  route();
  api("/api/admin/plugins").then((r) => setRestart(r.restartRequired)).catch(() => {});
}
function setRestart(v) {
  restartPending = !!v;
  const dot = $("#restart-dot");
  if (dot) dot.hidden = !restartPending;
}
function route() {
  const v = location.hash.replace(/^#\/?/, "") || "overview";
  show(views[v] ? v : "overview");
}
async function show(view) {
  current = view;
  document.querySelectorAll(".nav-link[data-view]").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const box = $("#view");
  box.replaceChildren(h("p", { class: "muted", role: "status" }, "Loading…"));
  const mine = ++showSeq;
  try { await views[view](); }
  catch (err) { if (mine === showSeq) box.replaceChildren(h("div", { class: "banner error", role: "alert" }, err.message)); return; }
  if (mine === showSeq) { const t = $("#page-title"); if (t) t.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}
let showSeq = 0;
const render = (...nodes) => $("#view").replaceChildren(...nodes);

// ---- Overview ------------------------------------------------------------
async function renderOverview() {
  const [o, lib, folder, upd] = await Promise.all([api("/api/admin/overview"), api("/api/library/status"), api("/api/admin/library"), api("/api/admin/update-check")]);
  const stat = (n, label) => h("div", { class: "stat" }, h("b", null, n), h("span", null, label));
  const dataDisk = o.storage.data;

  const attention = [];
  if (!folder.exists) attention.push("The music folder (" + folder.folder + ") doesn't exist or isn't a folder.");
  else if (!folder.readable) attention.push("The server can't read the music folder (" + folder.folder + ").");
  else if (!o.tracks) attention.push("The library is empty. Add music to the folder, then rescan.");
  if (o.oidc && !o.publicUrl) attention.push("Single sign-on is set up but PUBLIC_URL isn't, so sign-in can't complete.");
  if (dataDisk && dataDisk.freeBytes / dataDisk.totalBytes < 0.1) attention.push("The disk holding the server's data is almost full (" + bytes(dataDisk.freeBytes) + " free).");
  if (!o.admins) attention.push("There are no admins.");

  const updateBox = h("div");
  function drawUpdate(s) {
    const bits = [];
    if (!s) bits.push(h("p", { class: "muted" }, "Not checked yet. This contacts GitHub once, when you press the button."));
    else if (s.error) bits.push(h("p", { class: "status bad" }, s.error));
    else if (s.upToDate === true) bits.push(h("p", { class: "status good" }, "You're on the latest version (" + o.version + ")."));
    else if (s.upToDate === false) bits.push(h("div", { class: "banner warn" }, h("span", null, "Version " + s.latest + " is available (you have " + o.version + "). "), s.url ? h("a", { href: s.url, rel: "noopener noreferrer", target: "_blank" }, "See what's new") : null));
    else bits.push(h("p", { class: "muted" }, "Latest release: " + (s.latest || "unknown") + ". You have " + o.version + "."));
    if (s) bits.push(h("p", { class: "help" }, "Last checked " + when(s.checkedAt) + "."));
    updateBox.replaceChildren(...bits);
  }
  drawUpdate(upd.status);
  const checkBtn = h("button", { class: "btn", type: "button", onclick: async () => {
    checkBtn.disabled = true; checkBtn.textContent = "Checking…";
    try { const r = await api("/api/admin/update-check", { method: "POST" }); drawUpdate(r.status); }
    catch (err) { toast(err.message, true); }
    finally { checkBtn.disabled = false; checkBtn.textContent = "Check for updates"; }
  } }, "Check for updates");

  render(
    pageHead("Overview", "Cadence server " + o.version + (o.publicUrl ? " · " + o.publicUrl : "")),
    attention.length
      ? h("div", { class: "banner warn", role: "status" }, h("div", null, h("b", null, "Needs attention"), h("ul", { style: "margin:6px 0 0 18px" }, attention.map((a) => h("li", null, a)))))
      : null,
    h("div", { class: "stats" },
      stat(num(o.users), "accounts" + (o.disabledUsers ? " (" + o.disabledUsers + " off)" : "")), stat(num(o.activeSessions), "active sessions (7 days)"),
      stat(num(o.tracks), "tracks in the library"), stat(lib.lastScanAt ? ago(lib.lastScanAt) : "not yet", lib.scanning ? "last scan (scanning now)" : "last library scan"),
      stat(num(o.plays), "plays recorded"), stat(span(o.uptimeSec), "server uptime"),
      stat(bytes(o.storage.dbBytes), "database size"), stat(dataDisk ? bytes(dataDisk.freeBytes) : "—", "free disk space")),
    card("Updates", "Compare this server with the latest GitHub release.", updateBox, h("div", { class: "form-actions" }, checkBtn)),
    card("Sign-up", o.signup.mode === "closed" ? "Closed: only admins can add people." : o.signup.mode === "open" ? "Open: anyone with the link can create an account." : "Invite-only: people need the invite code.",
      h("a", { class: "btn", href: "#/signup" }, "Change sign-up")),
    card("Server", null, h("dl", { class: "kv" },
      h("dt", null, "Version"), h("dd", null, o.version),
      h("dt", null, "Runtime"), h("dd", null, "Node " + o.node + " on " + o.platform),
      h("dt", null, "Single sign-on"), h("dd", null, o.oidc ? o.oidc.name + " (" + o.oidc.issuer + ")" : "Not set up"),
      h("dt", null, "Community plugins"), h("dd", null, o.communityPlugins.enabled + " on, " + o.communityPlugins.available + " installed"))));
}

// ---- People --------------------------------------------------------------
async function renderUsers() {
  let { items } = await api("/api/admin/users");
  let filter = "";
  const list = h("ul", { class: "list" });

  async function reload() { items = (await api("/api/admin/users")).items; draw(); }
  const act = (label, fn, cls) => button(label, async () => { await fn(); await reload(); }, cls);

  function row(u) {
    const self = u.id === me.id;
    const actions = self ? [h("a", { class: "btn", href: "/account" }, "My account")] : [
      act(u.isAdmin ? "Remove admin" : "Make admin", async () => {
        await api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ isAdmin: !u.isAdmin }) });
        toast(u.isAdmin ? u.username + " is no longer an admin" : u.username + " is now an admin");
      }),
      act(u.disabled ? "Switch on" : "Switch off", async () => {
        if (!u.disabled) {
          const ok = await ask({ title: "Switch off " + u.username + "?", text: "They are signed out everywhere and can't sign in until you switch them back on. Nothing is deleted.", confirm: "Switch off" });
          if (!ok) return;
        }
        await api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ disabled: !u.disabled }) });
        toast(u.disabled ? u.username + " can sign in again" : u.username + " is switched off");
      }),
      u.signIn === "sso" ? null : act("Reset password", async () => {
        const v = await ask({ title: "Reset password for " + u.username, text: "They are signed out everywhere and must use the new password. Share it with them privately.",
          fields: [{ name: "password", label: "New password", type: "password", required: true, minlength: "10", autocomplete: "new-password", generate: true, help: "At least 10 characters." }],
          confirm: "Reset password", validate: (x) => (x.password.length < 10 ? "Use at least 10 characters." : "") });
        if (!v) return;
        await api("/api/admin/users/" + u.id, { method: "PATCH", body: JSON.stringify({ password: v.password }) });
        toast("Password reset for " + u.username);
      }),
      act("Sign out", async () => {
        const r = await api("/api/admin/users/" + u.id + "/sign-out", { method: "POST" });
        toast("Ended " + r.signedOut + " session" + (r.signedOut === 1 ? "" : "s"));
      }),
      act("Delete", async () => {
        const v = await ask({ title: "Delete " + u.username + "?", danger: true, confirm: "Delete account",
          text: "This removes their account, listening history, likes and playlists for good. It can't be undone. If you only want to stop them signing in, switch them off instead.",
          fields: [{ name: "name", label: "Type " + u.username + " to confirm", required: true }],
          validate: (x) => (x.name.trim().toLowerCase() !== u.username.toLowerCase() ? "That doesn't match the username." : "") });
        if (!v) return;
        await api("/api/admin/users/" + u.id, { method: "DELETE" });
        toast("Deleted " + u.username);
      }, "danger"),
    ];
    return h("li", { class: "item" },
      h("span", { class: "avatar" + (u.disabled ? " off" : ""), "aria-hidden": "true" }, (u.displayName || u.username).charAt(0).toUpperCase()),
      h("div", { class: "grow" },
        h("div", { class: "name" }, u.displayName || u.username),
        h("div", { class: "sub" }, "@" + u.username + (u.email ? " · " + u.email : "")),
        h("div", { class: "sub" }, "Last seen " + ago(u.lastSeenAt) + " · " + num(u.plays) + " plays · " + u.sessions + " session" + (u.sessions === 1 ? "" : "s")),
        h("div", { class: "tags" },
          u.isAdmin ? h("span", { class: "badge accent" }, "Admin") : h("span", { class: "badge" }, "Member"),
          u.signIn !== "password" ? h("span", { class: "badge" }, "SSO") : null,
          u.disabled ? h("span", { class: "badge danger" }, "Switched off") : null,
          self ? h("span", { class: "badge ok" }, "You") : null)),
      h("div", { class: "actions" }, actions));
  }

  function draw() {
    const q = filter.trim().toLowerCase();
    const shown = items.filter((u) => !q || (u.username + " " + (u.displayName || "") + " " + (u.email || "")).toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown.map(row) : [h("li", { class: "empty" }, "No one matches that.")]));
    count.textContent = items.length + " account" + (items.length === 1 ? "" : "s") + " on this server.";
  }
  const count = h("p", { class: "muted" });
  const search = h("input", { id: "filter", type: "search", placeholder: "Search people", "aria-label": "Search people", oninput: (e) => { filter = e.target.value; draw(); } });

  const add = button("Add person", async () => {
    const v = await ask({ title: "Add someone", text: "Creates a password account. Share the password with them privately; they can change it on their Account page.", confirm: "Add person",
      fields: [
        { name: "username", label: "Username", required: true, autocomplete: "off" },
        { name: "displayName", label: "Name (optional)" },
        { name: "password", label: "Password", type: "password", required: true, minlength: "10", autocomplete: "new-password", generate: true, help: "At least 10 characters." },
        { name: "isAdmin", label: "Make them an admin", checkbox: true },
      ],
      validate: (x) => (!/^[\w.@-]{1,48}$/.test(x.username.trim()) ? "Usernames can use letters, numbers, dots, dashes, underscores and @." : x.password.length < 10 ? "Use at least 10 characters." : "") });
    if (!v) return;
    await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: v.username.trim(), displayName: v.displayName, password: v.password, isAdmin: v.isAdmin }) });
    toast("Added " + v.username.trim());
    await reload();
  }, "primary");

  draw();
  render(pageHead("People", null), count,
    h("div", { class: "toolbar", style: "margin-top:14px" }, items.length > 6 ? search : h("span"), add), list);
}
`;
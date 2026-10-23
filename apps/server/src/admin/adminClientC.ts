// Browser code for the admin panel, part 3: single sign-on, plugins, activity and start-up.
export const ADMIN_C = String.raw`
// ---- Single sign-on ------------------------------------------------------
const SSO_ENV = { issuer: "OIDC_ISSUER", clientId: "OIDC_CLIENT_ID", clientSecret: "OIDC_CLIENT_SECRET", displayName: "OIDC_NAME", scopes: "OIDC_SCOPES", allowedGroups: "OIDC_ALLOWED_GROUPS", adminGroups: "OIDC_ADMIN_GROUPS" };

async function renderSso() {
  const s = await api("/api/admin/sso");
  const locked = s.locked || {};
  const anyEnv = Object.keys(locked).some((k) => locked[k]);
  const anySaved = Object.keys(s.source || {}).some((k) => s.source[k] === "admin");
  const lockNote = (f) => locked[f] ? "Set by " + SSO_ENV[f] + " in the server's environment, so it is locked here." : null;
  const input = (id, f, value, extra) => h("input", Object.assign({ id: id, value: value || "", disabled: !!locked[f], autocomplete: "off", spellcheck: "false" }, extra || {}));

  const issuer = input("sso-issuer", "issuer", s.issuer, { type: "url", placeholder: "https://auth.example.com/application/o/cadence/" });
  const clientId = input("sso-client", "clientId", s.clientId, { placeholder: "cadence" });
  const secret = input("sso-secret", "clientSecret", "", { type: "password", autocomplete: "new-password",
    placeholder: locked.clientSecret ? "Set in the environment" : s.hasClientSecret ? "Saved. Leave empty to keep it" : "Leave empty for a public client" });
  const name = input("sso-name", "displayName", s.source && s.source.displayName === "default" ? "" : s.name, { placeholder: "Single sign-on", maxlength: "60" });
  const scopes = input("sso-scopes", "scopes", s.scopes, { placeholder: "openid profile email" });
  const allowed = input("sso-allowed", "allowedGroups", (s.allowedGroups || []).join(", "), { placeholder: "music-users" });
  const admins = input("sso-admins", "adminGroups", (s.adminGroups || []).join(", "), { placeholder: "music-admins" });
  let removeSecret = false;
  const result = saying();

  function body() {
    const b = {};
    if (!locked.issuer) b.issuer = issuer.value.trim();
    if (!locked.clientId) b.clientId = clientId.value.trim();
    if (!locked.displayName) b.displayName = name.value.trim();
    if (!locked.scopes) b.scopes = scopes.value.trim();
    if (!locked.allowedGroups) b.allowedGroups = allowed.value;
    if (!locked.adminGroups) b.adminGroups = admins.value;
    if (!locked.clientSecret) b.clientSecret = removeSecret ? null : secret.value;
    return b;
  }

  async function test() {
    result.say("Contacting the provider…");
    try {
      const r = await api("/api/admin/sso/test", { method: "POST", body: JSON.stringify({ issuer: issuer.value.trim() }) });
      result.say(r.ok ? "Connected. The provider answered as " + r.issuer + "." : "Couldn't use that issuer: " + r.error, !r.ok);
      return r.ok;
    } catch (err) { result.say(err.message, true); return false; }
  }

  const ERRORS = {
    invalid_issuer: "The issuer must be an http(s) address, like https://auth.example.com/realms/home.",
    invalid_clientId: "The client ID can't contain spaces.",
    scopes_need_openid: "Scopes must include openid.",
    invalid_allowedGroups: "Allowed groups: use a comma-separated list of up to 50 names.",
    invalid_adminGroups: "Admin groups: use a comma-separated list of up to 50 names.",
  };
  Object.assign(messages, ERRORS);

  async function save() {
    try {
      const next = await api("/api/admin/sso", { method: "PUT", body: JSON.stringify(body()) });
      toast(next.active ? "Saved. The next sign-in uses these settings." : "Saved");
      renderSso();
    } catch (err) { result.say(err.message, true); }
  }

  const status = !s.configured
    ? h("div", { class: "banner", role: "status" }, "Not set up yet. Fill in the issuer and client ID below and save; the Sign in button appears in the apps straight away.")
    : s.discovery && s.discovery.ok ? h("div", { class: "banner ok", role: "status" }, "On. " + s.name + " is reachable and answered its discovery document.")
      : h("div", { class: "banner error", role: "alert" }, "Couldn't reach the provider" + (s.discovery && s.discovery.error ? ": " + s.discovery.error : "."));

  const copyRow = (label, value) => h("div", { class: "field" },
    h("span", { class: "help" }, label),
    value ? h("div", { class: "copy-row", style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
      h("code", { style: "overflow-wrap:anywhere;min-width:0;flex:1 1 200px;padding:10px 12px" }, value),
      h("button", { class: "btn", type: "button", onclick: () => copy(value), "aria-label": "Copy " + label }, "Copy"))
      : h("p", { class: "muted" }, "Needs PUBLIC_URL"));

  render(pageHead("Single sign-on", "Let people sign in with an account from your own identity provider (Authentik, Keycloak, Authelia, Google…)."),
    status,
    !s.publicUrlSet ? h("div", { class: "banner warn" }, "PUBLIC_URL isn't set, so sign-in can't return to this server. Set it in the server's environment and restart.") : null,
    s.secretUnreadable ? h("div", { class: "banner warn" }, "The saved client secret can't be read (the server secret changed). Enter it again.") : null,
    card("1. Register Cadence at your provider", "Create an OpenID Connect client (confidential or public with PKCE) and add both addresses as allowed redirect URIs.",
      copyRow("Server callback", s.callbackUrl), copyRow("Web player", s.webCallbackUrl)),
    card("2. Provider", "Saved here and used from the next sign-in. No restart needed." + (anyEnv ? " Fields set with OIDC_* variables win and are locked; change those in the environment and restart." : ""),
      field("Issuer", issuer, lockNote("issuer") || "The provider's issuer address. Cadence reads <issuer>/.well-known/openid-configuration."),
      field("Client ID", clientId, lockNote("clientId")),
      field("Client secret", secret, lockNote("clientSecret") || (s.hasClientSecret ? "Stored encrypted and never shown again. Type a new one to replace it." : "Stored encrypted with this server's secret.")),
      !locked.clientSecret && s.hasClientSecret ? h("label", { class: "check", style: "display:flex;gap:10px;align-items:center;min-height:44px" },
        h("input", { type: "checkbox", id: "sso-remove-secret", onchange: (e) => { removeSecret = e.target.checked; secret.disabled = removeSecret; } }),
        "Remove the saved secret (public client)") : null,
      field("Button label", name, lockNote("displayName") || "Shown as Sign in with <label>."),
      field("Scopes", scopes, lockNote("scopes") || "Space-separated. Must include openid. Add groups if your provider needs it for the groups claim.")),
    card("3. Who can sign in", "Groups come from the groups claim in the ID token or userinfo. Comma-separated; empty means anyone your provider lets through.",
      field("Allowed groups", allowed, lockNote("allowedGroups")),
      field("Admin groups", admins, lockNote("adminGroups") || "Members become admins here (and stop being admins when removed from the group). Empty: admins are made on the People page."),
      h("p", { class: "muted small" }, s.ssoAccounts === 1 ? "1 account signs in this way." : s.ssoAccounts + " accounts sign in this way.")),
    h("section", { class: "card" },
      h("div", { class: "form-actions" },
        h("button", { class: "btn", type: "button", onclick: test }, "Test connection"),
        button("Save", save, "primary"),
        anySaved ? button("Remove saved settings", async () => {
          const ok = await ask({ title: "Remove the saved single sign-on settings?", text: anyEnv ? "Values from the environment stay in effect." : "The Sign in button disappears from the apps. Existing accounts stay; their owners need a password to sign in.", confirm: "Remove", danger: true });
          if (!ok) return;
          await api("/api/admin/sso", { method: "DELETE" });
          toast("Single sign-on settings removed"); renderSso();
        }, "danger") : null),
      result));
}

// ---- Plugins -------------------------------------------------------------
async function renderPlugins() {
  const data = await api("/api/admin/plugins");
  let items = data.items;

  function drawAll() {
    setRestart(items.some((i) => i.restartRequired));
    render(pageHead("Plugins", "Community plugins add features to the server. They start off; you choose which to run."),
      items.some((i) => i.restartRequired)
        ? h("div", { class: "banner warn", role: "status" }, h("div", null, h("b", null, "Restart required. "), "Changes below apply the next time the server starts (for example docker compose restart server). Until then the server keeps running as before."))
        : null,
      items.length ? items.map(pluginCard) : card("No community plugins installed", "Community plugins are folders compiled into this server (src/community/<name>/plugin.ts). This build doesn't include any, so there is nothing to turn on. The built-in features (library, history, AI DJ, Jellyfin) are always on."));
  }

  function update(next) { items = items.map((i) => (i.id === next.id ? next : i)); drawAll(); }

  function pluginCard(p) {
    const sw = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(p.enabled), "aria-label": (p.enabled ? "Turn off " : "Turn on ") + p.name, onclick: guard(async () => {
      sw.disabled = true;
      try {
        const next = await api("/api/admin/plugins/" + encodeURIComponent(p.id), { method: "PUT", body: JSON.stringify({ enabled: !p.enabled }) });
        toast(next.enabled ? p.name + " will run after the server restarts" : p.name + " will stop after the server restarts");
        update(next);
      } finally { sw.disabled = false; }
    }) });
    const panel = h("div", { hidden: true, style: "margin-top:14px" });
    const settingsBtn = p.settings === "none" ? null : h("button", { class: "btn", type: "button", "aria-expanded": "false", onclick: () => {
      panel.hidden = !panel.hidden;
      settingsBtn.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden && !panel.firstChild) panel.append(configEditor(p, update));
    } }, "Settings");
    if (p.settings === "none") panel.append(p.configNote ? h("p", { class: "hint" }, p.configNote) : h("p", { class: "hint" }, "This plugin has no settings."));
    if (p.settings === "none") panel.hidden = false;
    return h("section", { class: "card" },
      h("div", { style: "display:flex;gap:14px;align-items:flex-start;justify-content:space-between" },
        h("div", { style: "min-width:0" },
          h("h2", null, p.name, " ", h("span", { class: "faint small" }, "v" + p.version)),
          h("div", { class: "tags", style: "display:flex;flex-wrap:wrap;gap:6px;margin:8px 0" },
            p.running ? h("span", { class: "badge ok" }, "Running") : h("span", { class: "badge" }, "Not running"),
            p.restartRequired ? h("span", { class: "badge warn" }, "Restart required") : null,
            h("span", { class: "badge" }, p.id)),
          p.description ? h("p", { class: "muted" }, p.description) : null,
          routesList(p)),
        h("span", { class: "switch-wrap" }, sw)),
      h("div", { class: "form-actions", style: "margin-top:12px" }, settingsBtn),
      panel);
  }

  drawAll();
}

function routesList(p) {
  const admin = p.adminRoutes || [];
  const user = p.userRoutes || [];
  if (!admin.length && !user.length) return null;
  const rows = admin.map((r) => [r, "admin"]).concat(user.map((r) => [r, "signed-in users"]));
  return h("details", { class: "small", style: "margin-top:8px" }, h("summary", { class: "faint" }, "Routes (" + rows.length + ")"),
    h("ul", { class: "list" }, rows.map((r) => h("li", null, h("code", null, r[0]), " ", h("span", { class: "faint" }, r[1])))));
}

// Settings may be nested ("lidarr.url"), so read and write them by path.
function getPath(o, key) { return key.split(".").reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), o); }
function setPath(o, key, v) {
  const ks = key.split(".");
  let c = o;
  for (let i = 0; i < ks.length - 1; i++) { if (!c[ks[i]] || typeof c[ks[i]] !== "object" || Array.isArray(c[ks[i]])) c[ks[i]] = {}; c = c[ks[i]]; }
  c[ks[ks.length - 1]] = v;
}
function delPath(o, key) {
  const ks = key.split(".");
  const trail = [o];
  for (let i = 0; i < ks.length - 1; i++) { const n = trail[i] && trail[i][ks[i]]; if (!n || typeof n !== "object") return; trail.push(n); }
  delete trail[trail.length - 1][ks[ks.length - 1]];
  for (let i = trail.length - 1; i > 0; i--) if (Object.keys(trail[i]).length === 0) delete trail[i - 1][ks[i - 1]];
}

function configEditor(p, onSaved) {
  const fields = p.configFields || [];
  const saved = p.config || {};
  const status = saying();
  let jsonMode = fields.length === 0;
  const wrap = h("div");

  async function save(config) {
    try {
      const next = await api("/api/admin/plugins/" + encodeURIComponent(p.id), { method: "PUT", body: JSON.stringify({ config }) });
      toast("Saved. Applies after the server restarts.");
      onSaved(next);
    } catch (err) { status.say(err.message, true); }
  }

  function formView() {
    const inputs = {};
    const grid = h("div", { class: "form-grid" }, fields.map((f) => {
      const id = "pc-" + p.id + "-" + f.key;
      const cur = getPath(saved, f.key);
      if (f.sealed) {
        return field(f.label, h("span", { id, class: "badge" + (cur ? " ok" : "") }, cur ? "Set (stored encrypted)" : "Not set"), f.help);
      }
      const shown = cur === undefined || cur === null ? f.default : cur;
      let input;
      if (f.type === "boolean") { input = h("input", { id, type: "checkbox" }); input.checked = shown === true; }
      else if (f.type === "select") {
        input = h("select", { id }, [h("option", { value: "" }, "Default")].concat((f.options || []).map((o) => h("option", { value: o.value }, o.label))));
        input.value = cur === undefined || cur === null ? "" : String(cur);
      } else {
        input = h("input", { id, type: f.type === "secret" ? "password" : f.type === "number" ? "number" : f.type === "url" ? "url" : "text",
          value: cur === undefined || cur === null ? "" : String(cur), placeholder: f.placeholder || (f.default !== undefined ? "Default: " + f.default : undefined), autocomplete: "off", spellcheck: "false" });
      }
      inputs[f.key] = input;
      return f.type === "boolean" ? h("div", { class: "field" }, h("label", { class: "check" }, input, f.label), f.help ? h("span", { class: "help" }, f.help) : null) : field(f.label, input, f.help);
    }));
    return [p.configNote ? h("p", { class: "hint" }, p.configNote) : null, grid, h("div", { class: "form-actions" },
      h("button", { class: "btn primary", type: "button", onclick: () => {
        const out = JSON.parse(JSON.stringify(saved));
        for (const f of fields) {
          if (f.sealed) continue;
          const el = inputs[f.key];
          if (f.type === "boolean") setPath(out, f.key, el.checked);
          else if (el.value === "") delPath(out, f.key);
          else setPath(out, f.key, f.type === "number" ? Number(el.value) : el.value);
        }
        save(out);
      } }, "Save settings"),
      h("button", { class: "btn quiet", type: "button", onclick: () => { jsonMode = true; draw(); } }, "Edit as JSON"))];
  }

  function jsonView() {
    const ta = h("textarea", { id: "pj-" + p.id, spellcheck: "false", "aria-label": "Settings for " + p.name + " as JSON" }, JSON.stringify(p.config || {}, null, 2));
    return [h("p", { class: "hint" }, "Plain JSON. Keys, secrets and tokens show as ******** when saved: leave the stars to keep the stored value."), ta,
      h("div", { class: "form-actions" },
        h("button", { class: "btn primary", type: "button", onclick: () => {
          let parsed;
          try { parsed = JSON.parse(ta.value || "{}"); } catch (e) { return status.say("That isn't valid JSON: " + e.message, true); }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return status.say("Settings must be a JSON object, like {\"key\": \"value\"}.", true);
          save(parsed);
        } }, "Save settings"),
        p.config ? h("button", { class: "btn danger", type: "button", onclick: async () => {
          const ok = await ask({ title: "Clear " + p.name + " settings?", text: "Its saved settings are removed. The plugin goes back to its defaults after a restart.", confirm: "Clear settings", danger: true });
          if (ok) save(null);
        } }, "Clear settings") : null,
        fields.length ? h("button", { class: "btn quiet", type: "button", onclick: () => { jsonMode = false; draw(); } }, "Use the form") : null)];
  }

  function draw() { wrap.replaceChildren(...(jsonMode ? jsonView() : formView()), status); }
  draw();
  return wrap;
}

// ---- Activity ------------------------------------------------------------
const ACTION_TEXT = {
  "user.create": "Added an account", "user.delete": "Deleted an account", "user.sign-out": "Signed someone out", "user.promote": "Made someone an admin",
  "user.demote": "Removed admin rights", "user.disable": "Switched an account off", "user.enable": "Switched an account on", "user.reset-password": "Reset a password",
  "user.rename": "Renamed an account", "signup.update": "Changed sign-up", "jellyfin.update": "Changed the Jellyfin address", "ai.provider.add": "Added an AI provider",
  "ai.provider.update": "Changed an AI provider", "ai.provider.remove": "Removed an AI provider", "library.scan": "Started a library scan", "plugin.update": "Changed a plugin",
};
function actionText(a) {
  if (ACTION_TEXT[a]) return ACTION_TEXT[a];
  if (a.indexOf("user.") === 0 && a.indexOf("+") !== -1) return a.slice(5).split("+").map((x) => ACTION_TEXT["user." + x] || x).join(" and ");
  return a;
}
async function renderActivity() {
  let { items, next } = await api("/api/admin/audit?limit=50");
  const list = h("ul", { class: "list" });
  const more = h("button", { class: "btn", type: "button", onclick: guard(async () => {
    const r = await api("/api/admin/audit?limit=50&before=" + next);
    items = items.concat(r.items); next = r.next; draw();
  }) }, "Show older");
  function draw() {
    list.replaceChildren(...(items.length ? items.map((e) => h("li", { class: "item" },
      h("div", { class: "grow" }, h("div", { class: "name" }, actionText(e.action), e.target ? h("span", { class: "muted" }, " · " + e.target) : null),
        h("div", { class: "sub" }, e.actor + " · " + when(e.at) + (e.detail ? " · " + e.detail : ""))))) : [h("li", { class: "empty" }, "Nothing yet. Changes made by admins show up here.")]));
    more.hidden = next == null;
  }
  draw();
  render(pageHead("Activity", "What admins changed on this server. Passwords and keys are never recorded."), list, more);
}

const views = { overview: renderOverview, users: renderUsers, signup: renderSignup, library: renderLibrary, jellyfin: renderJellyfin, ai: renderAi,
  sso: renderSso, plugins: renderPlugins, activity: renderActivity };

if (token) start(); else showSignIn();
`;
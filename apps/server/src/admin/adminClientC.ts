// Browser code for the admin panel, part 3: single sign-on, plugins, activity and start-up.
export const ADMIN_C = String.raw`
// ---- Single sign-on (read-only) -----------------------------------------
async function renderSso() {
  const s = await api("/api/admin/sso");
  if (!s.configured) {
    return render(pageHead("Single sign-on", "Let people sign in with an account from your own identity provider."),
      card("Not set up", "Single sign-on isn't configured on this server. It is set with OIDC_* variables in the server's environment (the setup script can do it), then a restart. This page only shows its status; it never changes it.",
        h("p", { class: "muted" }, "Works with Authentik, Keycloak, Authelia, Google and any other OpenID Connect provider.")));
  }
  const list = (a) => (a.length ? a.join(", ") : "Anyone who can sign in there");
  render(pageHead("Single sign-on", "Read-only. Change it in the server's environment, then restart."),
    s.discovery.ok ? h("div", { class: "banner ok", role: "status" }, "The provider " + s.name + " is reachable and answered its discovery document.")
      : h("div", { class: "banner error", role: "alert" }, "Couldn't reach the provider" + (s.discovery.error ? ": " + s.discovery.error : ".")),
    !s.publicUrlSet ? h("div", { class: "banner warn" }, "PUBLIC_URL isn't set, so sign-in can't return to this server. Set it and restart.") : null,
    card("Provider", null, h("dl", { class: "kv" },
      h("dt", null, "Button label"), h("dd", null, "Sign in with " + s.name),
      h("dt", null, "Issuer"), h("dd", null, h("code", null, s.issuer)),
      h("dt", null, "Client ID"), h("dd", null, h("code", null, s.clientId)),
      h("dt", null, "Client secret"), h("dd", null, s.hasClientSecret ? "Set (hidden)" : "None (public client)"),
      h("dt", null, "Scopes"), h("dd", null, s.scopes),
      h("dt", null, "Accounts using it"), h("dd", null, String(s.ssoAccounts)))),
    card("Access", "Groups are read from the sign-in token.", h("dl", { class: "kv" },
      h("dt", null, "Allowed groups"), h("dd", null, list(s.allowedGroups)),
      h("dt", null, "Admin groups"), h("dd", null, s.adminGroups.length ? s.adminGroups.join(", ") : "None: admins are made here"))),
    card("Redirect addresses", "Add these as allowed redirect URIs at your provider.", h("dl", { class: "kv" },
      h("dt", null, "Server callback"), h("dd", null, s.callbackUrl ? h("code", null, s.callbackUrl) : "Needs PUBLIC_URL"),
      h("dt", null, "Web player"), h("dd", null, s.webCallbackUrl ? h("code", null, s.webCallbackUrl) : "Needs PUBLIC_URL"))));
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
    const settingsBtn = h("button", { class: "btn", type: "button", "aria-expanded": "false", onclick: () => {
      panel.hidden = !panel.hidden;
      settingsBtn.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden && !panel.firstChild) panel.append(configEditor(p, update));
    } }, "Settings");
    return h("section", { class: "card" },
      h("div", { style: "display:flex;gap:14px;align-items:flex-start;justify-content:space-between" },
        h("div", { style: "min-width:0" },
          h("h2", null, p.name, " ", h("span", { class: "faint small" }, "v" + p.version)),
          h("div", { class: "tags", style: "display:flex;flex-wrap:wrap;gap:6px;margin:8px 0" },
            p.running ? h("span", { class: "badge ok" }, "Running") : h("span", { class: "badge" }, "Not running"),
            p.restartRequired ? h("span", { class: "badge warn" }, "Restart required") : null,
            h("span", { class: "badge" }, p.id)),
          p.description ? h("p", { class: "muted" }, p.description) : null),
        h("span", { class: "switch-wrap" }, sw)),
      h("div", { class: "form-actions", style: "margin-top:12px" }, settingsBtn),
      panel);
  }

  drawAll();
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
      const cur = saved[f.key];
      const input = f.type === "boolean" ? h("input", { id, type: "checkbox" }) : h("input", { id, type: f.type === "password" ? "password" : f.type === "number" ? "number" : f.type === "url" ? "url" : "text",
        value: cur == null ? "" : String(cur), placeholder: f.placeholder, autocomplete: "off", spellcheck: "false" });
      if (f.type === "boolean") input.checked = cur === true;
      inputs[f.key] = input;
      return f.type === "boolean" ? h("label", { class: "check" }, input, f.label) : field(f.label, input, f.help);
    }));
    return [grid, h("div", { class: "form-actions" },
      h("button", { class: "btn primary", type: "button", onclick: () => {
        const out = Object.assign({}, saved);
        for (const f of fields) {
          const el = inputs[f.key];
          if (f.type === "boolean") out[f.key] = el.checked;
          else if (el.value === "") delete out[f.key];
          else out[f.key] = f.type === "number" ? Number(el.value) : el.value;
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
  "signin.locked": "Sign-in locked after failed attempts", "signin.ip_locked": "Address blocked after failed sign-ins",
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
  render(pageHead("Activity", "What admins changed on this server, and sign-in lockouts. Passwords and keys are never recorded."), list, more);
}

const views = { overview: renderOverview, users: renderUsers, signup: renderSignup, library: renderLibrary, jellyfin: renderJellyfin, ai: renderAi,
  sso: renderSso, plugins: renderPlugins, activity: renderActivity };

if (token) start(); else showSignIn();
`;
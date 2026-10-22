// Browser code for the admin panel, part 2: sign-up, library, Jellyfin and AI providers.
export const ADMIN_B = String.raw`
// ---- Sign-up -------------------------------------------------------------
async function renderSignup() {
  const o = await api("/api/admin/overview");
  let mode = o.signup.mode;
  const code = h("input", { id: "code", value: o.signup.inviteCode || "", placeholder: "Leave empty to make one", autocomplete: "off", spellcheck: "false", oninput: drawShare });
  const codeRow = h("div", { hidden: mode !== "invite" },
    field("Invite code", code, "6-64 letters, numbers, dashes or underscores. Anyone who has it can sign up while the mode is invite-only."),
    h("div", { class: "form-actions", style: "margin-top:10px" },
      button("Make a new code", async () => { code.value = randomPassword().slice(0, 10); drawShare(); }),
      button("Copy code", () => copy(code.value))));
  const modes = [["closed", "Closed"], ["invite", "Invite-only"], ["open", "Open"]];
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Who can sign up" },
    modes.map((m) => h("button", { type: "button", role: "radio", "aria-checked": String(m[0] === mode), onclick: () => {
      mode = m[0];
      seg.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-checked", String(modes[i][0] === mode)));
      codeRow.hidden = mode !== "invite";
      explain.textContent = EXPLAIN[mode];
      drawShare();
    } }, m[1])));
  const EXPLAIN = {
    closed: "Only admins add people (People page). The sign-up page says sign-up is closed.",
    invite: "People can create their own account, but only with the invite code.",
    open: "Anyone who can reach this server can create an account.",
  };
  const explain = h("p", { class: "hint", style: "margin-top:12px" }, EXPLAIN[mode]);
  const share = h("div");
  function link() { return location.origin + "/signup" + (mode === "invite" && code.value.trim() ? "?invite=" + encodeURIComponent(code.value.trim()) : ""); }
  function drawShare() {
    if (mode === "closed") return share.replaceChildren(h("p", { class: "muted" }, "Sign-up is closed, so there's nothing to share. Switch to invite-only or open to get a link."));
    share.replaceChildren(
      h("p", { class: "hint" }, mode === "invite" ? "This link opens the sign-up page with the invite code already filled in." : "Send people this link."),
      h("code", { style: "display:block;padding:10px 12px" }, link()),
      h("div", { class: "form-actions", style: "margin-top:10px" }, button("Copy link", () => copy(link()))));
  }
  drawShare();
  render(pageHead("Sign-up", "Who can create an account on this server."),
    card("Who can sign up", null, seg, explain, h("div", { style: "margin-top:16px" }, codeRow),
      h("div", { class: "form-actions" }, button("Save", async () => {
        const r = await api("/api/admin/signup", { method: "PUT", body: JSON.stringify({ mode, inviteCode: code.value }) });
        toast(r.mode === "invite" ? "Saved. Invite code: " + r.inviteCode : "Saved: sign-up is " + r.mode);
        renderSignup();
      }, "primary"))),
    card("Share", null, share),
    card("Accounts made by an admin", null, h("p", { class: "muted" }, "Prefer to add people yourself? Use ", h("a", { href: "#/users" }, "People"), " and send them the password privately.")));
}

// ---- Library -------------------------------------------------------------
async function renderLibrary() {
  const [l, st] = await Promise.all([api("/api/admin/library"), api("/api/library/status")]);
  const result = h("p", { class: "status", role: "status" });
  const bar = h("div", { class: "bar busy", hidden: true, role: "progressbar", "aria-label": "Scanning the library" }, h("i"));
  const scanBtn = h("button", { class: "btn primary", type: "button" }, "Rescan library");
  let clock = null;
  let startedAt = 0;

  async function poll(before) {
    startedAt = startedAt || Date.now();
    scanBtn.disabled = true; bar.hidden = false;
    clearInterval(clock);
    clock = setInterval(() => { result.className = "status"; result.textContent = "Scanning… " + Math.round((Date.now() - startedAt) / 1000) + "s"; }, 500);
    try {
      let s;
      do { await new Promise((r) => setTimeout(r, 1200)); s = await api("/api/library/status"); } while (s.scanning);
      const diff = s.trackCount - before;
      result.className = "status good";
      result.textContent = "Scan finished in " + Math.max(1, Math.round((Date.now() - startedAt) / 1000)) + "s. " + num(s.trackCount) + " tracks" + (diff ? " (" + (diff > 0 ? "+" : "") + diff + ")" : ", no change") + ".";
      if (current === "library") setTimeout(() => { if (current === "library") renderLibrary(); }, 1500);
    } catch (err) { result.className = "status bad"; result.textContent = err.message; }
    finally { clearInterval(clock); bar.hidden = true; scanBtn.disabled = false; startedAt = 0; }
  }
  scanBtn.addEventListener("click", guard(async () => {
    startedAt = Date.now();
    await api("/api/library/scan", { method: "POST" });
    poll(st.trackCount);
  }));
  if (st.scanning) poll(st.trackCount);

  const okFolder = l.exists && l.readable;
  render(pageHead("Library", "The music folder this server serves to everyone who signs in."),
    card("Music folder", null, h("dl", { class: "kv" },
      h("dt", null, "Folder"), h("dd", null, h("code", null, l.folder)),
      h("dt", null, "Status"), h("dd", null, okFolder ? h("span", { class: "badge ok" }, "Readable") : h("span", { class: "badge danger" }, l.exists ? "Not readable" : "Missing")),
      h("dt", null, "Free space"), h("dd", null, bytes(l.freeBytes)),
      h("dt", null, "Automatic rescan"), h("dd", null, l.scanIntervalMinutes ? "Every " + l.scanIntervalMinutes + " minutes" : "Off (SCAN_INTERVAL_MINUTES=0). Use the button below."))),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", null, num(l.tracks)), h("span", null, "tracks")),
      h("div", { class: "stat" }, h("b", null, num(l.artists)), h("span", null, "artists")),
      h("div", { class: "stat" }, h("b", null, num(l.albums)), h("span", null, "albums")),
      h("div", { class: "stat" }, h("b", null, bytes(l.bytes)), h("span", null, "on disk")),
      h("div", { class: "stat" }, h("b", null, span(l.durationSec)), h("span", null, "of music")),
      h("div", { class: "stat" }, h("b", null, st.lastScanAt ? ago(st.lastScanAt) : "not yet"), h("span", null, "last scan since start"))),
    card("Rescan", "Looks for new, changed and removed files. The server also does this by itself on start-up.", bar,
      h("div", { class: "form-actions", style: "margin-top:12px" }, scanBtn), result));
}

// ---- Jellyfin ------------------------------------------------------------
async function renderJellyfin() {
  const cfg = await api("/api/admin/jellyfin");
  const fromEnv = cfg.source === "env";
  const input = h("input", { id: "jf", type: "url", value: cfg.serverUrl || "", placeholder: "https://jellyfin.example.com", disabled: fromEnv, autocomplete: "off", spellcheck: "false" });
  const result = saying();

  async function test() {
    try {
      const r = await api("/api/admin/jellyfin/test", { method: "POST", body: JSON.stringify({ serverUrl: input.value.trim() }) });
      result.say(r.ok ? "Reached " + (r.serverName || "Jellyfin") + (r.version ? " (version " + r.version + ")." : ".")
        : "Couldn't use that address: " + (r.error || "no answer."), !r.ok);
      return r.ok;
    } catch (err) { result.say(err.message, true); return false; }
  }

  render(pageHead("Jellyfin", cfg.serverUrl ? "Using " + cfg.serverUrl : "Not set up yet. People can't connect Jellyfin until you add its address."),
    card("Server address", "Where this Cadence server finds Jellyfin. Only you can change it; everyone else signs in with their own Jellyfin account in the app's settings. The address must be reachable from this server, not from their phones.",
      fromEnv ? h("div", { class: "banner" }, "This address comes from JELLYFIN_URL in the server's environment, so it can't be changed here. Change it there and restart the server.") : null,
      field("Jellyfin address", input),
      h("div", { class: "form-actions" },
        h("button", { class: "btn", type: "button", onclick: test }, "Test"),
        fromEnv ? null : button("Save", async () => {
          if (!input.value.trim()) return result.say("Enter the address first.", true);
          if (!(await test())) return;
          await api("/api/admin/jellyfin", { method: "PUT", body: JSON.stringify({ serverUrl: input.value.trim() }) });
          toast("Saved. People can now sign in to Jellyfin.");
          renderJellyfin();
        }, "primary"),
        !fromEnv && cfg.serverUrl ? button("Remove", async () => {
          const ok = await ask({ title: "Remove the Jellyfin address?", text: "Everyone will be signed out of Jellyfin here.", confirm: "Remove", danger: true });
          if (!ok) return;
          await api("/api/admin/jellyfin", { method: "PUT", body: JSON.stringify({ serverUrl: null }) });
          toast("Jellyfin removed"); renderJellyfin();
        }, "danger") : null),
      result),
    card("Good to know", "Audio and cover art are streamed through this server, so Jellyfin doesn't need to be reachable from outside. If the address changes, people are signed out of Jellyfin and sign in again. Jellyfin passwords are never stored."));
}

// ---- AI providers --------------------------------------------------------
const KINDS = { ollama: "Ollama", "openai-compatible": "OpenAI-compatible", anthropic: "Anthropic" };

async function renderAi() {
  const [first, presets] = await Promise.all([api("/api/admin/llm/providers"), api("/api/llm/presets")]);
  let items = first.items;
  let editing = null; // a provider being edited, "new", or null

  async function put(p, changes) {
    await api("/api/admin/llm/providers/" + p.id, { method: "PUT", body: JSON.stringify({
      name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled, isDefault: p.isDefault, ...changes }) });
    await load();
  }
  async function load() { items = (await api("/api/admin/llm/providers")).items; draw(); }

  function form() {
    const p = editing === "new" ? null : editing;
    const status = saying();
    const models = h("datalist", { id: "ai-models" });
    const name = h("input", { id: "ai-name", value: p ? p.name : "Ollama", required: true, maxlength: "60" });
    const kind = h("select", { id: "ai-kind" }, Object.keys(KINDS).map((k) => h("option", { value: k }, KINDS[k])));
    kind.value = p ? p.kind : "ollama";
    const url = h("input", { id: "ai-url", type: "url", value: p ? p.baseUrl : "http://localhost:11434", required: true, spellcheck: "false" });
    const model = h("input", { id: "ai-model", value: p ? p.model : "llama3.2:3b", required: true, list: "ai-models", spellcheck: "false" });
    const key = h("input", { id: "ai-key", type: "password", autocomplete: "off", placeholder: p && p.hasKey ? "Saved. Leave blank to keep it" : "Only if the service needs one" });
    const clear = h("input", { type: "checkbox" });
    const preset = h("select", { id: "ai-preset", onchange: () => {
      const x = presets.items.find((i) => i.id === preset.value);
      if (!x) return;
      kind.value = x.kind; url.value = x.baseUrl; if (x.id !== "custom") name.value = x.name; model.value = x.defaultModel || "";
    } }, presets.items.map((i) => h("option", { value: i.id }, i.name)));
    if (p) preset.value = "custom";
    const body = (withKey) => ({ name: name.value.trim(), kind: kind.value, baseUrl: url.value.trim(), model: model.value.trim(),
      ...(withKey ? (clear.checked ? { apiKey: "" } : key.value ? { apiKey: key.value } : {}) : {}) });

    return card(p ? "Edit " + p.name : "Add a provider", "The server calls this model for the AI DJ on every device. The key is stored encrypted and never sent to any app.",
      h("div", { class: "form-grid" }, p ? null : field("Start from", preset), field("Name", name), field("Type", kind)),
      h("div", { class: "form-grid", style: "margin-top:14px" }, field("Address", url), field("Model", model), models, field("API key", key)),
      p && p.hasKey ? h("label", { class: "check" }, clear, "Remove the saved key") : null,
      h("div", { class: "form-actions" },
        h("button", { class: "btn", type: "button", onclick: async () => {
          try {
            const r = await api("/api/admin/llm/test", { method: "POST", body: JSON.stringify({ ...(p ? { id: p.id } : {}), ...body(false), ...(key.value ? { apiKey: key.value } : {}) }) });
            models.replaceChildren(...(r.models || []).map((m) => h("option", { value: m })));
            status.say(r.available ? "Connected. " + r.models.length + " model" + (r.models.length === 1 ? "" : "s") + " available." + (r.models.length && r.models.indexOf(model.value.trim()) === -1 ? " (" + model.value.trim() + " isn't one of them.)" : "")
              : "Couldn't connect" + (r.error ? ": " + r.error : "."), !r.available);
          } catch (err) { status.say(err.message, true); }
        } }, "Test"),
        h("button", { class: "btn primary", type: "button", onclick: async () => {
          try {
            if (p) await api("/api/admin/llm/providers/" + p.id, { method: "PUT", body: JSON.stringify({ ...body(true), enabled: p.enabled, isDefault: p.isDefault }) });
            else await api("/api/admin/llm/providers", { method: "POST", body: JSON.stringify(body(true)) });
            toast("Saved " + name.value.trim()); editing = null; await load();
          } catch (err) { status.say(err.message, true); }
        } }, "Save"),
        h("button", { class: "btn quiet", type: "button", onclick: () => { editing = null; draw(); } }, "Cancel")),
      status);
  }

  function draw() {
    const rows = items.map((p) => h("li", { class: "item" },
      h("div", { class: "grow" },
        h("div", { class: "name" }, p.name),
        h("div", { class: "sub" }, (KINDS[p.kind] || p.kind) + " · " + p.model),
        h("div", { class: "sub" }, p.baseUrl + (p.hasKey ? " · key saved" : "")),
        h("div", { class: "tags" }, p.isDefault ? h("span", { class: "badge accent" }, "Default") : null, p.enabled ? null : h("span", { class: "badge" }, "Off"))),
      h("div", { class: "actions" },
        button("Test", async () => {
          const r = await api("/api/admin/llm/test", { method: "POST", body: JSON.stringify({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, model: p.model }) });
          if (!r.available) return toast(p.name + ": " + (r.error || "can't be reached"), true);
          const has = r.models.indexOf(p.model) !== -1 || !r.models.length;
          toast(p.name + (has ? " is working." : " is reachable, but it has no model called " + p.model + "."), !has);
        }),
        p.isDefault || !p.enabled ? null : button("Make default", () => put(p, { isDefault: true })),
        button(p.enabled ? "Turn off" : "Turn on", () => put(p, { enabled: !p.enabled })),
        button("Edit", async () => { editing = p; draw(); }),
        button("Remove", async () => {
          const ok = await ask({ title: "Remove " + p.name + "?", text: "The AI DJ stops using it right away.", confirm: "Remove", danger: true });
          if (!ok) return;
          await api("/api/admin/llm/providers/" + p.id, { method: "DELETE" });
          toast("Removed " + p.name); await load();
        }, "danger"))));
    render(pageHead("AI providers", items.length ? "These run the AI DJ for everyone who signs in, on any device." : "No providers yet. Add one so the AI DJ works on phones and browsers with no setup."),
      items.length ? h("ul", { class: "list" }, rows) : null,
      editing ? form() : h("div", { style: "margin-bottom:16px" }, button("Add a provider", async () => { editing = "new"; draw(); }, "primary")),
      card("Good to know", "Any OpenAI-compatible service works (OpenAI, LM Studio, llama.cpp, vLLM, OpenRouter, Groq), as do Ollama and Anthropic. The default is used when someone hasn't picked one. People can also use a model on their own device or computer from the app's AI DJ settings."));
  }
  draw();
}
`;
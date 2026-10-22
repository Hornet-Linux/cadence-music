import type { Plugin, PluginContext } from "../../types";
import { desktopBridge, desktopOnly } from "../_desktop/desktop";
import { planStatus, samePlan, type StatusPlan } from "./format";
import { StatusSyncSettings } from "./StatusSyncSettings";
import { statusSettings, useStatusState } from "./store";

// Sets your Slack status from what is playing (desktop app only, opt-in).
// The Slack call is made by the app's main process, which also clears the status on quit.

/** Slack allows roughly one profile change per second per user; stay well inside it. */
const MIN_GAP_MS = 4_000;

let ctxNow: PluginContext | null = null;
let lastSent: StatusPlan | null = null;
let lastSentAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let teardown: (() => void) | null = null;

async function send(plan: StatusPlan) {
  const bridge = desktopBridge();
  if (!bridge) return;
  lastSent = plan;
  lastSentAt = Date.now();
  try {
    const result =
      plan.action === "set"
        ? await bridge.slack.setStatus({ text: plan.text, emoji: plan.emoji, expiration: plan.expiration })
        : await bridge.slack.clearStatus();
    if (result.ok) {
      useStatusState.setState({
        active: plan.action === "set",
        message: plan.action === "set" ? { tone: "ok", text: `Status set: ${plan.emoji} ${plan.text}` } : { tone: "ok", text: "Status cleared" },
      });
    } else if (result.error !== "No Slack token saved" || plan.action === "set") {
      useStatusState.setState({ message: { tone: "warn", text: `Slack said: ${result.error}` } });
      lastSent = null; // try again on the next change
    } else {
      lastSent = null;
    }
  } catch {
    lastSent = null;
  }
}

function update() {
  if (!ctxNow) return;
  const s = ctxNow.player.getState();
  const plan = planStatus(s.current, s, statusSettings.get(), Date.now());
  // Never call Slack just to clear a status we never set.
  if (plan.action === "clear" && !lastSent && !useStatusState.getState().active) return;
  if (samePlan(lastSent, plan)) return;
  const wait = Math.max(0, lastSentAt + MIN_GAP_MS - Date.now());
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (!ctxNow) return;
    const now = ctxNow.player.getState();
    void send(planStatus(now.current, now, statusSettings.get(), Date.now()));
  }, wait);
}

export const statusSyncPlugin: Plugin = {
  manifest: {
    id: "cadence.status-sync",
    name: "Slack status",
    version: "1.0.0",
    description: "Show what you are listening to as your Slack status, and clear it when you pause or quit (desktop app only, opt-in).",
    author: "Cadence",
    capabilities: ["player.read", "ui.settings", "storage"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    if (!desktopBridge()) return;
    ctxNow = ctx;
    statusSettings.bind(ctx.storage);
    ctx.registerSettingsPanel({
      id: "status-sync",
      title: "Slack status",
      description: "Share your current song as your Slack status.",
      keywords: ["slack", "teams", "presence", "away", "workspace"],
      render: () => <StatusSyncSettings />,
    });
    if (!teardown) {
      const off = statusSettings.useSettings.subscribe((s, prev) => {
        if (s.values !== prev.values) update();
      });
      teardown = () => {
        off();
        teardown = null;
      };
    }
    ctx.onPlayback((event) => {
      if (event.kind !== "progress") update();
    });
    update();
  },
  deactivate() {
    teardown?.();
    if (timer) clearTimeout(timer);
    timer = null;
    ctxNow = null;
    const wasActive = lastSent?.action === "set" || useStatusState.getState().active;
    lastSent = null;
    if (wasActive) void desktopBridge()?.slack.clearStatus().catch(() => undefined);
    useStatusState.setState({ active: false });
  },
};

export default desktopOnly([statusSyncPlugin]);
import { create } from "zustand";
import { createSettingsStore } from "../_desktop/settingsStore";
import { DEFAULT_STATUS_SETTINGS, type StatusSettings } from "./format";

export const statusSettings = createSettingsStore<StatusSettings>(DEFAULT_STATUS_SETTINGS);

export const SLACK_SECRET_KEY = "statussync.slack-token";

interface LiveState {
  hasToken: boolean | null;
  /** Result of the last test or update, for the panel. */
  message: { tone: "ok" | "warn"; text: string } | null;
  /** Whether a status of ours is currently set in Slack. */
  active: boolean;
}

export const useStatusState = create<LiveState>(() => ({ hasToken: null, message: null, active: false }));
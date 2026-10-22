import type { Plugin } from "../../types";
import { AccountSettings } from "./AccountSettings";
import "./style.css";

function AccountIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c.9-3.6 3.9-5.4 7.5-5.4s6.6 1.8 7.5 5.4" />
    </svg>
  );
}

/** Your account on the Cadence server: change password, see and end sessions, export or delete your data. */
const accountPlugin: Plugin = {
  manifest: {
    id: "cadence.account",
    name: "Account",
    version: "1.0.0",
    description: "Change your password, see where you are signed in, download or delete your data on your Cadence server.",
    author: "Cadence",
    capabilities: ["ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    ctx.registerSettingsPanel({
      id: "account",
      title: "Account",
      description: "Your password, devices and data on the server.",
      icon: <AccountIcon />,
      keywords: ["password", "sessions", "devices", "sign out", "export", "delete", "privacy", "profile", "name"],
      render: () => <AccountSettings />,
    });
  },
};

export default accountPlugin;
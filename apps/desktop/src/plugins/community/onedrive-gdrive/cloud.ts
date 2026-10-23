import { createRemoteSourceStore } from "../_remoteSource/store";
import type { RemoteStatus } from "../_remoteSource/logic";

/*
 * UNTESTED AGAINST THE REAL SERVICES: the server side was exercised only against test doubles of Google's and
 * Microsoft's APIs. See apps/server/src/community/onedrive-gdrive/providers.ts.
 */

export type CloudProviderId = "google" | "microsoft";

export interface CloudStatus extends RemoteStatus {
  label: string;
  /** The server owner has registered an OAuth app for this service. */
  configured: boolean;
  /** The saved sign-in stopped working: connect again. */
  needsReconnect: boolean;
  account: string | null;
  /** Chosen folders; empty means the whole drive. */
  folders: { id: string; name: string }[];
  /** Where the OAuth app must send people back to (the owner enters this at Google or Microsoft). */
  redirectUri: string | null;
  publicUrlSet: boolean;
}

interface Combined {
  redirectUri: string | null;
  publicUrlSet: boolean;
  google: Omit<CloudStatus, "redirectUri" | "publicUrlSet">;
  microsoft: Omit<CloudStatus, "redirectUri" | "publicUrlSet">;
}

export const GDRIVE_PREFIX = "gdrive:";
export const ONEDRIVE_PREFIX = "onedrive:";

function make(provider: CloudProviderId, prefix: string, source: string, label: string) {
  return createRemoteSourceStore<CloudStatus>({
    area: `onedrive-gdrive/${provider}`,
    statusRoute: "api/onedrive-gdrive/status",
    pickStatus: (raw) => {
      const all = raw as Combined;
      return { ...all[provider], redirectUri: all.redirectUri, publicUrlSet: all.publicUrlSet };
    },
    prefix,
    source,
    label,
  });
}

export const useGoogleDrive = make("google", GDRIVE_PREFIX, "gdrive", "Google Drive");
export const useOneDrive = make("microsoft", ONEDRIVE_PREFIX, "onedrive", "OneDrive");

export const stores = { google: useGoogleDrive, microsoft: useOneDrive } as const;

export interface AppsView {
  redirectUri: string | null;
  google: { configured: boolean; clientId: string | null };
  microsoft: { configured: boolean; clientId: string | null; tenant: string | null };
}

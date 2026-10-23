import { ApiError, useServer } from "../../builtins/server/serverStore";

/** What the server's account endpoints return (see apps/server/src/auth/account.ts). */
export interface AccountInfo {
  user: { id: number | string; username: string; displayName: string | null; email: string | null; isAdmin: boolean };
  createdAt: number;
  signIn: { password: boolean; sso: string | null };
  counts: { plays: number; likes: number; playlists: number };
  connections: { jellyfin: { userName: string; serverName: string | null } | null };
}

export interface DeviceSession {
  id: string;
  device: string;
  ip: string | null;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}

const api = <T,>(route: string, init?: RequestInit) => useServer.getState().api<T>(route, init);
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** Plain-language messages for the server's account error codes. */
const MESSAGES: Record<string, string> = {
  wrong_password: "That isn't your current password.",
  weak_password: "Use a new password of at least 10 characters.",
  same_password: "Choose a password that is different from the current one.",
  too_many_attempts: "Too many wrong attempts. Try again in a few minutes.",
  no_password: "This account signs in with single sign-on, so it has no password to change.",
  confirm_mismatch: "That doesn't match your username.",
  last_admin: "You're the only admin. Make someone else an admin before deleting your account.",
};

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError && err.code && MESSAGES[err.code]) return MESSAGES[err.code]!;
  return err instanceof Error ? err.message : "Something went wrong.";
}

export const loadAccount = () => api<AccountInfo>("api/me/account");
export const saveDisplayName = (displayName: string) => api<AccountInfo["user"]>("api/me", { method: "PATCH", body: JSON.stringify({ displayName }) });
export const changePassword = (currentPassword: string, newPassword: string) =>
  api<{ ok: true; signedOut: number }>("api/me/password", json({ currentPassword, newPassword }));
export const loadSessions = async () => (await api<{ items: DeviceSession[] }>("api/me/sessions")).items;
export const endSession = (id: string) => api<void>(`api/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
export const endOtherSessions = () => api<{ signedOut: number }>("api/me/sessions/sign-out-others", { method: "POST" });
export const exportMyData = () => api<Record<string, unknown>>("api/me/export");
export const deleteHistory = () => api<{ deleted: number }>("api/me/history", { method: "DELETE" });
export const deleteAccount = (proof: { password?: string; confirm?: string }) => api<void>("api/me/delete-account", json(proof));

/** Check a new password the way the server will, so the form can say what is wrong before sending. */
export function passwordProblem(next: string, repeat: string): string | null {
  if (next.length > 0 && next.length < 10) return "Use at least 10 characters.";
  if (repeat.length > 0 && repeat !== next) return "The new passwords don't match.";
  return null;
}

/** "5 minutes ago", "yesterday"... for a device's last activity. */
export function agoText(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Save the export as a file in the browser or app. */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
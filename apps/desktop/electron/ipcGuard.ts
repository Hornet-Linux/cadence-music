import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Is this the app's own page? IPC only answers the top frame of the app
 * window, loaded from the app's files (or the dev server while developing),
 * never an iframe or a site the window was navigated to.
 */
export function isAppUrl(url: string, opts: { devServerUrl?: string; rendererDir: string }): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (opts.devServerUrl) {
    try {
      if (u.origin === new URL(opts.devServerUrl).origin) return true;
    } catch {
      // fall through to the packaged check
    }
  }
  if (u.protocol !== "file:") return false;
  const file = path.resolve(fileURLToPath(u));
  const root = path.resolve(opts.rendererDir);
  return file === path.join(root, "index.html") || file.startsWith(root + path.sep);
}

interface FrameLike {
  url: string;
  parent: unknown;
  processId: number;
  routingId: number;
}

/** The app window's own top frame, showing the app's page. */
export function isTrustedSender(
  frame: FrameLike | null | undefined,
  mainFrame: Pick<FrameLike, "processId" | "routingId"> | null | undefined,
  opts: { devServerUrl?: string; rendererDir: string },
): boolean {
  return (
    !!frame &&
    !!mainFrame &&
    frame.parent === null &&
    frame.processId === mainFrame.processId &&
    frame.routingId === mainFrame.routingId &&
    isAppUrl(frame.url, opts)
  );
}

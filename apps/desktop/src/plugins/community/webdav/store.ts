import { createRemoteSourceStore } from "../_remoteSource/store";
import type { RemoteStatus } from "../_remoteSource/logic";

export const WEBDAV_PREFIX = "webdav:";

export interface WebdavStatus extends RemoteStatus {
  address?: string;
  username?: string;
  /** Chosen folder paths; empty means the whole share. */
  folders?: string[];
}

export const useWebdav = createRemoteSourceStore<WebdavStatus>({
  area: "webdav",
  prefix: WEBDAV_PREFIX,
  source: "webdav",
  label: "WebDAV",
});

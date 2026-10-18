import type { HistoryResponse, TopTracksResponse } from "@uma/shared";
import { useHistory } from "@/features/history/historyStore";
import { useServer } from "./serverStore";

// Syncs listening history with the server while signed in: uploads plays made
// on this device, pulls plays from other devices, and fetches the all-device
// "most played" ranking for Home.

const BATCH = 200;
let uploading = false;

async function upload() {
  if (uploading || !useServer.getState().user) return;
  uploading = true;
  try {
    for (;;) {
      const batch = useHistory.getState().pending.slice(0, BATCH);
      if (batch.length === 0) break;
      await useServer.getState().api("api/me/history", {
        method: "POST",
        body: JSON.stringify({ plays: batch }),
      });
      useHistory.getState().markUploaded(batch.length);
    }
  } catch {
    // Offline or server error: pending plays stay queued for the next attempt.
  } finally {
    uploading = false;
  }
}

async function pull() {
  const server = useServer.getState();
  if (!server.user) return;
  try {
    const [history, top] = await Promise.all([
      server.api<HistoryResponse>("api/me/history?limit=500"),
      server.api<TopTracksResponse>("api/me/top?limit=20"),
    ]);
    useHistory.getState().merge(history.items);
    useHistory.getState().setRemoteTop(top.items);
  } catch {
    // Older server without history support, or offline.
  }
}

let started = false;

export function startHistorySync(): void {
  if (started) return;
  started = true;

  let signedInAs: number | null = null;
  const onServerChange = () => {
    const user = useServer.getState().user;
    const id = user?.id ?? null;
    if (id === signedInAs) return;
    signedInAs = id;
    if (id === null) {
      useHistory.getState().setRemoteTop(null);
      return;
    }
    void upload().then(pull);
  };
  useServer.subscribe(onServerChange);
  onServerChange();

  // Upload new plays shortly after they are recorded.
  let timer: ReturnType<typeof setTimeout> | null = null;
  useHistory.subscribe((state, prev) => {
    if (state.pending.length <= prev.pending.length || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void upload();
    }, 5000);
  });

  // Refresh other devices' plays now and then.
  setInterval(() => void pull(), 10 * 60_000);
}

import { NoteIcon } from "@/ui/icons";
import { usePlayer } from "@/player/playerStore";
import { openDock } from "../_streaming/dock";
import { buildStreamingPlugin } from "../_streaming/plugin";
import { createStreamingStore } from "../_streaming/store";
import type { ServiceInfo } from "../_streaming/types";

export const deezerInfo: ServiceInfo = {
  slug: "deezer",
  name: "Deezer",
  prefix: "deezer:",
  homepage: "https://www.deezer.com/",
  credit: { text: "Powered by Deezer", href: "https://www.deezer.com/" },
  termsHref: "https://developers.deezer.com/termsofuse",
  adminHelp:
    "Create an app at developers.deezer.com/myapps and paste its application ID and secret key here. Use the redirect address below as the app's redirect URL (its domain must match the app's domain). Deezer's API terms apply: personal, non-commercial use only.",
  capabilities: {
    works: [
      "Search Deezer, and see your favourite tracks and playlists after you connect your account.",
      "Play 30-second previews in Cadence.",
      "Open any track in Deezer, or play it in full in Deezer's own player panel if you have a Deezer account.",
    ],
    limits: [
      "Deezer's API only provides 30-second previews. Full tracks play only in Deezer's own player, which Cadence cannot control (no queue, seek or volume).",
      "No downloading or offline storage; Deezer's terms forbid it.",
      "For private, personal, non-commercial use only, as Deezer's terms require.",
    ],
  },
};

export const useDeezer = createStreamingStore(deezerInfo);

/** Deezer's official widget in the visible panel. Deezer, not Cadence, controls it. */
export function openDeezerWidget(trackId: string, href?: string) {
  // Never two sources of sound at once.
  const player = usePlayer.getState();
  if (player.isPlaying) player.toggle();
  const dock = openDock({
    service: "Deezer",
    href: href ?? `https://www.deezer.com/track/${encodeURIComponent(trackId)}`,
    hrefLabel: "Open in Deezer",
    credit: deezerInfo.credit,
    height: 200,
    onClose: () => undefined,
  });
  const frame = document.createElement("iframe");
  frame.title = "Deezer player";
  frame.className = "stream-dock-frame";
  frame.setAttribute("allow", "encrypted-media; clipboard-write");
  frame.src = `https://widget.deezer.com/widget/auto/track/${encodeURIComponent(trackId)}`;
  dock.body.append(frame);
  dock.setNote("Deezer's own player. Full tracks need a Deezer account; otherwise Deezer plays a preview.");
}

/** Under the page header: the full-length option for whatever Deezer track is selected. */
function FullTrackPlayer() {
  const current = usePlayer((s) => s.current);
  const links = useDeezer((s) => s.links);
  const id = current?.source === "deezer" ? current.id.slice(deezerInfo.prefix.length) : null;
  return (
    <div className="notice small stream-note">
      Cadence plays 30-second previews from Deezer. For the full track, Deezer only allows its own player.
      {id && current ? (
        <>
          {" "}
          <button className="btn" onClick={() => openDeezerWidget(id, links[current.id])}>
            Play "{current.title}" in Deezer's player
          </button>
        </>
      ) : (
        " Select a Deezer track, then use this button."
      )}
    </div>
  );
}

/** Deezer search and library with 30-second previews, plus Deezer's own widget for full tracks. */
export const deezerPlugin = buildStreamingPlugin({
  info: deezerInfo,
  store: useDeezer,
  description: "Search Deezer, see your favourites and playlists, and play 30-second previews. Full tracks open in Deezer's own player.",
  icon: <NoteIcon />,
  pageExtra: <FullTrackPlayer />,
  async resolve(track) {
    if (useDeezer.getState().playback[track.id] === "link") return null;
    const id = track.id.slice(deezerInfo.prefix.length);
    // Deezer signs preview URLs and lets them expire, so ask for a fresh one each time.
    const res = await useDeezer.getState().get<{ url: string }>(`tracks/${encodeURIComponent(id)}/preview`);
    return res.url;
  },
  actions: [
    {
      id: "widget",
      label: "Play full track in Deezer's player",
      run: (track, id) => openDeezerWidget(id, useDeezer.getState().links[track.id]),
    },
  ],
});

export default deezerPlugin;

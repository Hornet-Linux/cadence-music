import type { ReactNode } from "react";
import { useServer } from "@/plugins/builtins/server/serverStore";
import type { Track } from "@/shared/types";
import type { AudioSource, Capability, Plugin, ResolvedAudio } from "@/plugins/types";
import type { StreamingStore } from "./store";
import { serviceId } from "./store";
import type { ServiceInfo } from "./types";
import { ServicePage, ServiceSettings } from "./ui";
import "./style.css";

export interface StreamingPluginSpec {
  info: ServiceInfo;
  store: StreamingStore;
  description: string;
  icon: ReactNode;
  /** Absent for services that cannot play inside Cadence (link-out only). */
  resolve?: (track: Track, id: string) => Promise<ResolvedAudio | null>;
  /** Shown on the page above the results (e.g. a note about the player). */
  pageExtra?: ReactNode;
  /** Extra track-menu actions. */
  actions?: { id: string; label: string; run: (track: Track, id: string) => void; applies?: (track: Track) => boolean }[];
}

const followed = new WeakSet<object>();

/** Follow the Cadence account: look the service up on sign-in, forget everything on sign-out. */
function followServerAccount(store: StreamingStore) {
  if (followed.has(store)) return;
  followed.add(store);
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void store.getState().refresh();
    else store.getState().reset();
  });
}

/** Everything the streaming plugins share: settings panel, page, library section, audio source, track actions. Always opt-in. */
export function buildStreamingPlugin(spec: StreamingPluginSpec): Plugin {
  const { info, store } = spec;
  const capabilities: Capability[] = ["source.library", "ui.sidebar", "ui.settings", "network.outbound", "track.actions"];
  if (spec.resolve) capabilities.push("source.audio");

  return {
    manifest: {
      id: `cadence.${info.slug}`,
      name: info.name,
      version: "1.0.0",
      description: spec.description,
      author: "Cadence",
      capabilities,
      apiRange: "^1.0.0",
      builtin: false,
    },
    activate(ctx) {
      followServerAccount(store);
      if (useServer.getState().user) void store.getState().refresh();

      ctx.registerSettingsPanel({
        id: info.slug,
        title: info.name,
        description: spec.description,
        icon: spec.icon,
        keywords: ["streaming", "account", "sign in", "api", info.name.toLowerCase()],
        render: () => <ServiceSettings store={store} info={info} />,
      });
      ctx.registerSidebarItem({
        id: info.slug,
        label: info.name,
        icon: spec.icon,
        render: () => <ServicePage store={store} info={info} extra={spec.pageExtra} />,
      });
      ctx.registerLibrarySource({
        id: info.slug,
        label: info.name,
        useTracks: () => store((s) => s.library),
      });

      if (spec.resolve) {
        const resolve = spec.resolve;
        const source: AudioSource = {
          id: info.slug,
          label: info.name,
          async resolve(track) {
            const id = serviceId(info, track);
            if (!id || !useServer.getState().token) return null;
            try {
              return await resolve(track, id);
            } catch (err) {
              store.setState({ error: err instanceof Error ? err.message : String(err) });
              return null;
            }
          },
        };
        ctx.registerAudioSource(source);
      }

      const applies = (t: Track) => t.source === info.slug && !!store.getState().links[t.id];
      ctx.registerTrackAction({
        id: `${info.slug}-open`,
        label: `Open in ${info.name}`,
        appliesTo: applies,
        run: (t) => {
          const href = store.getState().links[t.id];
          if (href) window.open(href, "_blank", "noopener,noreferrer");
        },
      });
      for (const a of spec.actions ?? []) {
        ctx.registerTrackAction({
          id: `${info.slug}-${a.id}`,
          label: a.label,
          appliesTo: a.applies ?? ((t) => t.source === info.slug),
          run: (t) => {
            const id = serviceId(info, t);
            if (id) a.run(t, id);
          },
        });
      }
    },
  };
}

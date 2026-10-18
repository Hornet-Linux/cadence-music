import { useRef } from "react";
import type { Plugin } from "../types";
import { TrackRow } from "@/ui/media";
import { useLocalFiles } from "./localFilesStore";

function LocalFilesPage() {
  const tracks = useLocalFiles((s) => s.tracks);
  const addFiles = useLocalFiles((s) => s.addFiles);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="view">
      <header className="view-header">
        <h1>Local Files</h1>
        <p className="muted">
          Add audio files from this computer. They play through the shared engine — this is a real
          source plugin, not a mock.
        </p>
      </header>

      <div style={{ marginBottom: 22 }}>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button className="btn primary" onClick={() => inputRef.current?.click()}>
          Add files
        </button>
      </div>

      {tracks.length === 0 ? (
        <p className="empty">No files added yet. Click “Add files” to choose some audio.</p>
      ) : (
        <div className="track-list">
          {tracks.map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} queue={tracks} />
          ))}
        </div>
      )}
    </div>
  );
}

// A real, working audio source: plays audio files chosen from this computer.
export const localFilesPlugin: Plugin = {
  manifest: {
    id: "core.local-files",
    name: "Local Files",
    version: "1.0.0",
    description: "Play audio files from your computer. A working source plugin.",
    author: "Unnamed Music App",
    capabilities: ["source.audio", "source.library", "ui.sidebar"],
    apiRange: "^1.0.0",
    builtin: true,
  },
  activate(ctx) {
    ctx.registerAudioSource({
      id: "local-files",
      label: "Local Files",
      resolve: async (track) => useLocalFiles.getState().urls.get(track.id) ?? null,
    });
    ctx.registerLibrarySource({
      id: "local-files",
      label: "Local files",
      useTracks: () => useLocalFiles((s) => s.tracks),
    });
    ctx.registerSidebarItem({
      id: "local-files",
      label: "Local Files",
      render: () => <LocalFilesPage />,
    });
  },
};

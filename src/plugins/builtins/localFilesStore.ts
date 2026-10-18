import { create } from "zustand";
import type { Track } from "@/shared/types";

interface LocalFilesState {
  tracks: Track[];
  /** Maps track id -> object URL for the selected file. */
  urls: Map<string, string>;
  addFiles: (files: FileList | File[]) => void;
  clear: () => void;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i;

function titleFromName(name: string): string {
  return name.replace(AUDIO_EXT, "").replace(/_/g, " ").trim() || name;
}

export const useLocalFiles = create<LocalFilesState>((set, get) => ({
  tracks: [],
  urls: new Map(),
  addFiles(files) {
    const list = Array.from(files).filter(
      (f) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name),
    );
    if (list.length === 0) return;
    const urls = new Map(get().urls);
    const added: Track[] = [];
    for (const file of list) {
      const id = `local:${file.name}:${file.size}`;
      if (urls.has(id)) continue;
      urls.set(id, URL.createObjectURL(file));
      added.push({
        id,
        title: titleFromName(file.name),
        artists: [{ id: "local", name: "Local file" }],
        source: "local",
      });
    }
    set({ tracks: [...get().tracks, ...added], urls });
  },
  clear() {
    for (const url of get().urls.values()) URL.revokeObjectURL(url);
    set({ tracks: [], urls: new Map() });
  },
}));

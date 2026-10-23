import { jsonRequest, type FetchFn } from "../_ops/http.js";

interface LidarrArtist {
  id?: number;
  foreignArtistId?: string;
  artistName?: string;
  [k: string]: unknown;
}

export interface LidarrAlbum {
  id?: number;
  title?: string;
  foreignAlbumId?: string;
  releaseDate?: string;
  albumType?: string;
  monitored?: boolean;
  artist?: LidarrArtist;
  images?: { coverType?: string; url?: string; remoteUrl?: string }[];
  statistics?: { trackFileCount?: number; trackCount?: number };
  [k: string]: unknown;
}

export interface AlbumHit {
  foreignAlbumId: string;
  title: string;
  artist: string;
  releaseDate: string | null;
  albumType: string | null;
  cover: string | null;
  /** True when Lidarr already tracks this album. */
  inLibrary: boolean;
  monitored: boolean;
  trackFileCount: number | null;
  trackCount: number | null;
}

export interface QueueItem {
  title: string;
  artist: string | null;
  status: string;
  /** 0-100. */
  progress: number;
  timeLeft: string | null;
  errorMessage: string | null;
}

export interface LidarrSettings {
  rootFolderPath?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
}

export type RequestOutcome = { action: "added" | "monitored"; albumId: number | null; title: string; artist: string };

/** The parts of Lidarr's v1 API that Cadence uses. Documented at https://lidarr.audio/docs/api/ */
export class LidarrClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn?: FetchFn,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return jsonRequest<T>(`${this.base}/api/v1/${path}`, { ...init, headers: { "x-api-key": this.apiKey }, fetchFn: this.fetchFn });
  }

  status(): Promise<{ appName?: string; version?: string; instanceName?: string }> {
    return this.call("system/status");
  }
  rootFolders(): Promise<{ id: number; path: string; name?: string }[]> {
    return this.call("rootfolder");
  }
  qualityProfiles(): Promise<{ id: number; name: string }[]> {
    return this.call("qualityprofile");
  }
  metadataProfiles(): Promise<{ id: number; name: string }[]> {
    return this.call("metadataprofile");
  }

  async lookupAlbums(term: string): Promise<{ raw: LidarrAlbum; hit: AlbumHit }[]> {
    const found = await this.call<LidarrAlbum[]>(`album/lookup?term=${encodeURIComponent(term)}`);
    return (found ?? [])
      .filter((a) => a.foreignAlbumId && a.title)
      .slice(0, 25)
      .map((raw) => ({ raw, hit: toHit(raw) }));
  }

  async findAlbum(foreignAlbumId: string): Promise<LidarrAlbum | null> {
    const found = await this.call<LidarrAlbum[]>(`album?foreignAlbumId=${encodeURIComponent(foreignAlbumId)}`);
    return found?.[0] ?? null;
  }

  monitorAlbums(albumIds: number[], monitored: boolean): Promise<unknown> {
    return this.call("album/monitor", { method: "PUT", body: { albumIds, monitored } });
  }

  searchAlbums(albumIds: number[]): Promise<unknown> {
    return this.call("command", { method: "POST", body: { name: "AlbumSearch", albumIds } });
  }

  /**
   * Ask Lidarr for an album. An album Lidarr already knows is switched to monitored and searched; a new
   * one is added with its artist (the artist is added unmonitored, so only this album is wanted).
   */
  async requestAlbum(foreignAlbumId: string, settings: LidarrSettings): Promise<RequestOutcome> {
    const existing = await this.findAlbum(foreignAlbumId);
    if (existing?.id) {
      await this.monitorAlbums([existing.id], true);
      await this.searchAlbums([existing.id]);
      return { action: "monitored", albumId: existing.id, title: existing.title ?? "", artist: existing.artist?.artistName ?? "" };
    }
    const lookup = (await this.lookupAlbums(`lidarr:${foreignAlbumId}`)).find((r) => r.raw.foreignAlbumId === foreignAlbumId)?.raw;
    if (!lookup) throw new Error("Lidarr could not find that album any more.");

    const rootFolderPath = settings.rootFolderPath ?? (await this.rootFolders())[0]?.path;
    const qualityProfileId = settings.qualityProfileId ?? (await this.qualityProfiles())[0]?.id;
    const metadataProfileId = settings.metadataProfileId ?? (await this.metadataProfiles())[0]?.id;
    if (!rootFolderPath || qualityProfileId === undefined || metadataProfileId === undefined) {
      throw new Error("Lidarr has no root folder or profile to add the album to. Set one in Lidarr first.");
    }
    const body = {
      ...lookup,
      monitored: true,
      anyReleaseOk: true,
      addOptions: { addType: "automatic", searchForNewAlbum: true },
      artist: {
        ...lookup.artist,
        qualityProfileId,
        metadataProfileId,
        rootFolderPath,
        monitored: true,
        monitorNewItems: "none",
        addOptions: { monitor: "none", albumsToMonitor: [foreignAlbumId], searchForMissingAlbums: false },
      },
    };
    const added = await this.call<LidarrAlbum>("album", { method: "POST", body });
    return { action: "added", albumId: added?.id ?? null, title: lookup.title ?? "", artist: lookup.artist?.artistName ?? "" };
  }

  async queue(): Promise<QueueItem[]> {
    const page = await this.call<{ records?: Record<string, unknown>[] }>("queue?page=1&pageSize=50&includeAlbum=true&includeArtist=true");
    return (page.records ?? []).map((r) => {
      const size = Number(r.size) || 0;
      const left = Number(r.sizeleft) || 0;
      const album = r.album as LidarrAlbum | undefined;
      const artist = r.artist as LidarrArtist | undefined;
      return {
        title: String(album?.title ?? r.title ?? "Unknown"),
        artist: artist?.artistName ?? album?.artist?.artistName ?? null,
        status: String(r.trackedDownloadState ?? r.status ?? "unknown"),
        progress: size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 100))) : 0,
        timeLeft: typeof r.timeleft === "string" ? r.timeleft : null,
        errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : null,
      };
    });
  }

  async missingCount(): Promise<number> {
    const page = await this.call<{ totalRecords?: number }>("wanted/missing?page=1&pageSize=1&monitored=true");
    return page.totalRecords ?? 0;
  }
}

function toHit(raw: LidarrAlbum): AlbumHit {
  const cover = raw.images?.find((i) => i.coverType === "cover") ?? raw.images?.[0];
  return {
    foreignAlbumId: String(raw.foreignAlbumId),
    title: String(raw.title),
    artist: raw.artist?.artistName ?? "Unknown artist",
    releaseDate: raw.releaseDate ? String(raw.releaseDate).slice(0, 10) : null,
    albumType: raw.albumType ?? null,
    cover: cover?.remoteUrl ?? cover?.url ?? null,
    inLibrary: Boolean(raw.id),
    monitored: Boolean(raw.monitored),
    trackFileCount: raw.statistics?.trackFileCount ?? null,
    trackCount: raw.statistics?.trackCount ?? null,
  };
}
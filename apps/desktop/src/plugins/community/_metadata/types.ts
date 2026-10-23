// Shapes returned by the server /api/metadata routes (see apps/server/src/community/metadata).

export interface ArtistInfo {
  mbid: string;
  name: string;
  type?: string;
  country?: string;
  disambiguation?: string;
  beginYear?: number;
  genres: string[];
  links: { label: string; url: string }[];
  wikidataId?: string;
}

export interface RecordingInfo {
  mbid: string;
  title: string;
  artist: string;
  year?: number;
  genres: string[];
}

export interface WikiSummary {
  title: string;
  description?: string;
  extract: string;
  image?: string;
  url?: string;
}

export interface CoverInfo {
  url: string;
  full?: string;
  mbid: string;
}

export interface FanartInfo {
  thumbs: string[];
  backgrounds: string[];
  logos: string[];
  banners: string[];
}

export interface DiscogsArtist {
  id: number;
  name: string;
  profile?: string;
  url?: string;
  images: string[];
  links: { label: string; url: string }[];
}

export interface DiscogsRelease {
  id: number;
  title: string;
  year?: number;
  genres: string[];
  styles: string[];
  cover?: string;
  url?: string;
}

export interface ConcertInfo {
  id: string;
  artist: string;
  datetime: string;
  title?: string;
  venue: string;
  city: string;
  region?: string;
  country: string;
  url?: string;
  ticketUrl?: string;
  lineup: string[];
}

export interface ReleaseGroupInfo {
  mbid: string;
  title: string;
  artist: string;
  type: string;
  date: string;
  coverUrl: string;
}

export interface MetadataStatus {
  providers: Record<"musicbrainz" | "coverart" | "wikipedia" | "wikidata" | "fanart" | "discogs" | "bandsintown", boolean>;
}

export interface MetadataAdminConfig {
  fanartApiKey: boolean;
  discogsToken: boolean;
  bandsintownAppId: string;
}

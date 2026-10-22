import type { LlmConfig } from "../../../electron/llm";
import { buildDjMessages, cleanReply, DJ_SCHEMA, type DjRequest } from "./prompt";
import { resolvePicks, type DjTrack } from "./resolve";
import type { TasteProfile } from "./tasteProfile";

export interface DjSetOptions extends Omit<DjRequest, "avoid"> {
  /** Tracks already played or queued this session. */
  history?: DjTrack[];
}

/**
 * Ask the model for a set and keep only the picks that exist on Spotify.
 * Small models invent songs, so we ask for a few more than we need.
 */
export async function planDjSet(config: LlmConfig, profile: TasteProfile, opts: DjSetOptions = {}): Promise<DjTrack[]> {
  const llm = window.host?.llm;
  if (!llm) throw new Error("AI DJ isn't available here");
  const count = opts.count ?? 8;
  const history = opts.history ?? [];
  const messages = buildDjMessages(profile, {
    ...opts,
    count: count + 3,
    avoid: history.map((h) => `${h.track.artists[0]?.name ?? ""} – ${h.track.title}`),
  });
  const reply = await llm.chatJson(config, { messages, schema: DJ_SCHEMA });
  const picks = cleanReply(reply);
  if (!picks.length) throw new Error("The DJ didn't suggest any songs. Try again.");
  const set = await resolvePicks(picks, history.map((h) => h.track.id));
  if (!set.length) throw new Error("None of the DJ's picks were found on Spotify. Try again or pick a bigger model.");
  return set.slice(0, count);
}

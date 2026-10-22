import { apiUrl, useServer } from "../../builtins/server/serverStore";

/** Saves the person's subscriptions as an OPML file (the format every podcast app imports). */
export async function downloadOpml(): Promise<void> {
  const { url, token } = useServer.getState();
  const res = await fetch(apiUrl(url, "api/podcasts/opml"), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Couldn't export (${res.status})`);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = "cadence-podcasts.opml";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Reads an OPML file chosen by the person, refusing anything that isn't a reasonable size. */
export async function readOpmlFile(file: { size: number; text: () => Promise<string> }): Promise<string> {
  if (file.size > 1_500_000) throw new Error("That file is too big to be a list of podcasts.");
  return file.text();
}

export function describeImport(r: { found: number; added: number; alreadySubscribed: number }): string {
  if (r.added === 0 && r.alreadySubscribed > 0) return `You already follow all ${r.found} of those shows.`;
  const extra = r.alreadySubscribed ? ` (${r.alreadySubscribed} you already had)` : "";
  return `Added ${r.added} show${r.added === 1 ? "" : "s"}${extra}. Their episodes will appear over the next minute.`;
}
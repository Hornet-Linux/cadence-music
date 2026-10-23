import { beforeEach, describe, expect, it } from "vitest";
import { emptyContributions, usePluginHost } from "../../host";
import { communityPlugins } from "../../builtins";
import artistAbout from "../artist-about";
import concertAlerts from "../concert-alerts";
import metadataProviders from "../metadata-providers";
import newReleases from "../new-releases";

const ours = [metadataProviders, artistAbout, concertAlerts, newReleases];

describe("metadata and discovery plugins", () => {
  beforeEach(() => {
    usePluginHost.setState({ plugins: [], contributions: emptyContributions() });
  });

  it("are found automatically and start disabled", () => {
    const ids = communityPlugins.map((p) => p.manifest.id);
    for (const p of ours) expect(ids).toContain(p.manifest.id);
    for (const p of ours) expect(p.manifest.builtin).not.toBe(true);
  });

  it("declare only what they use and activate cleanly", async () => {
    for (const p of ours) usePluginHost.getState().register(p);
    for (const p of ours) await usePluginHost.getState().setEnabled(p.manifest.id, true);
    const c = usePluginHost.getState().contributions;
    expect(c.metadataProviders.map((m) => m.id)).toEqual(["musicbrainz", "wikipedia", "discogs"]);
    expect(c.settings.map((s) => s.id)).toContain("metadata-services");
    expect(c.sidebar.map((s) => s.id)).toContain("artist-about");
    expect(c.homeWidgets.map((w) => w.id).sort()).toEqual(["artist-about", "concert-alerts", "new-releases"]);
  });

  it("each plugin id follows the cadence.<name> rule and is unique", () => {
    const ids = ours.map((p) => p.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^cadence\.[a-z-]+$/);
  });
});

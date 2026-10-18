import { beforeEach, describe, expect, it } from "vitest";
import type { Play } from "@uma/shared";
import { recentTracks, topTracks, useHistory } from "./historyStore";

const t = (id: string) => ({ id, title: id, artists: [{ id: "a", name: "A" }] });
const play = (id: string, playedAt: number): Play => ({ track: t(id), playedAt });

beforeEach(() => {
  localStorage.clear();
  useHistory.getState().clear();
});

describe("listening history", () => {
  it("records plays newest first and queues them for upload", () => {
    useHistory.getState().record(t("a"));
    useHistory.getState().record(t("b"));
    const { plays, pending } = useHistory.getState();
    expect(plays.map((p) => p.track.id)).toEqual(["b", "a"]);
    expect(pending.map((p) => p.track.id)).toEqual(["a", "b"]);
    useHistory.getState().markUploaded(1);
    expect(useHistory.getState().pending.map((p) => p.track.id)).toEqual(["b"]);
  });

  it("merges remote plays without duplicates, in time order", () => {
    useHistory.getState().merge([play("x", 100), play("y", 300)]);
    useHistory.getState().merge([play("x", 100), play("z", 200)]);
    expect(useHistory.getState().plays.map((p) => p.track.id)).toEqual(["y", "z", "x"]);
  });

  it("derives recent and top tracks", () => {
    const plays = [play("a", 5), play("b", 4), play("a", 3), play("c", 2), play("a", 1), play("b", 0)];
    expect(recentTracks(plays).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(topTracks(plays).map((x) => [x.track.id, x.plays])).toEqual([
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ]);
  });
});

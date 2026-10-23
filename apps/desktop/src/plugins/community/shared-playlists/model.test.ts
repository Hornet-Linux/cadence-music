import { describe, expect, it } from "vitest";
import { canRemove, nextVote, playOrder, sortItems, withVote, type SharedDetail, type SharedItem } from "./model";

const item = (id: string, score: number, addedAt: number, myVote: -1 | 0 | 1 = 0, addedBy = 1): SharedItem => ({
  id,
  track: { id: `track-${id}`, title: id, artists: [] },
  addedBy: { id: addedBy, name: "x" },
  addedAt,
  score,
  myVote,
});
const detail = (items: SharedItem[], isOwner = false): SharedDetail => ({
  id: "p",
  name: "P",
  ownerId: 1,
  isOwner,
  members: [],
  items,
  createdAt: 0,
  updatedAt: 0,
});

describe("voting", () => {
  it("moves a track up when it is voted up, and shows the new score and vote", () => {
    const d = detail([item("a", 2, 1), item("b", 1, 2), item("c", 1, 3)]);
    const after = withVote(d, "c", 1);
    expect(after.items.map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(after.items[1]).toMatchObject({ score: 2, myVote: 1 });
  });
  it("replaces an earlier vote instead of adding to it", () => {
    const d = detail([item("a", 1, 1, 1), item("b", 1, 2)]);
    const after = withVote(d, "a", -1);
    expect(after.items.find((i) => i.id === "a")).toMatchObject({ score: -1, myVote: -1 });
    expect(after.items.map((i) => i.id)).toEqual(["b", "a"]);
  });
  it("takes a vote back when the same arrow is pressed twice", () => {
    expect(nextVote(0, 1)).toBe(1);
    expect(nextVote(1, 1)).toBe(0);
    expect(nextVote(1, -1)).toBe(-1);
    expect(nextVote(-1, -1)).toBe(0);
    const d = detail([item("a", 1, 1, 1)]);
    expect(withVote(d, "a", 0).items[0]).toMatchObject({ score: 0, myVote: 0 });
  });
  it("breaks ties by when the track was added", () => {
    expect(sortItems([item("late", 3, 9), item("early", 3, 1)]).map((i) => i.id)).toEqual(["early", "late"]);
  });
});

describe("permissions and play order", () => {
  it("lets the owner remove anything and members only their own", () => {
    const i = item("a", 0, 1, 0, 7);
    expect(canRemove(detail([i], true), i, 1)).toBe(true);
    expect(canRemove(detail([i]), i, 7)).toBe(true);
    expect(canRemove(detail([i]), i, 8)).toBe(false);
    expect(canRemove(detail([i]), i, null)).toBe(false);
  });
  it("plays in the shown order", () => {
    expect(playOrder(detail([item("a", 1, 1), item("b", 0, 2)])).map((t) => t.id)).toEqual(["track-a", "track-b"]);
  });
});
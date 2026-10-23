import { describe, expect, it } from "vitest";
import { activeLineIndex, instrumentalLyrics, isInstrumental, lrcToLyrics, parseLrc, plainLines } from "./lrc";

describe("parseLrc", () => {
  it("reads timestamps and sorts lines by time", () => {
    const { lines, synced } = parseLrc("[00:12.50]second\n[00:05.00]first\n[01:02.25]third");
    expect(synced).toBe(true);
    expect(lines).toEqual([
      { timeSec: 5, text: "first" },
      { timeSec: 12.5, text: "second" },
      { timeSec: 62.25, text: "third" },
    ]);
  });

  it("expands several timestamps on one line", () => {
    const { lines } = parseLrc("[00:10.00][00:50.00][01:30.5]chorus\n[00:20.00]verse");
    expect(lines.map((l) => [l.timeSec, l.text])).toEqual([
      [10, "chorus"],
      [20, "verse"],
      [50, "chorus"],
      [90.5, "chorus"],
    ]);
  });

  it("accepts mm:ss, 1-3 digit fractions and the colon form", () => {
    const { lines } = parseLrc("[1:02]a\n[01:02.5]b\n[01:02.123]c\n[01:02:50]d");
    expect(lines.map((l) => l.timeSec)).toEqual([62, 62.5, 62.123, 62.5].sort((x, y) => x - y));
  });

  it("applies the offset tag (positive means earlier)", () => {
    const { lines, offsetMs } = parseLrc("[offset:+500]\n[00:10.00]a\n[00:00.20]b");
    expect(offsetMs).toBe(500);
    expect(lines).toEqual([
      { timeSec: 0, text: "b" },
      { timeSec: 9.5, text: "a" },
    ]);
    expect(parseLrc("[offset:-1000]\n[00:10.00]a").lines[0]!.timeSec).toBe(11);
  });

  it("keeps empty timed lines as gaps and strips word timestamps", () => {
    const { lines } = parseLrc("[00:01.00]<00:01.00>hel<00:01.40>lo  world\n[00:05.00]\n[00:08.00]next");
    expect(lines).toEqual([
      { timeSec: 1, text: "hello world" },
      { timeSec: 5, text: "" },
      { timeSec: 8, text: "next" },
    ]);
  });

  it("collects metadata tags and ignores them as lyrics", () => {
    const parsed = parseLrc("[ti:Song]\n[ar:Someone]\n[00:01.00]hi");
    expect(parsed.meta).toMatchObject({ ti: "Song", ar: "Someone" });
    expect(parsed.lines).toEqual([{ timeSec: 1, text: "hi" }]);
  });

  it("handles CRLF, a BOM and stray untimed lines in synced text", () => {
    const parsed = parseLrc(String.fromCharCode(0xfeff) + "[00:01.00]one\r\nnot timed\r\n[00:02.00]two\r\n");
    expect(parsed.lines.map((l) => l.text)).toEqual(["one", "two"]);
  });

  it("treats text with no timestamps as unsynced plain lines", () => {
    const parsed = parseLrc("[ti:x]\nline one\n\n\n\nline two\n");
    expect(parsed.synced).toBe(false);
    expect(parsed.lines).toEqual([{ text: "line one" }, { text: "" }, { text: "line two" }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseLrc("").lines).toEqual([]);
    expect(parseLrc("   \n\n").synced).toBe(false);
  });

  it("keeps timestamps past 59 minutes and keeps equal times in file order", () => {
    const { lines } = parseLrc("[75:00.00]late\n[00:01.00]a\n[00:01.00]b");
    expect(lines.map((l) => l.text)).toEqual(["a", "b", "late"]);
    expect(lines[2]!.timeSec).toBe(4500);
  });
});

describe("plainLines", () => {
  it("trims the ends and collapses blank runs", () => {
    expect(plainLines("\n\n a \n\n\n\n b\n\n")).toEqual([{ text: "a" }, { text: "" }, { text: "b" }]);
  });
});

describe("activeLineIndex", () => {
  const lines = [
    { timeSec: 5, text: "a" },
    { timeSec: 10, text: "b" },
    { timeSec: 20, text: "c" },
  ];
  it("is -1 before the first line", () => {
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 4.99)).toBe(-1);
  });
  it("picks the last line that has started", () => {
    expect(activeLineIndex(lines, 5)).toBe(0);
    expect(activeLineIndex(lines, 9.9)).toBe(0);
    expect(activeLineIndex(lines, 10)).toBe(1);
    expect(activeLineIndex(lines, 999)).toBe(2);
  });
  it("can light a line slightly early", () => {
    expect(activeLineIndex(lines, 9.85, 0.2)).toBe(1);
  });
  it("is -1 for unsynced or empty lyrics", () => {
    expect(activeLineIndex([{ text: "x" }], 10)).toBe(-1);
    expect(activeLineIndex([], 10)).toBe(-1);
  });
});

describe("helpers", () => {
  it("recognises instrumental lyrics", () => {
    expect(isInstrumental(instrumentalLyrics("X"))).toBe(true);
    expect(isInstrumental({ lines: [{ text: "hi" }], synced: false, source: "X" })).toBe(false);
    expect(isInstrumental(null)).toBe(false);
  });
  it("lrcToLyrics returns null when there are no words", () => {
    expect(lrcToLyrics("[00:01.00]\n[00:02.00]", "X")).toBeNull();
    expect(lrcToLyrics("[00:01.00]hi", "X")).toMatchObject({ synced: true, source: "X" });
    expect(lrcToLyrics("just words", "X")).toMatchObject({ synced: false });
  });
});

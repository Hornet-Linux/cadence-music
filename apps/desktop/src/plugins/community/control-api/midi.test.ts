import { describe, expect, it } from "vitest";
import { addMapping, describeMapping, matchMidi, parseMidi, type MidiMapping } from "./midi";

describe("parseMidi", () => {
  it("reads notes, note-off and controllers with their channel", () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ kind: "note", off: false, channel: 1, number: 60, value: 100 });
    expect(parseMidi([0x93, 61, 0])).toEqual({ kind: "note", off: true, channel: 4, number: 61, value: 0 });
    expect(parseMidi([0x80, 60, 40])).toMatchObject({ kind: "note", off: true });
    expect(parseMidi([0xb0, 7, 127])).toEqual({ kind: "cc", off: false, channel: 1, number: 7, value: 127 });
  });
  it("ignores messages we do not map", () => {
    expect(parseMidi([0xe0, 0, 64])).toBeNull(); // pitch bend
    expect(parseMidi([0xf8])).toBeNull(); // clock
    expect(parseMidi([])).toBeNull();
  });
});

describe("matchMidi", () => {
  const mappings: MidiMapping[] = [
    { id: "n1", kind: "note", number: 36, channel: 0, command: "next" },
    { id: "n2", kind: "note", number: 37, channel: 10, command: "previous" },
    { id: "c1", kind: "cc", number: 7, channel: 0, command: "volume" },
    { id: "c2", kind: "cc", number: 64, channel: 0, command: "play-pause" },
  ];

  it("fires a note on any channel when the mapping allows it, and only on the right channel otherwise", () => {
    const mem = new Map<string, number>();
    expect(matchMidi(parseMidi([0x95, 36, 90])!, mappings, mem).map((a) => a.mapping.command)).toEqual(["next"]);
    expect(matchMidi(parseMidi([0x95, 37, 90])!, mappings, mem)).toEqual([]);
    expect(matchMidi(parseMidi([0x99, 37, 90])!, mappings, mem).map((a) => a.mapping.command)).toEqual(["previous"]);
  });

  it("does not fire on note-off", () => {
    expect(matchMidi(parseMidi([0x80, 36, 0])!, mappings, new Map())).toEqual([]);
  });

  it("maps a fader to a 0-1 volume", () => {
    const [a] = matchMidi(parseMidi([0xb0, 7, 127])!, mappings, new Map());
    expect(a!.args).toEqual({ value: 1 });
    const [b] = matchMidi(parseMidi([0xb0, 7, 0])!, mappings, new Map());
    expect(b!.args).toEqual({ value: 0 });
  });

  it("fires a controller button once as it goes past halfway, not while held or on release", () => {
    const mem = new Map<string, number>();
    const fire = (v: number) => matchMidi(parseMidi([0xb0, 64, v])!, mappings, mem).length;
    expect([fire(0), fire(127), fire(127), fire(0), fire(100)]).toEqual([0, 1, 0, 0, 1]);
  });

  it("learns a control, replacing an older mapping for the same one", () => {
    let m = addMapping([], { kind: "note", number: 40, channel: 1, command: "next" });
    m = addMapping(m, { kind: "note", number: 40, channel: 1, command: "previous" });
    expect(m).toHaveLength(1);
    expect(m[0]!.command).toBe("previous");
    expect(describeMapping(m[0]!)).toBe("Note 40 (channel 1)");
  });
});
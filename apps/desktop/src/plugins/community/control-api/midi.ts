// Web MIDI: turn notes and control-change messages from a MIDI pad or keyboard
// into commands. Pure logic here; the browser wiring is in midiController.ts.

export type MidiKind = "note" | "cc";

export interface MidiMessage {
  kind: MidiKind;
  /** True for note-off (or note-on with velocity 0). */
  off: boolean;
  /** 1 to 16. */
  channel: number;
  /** Note number or controller number, 0 to 127. */
  number: number;
  value: number;
}

export interface MidiMapping {
  id: string;
  kind: MidiKind;
  number: number;
  /** 1 to 16, or 0 for any channel. */
  channel: number;
  command: string;
}

/** Commands where a knob or fader sets a level instead of firing once. */
const CONTINUOUS = new Set(["volume"]);

export function parseMidi(data: ArrayLike<number>): MidiMessage | null {
  if (data.length < 3) return null;
  const status = data[0]! & 0xf0;
  const channel = (data[0]! & 0x0f) + 1;
  const number = data[1]! & 0x7f;
  const value = data[2]! & 0x7f;
  if (status === 0x90) return { kind: "note", off: value === 0, channel, number, value };
  if (status === 0x80) return { kind: "note", off: true, channel, number, value };
  if (status === 0xb0) return { kind: "cc", off: false, channel, number, value };
  return null;
}

export function describeMessage(m: Pick<MidiMessage, "kind" | "number" | "channel">): string {
  return `${m.kind === "note" ? "Note" : "Control"} ${m.number} on channel ${m.channel}`;
}

export function describeMapping(m: MidiMapping): string {
  return `${m.kind === "note" ? "Note" : "Control"} ${m.number}${m.channel ? ` (channel ${m.channel})` : " (any channel)"}`;
}

export interface MidiAction {
  mapping: MidiMapping;
  args: Record<string, unknown>;
}

/**
 * Which mappings does this message trigger? `memory` remembers each button-style controller's
 * last value so a pedal or button held down fires once, on the way down past halfway.
 */
export function matchMidi(message: MidiMessage, mappings: MidiMapping[], memory: Map<string, number>): MidiAction[] {
  const actions: MidiAction[] = [];
  for (const mapping of mappings) {
    if (mapping.kind !== message.kind || mapping.number !== message.number) continue;
    if (mapping.channel !== 0 && mapping.channel !== message.channel) continue;
    if (message.kind === "note") {
      if (!message.off) actions.push({ mapping, args: {} });
    } else if (CONTINUOUS.has(mapping.command)) {
      actions.push({ mapping, args: { value: message.value / 127 } });
    } else {
      const key = `${mapping.id}`;
      const previous = memory.get(key) ?? 0;
      memory.set(key, message.value);
      if (previous < 64 && message.value >= 64) actions.push({ mapping, args: {} });
    }
  }
  return actions;
}

/** Replace any mapping for the same control and add this one. */
export function addMapping(mappings: MidiMapping[], next: Omit<MidiMapping, "id">): MidiMapping[] {
  const id = `${next.kind}-${next.channel}-${next.number}`;
  return [...mappings.filter((m) => m.id !== id), { ...next, id }];
}
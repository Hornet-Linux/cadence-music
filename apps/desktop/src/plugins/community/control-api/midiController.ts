import { addMapping, describeMessage, matchMidi, parseMidi, type MidiMapping } from "./midi";

export interface MidiHooks {
  getMappings: () => MidiMapping[];
  setMappings: (m: MidiMapping[]) => void;
  /** The command being learned, if any. */
  getLearning: () => string | null;
  finishLearning: () => void;
  run: (command: string, args: Record<string, unknown>) => void;
  onInputs: (names: string[]) => void;
  onSeen: (text: string) => void;
}

interface MidiInputLike {
  id: string;
  name?: string | null;
  state?: string;
  onmidimessage: ((e: { data?: Uint8Array | null }) => void) | null;
}
interface MidiAccessLike {
  inputs: { values: () => IterableIterator<MidiInputLike> };
  onstatechange: (() => void) | null;
}

/** Listen to every MIDI input, now and as devices are plugged in. Returns a stop function. */
export async function startMidi(hooks: MidiHooks): Promise<() => void> {
  const nav = navigator as Navigator & { requestMIDIAccess?: (o?: { sysex?: boolean }) => Promise<MidiAccessLike> };
  if (!nav.requestMIDIAccess) throw new Error("Web MIDI is not available in this build");
  const access = await nav.requestMIDIAccess({ sysex: false });
  const memory = new Map<string, number>();

  const onMessage = (e: { data?: Uint8Array | null }) => {
    const message = e.data ? parseMidi(e.data) : null;
    if (!message) return;
    hooks.onSeen(describeMessage(message));
    const learning = hooks.getLearning();
    if (learning) {
      // Ignore the button coming back up so the release doesn't count as the press.
      if (message.kind === "note" && message.off) return;
      if (message.kind === "cc" && message.value < 64 && learning !== "volume") return;
      hooks.setMappings(addMapping(hooks.getMappings(), { kind: message.kind, number: message.number, channel: message.channel, command: learning }));
      hooks.finishLearning();
      return;
    }
    for (const action of matchMidi(message, hooks.getMappings(), memory)) hooks.run(action.mapping.command, action.args);
  };

  const attach = () => {
    const names: string[] = [];
    for (const input of access.inputs.values()) {
      if (input.state && input.state !== "connected") continue;
      input.onmidimessage = onMessage;
      names.push(input.name || "MIDI input");
    }
    hooks.onInputs(names);
  };
  access.onstatechange = attach;
  attach();

  return () => {
    access.onstatechange = null;
    for (const input of access.inputs.values()) input.onmidimessage = null;
    hooks.onInputs([]);
  };
}
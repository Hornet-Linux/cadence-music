/**
 * Tiny WAV generator for test fixtures (16-bit PCM, mono). No audio library needed:
 * `render(t)` returns a sample in -1..1 for time `t` in seconds.
 */
export function makeWav(seconds: number, render: (t: number) => number, sampleRate = 22050, tags: WavTags = {}): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, render(i / sampleRate)));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const info = infoChunk(tags);
  const out = Buffer.concat([header, data, info]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

export interface WavTags {
  title?: string;
  artist?: string;
  album?: string;
  /** Track number. */
  track?: number;
  genre?: string;
  /** Release year. */
  year?: number;
}

/** A RIFF LIST/INFO chunk, which music-metadata reads as ordinary tags. */
function infoChunk(tags: WavTags): Buffer {
  const entries: [string, string | undefined][] = [
    ["INAM", tags.title],
    ["IART", tags.artist],
    ["IPRD", tags.album],
    ["ITRK", tags.track === undefined ? undefined : String(tags.track)],
    ["IGNR", tags.genre],
    ["ICRD", tags.year === undefined ? undefined : String(tags.year)],
  ];
  const parts: Buffer[] = [Buffer.from("INFO")];
  for (const [id, value] of entries) {
    if (value === undefined) continue;
    const text = Buffer.from(value + "\0", "utf8");
    const head = Buffer.alloc(8);
    head.write(id, 0);
    head.writeUInt32LE(text.length, 4);
    parts.push(head, text, Buffer.alloc(text.length % 2));
  }
  if (parts.length === 1) return Buffer.alloc(0);
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("LIST", 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

export const sine = (freq: number, amp = 0.5) => (t: number) => amp * Math.sin(2 * Math.PI * freq * t);

/** Several harmonics per note so pitch detection has something to work with. */
export const chord = (freqs: number[], amp = 0.6) => (t: number) => {
  let v = 0;
  for (const f of freqs) for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
  return (amp * v) / (freqs.length * 1.5);
};

/** Decaying clicks on every beat (a drum-machine stand-in). */
export const clickTrack = (bpm: number, amp = 0.9) => {
  const period = 60 / bpm;
  return (t: number) => {
    const since = t % period;
    const env = Math.exp(-since * 60);
    return amp * env * Math.sin(2 * Math.PI * 180 * since) + 0.002 * Math.sin(t * 91);
  };
};

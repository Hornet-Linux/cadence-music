/**
 * Tiny but valid audio files for tests: an MP3 (ID3v2.3 tags plus 128 kbit/s MPEG frames of silence).
 * Lives next to the tests; not imported by the server.
 */

function syncsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function textFrame(id: string, text: string): Buffer {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from(id, "latin1"), size, Buffer.from([0, 0]), body]);
}

export interface Mp3Options {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: number;
  /** 417-byte frames of 26.1 ms each. */
  frames?: number;
}

export const MP3_FRAME_BYTES = 417;

export function makeMp3(o: Mp3Options = {}): Buffer {
  const frames: Buffer[] = [];
  if (o.title) frames.push(textFrame("TIT2", o.title));
  if (o.artist) frames.push(textFrame("TPE1", o.artist));
  if (o.album) frames.push(textFrame("TALB", o.album));
  if (o.albumArtist) frames.push(textFrame("TPE2", o.albumArtist));
  if (o.track) frames.push(textFrame("TRCK", String(o.track)));
  const tagBody = Buffer.concat(frames);
  const header = tagBody.length ? Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0]), syncsafe(tagBody.length)]) : Buffer.alloc(0);
  const frame = Buffer.alloc(MP3_FRAME_BYTES);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const audio = Buffer.concat(Array.from({ length: o.frames ?? 120 }, () => frame));
  return Buffer.concat([header, tagBody, audio]);
}

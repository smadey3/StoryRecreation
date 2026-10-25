// The sound of a phone's video, taken out of it here on the phone. An iPhone records into a QuickTime movie (.MOV),
// which Safari plays but won't open for its sound alone, and most of any video is its picture. So the boxes an MP4
// or a MOV is made of are read for where its sound is kept, and just that is read from the file and packed as a
// plain .m4a, which every browser opens. The picture is never read.

/** Boxes a movie file can begin with. */
const FIRST = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);
/** The most sample tables to read (a movie's are a few MB at most). */
const MAX_MOOV = 64 * 1024 * 1024;
/** AAC: MPEG-4 audio, and MPEG-2's three AAC profiles. */
const AAC = new Set([0x40, 0x66, 0x67, 0x68]);
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

type Box = { type: string; start: number; end: number; body: number };

function* boxes(v: DataView, start: number, end: number): Generator<Box> {
  for (let at = start; at + 8 <= end; ) {
    let size = v.getUint32(at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(v.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) size = end - at;
    if (size < body - at || at + size > end) return;
    yield { type: String.fromCharCode(v.getUint8(at + 4), v.getUint8(at + 5), v.getUint8(at + 6), v.getUint8(at + 7)), start: at, end: at + size, body };
    at += size;
  }
}
const all = (v: DataView, box: Box, type: string) => [...boxes(v, box.body, box.end)].filter((b) => b.type === type);
const child = (v: DataView, box: Box | undefined, type: string): Box | undefined => (box ? all(v, box, type)[0] : undefined);

/** A movie's sample tables, read without reading the rest of it. */
async function moovOf(file: Blob): Promise<DataView | null> {
  for (let at = 0; at + 8 <= file.size; ) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (at === 0 && !FIRST.has(type)) return null; // not a movie
    let body = 8;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      size = Number(head.getBigUint64(8));
      body = 16;
    } else if (size === 0) size = file.size - at;
    if (size < body) return null;
    if (type === "moov") return size > MAX_MOOV || at + size > file.size ? null : new DataView(await file.slice(at, at + size).arrayBuffer());
    at += size;
  }
  return null;
}

/** An MPEG-4 descriptor's tag and where its contents are. */
function descriptor(v: DataView, at: number, end: number) {
  if (at + 2 > end) return null;
  const tag = v.getUint8(at++);
  let length = 0;
  for (let i = 0; i < 4 && at < end; i++) {
    const b = v.getUint8(at++);
    length = (length << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { tag, body: at, end: Math.min(end, at + length) };
}

/** The AAC an esds box describes: its rate and channels, from its AudioSpecificConfig. */
function aacIn(v: DataView, esds: Box): { rate: number; channels: number } | null {
  let d = descriptor(v, esds.body + 4, esds.end);
  if (d?.tag === 3) {
    let at = d.body + 2;
    const flags = v.getUint8(at++);
    if (flags & 0x80) at += 2;
    if (flags & 0x40) at += 1 + v.getUint8(at);
    if (flags & 0x20) at += 2;
    d = descriptor(v, at, d.end);
  }
  if (d?.tag !== 4 || !AAC.has(v.getUint8(d.body))) return null;
  const info = descriptor(v, d.body + 13, d.end);
  if (info?.tag !== 5 || info.end - info.body < 2) return null;
  let bit = info.body * 8;
  const read = (n: number) => {
    let x = 0;
    for (let i = 0; i < n; i++, bit++) x = (x << 1) | ((v.getUint8(bit >> 3) >> (7 - (bit & 7))) & 1);
    return x;
  };
  if (read(5) === 31) read(6);
  const index = read(4);
  if (index === 15 && info.end - info.body < 5) return null;
  const rate = index === 15 ? read(24) : RATES[index];
  return rate ? { rate, channels: read(4) } : null;
}

/** The esds box among a sample description's boxes, or in its QuickTime 'wave' box. */
function esdsIn(v: DataView, start: number, end: number): Box | undefined {
  for (const b of boxes(v, start, end)) {
    if (b.type === "esds") return b;
    if (b.type === "wave") {
      const found = esdsIn(v, b.body, b.end);
      if (found) return found;
    }
  }
}

type Sound = {
  enabled: boolean;
  timescale: number;
  esds: Box;
  rate: number;
  channels: number;
  /** How long each sample plays, as runs of (samples, ticks each): copied as it is. */
  timing: Uint8Array;
  sizes: number[];
  chunks: { offset: number; size: number }[];
};

/** How long the samples play for, in the track's ticks. */
function ticks(timing: Uint8Array): number {
  const v = new DataView(timing.buffer, timing.byteOffset, timing.byteLength);
  let n = 0;
  for (let i = 0; i + 8 <= timing.length; i += 8) n += v.getUint32(i) * v.getUint32(i + 4);
  return n;
}

/**
 * A sound track kept as AAC, and where in the file its sound is. `"sound"` if it's some other sound, or its tables
 * don't add up; null if it isn't sound at all (the picture, say).
 */
function aacTrack(v: DataView, trak: Box): Sound | null | "sound" {
  const mdia = child(v, trak, "mdia");
  const hdlr = child(v, mdia, "hdlr");
  if (!hdlr || hdlr.end - hdlr.body < 12) return "sound";
  if (String.fromCharCode(...[8, 9, 10, 11].map((i) => v.getUint8(hdlr.body + i))) !== "soun") return null;
  const stbl = child(v, child(v, mdia, "minf"), "stbl");
  const stsd = child(v, stbl, "stsd");
  const mdhd = child(v, mdia, "mdhd");
  const stts = child(v, stbl, "stts");
  const stsc = child(v, stbl, "stsc");
  const stsz = child(v, stbl, "stsz");
  const stco = child(v, stbl, "stco") ?? child(v, stbl, "co64");
  if (!stsd || !mdhd || !stts || !stsc || !stsz || !stco) return "sound";
  const entry = [...boxes(v, stsd.body + 8, stsd.end)][0];
  if (entry?.type !== "mp4a") return "sound";
  // After its first 8 bytes and the 20 every sound description has, a QuickTime one carries 16 or 36 more
  // (version 1 or 2). One in an MP4 doesn't, whatever its version says.
  const version = v.getUint16(entry.body + 8);
  const quicktime = v.getUint8(stsd.body) === 0 ? [0, 16, 36][version] ?? 0 : 0;
  let esds: Box | undefined;
  for (const extra of new Set([quicktime, 0, 16, 36])) if (!esds && entry.body + 28 + extra <= entry.end) esds = esdsIn(v, entry.body + 28 + extra, entry.end);
  const aac = esds && aacIn(v, esds);
  if (!esds || !aac) return "sound";

  const sizeEach = v.getUint32(stsz.body + 4);
  const count = v.getUint32(stsz.body + 8);
  if (!count || (!sizeEach && stsz.body + 12 + count * 4 > stsz.end)) return "sound";
  const sizes = Array.from({ length: count }, (_, i) => sizeEach || v.getUint32(stsz.body + 12 + i * 4));
  const wide = stco.type === "co64";
  const offsets = Array.from({ length: Math.min(v.getUint32(stco.body + 4), (stco.end - stco.body - 8) / (wide ? 8 : 4)) }, (_, i) =>
    wide ? Number(v.getBigUint64(stco.body + 8 + i * 8)) : v.getUint32(stco.body + 8 + i * 4),
  );
  const runs = Array.from({ length: Math.min(v.getUint32(stsc.body + 4), (stsc.end - stsc.body - 8) / 12) }, (_, i) => ({
    first: v.getUint32(stsc.body + 8 + i * 12),
    each: v.getUint32(stsc.body + 12 + i * 12),
    description: v.getUint32(stsc.body + 16 + i * 12),
  }));
  // Each chunk is a run of samples, one after another in the file.
  const chunks: Sound["chunks"] = [];
  let sample = 0;
  runs.forEach((run, r) => {
    const last = r + 1 < runs.length ? runs[r + 1].first - 1 : offsets.length;
    for (let c = run.first; c <= last && c <= offsets.length && sample < count; c++) {
      let size = 0;
      for (let k = 0; k < run.each && sample < count; k++) size += sizes[sample++];
      chunks.push({ offset: offsets[c - 1], size });
    }
  });
  if (sample < count || runs.some((run) => run.description !== 1)) return "sound";
  const tkhd = child(v, trak, "tkhd");
  return {
    enabled: !tkhd || Boolean(v.getUint32(tkhd.body) & 1),
    timescale: v.getUint32(mdhd.body + (v.getUint8(mdhd.body) === 1 ? 20 : 12)),
    esds,
    rate: aac.rate,
    channels: aac.channels || v.getUint16(entry.body + 16) || 2,
    timing: new Uint8Array(v.buffer, v.byteOffset + stts.body + 8, Math.min(v.getUint32(stts.body + 4) * 8, stts.end - stts.body - 8)),
    sizes,
    chunks,
  };
}

const u16 = (values: ArrayLike<number>) => {
  const out = new Uint8Array(values.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) v.setUint16(i * 2, values[i]);
  return out;
};
const u32 = (values: ArrayLike<number>) => {
  const out = new Uint8Array(values.length * 4);
  const v = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) v.setUint32(i * 4, values[i]);
  return out;
};
const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + parts.reduce((n, p) => n + p.length, 0));
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(text(type), 4);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const MATRIX = u32([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]);

/** The track's sound as a .m4a of its own: the same AAC, untouched, in one chunk after the tables. */
function m4a(v: DataView, sound: Sound, data: Uint8Array<ArrayBuffer>): Blob {
  const duration = ticks(sound.timing);
  const esds = new Uint8Array(v.buffer, v.byteOffset + sound.esds.start, sound.esds.end - sound.esds.start);
  const ftyp = box("ftyp", text("M4A "), u32([0]), text("M4A isommp42"));
  const moov = box(
    "moov",
    box("mvhd", u32([0, 0, 0, sound.timescale, duration, 0x10000]), u16([0x100, 0]), u32([0, 0]), MATRIX, u32([0, 0, 0, 0, 0, 0, 2])),
    box(
      "trak",
      box("tkhd", u32([7, 0, 0, 1, 0, duration, 0, 0]), u16([0, 0, 0x100, 0]), MATRIX, u32([0, 0])),
      box(
        "mdia",
        box("mdhd", u32([0, 0, 0, sound.timescale, duration]), u16([0x55c4, 0])),
        box("hdlr", u32([0, 0]), text("soun"), u32([0, 0, 0]), text("SoundHandler\0")),
        box(
          "minf",
          box("smhd", u32([0, 0])),
          box("dinf", box("dref", u32([0, 1]), box("url ", u32([1])))),
          box(
            "stbl",
            box("stsd", u32([0, 1]), box("mp4a", u16([0, 0, 0, 1]), u32([0, 0]), u16([sound.channels, 16, 0, 0]), u32([Math.min(sound.rate, 0xffff) * 0x10000]), esds)),
            box("stts", u32([0, Math.floor(sound.timing.length / 8)]), sound.timing),
            box("stsc", u32([0, 1, 1, sound.sizes.length, 1])),
            box("stsz", u32([0, 0, sound.sizes.length]), u32(sound.sizes)),
            // Last of all, so its one offset is the last four bytes of the moov box, set just below.
            box("stco", u32([0, 1, 0])),
          ),
        ),
      ),
    ),
  );
  new DataView(moov.buffer).setUint32(moov.length - 4, ftyp.length + moov.length + 8);
  return new Blob([ftyp, moov, u32([data.length + 8]), text("mdat"), data], { type: "audio/mp4" });
}

/** Chunks closer than this in the file are read in one go. */
const NEAR = 256 * 1024;

/**
 * How long the sound of an MP4 or a MOV is, and `read` for it as an .m4a; `"silent"` if the video has no sound at
 * all; null if it isn't a movie, or its sound isn't AAC, so it's left to the browser to open whole.
 */
export async function soundOfVideo(file: Blob): Promise<{ durationMs: number; read: () => Promise<Blob> } | "silent" | null> {
  const v = await moovOf(file);
  const moov = v && [...boxes(v, 0, v.byteLength)][0];
  if (!v || !moov) return null;
  const tracks = all(v, moov, "trak").map((trak) => aacTrack(v, trak));
  if (tracks.length && !tracks.some(Boolean)) return "silent";
  const sounds = tracks.filter((t): t is Sound => typeof t === "object" && t !== null);
  // An iPhone 16 keeps a spatial copy of its sound too, in a format all its own: the AAC one is what plays.
  const sound = sounds.find((s) => s.enabled) ?? sounds[0];
  if (!sound || sound.chunks.some((c) => c.offset + c.size > file.size)) return null;
  return { durationMs: Math.round((ticks(sound.timing) / (sound.timescale || 1)) * 1000), read: () => read(file, v, sound) };
}

/** The track's sound read from the file: where each chunk goes, one after another, read a few at a time. */
async function read(file: Blob, v: DataView, sound: Sound): Promise<Blob> {
  const { chunks } = sound;
  const place: number[] = [];
  let total = 0;
  for (const c of chunks) {
    place.push(total);
    total += c.size;
  }
  const spans: { first: number; last: number }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const span = spans.at(-1);
    const gap = span ? chunks[i].offset - (chunks[i - 1].offset + chunks[i - 1].size) : -1;
    if (span && gap >= 0 && gap <= NEAR) span.last = i;
    else spans.push({ first: i, last: i });
  }
  const data = new Uint8Array(total);
  for (let s = 0; s < spans.length; s += 8) {
    await Promise.all(
      spans.slice(s, s + 8).map(async ({ first, last }) => {
        const from = chunks[first].offset;
        const bytes = new Uint8Array(await file.slice(from, chunks[last].offset + chunks[last].size).arrayBuffer());
        for (let k = first; k <= last; k++) data.set(bytes.subarray(chunks[k].offset - from, chunks[k].offset - from + chunks[k].size), place[k]);
      }),
    );
  }
  return m4a(v, sound, data);
}

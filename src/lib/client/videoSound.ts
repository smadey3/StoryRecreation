// The sound of a phone's video, taken out of it here on the phone. An iPhone records into a QuickTime movie (.MOV),
// which Safari plays but won't open for its sound alone, and most of any video is its picture. So the boxes an MP4
// or a MOV is made of are read for where its sound is kept, and just that is read from the file and packed as a
// plain .m4a, which every browser opens. The picture is never read. (A voice memo or a voicemail saved as .m4a is
// the same kind of file, so it's read the same way.) The file can be on the phone, or in Google Drive, read a
// piece at a time.

/** A file to read pieces of: one on the phone, or one far away. */
export type Source = {
  size: number;
  /** The bytes from `from` up to (not including) `to`. */
  read: (from: number, to: number) => Promise<ArrayBuffer>;
  /** Pieces of sound closer together than this are read in one go, up to `most` bytes at a time. */
  near?: number;
  most?: number;
  /** How many reads are made at once. */
  together?: number;
};
const onPhone = (file: Blob): Source => ({ size: file.size, read: (from, to) => file.slice(from, to).arrayBuffer() });

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
async function moovOf(file: Source): Promise<DataView | null> {
  for (let at = 0; at + 8 <= file.size; ) {
    const head = new DataView(await file.read(at, Math.min(at + 16, file.size)));
    if (head.byteLength < 8) return null;
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
    if (type === "moov") return size > MAX_MOOV || at + size > file.size ? null : new DataView(await file.read(at, at + size));
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

type Run = { count: number; delta: number };

type Sound = {
  enabled: boolean;
  timescale: number;
  esds: Box;
  rate: number;
  channels: number;
  /** How long each sample plays: runs of samples, each so many ticks long. */
  timing: Run[];
  /** Where each sample is in the file, and how big. */
  offsets: Float64Array;
  sizes: Uint32Array;
};

/** The samples that start from `from` up to `to` (in ticks). */
function samplesWithin(timing: Run[], count: number, from: number, to: number): [number, number] {
  let first = count;
  let tick = 0;
  let i = 0;
  for (const run of timing) {
    for (let k = 0; k < run.count && i < count; k++, i++, tick += run.delta) {
      if (first === count && tick >= from) first = i;
      if (tick >= to) return [Math.min(first, i), i];
    }
  }
  return [first, count];
}

/** The timing of samples `first` up to `last`, as runs. */
function timingOf(timing: Run[], first: number, last: number): Run[] {
  const out: Run[] = [];
  let i = 0;
  for (const run of timing) {
    const count = Math.min(i + run.count, last) - Math.max(i, first);
    if (count > 0) out.push({ count, delta: run.delta });
    i += run.count;
  }
  return out;
}
const ticks = (timing: Run[]) => timing.reduce((n, run) => n + run.count * run.delta, 0);

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
  const sizes = Uint32Array.from({ length: count }, (_, i) => sizeEach || v.getUint32(stsz.body + 12 + i * 4));
  const wide = stco.type === "co64";
  const chunks = Array.from({ length: Math.min(v.getUint32(stco.body + 4), (stco.end - stco.body - 8) / (wide ? 8 : 4)) }, (_, i) =>
    wide ? Number(v.getBigUint64(stco.body + 8 + i * 8)) : v.getUint32(stco.body + 8 + i * 4),
  );
  const runs = Array.from({ length: Math.min(v.getUint32(stsc.body + 4), (stsc.end - stsc.body - 8) / 12) }, (_, i) => ({
    first: v.getUint32(stsc.body + 8 + i * 12),
    each: v.getUint32(stsc.body + 12 + i * 12),
    description: v.getUint32(stsc.body + 16 + i * 12),
  }));
  // Each chunk is a run of samples, one after another in the file.
  const offsets = new Float64Array(count);
  let sample = 0;
  runs.forEach((run, r) => {
    const last = r + 1 < runs.length ? runs[r + 1].first - 1 : chunks.length;
    for (let c = run.first; c <= last && c <= chunks.length && sample < count; c++) {
      let at = chunks[c - 1];
      for (let k = 0; k < run.each && sample < count; k++) {
        offsets[sample] = at;
        at += sizes[sample++];
      }
    }
  });
  if (sample < count || runs.some((run) => run.description !== 1)) return "sound";
  const timing = Array.from({ length: Math.min(v.getUint32(stts.body + 4), (stts.end - stts.body - 8) / 8) }, (_, i) => ({
    count: v.getUint32(stts.body + 8 + i * 8),
    delta: v.getUint32(stts.body + 12 + i * 8),
  }));
  const tkhd = child(v, trak, "tkhd");
  return {
    enabled: !tkhd || Boolean(v.getUint32(tkhd.body) & 1),
    timescale: v.getUint32(mdhd.body + (v.getUint8(mdhd.body) === 1 ? 20 : 12)) || 1,
    esds,
    rate: aac.rate,
    channels: aac.channels || v.getUint16(entry.body + 16) || 2,
    timing,
    offsets,
    sizes,
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

/** Sound as a .m4a of its own: the same AAC, untouched, in one chunk after the tables. */
function m4a(v: DataView, sound: Sound, timing: Run[], sizes: Uint32Array, data: Uint8Array<ArrayBuffer>): Blob {
  const duration = ticks(timing);
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
            box("stts", u32([0, timing.length]), u32(timing.flatMap((run) => [run.count, run.delta]))),
            box("stsc", u32([0, 1, 1, sizes.length, 1])),
            box("stsz", u32([0, 0, sizes.length]), u32(sizes)),
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

/** Sound opened by a browser: a channel of samples for each of its channels. */
export type Opened = { length: number; numberOfChannels: number; getChannelData: (channel: number) => Float32Array };

/** A movie's sound, found: how long it is, `read` for it (or for just part of it) as an .m4a, and `open` to open it. */
export type FoundSound = {
  durationMs: number;
  read: (part?: Part, onProgress?: (fraction: number) => void) => Promise<Blob>;
  /**
   * The sound (or just part of it) opened as one mono track, a couple of minutes at a time: a phone runs short of room
   * opening twenty minutes at once. `decode` opens an .m4a at the rate it's asked for.
   */
  open: (options: {
    part?: Part;
    decode: (m4a: Blob, rate: number) => Promise<Opened>;
    onProgress?: (fraction: number) => void;
    pieceMs?: number;
  }) => Promise<{ samples: Float32Array; rate: number }>;
};
type Part = { fromMs: number; toMs: number };

/** The rates an MP3 can be made at: sound kept at one of them is opened at it, so it's never made over. */
const MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000];
/**
 * Each piece is opened from a few samples before it: the first sample opened comes out wrong (a sample of AAC is
 * finished by the one after it), and a decoder may leave out the 2112 an encoder begins with, two of them and more.
 */
const LEAD = 6;

/**
 * The AAC sound of an MP4, a MOV or an M4A; `"silent"` if it has no sound at all; null if it isn't one of those, or
 * its sound isn't AAC, so it's left to the browser to open whole.
 */
export async function mp4Sound(file: Blob | Source): Promise<FoundSound | "silent" | null> {
  const source = file instanceof Blob ? onPhone(file) : file;
  const v = await moovOf(source);
  const moov = v && [...boxes(v, 0, v.byteLength)][0];
  if (!v || !moov) return null;
  const tracks = all(v, moov, "trak").map((trak) => aacTrack(v, trak));
  if (tracks.length && !tracks.some(Boolean)) return "silent";
  const sounds = tracks.filter((t): t is Sound => typeof t === "object" && t !== null);
  // An iPhone 16 keeps a spatial copy of its sound too, in a format all its own: the AAC one is what plays.
  const sound = sounds.find((s) => s.enabled) ?? sounds[0];
  if (!sound || sound.offsets.some((at, i) => at + sound.sizes[i] > source.size)) return null;
  const count = sound.sizes.length;
  const within = (part?: Part): [number, number] => {
    const [first, last] = part
      ? samplesWithin(sound.timing, count, (part.fromMs / 1000) * sound.timescale, (part.toMs / 1000) * sound.timescale)
      : [0, count];
    if (last <= first) throw new Error("There's no sound in that part.");
    return [first, last];
  };
  return {
    durationMs: Math.round((ticks(sound.timing) / sound.timescale) * 1000),
    read: async (part, onProgress) => readSamples(source, v, sound, ...within(part), onProgress),
    open: async ({ part, decode, onProgress, pieceMs = 2 * 60 * 1000 }) => open(source, v, sound, within(part), decode, pieceMs, onProgress),
  };
}

/** Samples `first` up to `last` read from the file, a few pieces at a time, as an .m4a. */
async function readSamples(file: Source, v: DataView, sound: Sound, first: number, last: number, onProgress?: (fraction: number) => void): Promise<Blob> {
  const { offsets, sizes } = sound;
  // Where each sample goes, one after another; samples close together in the file are read in one go (but never
  // much at once: the picture between them may be most of the file).
  const place = new Float64Array(last - first);
  let total = 0;
  for (let i = first; i < last; i++) {
    place[i - first] = total;
    total += sizes[i];
  }
  const near = file.near ?? 256 * 1024;
  const most = file.most ?? 2 * 1024 * 1024;
  const spans: { first: number; last: number }[] = [];
  for (let i = first; i < last; i++) {
    const span = spans.at(-1);
    const gap = span ? offsets[i] - (offsets[i - 1] + sizes[i - 1]) : -1;
    if (span && gap >= 0 && gap <= near && offsets[i] + sizes[i] - offsets[span.first] <= most) span.last = i;
    else spans.push({ first: i, last: i });
  }
  const data = new Uint8Array(total);
  let got = 0;
  let next = 0;
  const reader = async () => {
    while (next < spans.length) {
      const span = spans[next++];
      const from = offsets[span.first];
      const bytes = new Uint8Array(await file.read(from, offsets[span.last] + sizes[span.last]));
      for (let i = span.first; i <= span.last; i++) {
        data.set(bytes.subarray(offsets[i] - from, offsets[i] - from + sizes[i]), place[i - first]);
        got += sizes[i];
      }
      onProgress?.(got / total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(file.together ?? 8, spans.length) }, reader));
  return m4a(v, sound, timingOf(sound.timing, first, last), sizes.subarray(first, last), data);
}

/** Samples `first` up to `last`, opened a piece at a time into one mono track. */
async function open(
  file: Source,
  v: DataView,
  sound: Sound,
  [first, last]: [number, number],
  decode: (m4a: Blob, rate: number) => Promise<Opened>,
  pieceMs: number,
  onProgress?: (fraction: number) => void,
): Promise<{ samples: Float32Array; rate: number }> {
  // When each sample starts, in the track's ticks, and in samples of sound once opened.
  const starts = new Float64Array(sound.sizes.length + 1);
  let i = 0;
  for (const run of sound.timing) for (let k = 0; k < run.count && i < sound.sizes.length; k++, i++) starts[i + 1] = starts[i] + run.delta;
  const rate = MP3_RATES.includes(sound.timescale) ? sound.timescale : 44100;
  const at = (sample: number) => Math.round((starts[sample] * rate) / sound.timescale);
  const out = new Float32Array(at(last) - at(first) + rate);
  let filled = 0;
  const pieceTicks = (pieceMs / 1000) * sound.timescale;
  for (let s = first; s < last; ) {
    let e = s + 1;
    while (e < last && starts[e] - starts[s] < pieceTicks) e++;
    const lead = Math.min(LEAD, s);
    const piece = await decode(await readSamples(file, v, sound, s - lead, e), rate);
    const channels = Array.from({ length: piece.numberOfChannels }, (_, c) => piece.getChannelData(c));
    const mono = (from: number, to: number, into: Float32Array, offset = 0) => {
      into.fill(0, offset, offset + to - from);
      for (const ch of channels) for (let k = from; k < to; k++) into[offset + k - from] += ch[k] / channels.length;
    };
    // Where this piece's own samples begin: what the decoder should have made of the lead, less what it left out at
    // its start (as far as its length says)...
    const short = Math.max(0, at(e) - at(s - lead) - piece.length);
    let begin = Math.max(0, at(s) - at(s - lead) - short);
    // ...or, after the first, wherever its lead matches the end of what's opened already, sample for sample.
    const frame = at(s) - at(s - 1);
    if (filled >= frame && lead >= 2) {
      const tail = out.subarray(filled - frame, filled);
      if (tail.reduce((n, x) => n + x * x, 0) > 1e-6) {
        const lo = Math.max(0, begin - 4 * frame);
        const hi = Math.min(piece.length, begin + 3 * frame);
        const near = new Float32Array(Math.max(0, hi - lo));
        mono(lo, hi, near);
        let best = Infinity;
        for (let k = 0; k + frame <= near.length; k++) {
          let miss = 0;
          for (let j = 0; j < frame && miss < best; j++) miss += (near[k + j] - tail[j]) ** 2;
          if (miss < best) {
            best = miss;
            begin = lo + k + frame;
          }
        }
      }
    }
    const n = Math.max(0, Math.min(piece.length - begin, out.length - filled));
    mono(begin, begin + n, out, filled);
    filled += n;
    onProgress?.((e - first) / (last - first));
    s = e;
  }
  return { samples: out.subarray(0, filled), rate };
}

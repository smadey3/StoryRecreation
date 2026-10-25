import { Mp3Encoder } from "@breezystack/lamejs";
import { renderChime } from "@/lib/shared/chime";
import type { ChimeSettings, StoryTimeline, TimelinePage, TimelineWord } from "@/lib/shared/types";

// All story audio is handled as 24 kHz mono. ElevenLabs returns raw 16-bit
// PCM at this rate on every plan, which lets us mix narration, page-turn
// chimes and ambience in plain JavaScript and encode a single MP3 that plays
// anywhere: the app, a lock screen, a Bluetooth speaker or a Yoto card.

export const SAMPLE_RATE = 24000;

export interface Clip {
  samples: Float32Array;
  /** Word timings relative to the start of the clip. */
  words: TimelineWord[];
}

export function pcm16ToFloat(buf: Uint8Array): Float32Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.floor(buf.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export function floatToPcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return buf;
}

export function concatClips(clips: Clip[], gapSeconds: number): Clip {
  const gap = Math.round(gapSeconds * SAMPLE_RATE);
  const total = clips.reduce((n, c) => n + c.samples.length, 0) + gap * Math.max(0, clips.length - 1);
  const samples = new Float32Array(total);
  const words: TimelineWord[] = [];
  let at = 0;
  clips.forEach((c, i) => {
    samples.set(c.samples, at);
    const offset = at / SAMPLE_RATE;
    for (const w of c.words) words.push({ ...w, t: w.t + offset, e: w.e + offset });
    at += c.samples.length + (i < clips.length - 1 ? gap : 0);
  });
  return { samples, words };
}

/** A sound effect to play at a moment in one page's recording. */
export interface PlacedEffect {
  page: number;
  /** Seconds from the start of that page's recording. */
  at: number;
  samples: Float32Array;
}

/**
 * Long work on a story's audio gives way every so often (each 12 ms or so), so the app keeps answering everyone else
 * while a story is put together. Call it between blocks of work; it returns at once until a breath is due.
 */
function breather(): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < 12) return;
    await new Promise((r) => setImmediate(r));
    since = performance.now();
  };
}

/** Samples worked on between breaths. */
const BLOCK = 1 << 16;

export interface MixInput {
  pages: { page: number; clip: Clip }[];
  intro?: { before: Clip; after: Clip } | null;
  chime: ChimeSettings;
  ambience?: Float32Array | null;
  effects?: PlacedEffect[];
}

const LEAD_IN = 0.8;
const BEFORE_CHIME = 0.7;
const PAGE_GAP_NO_CHIME = 1.4;
const TAIL = 2.5;
const CHIME_PEAK = 0.34;

/** Lay the story out on one timeline and render it (giving way to the rest of the app as it goes). */
export async function mixStory(input: MixInput): Promise<{ samples: Float32Array; timeline: StoryTimeline }> {
  const breathe = breather();
  const chime = renderChime(input.chime.style, SAMPLE_RATE, CHIME_PEAK);
  const chimeLen = chime.length / SAMPLE_RATE;
  const parts: { at: number; samples: Float32Array }[] = [];
  const pages: TimelinePage[] = [];
  let t = LEAD_IN;

  const speechGain = await narrationGain(
    [...input.pages.map((p) => p.clip.samples), ...(input.intro ? [input.intro.before.samples, input.intro.after.samples] : [])],
    breathe,
  );

  const place = (samples: Float32Array, gain = 1) => {
    const scaled = gain === 1 ? samples : samples.map((s) => s * gain);
    parts.push({ at: t, samples: scaled });
    t += samples.length / SAMPLE_RATE;
  };
  const shift = (words: TimelineWord[], offset: number) => words.map((w) => ({ ...w, t: w.t + offset, e: w.e + offset }));

  if (input.intro) {
    const start = t;
    const words = shift(input.intro.before.words, t);
    place(input.intro.before.samples, speechGain);
    const speechEnd = t;
    let chimeAt: number | null = null;
    if (input.chime.enabled) {
      t += 0.6;
      chimeAt = t;
      place(chime);
      t += 0.4;
    }
    words.push(...shift(input.intro.after.words, t));
    place(input.intro.after.samples, speechGain);
    const introEnd = input.intro.after.samples.length ? t : speechEnd;
    t += 1.6;
    pages.push({ page: 0, start, speechEnd: introEnd, chimeAt, next: t, words });
  }

  input.pages.forEach(({ page, clip }, i) => {
    const last = i === input.pages.length - 1;
    const start = t;
    const words = shift(clip.words, t);
    place(clip.samples, speechGain);
    const speechEnd = t;
    let chimeAt: number | null = null;
    if (!last) {
      if (input.chime.enabled) {
        t += BEFORE_CHIME;
        chimeAt = t;
        place(chime);
        t += Math.max(0.5, input.chime.gapSeconds - chimeLen * 0.4);
      } else {
        t += PAGE_GAP_NO_CHIME;
      }
    }
    pages.push({ page, start, speechEnd, chimeAt, next: t, words });
    for (const fx of input.effects ?? []) if (fx.page === page) parts.push({ at: start + fx.at, samples: shapeEffect(fx.samples) });
  });

  t += TAIL;
  const total = Math.ceil(t * SAMPLE_RATE);
  const out = new Float32Array(total);
  for (const p of parts) {
    const offset = Math.round(p.at * SAMPLE_RATE);
    for (let from = 0; from < p.samples.length; from += BLOCK) {
      for (let i = from; i < Math.min(from + BLOCK, p.samples.length) && offset + i < total; i++) out[offset + i] += p.samples[i];
      await breathe();
    }
  }

  if (input.ambience && input.ambience.length > SAMPLE_RATE) await layAmbience(out, input.ambience, breathe);
  await softLimit(out, breathe);

  const duration = total / SAMPLE_RATE;
  if (pages.length) pages[pages.length - 1].next = duration;
  return { samples: out, timeline: { duration, pages } };
}

/** One gain for all narration so voices sit at a comfortable, even level. */
async function narrationGain(clips: Float32Array[], breathe: () => Promise<void>): Promise<number> {
  let sumSq = 0;
  let n = 0;
  let peak = 0;
  for (const c of clips) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
      if (a > 0.01) {
        sumSq += c[i] * c[i];
        n++;
      }
      if (i % BLOCK === 0) await breathe();
    }
  }
  if (!n || !peak) return 1;
  const rms = Math.sqrt(sumSq / n);
  const target = 0.12; // about -18 dBFS while speaking
  return Math.min(target / rms, 0.95 / peak, 4);
}

/** Loop a soundscape quietly under the story with long, gentle fades. */
async function layAmbience(out: Float32Array, loop: Float32Array, breathe: () => Promise<void>) {
  let sumSq = 0;
  for (let i = 0; i < loop.length; i++) sumSq += loop[i] * loop[i];
  const rms = Math.sqrt(sumSq / loop.length) || 1;
  const gain = 0.018 / rms; // far beneath the voices
  const fadeIn = 4 * SAMPLE_RATE;
  const fadeOut = 6 * SAMPLE_RATE;
  const cross = Math.min(Math.floor(0.5 * SAMPLE_RATE), Math.floor(loop.length / 4));
  const period = loop.length - cross;
  for (let i = 0; i < out.length; i++) {
    const pos = i % period;
    let s = loop[pos];
    // Crossfade the seam in case the loop isn't perfectly seamless.
    if (pos < cross && i >= period) {
      const k = pos / cross;
      s = loop[pos] * k + loop[period + pos] * (1 - k);
    }
    let env = 1;
    if (i < fadeIn) env = i / fadeIn;
    const fromEnd = out.length - i;
    if (fromEnd < fadeOut) env = Math.min(env, fromEnd / fadeOut);
    out[i] += s * gain * env;
    if (i % BLOCK === 0) await breathe();
  }
}

/**
 * Fit a sound effect beneath the voices: a quick fade in, a gentle fade out,
 * and a level that's clearly heard without ever covering a word.
 */
function shapeEffect(samples: Float32Array): Float32Array {
  const out = samples.slice(0, Math.min(samples.length, 5 * SAMPLE_RATE));
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < out.length; i++) {
    peak = Math.max(peak, Math.abs(out[i]));
    sumSq += out[i] * out[i];
  }
  if (!peak) return out;
  const rms = Math.sqrt(sumSq / out.length);
  const gain = Math.min(0.045 / (rms || 1), 0.3 / peak); // about 8 dB under the narration
  const fadeIn = Math.min(out.length, Math.round(0.02 * SAMPLE_RATE));
  const fadeOut = Math.min(out.length, Math.round(0.4 * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    let env = 1;
    if (i < fadeIn) env = i / fadeIn;
    const fromEnd = out.length - i;
    if (fromEnd < fadeOut) env = Math.min(env, fromEnd / fadeOut);
    out[i] *= gain * env;
  }
  return out;
}

async function softLimit(out: Float32Array, breathe: () => Promise<void>) {
  const knee = 0.9;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > knee) out[i] = Math.sign(out[i]) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
    if (i % BLOCK === 0) await breathe();
  }
}

/** The story as an MP3 (the slowest part of putting it together: it gives way to the rest of the app as it goes). */
export async function encodeMp3(samples: Float32Array, kbps = 64): Promise<Buffer> {
  const breathe = breather();
  const encoder = new Mp3Encoder(1, SAMPLE_RATE, kbps);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 32768 : s * 32767;
    if (i % BLOCK === 0) await breathe();
  }
  const chunks: Buffer[] = [];
  const block = 1152 * 8;
  for (let i = 0; i < pcm.length; i += block) {
    const buf = encoder.encodeBuffer(pcm.subarray(i, i + block));
    if (buf.length) chunks.push(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
    await breathe();
  }
  const end = encoder.flush();
  if (end.length) chunks.push(Buffer.from(end.buffer, end.byteOffset, end.byteLength));
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ demo

/**
 * DEMO_MODE stand-in for real voices: a soft hum with syllable-like rhythm,
 * pitched per voice, with word timings so the read-along still works.
 */
export function demoVoiceClip(lines: { speaker: string; text: string; voiceId: string }[]): Clip {
  const clips: Clip[] = lines.map((line) => {
    const words = line.text.replace(/\[[^\]]*\]/g, "").split(/\s+/).filter(Boolean);
    const perWord = 0.36;
    const dur = Math.max(0.6, words.length * perWord);
    const n = Math.round(dur * SAMPLE_RATE);
    const samples = new Float32Array(n);
    const f0 = 120 + (hash(line.voiceId) % 140);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const syllable = Math.abs(Math.sin(Math.PI * t * 4.2)) ** 1.5;
      const wobble = 1 + 0.04 * Math.sin(2 * Math.PI * 3 * t);
      const ph = 2 * Math.PI * f0 * wobble * t;
      samples[i] = 0.12 * syllable * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph));
    }
    return {
      samples,
      words: words.map((w, i) => ({ t: i * perWord, e: (i + 1) * perWord - 0.04, w, speaker: line.speaker })),
    };
  });
  return concatClips(clips, 0.35);
}

/** DEMO_MODE stand-in for a sound effect: a soft two-note chime. */
export function demoSoundEffect(seconds: number): Float32Array {
  const n = Math.round(Math.min(seconds, 2) * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const note = t < 0.25 ? 1318.5 : 1760;
    out[i] = 0.3 * Math.sin(2 * Math.PI * note * t) * Math.exp(-3 * (t < 0.25 ? t : t - 0.25));
  }
  return out;
}

export function demoAmbience(): Float32Array {
  const n = 8 * SAMPLE_RATE;
  const out = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) {
    b = 0.985 * b + 0.015 * (Math.random() * 2 - 1); // soft brown-ish noise, like wind
    out[i] = b * 0.5;
  }
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

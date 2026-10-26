import { Mp3Encoder } from "@breezystack/lamejs";
import { mp4Sound } from "./videoSound";

// Family recordings arrive in every shape: an iPhone voicemail (.m4a), a
// voice memo, the sound from a video, a recording made right here. The
// browser opens them, and we keep one tidy mono MP3 that plays everywhere
// and is just what the voice service wants to learn from. A video is opened
// here on the phone for its sound alone: the video itself never leaves it.
// Its sound track is taken out of it first (Safari won't open an iPhone's
// .MOV for its sound), so only that is read, however big the video is.

const RATE = 44100;
/** The longest recording kept: from a longer one, the family chooses a part up to this long. */
export const MAX_MS = 20 * 60 * 1000;
/** Bigger than this, a phone may run out of room opening it. */
export const MAX_BYTES = 400 * 1024 * 1024;

export const isVideo = (blob: Blob) => blob.type.startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test((blob as File).name ?? "");

/** A recording longer than can be kept: `sound` is all of it, to listen to and choose a part from. */
export class TooLong extends Error {
  constructor(
    readonly durationMs: number,
    readonly sound: Blob,
  ) {
    super("That's longer than 20 minutes: choose up to 20 minutes of it to keep.");
  }
}

type Part = { fromMs: number; toMs: number };

/**
 * `onProgress` hears how much of it is ready (opening it, then making the MP3). A recording longer than 20 minutes
 * throws `TooLong` unless `within` says which part of it (up to 20 minutes) to make ready. `keep` is the part to keep,
 * in the recording as it was first made ready (after its silent ends are trimmed).
 */
export async function prepareRecording(
  blob: Blob,
  name = "recording",
  { onProgress, keep, within }: { onProgress?: (fraction: number) => void; keep?: Part; within?: Part } = {},
): Promise<{ file: File; durationMs: number }> {
  const video = isVideo(blob);
  const decode = (b: Blob, rate: number) => b.arrayBuffer().then((bytes) => new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes));
  // An MP4, a MOV or an M4A has its sound taken out, and just the part wanted, opened a couple of minutes at a time.
  const found = await mp4Sound(blob).catch(() => null);
  if (found === "silent" && video) throw new Error("That video has no sound in it. Choose one where you can hear them speaking.");
  const sound = found && found !== "silent" ? found : null;
  // Too long to keep, and too much to open: a part is chosen first. (A little over may trim down.)
  if (sound && !within && sound.durationMs > MAX_MS + 60_000) throw new TooLong(sound.durationMs, await sound.read());
  let opened = sound ? await sound.open({ part: within, decode, onProgress: (f) => onProgress?.(f * 0.4) }).catch(() => null) : null;
  // Whether the part wanted is all that was opened.
  const cut = Boolean(opened && within);
  if (!opened) {
    if (blob.size > MAX_BYTES) {
      throw new Error(
        video
          ? "That video is too big to open on a phone. Trim it to the part where they're speaking first (in Photos, tap Edit and drag the ends in), then add it again."
          : "That recording is too big to open here. Trim it to the part you'd like to keep, then add it again.",
      );
    }
    const whole = await decode(blob, RATE).catch(() => null);
    if (whole) opened = { samples: monoOf(whole), rate: whole.sampleRate };
  }
  if (!opened) {
    throw new Error(
      video
        ? "The sound in that video couldn't be opened here. Try trimming it to the part where they're speaking, or save its sound (as a voice memo, say) and add that."
        : "That recording couldn't be opened here. Try saving it as an MP3, M4A or WAV file and adding it again.",
    );
  }

  const { rate } = opened;
  let mono = opened.samples;
  const allMs = Math.round((mono.length / rate) * 1000);
  const tooLong = async () => new TooLong(allMs, sound ? await sound.read() : blob);
  if (within && !cut) {
    const at = (ms: number) => Math.min(mono.length, Math.max(0, Math.round((ms / 1000) * rate)));
    mono = mono.subarray(at(within.fromMs), Math.max(at(within.fromMs) + 1, at(within.toMs)));
  } else if (!within && allMs > MAX_MS + 60_000) throw await tooLong();

  // Trim long silences at the ends (a voicemail's beep and hang-up), keeping a breath of room.
  let peak = 0;
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 0.001) throw new Error("That recording seems to be silent.");
  const floor = peak * 0.04;
  let start = 0;
  let end = mono.length - 1;
  while (start < end && Math.abs(mono[start]) < floor) start++;
  while (end > start && Math.abs(mono[end]) < floor) end--;
  const pad = Math.round(rate * 0.3);
  let clip = mono.subarray(Math.max(0, start - pad), Math.min(mono.length, end + pad));
  // Just part of it: the part where they're speaking, say, without anyone else.
  if (keep) {
    const at = (ms: number) => Math.min(clip.length, Math.max(0, Math.round((ms / 1000) * rate)));
    clip = clip.subarray(at(keep.fromMs), Math.max(at(keep.fromMs) + 1, at(keep.toMs)));
  }
  // A part chosen from a long one can run a moment over, its sound being cut where its pieces begin.
  if (within) clip = clip.subarray(0, Math.round((MAX_MS / 1000) * rate));
  const durationMs = Math.round((clip.length / rate) * 1000);
  if (durationMs > MAX_MS) throw await tooLong();

  // Even out the level so a quiet voicemail isn't a whisper (without blasting the hiss), a block at a time as the MP3
  // is made. 192 kbps: the quality ElevenLabs asks for, to learn a voice from.
  const gain = Math.min(4, 0.89 / peak);
  const encoder = new Mp3Encoder(1, rate, 192);
  const parts: BlobPart[] = [];
  const block = 1152 * 16;
  const pcm = new Int16Array(block);
  for (let i = 0; i < clip.length; i += block) {
    const n = Math.min(block, clip.length - i);
    for (let k = 0; k < n; k++) {
      const s = Math.max(-1, Math.min(1, clip[i + k] * gain));
      pcm[k] = s < 0 ? s * 32768 : s * 32767;
    }
    const buf = encoder.encodeBuffer(pcm.subarray(0, n));
    if (buf.length) parts.push(new Uint8Array(buf));
    if (i % (block * 64) === 0) {
      onProgress?.((sound ? 0.4 : 0) + (sound ? 0.6 : 1) * (i / clip.length));
      await new Promise((r) => setTimeout(r)); // keep the page responsive
    }
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return { file: new File(parts, `${name.replace(/[^\w-]+/g, "-").slice(0, 40) || "recording"}.mp3`, { type: "audio/mpeg" }), durationMs };
}

/** All its channels as one, in place of its first: there's no room for another copy of twenty minutes of sound. */
function monoOf(sound: AudioBuffer): Float32Array {
  const mono = sound.getChannelData(0);
  const n = sound.numberOfChannels;
  for (let c = 1; c < n; c++) {
    const ch = sound.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i];
  }
  if (n > 1) for (let i = 0; i < mono.length; i++) mono[i] /= n;
  return mono;
}

/** "1:05" */
export function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

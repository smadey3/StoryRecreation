import { Mp3Encoder } from "@breezystack/lamejs";
import { soundOfVideo } from "./videoSound";

// Family recordings arrive in every shape: an iPhone voicemail (.m4a), a
// voice memo, the sound from a video, a recording made right here. The
// browser opens them, and we keep one tidy mono MP3 that plays everywhere
// and is just what the voice service wants to learn from. A video is opened
// here on the phone for its sound alone: the video itself never leaves it.
// Its sound track is taken out of it first (Safari won't open an iPhone's
// .MOV for its sound), so only that is read, however big the video is.

const RATE = 44100;
const MAX_MS = 20 * 60 * 1000;
/** Bigger than this, a phone may run out of room opening it. */
export const MAX_BYTES = 400 * 1024 * 1024;

export const isVideo = (blob: Blob) => blob.type.startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test((blob as File).name ?? "");

/**
 * `onProgress` hears how much of it is ready (opening it is quick; making the MP3 is most of the wait). `keep` is the
 * part to keep, in the recording as it was first made ready (after its silent ends are trimmed).
 */
export async function prepareRecording(
  blob: Blob,
  name = "recording",
  onProgress?: (fraction: number) => void,
  keep?: { fromMs: number; toMs: number },
): Promise<{ file: File; durationMs: number }> {
  const video = isVideo(blob);
  const tooLong = video
    ? "That video is longer than 20 minutes. Trim it to the part where they're speaking (in Photos, tap Edit and drag the ends in), then add it again."
    : "That recording is longer than 20 minutes. Trim it a little and try again.";
  const decode = (b: Blob) => b.arrayBuffer().then((bytes) => new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes));
  const sound = video ? await soundOfVideo(blob).catch(() => null) : null;
  if (sound === "silent") throw new Error("That video has no sound in it. Choose one where you can hear them speaking.");
  // Too long to be any use, and too much to open: said before it's opened. (A little over may trim down.)
  if (sound && sound.durationMs > MAX_MS + 60_000) throw new Error(tooLong);
  let decoded = sound ? await sound.read().then(decode).catch(() => null) : null;
  if (!decoded) {
    if (blob.size > MAX_BYTES) {
      throw new Error(
        video
          ? "That video is too big to open on a phone. Trim it to the part where they're speaking first (in Photos, tap Edit and drag the ends in), then add it again."
          : "That recording is too big to open here. Trim it to the part you'd like to keep, then add it again.",
      );
    }
    decoded = await decode(blob).catch(() => null);
  }
  if (!decoded) {
    throw new Error(
      video
        ? "The sound in that video couldn't be opened here. Try trimming it to the part where they're speaking, or save its sound (as a voice memo, say) and add that."
        : "That recording couldn't be opened here. Try saving it as an MP3, M4A or WAV file and adding it again.",
    );
  }

  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }

  // Trim long silences at the ends (a voicemail's beep and hang-up), keeping a breath of room.
  let peak = 0;
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 0.001) throw new Error("That recording seems to be silent.");
  const floor = peak * 0.04;
  let start = 0;
  let end = mono.length - 1;
  while (start < end && Math.abs(mono[start]) < floor) start++;
  while (end > start && Math.abs(mono[end]) < floor) end--;
  const pad = Math.round(RATE * 0.3);
  let clip = mono.subarray(Math.max(0, start - pad), Math.min(mono.length, end + pad));
  // Just part of it: the part where they're speaking, say, without anyone else.
  if (keep) {
    const at = (ms: number) => Math.min(clip.length, Math.max(0, Math.round((ms / 1000) * RATE)));
    clip = clip.subarray(at(keep.fromMs), Math.max(at(keep.fromMs) + 1, at(keep.toMs)));
  }
  const durationMs = Math.round((clip.length / RATE) * 1000);
  if (durationMs > MAX_MS) throw new Error(tooLong);

  // Even out the level so a quiet voicemail isn't a whisper (without blasting the hiss).
  const gain = Math.min(4, 0.89 / peak);
  const pcm = new Int16Array(clip.length);
  for (let i = 0; i < clip.length; i++) {
    const s = Math.max(-1, Math.min(1, clip[i] * gain));
    pcm[i] = s < 0 ? s * 32768 : s * 32767;
  }

  // 192 kbps: the quality ElevenLabs asks for, to learn a voice from.
  const encoder = new Mp3Encoder(1, RATE, 192);
  const parts: BlobPart[] = [];
  const block = 1152 * 16;
  for (let i = 0; i < pcm.length; i += block) {
    const buf = encoder.encodeBuffer(pcm.subarray(i, i + block));
    if (buf.length) parts.push(new Uint8Array(buf));
    if (i % (block * 64) === 0) {
      onProgress?.(i / pcm.length);
      await new Promise((r) => setTimeout(r)); // keep the page responsive
    }
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return { file: new File(parts, `${name.replace(/[^\w-]+/g, "-").slice(0, 40) || "recording"}.mp3`, { type: "audio/mpeg" }), durationMs };
}

/** "1:05" */
export function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

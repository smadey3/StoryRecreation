// A family video's sound, taken out of it on the phone: an iPhone's QuickTime movie is read for its AAC sound alone
// and packed as a plain .m4a, the sound that plays is the one taken, a video without sound says so, anything else is
// left to the browser to open whole, just part of it can be taken, and one far away is read a piece at a time. And a
// recording longer than 20 minutes asks which part to keep.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mp4Sound, type Source } from "@/lib/client/videoSound";
import { prepareRecording, TooLong } from "@/lib/client/audio";

// Made with ffmpeg: a second of a little picture with a tone, as a QuickTime movie (its sound described the old
// QuickTime way, in a 'wave' box, its tables after the picture); the same with an ALAC sound first and the AAC one
// set to play; with no sound; with only ALAC; and the first one's sound copied out by ffmpeg on its own.
const DIR = "tests/fixtures/videos";
const bytesOf = (name: string) => fs.readFileSync(path.join(DIR, name));
const blobOf = (name: string) => new Blob([bytesOf(name)]);

/** The boxes at the top of a file, and what's inside each. */
function top(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    out.set(bytes.toString("latin1", at + 4, at + 8), bytes.subarray(at + 8, at + size));
    at += size;
  }
  return out;
}

async function soundOf(name: string) {
  const found = await mp4Sound(blobOf(name));
  assert.ok(found && found !== "silent", `${name} has its sound found`);
  const sound = await found.read();
  return { durationMs: found.durationMs, type: sound.type, bytes: Buffer.from(await sound.arrayBuffer()) };
}

const ffmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("an iPhone's video: its sound alone, the very AAC it was recorded in, as an .m4a", async () => {
  const { durationMs, type, bytes } = await soundOf("iphone.mov");
  assert.equal(durationMs, 1021);
  assert.equal(type, "audio/mp4");
  const boxes = top(bytes);
  assert.deepEqual([...boxes.keys()], ["ftyp", "moov", "mdat"]);
  assert.equal(boxes.get("ftyp")!.toString("latin1", 0, 4), "M4A ");
  assert.deepEqual(boxes.get("mdat"), top(bytesOf("iphone-sound.m4a")).get("mdat"), "the same sound ffmpeg copies out of it");
});

test("the .m4a plays through, sounding just as the video did", { skip: !ffmpeg && "ffmpeg isn't installed here" }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-video-")), "sound.m4a");
  fs.writeFileSync(file, (await soundOf("iphone.mov")).bytes);
  const pcm = (input: string) => execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", input, "-map", "0:a", "-f", "s16le", "-"]);
  const ours = pcm(file);
  const video = pcm(path.join(DIR, "iphone.mov"));
  // The video's own list of edits skips the 1024 samples the encoder begins with (here, in stereo); the .m4a keeps them.
  assert.equal(ours.length, video.length + 1024 * 2 * 2);
  assert.ok(ours.subarray(1024 * 2 * 2).equals(video));
});

test("with more than one sound, the AAC one that plays", async () => {
  // its ALAC sound is a second long; the AAC one, set to play, 0.6 seconds
  assert.equal((await soundOf("two-sounds.mov")).durationMs, 623);
});

test("a video with no sound says so", async () => {
  assert.equal(await mp4Sound(blobOf("no-sound.mov")), "silent");
});

test("anything else is left to the browser to open whole", async () => {
  const movie = bytesOf("iphone.mov");
  for (const [what, blob] of [
    ["a video whose sound isn't AAC", blobOf("alac.mov")],
    ["an MP3", new Blob([Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000ÿû\u0090d", "latin1")])],
    ["a WebM", new Blob([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01])])],
    ["nothing at all", new Blob([])],
    ["a movie cut off before its tables", new Blob([movie.subarray(0, movie.length - 200)])],
  ] as const) {
    assert.equal(await mp4Sound(blob), null, what);
  }
});

test("just part of it: the samples in that stretch, and nothing either side", async () => {
  const found = await mp4Sound(blobOf("iphone.mov"));
  assert.ok(found && found !== "silent");
  const part = await found.read({ fromMs: 250, toMs: 750 });
  const again = await mp4Sound(part);
  assert.ok(again && again !== "silent");
  // cut where its pieces of sound begin, 1024 samples (21 ms) apart
  assert.ok(Math.abs(again.durationMs - 500) <= 22, `${again.durationMs} ms`);
  await assert.rejects(found.read({ fromMs: 5000, toMs: 6000 }), /no sound in that part/);
});

test("a file far away is read a piece at a time: its tables and its sound, never its picture", async () => {
  const bytes = bytesOf("iphone.mov");
  const asked: [number, number][] = [];
  // near: 0, so each run of sound is asked for on its own
  const far: Source = { size: bytes.length, near: 0, read: async (from, to) => (asked.push([from, to]), bytes.buffer.slice(bytes.byteOffset + from, bytes.byteOffset + to)) };
  const found = await mp4Sound(far);
  assert.ok(found && found !== "silent");
  const sound = Buffer.from(await (await found.read()).arrayBuffer());
  assert.deepEqual(top(sound).get("mdat"), top(bytesOf("iphone-sound.m4a")).get("mdat"));
  const fetched = asked.reduce((n, [from, to]) => n + to - from, 0);
  const moov = top(bytes).get("moov")!.length + 8;
  const sounds = top(sound).get("mdat")!.length;
  assert.ok(fetched <= moov + sounds + 16 * 4, `${fetched} bytes asked for, of ${bytes.length}`);
});

test("however close together its pieces of sound, a file is never read more than a little at a time", async () => {
  // As an iPhone keeps them: a little sound, then the picture, which a phone can't hold all of at once.
  const bytes = bytesOf("iphone.mov");
  const asked: number[] = [];
  const far: Source = { size: bytes.length, near: Infinity, most: 2000, read: async (from, to) => (asked.push(to - from), bytes.buffer.slice(bytes.byteOffset + from, bytes.byteOffset + to)) };
  const found = await mp4Sound(far);
  assert.ok(found && found !== "silent");
  asked.length = 0;
  const sound = Buffer.from(await (await found.read()).arrayBuffer());
  assert.ok(asked.length > 1 && Math.max(...asked) <= 2000, `read ${asked.join(", ")} bytes at a time`);
  assert.deepEqual(top(sound).get("mdat"), top(bytesOf("iphone-sound.m4a")).get("mdat"));
});

test("longer than 20 minutes: all its sound to choose from, then just the part chosen is opened", async (t) => {
  // A second of sound whose pieces each say they last 31¼ seconds: 25 minutes, as far as its tables go.
  const long = Buffer.from(bytesOf("iphone-sound.m4a"));
  const stts = long.indexOf("stts") + 4;
  for (let i = 0; i < long.readUInt32BE(stts + 4); i++) long.writeUInt32BE(1_500_000, stts + 12 + i * 8);
  const memo = new File([long], "Grandpa's stories.m4a", { type: "audio/mp4" });

  const given: Blob[] = [];
  const real = globalThis.OfflineAudioContext;
  t.after(() => void (globalThis.OfflineAudioContext = real));
  // No decoder here: it notes what it's given and answers with a second of tone.
  globalThis.OfflineAudioContext = class {
    decodeAudioData(bytes: ArrayBuffer) {
      given.push(new Blob([bytes]));
      const tone = Float32Array.from({ length: 44100 }, (_, i) => 0.5 * Math.sin(i / 10));
      return Promise.resolve({ length: tone.length, numberOfChannels: 1, getChannelData: () => tone });
    }
  } as unknown as typeof OfflineAudioContext;

  const err = await prepareRecording(memo, "Grandpa").catch((e: unknown) => e);
  assert.ok(err instanceof TooLong, String(err));
  assert.equal(err.durationMs, 1_500_000);
  assert.equal(err.sound.type, "audio/mp4");
  assert.equal(given.length, 0, "nothing opened before a part is chosen");

  const out = await prepareRecording(memo, "Grandpa", { within: { fromMs: 60_000, toMs: 120_000 } });
  assert.equal(out.file.type, "audio/mpeg");
  assert.equal(given.length, 1, "a minute is opened in one piece");
  const opened = await mp4Sound(given[0]);
  assert.ok(opened && opened !== "silent");
  // the minute, from the start of its first sample, and the few samples before it that a piece opens from
  assert.ok(opened.durationMs >= 60_000 && opened.durationMs <= 60_000 + 4 * 31_250, `opened ${opened.durationMs} ms of it`);
});

test("opened a piece at a time, the sound is just as it is opened whole, however the decoder starts", { skip: !ffmpeg && "ffmpeg isn't installed here" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-pieces-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Eight seconds of a voice-like warble in stereo, as an iPhone records it: AAC at 48 kHz.
  const file = path.join(dir, "warble.m4a");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=8,vibrato=f=5:d=0.5", "-ac", "2", "-c:a", "aac", "-b:a", "96k", file]);
  const found = await mp4Sound(new Blob([fs.readFileSync(file)]));
  assert.ok(found && found !== "silent");
  let n = 0;
  // ffmpeg as the decoder: every sample it's given comes out. Some decoders leave out the 2112 an encoder begins with.
  const decoder = (leaveOut: number) => async (m4a: Blob, rate: number) => {
    const piece = path.join(dir, `piece-${n++}.m4a`);
    fs.writeFileSync(piece, Buffer.from(await m4a.arrayBuffer()));
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", piece, "-f", "f32le", "-ar", String(rate), "-ac", "2", "-"], { maxBuffer: 64 * 1024 * 1024 });
    const all = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    const length = all.length / 2 - leaveOut;
    const channels = [0, 1].map((c) => Float32Array.from({ length }, (_, i) => all[(i + leaveOut) * 2 + c]));
    return { length, numberOfChannels: 2, getChannelData: (c: number) => channels[c] };
  };
  for (const leaveOut of [0, 2112]) {
    const whole = await found.open({ decode: decoder(leaveOut), pieceMs: 60_000 });
    const pieces = await found.open({ decode: decoder(leaveOut), pieceMs: 1000 });
    assert.equal(whole.rate, 48000);
    assert.equal(pieces.samples.length, whole.samples.length, `${leaveOut} left out: the same length`);
    const worst = pieces.samples.reduce((m, x, i) => Math.max(m, Math.abs(x - whole.samples[i])), 0);
    assert.ok(worst < 1e-5, `${leaveOut} left out: differs by up to ${worst}`);
    // and part of it, in pieces, is that stretch of the whole
    const part = await found.open({ part: { fromMs: 2000, toMs: 5000 }, decode: decoder(leaveOut), pieceMs: 700 });
    // from its first sample at or after 2 s (the whole, opened from the very start, is short what was left out)
    const from = Math.ceil((2000 * 48) / 1024) * 1024 - leaveOut;
    const off = part.samples.reduce((m, x, i) => Math.max(m, Math.abs(x - whole.samples[from + i])), 0);
    assert.ok(Math.abs(part.samples.length - 3000 * 48) <= 1024 && off < 1e-5, `${leaveOut} left out: the part differs by up to ${off}`);
  }
});

// A family video's sound, taken out of it on the phone: an iPhone's QuickTime movie is read for its AAC sound alone
// and packed as a plain .m4a, the sound that plays is the one taken, a video without sound says so, and anything
// else is left to the browser to open whole.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { soundOfVideo } from "@/lib/client/videoSound";

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
  const found = await soundOfVideo(blobOf(name));
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
  assert.equal(await soundOfVideo(blobOf("no-sound.mov")), "silent");
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
    assert.equal(await soundOfVideo(blob), null, what);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChime, chimeDuration } from "@/lib/shared/chime";
import { demoVoiceClip, encodeMp3, mixStory, SAMPLE_RATE } from "@/lib/server/audio";
import { wordsFromAlignment } from "@/lib/server/performer";

test("chimes are gentle, bounded and the right length", () => {
  for (const style of ["bell", "sparkle", "windchime"] as const) {
    const c = renderChime(style, SAMPLE_RATE, 0.5);
    assert.equal(c.length, Math.ceil(chimeDuration(style) * SAMPLE_RATE));
    const peak = c.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    assert.ok(Math.abs(peak - 0.5) < 1e-3, `${style} peak ${peak}`);
    assert.ok(Math.abs(c[c.length - 1]) < 1e-4, `${style} ends in silence`);
  }
});

test("the mix puts a chime between pages, never after the last", async () => {
  const clip = (n: number) => demoVoiceClip([{ speaker: "narrator", text: "one two three four ".repeat(n), voiceId: "v" }]);
  const { samples, timeline } = await mixStory({
    pages: [1, 2, 3].map((page) => ({ page, clip: clip(page) })),
    chime: { enabled: true, style: "bell", gapSeconds: 3 },
  });
  assert.equal(timeline.pages.length, 3);
  const [p1, p2, p3] = timeline.pages;
  assert.ok(p1.chimeAt! > p1.speechEnd, "chime after speech");
  assert.ok(p2.start >= p1.chimeAt! + 3, "a real pause to turn the page");
  assert.equal(p3.chimeAt, null);
  assert.equal(p1.next, p2.start);
  assert.ok(Math.abs(timeline.duration - samples.length / SAMPLE_RATE) < 1e-6);
  // word timings are absolute and inside their page
  for (const p of timeline.pages) for (const w of p.words) assert.ok(w.t >= p.start && w.e <= p.speechEnd + 0.01);
  assert.ok(samples.every((s) => Math.abs(s) <= 1));
});

test("intro rings the chime once as a demonstration", async () => {
  const c = demoVoiceClip([{ speaker: "narrator", text: "hello there", voiceId: "v" }]);
  const { timeline } = await mixStory({
    pages: [{ page: 1, clip: c }],
    intro: { before: c, after: c },
    chime: { enabled: true, style: "sparkle", gapSeconds: 2 },
  });
  assert.equal(timeline.pages[0].page, 0);
  assert.ok(timeline.pages[0].chimeAt! > timeline.pages[0].start);
  assert.equal(timeline.pages[1].page, 1);
});

test("mp3 encoding produces a playable stream", async () => {
  const c = demoVoiceClip([{ speaker: "narrator", text: "a little test of the encoder", voiceId: "v" }]);
  const mp3 = await encodeMp3(c.samples);
  assert.ok(mp3.length > 1000);
  // MPEG audio frame sync
  assert.equal(mp3[0], 0xff);
  assert.equal(mp3[1] & 0xe0, 0xe0);
});

test("alignment becomes words and skips delivery tags", () => {
  const text = "[whispers] Hush now, little owl.";
  const chars = [...text];
  const words = wordsFromAlignment(
    {
      characters: chars,
      characterStartTimesSeconds: chars.map((_, i) => i * 0.05),
      characterEndTimesSeconds: chars.map((_, i) => i * 0.05 + 0.04),
    },
    () => "narrator",
  );
  assert.deepEqual(
    words.map((w) => w.w),
    ["Hush", "now,", "little", "owl."],
  );
  assert.ok(words[0].t > 0.4, "timing starts after the tag");
});

test("words never run together across two lines of a dialogue", () => {
  // A dialogue's lines come back joined with nothing between them.
  const lines = ["And you can draw me!", "Floss blinked."];
  const chars = [...lines.join("")];
  const lineAt = (i: number) => (i < lines[0].length ? 0 : 1);
  const words = wordsFromAlignment(
    {
      characters: chars,
      characterStartTimesSeconds: chars.map((_, i) => i * 0.05),
      characterEndTimesSeconds: chars.map((_, i) => i * 0.05 + 0.04),
    },
    (i) => (lineAt(i) === 0 ? "mia" : "narrator"),
    lineAt,
  );
  assert.deepEqual(
    words.map((w) => w.w),
    ["And", "you", "can", "draw", "me!", "Floss", "blinked."],
  );
  assert.equal(words[5].speaker, "narrator", "each word is the right speaker's");
});

test("putting a long story together gives way to the rest of the app as it goes", async () => {
  // About six minutes of story, mixed and made into an MP3, while a timer ticks every 10 ms.
  const clip = (seconds: number) => ({ samples: new Float32Array(24000 * seconds).map((_, i) => Math.sin(i / 9) * 0.2), words: [] });
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  const began = Date.now();
  try {
    const { samples } = await mixStory({ pages: [1, 2, 3, 4, 5, 6].map((page) => ({ page, clip: clip(60) })), chime: { enabled: true, style: "bell", gapSeconds: 3 } });
    await encodeMp3(samples);
  } finally {
    clearInterval(ticker);
  }
  const took = Date.now() - began;
  // The timer kept ticking throughout: it never waited more than a moment for its turn.
  assert.ok(ticks >= (took / 10) * 0.5, `${ticks} ticks in ${took} ms`);
});

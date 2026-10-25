// Waits that tell the truth: each finished job's time is kept beside its rule of thumb, and later waits go at the
// pace the last dozen really went, with a little to spare. While a story is written, the wait is until it's ready
// to hear: the writing, then the voices.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Story } from "@/lib/shared/types";

before(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-timing-test-"));
  // Real storyteller and voices (nothing is sent: only the estimates are worked out).
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
});

test("until three are timed the rule of thumb stands; then the waits go at the real pace, with a little to spare", async () => {
  const { paceOf, expectedSeconds, noteWorkTime } = await import("@/lib/server/timing");
  assert.equal(paceOf("sketching"), 1);
  assert.equal(expectedSeconds("sketching", 50), 50);

  const ago = (seconds: number) => Date.now() - seconds * 1000;
  noteWorkTime("sketching", 50, ago(100));
  noteWorkTime("sketching", 50, ago(100));
  assert.equal(paceOf("sketching"), 1, "two aren't enough to go by");
  noteWorkTime("sketching", 50, ago(100));
  // Each took twice its rule of thumb: 2, and a fifth more to spare.
  assert.ok(Math.abs(paceOf("sketching") - 2.4) < 0.01, String(paceOf("sketching")));
  assert.equal(expectedSeconds("sketching", 50), 120);

  // Other work keeps its own pace.
  assert.equal(paceOf("drawing"), 1);
});

test("a job that stalled counts for no more than four times its rule of thumb, and only the latest dozen count", async () => {
  const { paceOf } = await import("@/lib/server/timing");
  const { saveWorkTime, recentWorkTimes } = await import("@/lib/server/db");
  saveWorkTime("planning", 30, 30);
  saveWorkTime("planning", 30, 30);
  saveWorkTime("planning", 30, 3000); // a service having a very slow day
  // (30 + 30 + 120) / 90 = 2, and a fifth more.
  assert.ok(Math.abs(paceOf("planning") - 2.4) < 0.01, String(paceOf("planning")));

  for (let i = 0; i < 12; i++) saveWorkTime("planning", 30, 15);
  // The stall has fallen out of the latest dozen: half the rule of thumb, and a fifth more.
  assert.ok(Math.abs(paceOf("planning") - 0.6) < 0.01, String(paceOf("planning")));
  for (let i = 0; i < 60; i++) saveWorkTime("planning", 30, 15);
  assert.equal(recentWorkTimes("planning", 100).length, 50, "only the latest 50 are kept");

  // However fast or slow it's gone, the pace stays between half and five times the rule of thumb.
  for (let i = 0; i < 12; i++) saveWorkTime("drawing", 100, 1);
  assert.equal(paceOf("drawing"), 0.5);
});

test("while a story is written, the wait shown is until it's ready to hear: the writing, then the voices", async () => {
  const { readyInSeconds } = await import("@/lib/server/jobs");
  const { saveWorkTime } = await import("@/lib/server/db");
  const { defaultSettings } = await import("@/lib/shared/options");
  const story = (settings: Partial<Story["settings"]>) =>
    ({ id: "s1", bookId: "b1", mode: "create", settings: defaultSettings({ source: "idea", length: "medium", ...settings }) }) as Story;

  // A medium story: about 2 minutes to write, then about 6 minutes of listening, voiced with a welcome.
  assert.equal(readyInSeconds(story({ review: false }), 120), 120 + 133);
  // Read over before the voices record it: the wait is just the writing.
  assert.equal(readyInSeconds(story({ review: true }), 120), 120);
  // Sound effects to choose and make add a little.
  assert.equal(readyInSeconds(story({ review: false, effects: true }), 120), 120 + 183);

  // Once the voices have been timed going slower than the rule of thumb, the wait says so.
  for (let i = 0; i < 3; i++) saveWorkTime("recording", 100, 150);
  assert.equal(readyInSeconds(story({ review: false }), 120), 120 + Math.round(133 * 1.8));
});

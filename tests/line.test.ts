// The line for the voices: the story started first goes first, whoever asks on its behalf, a few at a time; a story
// waiting with nothing being made for it can say where it stands, and the time it waits isn't counted as making it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Line, forStory } from "@/lib/server/line";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the story started first has its turns first, a few at a time and never more", async () => {
  const line = new Line(() => 2, 1);
  const order: string[] = [];
  let atOnce = 0;
  let most = 0;
  const turn = (name: string) =>
    line.run(async () => {
      most = Math.max(most, ++atOnce);
      order.push(name);
      await pause(15);
      atOnce--;
    });
  // A later story asks first, an earlier one after it: the earlier one still goes first.
  const later = forStory({ story: "later", since: 2000 }, () => Promise.all([turn("later 1"), turn("later 2"), turn("later 3"), turn("later 4")]));
  const earlier = forStory({ story: "earlier", since: 1000 }, () => Promise.all([turn("earlier 1"), turn("earlier 2"), turn("earlier 3")]));
  await Promise.all([later, earlier]);
  assert.equal(most, 2);
  // The first two turns were free to take; after them, every turn of the earlier story comes before the rest of the later one's.
  assert.deepEqual(order, ["later 1", "later 2", "earlier 1", "earlier 2", "earlier 3", "later 3", "later 4"]);
});

test("a story waiting with nothing being made says where it stands, and how long it waited", async () => {
  const line = new Line(() => 1, 4);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const first = forStory({ story: "first", since: 1 }, () => line.run(() => held));
  const second = forStory({ story: "second", since: 2 }, () => Promise.all([line.run(async () => undefined), line.run(async () => undefined)]));
  const third = forStory({ story: "third", since: 3 }, () => line.run(async () => undefined));
  await pause(30);

  assert.equal(line.placeOf("first"), null, "being made, so not waiting");
  assert.deepEqual(line.placeOf("second"), { ahead: 0, seconds: 4 }, "next in line, one turn away");
  assert.deepEqual(line.placeOf("third"), { ahead: 1, seconds: 12 }, "behind the second story's two turns");
  assert.ok(line.waitedSeconds("second") >= 0.025, String(line.waitedSeconds("second")));
  assert.equal(line.waitedSeconds("first"), 0);

  release();
  await Promise.all([first, second, third]);
  const waited = line.waitedSeconds("second");
  await pause(20);
  assert.equal(line.waitedSeconds("second"), waited, "no longer counting once it's had its turns");
  assert.equal(line.placeOf("second"), null);
  line.forget("second");
  assert.equal(line.waitedSeconds("second"), 0);
});

test("a story that has a turn under way isn't counted as waiting, though more of its turns are", async () => {
  const line = new Line(() => 1, 1);
  const story = forStory({ story: "busy", since: 1 }, () => Promise.all([line.run(() => pause(40)), line.run(async () => undefined)]));
  await pause(15);
  assert.equal(line.placeOf("busy"), null);
  assert.equal(line.waitedSeconds("busy"), 0);
  await story;
});

test("places in line are said the way people say them", async () => {
  const { ordinal } = await import("@/lib/server/jobs");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
});

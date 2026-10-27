// Kept for children, when the storyteller can't be asked (no Anthropic key, or it's unreachable): a plain screen of
// unmistakable words stands in, and leaves alone what only sounds alike.

import { test } from "node:test";
import assert from "node:assert/strict";

test("without the storyteller, unmistakable words are turned down, and nothing else is", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { forChildren } = await import("@/lib/server/guard");
  const no = async (text: string) => {
    const verdict = await forChildren([{ label: "Story idea", text }]);
    return verdict.forChildren ? null : verdict.kind;
  };
  assert.equal(await no("A fox who gets drunk on vodka"), "drugs, alcohol or smoking");
  assert.equal(await no("Make it sexy"), "grown-up or sexual content");
  assert.equal(await no("then she wants to kill herself"), "self-harm or suicide");
  assert.equal(await no("the bear says shit a lot"), "swearing");
  // what only sounds alike is left to the storyteller's own rules
  assert.equal(await no("A bear who works at the drugstore and gives medicine to sick animals"), null);
  assert.equal(await no("Sixteen sheep in Essex"), null);
  assert.equal(await no("A pirate who loves root beer"), null);
  assert.equal(await no(""), null);
});

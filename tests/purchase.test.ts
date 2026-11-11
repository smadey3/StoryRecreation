// Buying pictures: the price said yes to is the one shown, to the cent (a picture's price moves by fractions of a
// cent as pictures are drawn, so the page and the server can differ by a sliver); a real change is turned back with
// the new price, which the page shows and approves next, so a grown-up is never asked again and again.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

before(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-purchase-test-"));
});

test("a price that moved by a sliver is the price said yes to; a real change comes back with the new price", async () => {
  const { approvePurchase } = await import("@/lib/server/spending");
  const { HttpError } = await import("@/lib/server/auth");
  // A grown-up on a device that has the PIN entered lately: a tap is the yes.
  const ctx = { household: { id: "h", pin_hash: "x" }, grownup: true } as never;
  const price = 7 * 119_900; // 83.93¢ ("84¢"), as the server works it out now

  // The page loaded when a picture was 11.95¢: it showed and sent 83.65¢ (also "84¢")
  assert.doesNotThrow(() => approvePurchase(ctx, { micros: 7 * 119_500 }, price));
  assert.doesNotThrow(() => approvePurchase(ctx, { micros: price }, price));

  // A real change (80¢ shown, 84¢ now): said, with the new price for the page to show and approve
  const err = (() => {
    try {
      approvePurchase(ctx, { micros: 800_000 }, price);
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 409);
  assert.equal(err.code, "price_changed");
  assert.equal(err.message, "The price has changed to 84¢. Please look again before saying yes.");
  assert.deepEqual(err.details, { price });
  // ...and the page's next yes, with that price, goes through
  assert.doesNotThrow(() => approvePurchase(ctx, { micros: err.details!.price as number }, price));
  // nothing said yes to at all is still turned down
  assert.throws(() => approvePurchase(ctx, {}, price), /price has changed/);
});

test("the price that changed reaches the page beside the message", async () => {
  const { route, HttpError } = await import("@/lib/server/auth");
  const res = await route(async () => {
    throw new HttpError(409, "The price has changed to 84¢.", "price_changed", { price: 840_091 });
  })();
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { price: 840_091, error: "The price has changed to 84¢.", code: "price_changed" });
});

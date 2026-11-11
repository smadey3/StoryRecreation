// Picture books: what pictures cost and how that's shown, the purchase a grown-up approves with the PIN,
// the picture plan and the illustrator's prompts, and drawing a book on a fake Google that stays within
// the approved price.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { StoryArt, StoryScript } from "@/lib/shared/types";

// A 1×1 PNG: what the fake Google draws.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let mode: "ok" | "forbidden" | "blocked" = "ok";
const asked: { headers: http.IncomingHttpHeaders; url: string; body: Record<string, any> }[] = [];
// A picture whose prompt has one of these in it comes back empty, once (as Google's sometimes do).
const emptyOnce = new Set<string>();
let server: http.Server;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-pictures-test-"));
  process.env.ART_RETRY_PAUSE_MS = "0";
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      asked.push({ headers: req.headers, url: req.url ?? "", body });
      res.setHeader("Content-Type", "application/json");
      if (mode === "forbidden") {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: { message: "API key not valid.", status: "PERMISSION_DENIED" } }));
      }
      if (mode === "blocked") {
        return res.end(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 500 } }));
      }
      const prompt: string = body.contents?.[0]?.parts?.at(-1)?.text ?? "";
      const empty = [...emptyOnce].find((k) => prompt.includes(k));
      if (empty) {
        emptyOnce.delete(empty);
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "OTHER" }], usageMetadata: { promptTokenCount: 500 } }));
      }
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 1680 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

/** What one picture from the fake Google costs on Nano Banana 2.1: 1,680 tokens out at $30 a million, 3,000 in at 50¢ a million. */
const DRAWN = 1680 * 30 + 3000 * 0.5;
/** What an empty reply costs: the 500 tokens it read. */
const EMPTY = 500 * 0.5;

test("money is shown rounded up, so it's never less than it can cost", async () => {
  const { formatMoney } = await import("@/lib/shared/art");
  assert.equal(formatMoney(0), "free");
  assert.equal(formatMoney(0, "$0"), "$0");
  assert.equal(formatMoney(50_400), "6¢");
  assert.equal(formatMoney(1_000_000), "$1.00");
  assert.equal(formatMoney(1_234_567), "$1.24");
});

test("waits are told in plain words: about how long, and when it's taking longer than usual", async () => {
  const { drawingSeconds, planningSeconds } = await import("@/lib/shared/art");
  const { aboutTime, timeLeft } = await import("@/lib/shared/options");
  assert.equal(aboutTime(5), "a few seconds");
  assert.equal(aboutTime(32), "about 30 seconds");
  assert.equal(aboutTime(70), "about a minute");
  assert.equal(aboutTime(125), "about 2 minutes");
  assert.equal(drawingSeconds(3, false, true), 50, "sketches, two at a time");
  assert.equal(drawingSeconds(8, true, true), 125, "the cover on its own, then the pages two at a time");
  assert.equal(drawingSeconds(8, true, false), 3, "stand-ins are quick");
  assert.equal(planningSeconds(true), 30);
  const start = 1_000_000;
  assert.equal(timeLeft(start, 60, start + 15_000), "about 50 seconds left");
  assert.equal(timeLeft(start, 60, start + 70_000), "almost done");
  assert.equal(timeLeft(start, 60, start + 100_000), "taking a little longer than usual");
  assert.equal(timeLeft(start, 60, start - 5_000), "about a minute left", "a clock a little behind the server's");
});

test("prices: Claude by the token, pictures by the picture, with a fair guess before any stories are written", async () => {
  const { claudeCost, picturePrice, pictureCost, writeCostGuess, planCostGuess } = await import("@/lib/server/prices");
  assert.equal(claudeCost("claude-opus-5-5", { input_tokens: 1000, output_tokens: 2000 }), 1000 * 4 + 2000 * 20);
  assert.equal(
    claudeCost("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 }),
    1000 * 4 * 1.25 + 1000 * 0.2,
  );
  assert.equal(claudeCost("claude-opus-4-8", { input_tokens: 1000, output_tokens: 0 }), 5000, "an older Opus at its own price");
  assert.equal(picturePrice("gemini-nano-banana-2.1"), 3680 * 30 + 10_000 * 0.5, "the picture, and room for the model's thinking");
  assert.ok(picturePrice("gemini-3-pro-image-preview") > picturePrice("gemini-nano-banana-2.1"), "the premium model costs more");
  assert.equal(pictureCost("gemini-nano-banana-2.1", { promptTokenCount: 3000, candidatesTokenCount: 1680 }), DRAWN);
  assert.ok(DRAWN <= picturePrice("gemini-nano-banana-2.1"), "a picture never costs more than its price");
  assert.ok(writeCostGuess("short") < writeCostGuess("medium") && writeCostGuess("medium") < writeCostGuess("long"));
  assert.ok(planCostGuess(800, 6) > 0);

  process.env.PICTURE_PRICE = "0.08";
  assert.equal(picturePrice("some-new-model"), 80_000, "a model the app doesn't know is priced by the family");
  delete process.env.PICTURE_PRICE;
});

test("a purchase is a grown-up's yes: the PIN on a locked device (remembered for 30 days if asked), and a price no lower than it can cost", async () => {
  const { createHousehold, createSession, getHousehold, getSession, setHouseholdPin } = await import("@/lib/server/db");
  const { hashSecret } = await import("@/lib/server/auth");
  const { approvePurchase } = await import("@/lib/server/spending");
  const id = createHousehold("The Gap Family", "gap@example.com", "hash");
  const sid = createSession(id, 60_000);
  const locked = () => ({ session: getSession(sid)!, household: getHousehold(id)!, profile: null, grownup: false });
  const unlocked = () => ({ ...locked(), grownup: true });
  const code = (fn: () => void) => {
    try {
      fn();
      return "approved";
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };
  const minutesLeft = () => Math.round((getSession(sid)!.grownup_until - Date.now()) / 60_000);
  assert.equal(code(() => approvePurchase(unlocked(), { micros: 100 }, 100)), "pin_needed", "without a PIN, one is chosen first");
  setHouseholdPin(id, hashSecret("2468"));
  assert.equal(code(() => approvePurchase(locked(), { micros: 100 }, 100)), "pin_required", "a locked device asks for the PIN");
  assert.equal(code(() => approvePurchase(locked(), { pin: "1111", micros: 100 }, 100)), "wrong_pin");
  assert.equal(getHousehold(id)!.pin_digits, null, "a PIN from before lengths were kept, not entered right yet");
  assert.equal(code(() => approvePurchase(locked(), { pin: "2468", micros: 990_000 }, 1_000_000)), "price_changed", "never more than was approved (99¢ shown, $1.00 now)");
  assert.equal(getHousehold(id)!.pin_digits, 4, "entered right once: its length is kept, so the pad checks it as soon as it's all in");
  assert.equal(code(() => approvePurchase(locked(), { pin: "2468", micros: 100 }, 100)), "approved");
  assert.equal(minutesLeft(), 30, "the PIN unlocks this device for half an hour");
  assert.equal(code(() => approvePurchase(unlocked(), { micros: 100 }, 100)), "approved", "then a yes is enough here: no PIN again");
  assert.equal(code(() => approvePurchase(unlocked(), { micros: 990_000 }, 1_000_000)), "price_changed");
  assert.equal(code(() => approvePurchase(locked(), { pin: "2468", micros: 100, remember: true }, 100)), "approved");
  assert.equal(Math.round(minutesLeft() / 60 / 24), 30, "\"don't ask again on this device for 30 days\"");
  approvePurchase(locked(), { pin: "2468", micros: 100 }, 100);
  assert.equal(Math.round(minutesLeft() / 60 / 24), 30, "entering it again never shortens a remembered device");

  setHouseholdPin(id, hashSecret("135790"), 6);
  assert.equal(getHousehold(id)!.pin_digits, 6);
  setHouseholdPin(id, null, 6);
  assert.equal(getHousehold(id)!.pin_digits, null, "no PIN, no length");
});

const script: StoryScript = {
  title: "The Tooth Fairy Who Was Actually a Giant",
  synopsis: "Mia discovers who really collects her teeth.",
  ambience: "",
  cast: [
    { id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: "v1" },
    { id: "mia", name: "Mia", description: "a girl who just lost a tooth", voiceBrief: "", voiceId: "v2" },
    { id: "fairy", name: "Gwendolyn", description: "the tooth fairy", voiceBrief: "", voiceId: "v3" },
  ],
  pages: [1, 2, 3].map((page) => ({ page, picture: `Page ${page}`, lines: [{ speaker: "narrator", text: `Words for page ${page}.` }] })),
};

test("the picture plan keeps its promises: real characters, a few main ones, every page planned", async () => {
  const { cleanPicturePlan } = await import("@/lib/server/storyteller");
  const plan = cleanPicturePlan(script, {
    characters: [
      { id: "narrator", name: "Narrator", look: "", main: true },
      { id: "Fairy", name: "Gwendolyn", look: "a giant, green and lumpy, with a coin purse the size of a bathtub", main: true },
      { id: "fairy", name: "Gwendolyn again", look: "", main: true },
      { id: "mia", name: "Mia", look: "", main: true },
      ...["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase(), look: "", main: true })),
    ],
    cover: "  Mia peeking at a giant shadow.  ",
    pages: [
      { page: 1, scene: "Mia puts her tooth under the pillow.", characters: ["mia", "nobody"] },
      { page: 3, scene: "The giant fairy waves goodbye.", characters: ["fairy", "mia"] },
    ],
  });
  assert.deepEqual(plan.characters.map((c) => c.id), ["fairy", "mia", "a", "b", "c", "d"], "no narrator, no repeats");
  assert.equal(plan.characters.filter((c) => c.main).length, 4, "at most four are sketched");
  assert.equal(plan.cover, "Mia peeking at a giant shadow.");
  assert.deepEqual(plan.pages.map((p) => p.page), [1, 2, 3], "every page has a picture planned");
  assert.deepEqual(plan.pages[0].characters, ["mia"], "only characters who exist");
  assert.equal(plan.pages[1].scene, "Page 2", "a page the plan missed falls back to the storyteller's note");
});

test("the illustrator's prompts: sketches from a description or a child's drawing, pages from the chosen sketches and the cover", async () => {
  const { characterPrompt, sceneRequest, undrawn } = await import("@/lib/server/art");
  const fairy = { id: "fairy", name: "Gwendolyn", look: "a giant, green and lumpy", main: true, drawing: null, sketches: [], chosen: null };
  const mia = { ...fairy, id: "mia", name: "Mia", look: "curly hair and a gap in her smile" };
  assert.match(characterPrompt(fairy, "watercolor", false), /^Art style, the most important instruction of all: a traditional watercolor.*Gwendolyn, a giant, green and lumpy\..*white watercolor paper.*No words/);
  assert.match(characterPrompt(fairy, "watercolor", true), /child's own drawing of Gwendolyn.*made in that art style.*Keep the child's design/);
  // Every style is its own: what it looks like up close, and where a character stands for its sketch.
  const { ART_STYLES } = await import("@/lib/shared/art");
  const styles = Object.keys(ART_STYLES) as (keyof typeof ART_STYLES)[];
  const sketches = styles.map((style) => characterPrompt(fairy, style, false));
  assert.equal(new Set(sketches).size, styles.length);
  for (const [i, style] of styles.entries()) {
    assert.ok(sketches[i].startsWith(`Art style, the most important instruction of all: ${ART_STYLES[style].prompt}.`), `${style} comes first`);
    assert.ok(sketches[i].includes(`alone ${ART_STYLES[style].alone}`), `${style} sets its own background`);
  }
  assert.match(characterPrompt(fairy, "papercut", false), /scissor-cut edges.*plain sheet of colored card/);

  const sketch = { data: PNG, mime: "image/png", label: "Gwendolyn" };
  const cover = { data: PNG, mime: "image/png", label: "the cover" };
  const page = sceneRequest({
    title: "The Giant Tooth Fairy",
    page: 2,
    scene: "Gwendolyn tiptoes past the bed.",
    characters: [fairy, mia],
    sketches: new Map([["fairy", sketch]]),
    cover,
    style: "watercolor",
    mood: "silly",
    note: "make her even lumpier",
    seed: "x",
  });
  assert.equal(page.references.length, 2, "Gwendolyn's sketch, then the cover");
  assert.equal(page.aspect, "4:3");
  assert.match(page.prompt, /^Art style, the most important instruction of all: a traditional watercolor/, "the style comes first on every page too");
  assert.match(page.prompt, /page 2 of the picture book "The Giant Tooth Fairy", in that art style/);
  assert.match(page.prompt, /Gwendolyn looks exactly like reference picture 1/);
  assert.match(page.prompt, /Mia: curly hair and a gap in her smile/, "a character without a sketch is described");
  assert.match(page.prompt, /Match the art style and palette of the cover \(reference picture 2\)\./, "its style, not its lighting: a page can be another time of day");
  assert.match(page.prompt, /Whatever the scene, the whole picture is in the art style above: a traditional watercolor/, "and the style said again, last");
  assert.doesNotMatch(page.prompt, /another page of this same book/, "no page drawn yet, none shown");
  const later = sceneRequest({ ...page, title: "The Giant Tooth Fairy", page: 4, scene: "s", characters: [fairy, mia], sketches: new Map([["fairy", sketch]]), cover, earlier: sketch, style: "watercolor", mood: "silly", seed: "w" });
  assert.equal(later.references.length, 3, "Gwendolyn's sketch, the cover, then a page already drawn");
  assert.match(later.prompt, /Reference picture 3 is another page of this same book: make this picture look made exactly the same way/);
  assert.match(page.prompt, /The family asked for this change: make her even lumpier/);
  const front = sceneRequest({ title: "T", page: 0, scene: "s", characters: [fairy], sketches: new Map(), cover, style: "shadow", mood: "heartwarming", seed: "y" });
  assert.equal(front.references.length, 0, "the cover isn't drawn from itself");
  assert.match(front.prompt, /front cover/);
  assert.doesNotMatch(front.prompt, /every picture in this book/, "no note for the book, nothing said");

  // A note for the whole book ("make it daytime") goes with every picture, ahead of what its scene says.
  const daytime = { title: "T", scene: "On a spooky moonlit mountainside", characters: [fairy], sketches: new Map(), cover, style: "papercut" as const, mood: "heartwarming" as const, bookNote: "Make it daytime.", seed: "z" };
  for (const p of [sceneRequest({ ...daytime, page: 0 }), sceneRequest({ ...daytime, page: 3 }), sceneRequest({ ...daytime, page: 3, note: "add a rainbow" })]) {
    assert.match(p.prompt, /For every picture in this book, the family asked: Make it daytime\. Where the scene above says otherwise, this comes first\./);
  }
  assert.match(sceneRequest({ ...daytime, page: 3, note: "add a rainbow" }).prompt, /this comes first\. The family asked for this change: add a rainbow/, "and a redraw's own note after it");

  const art = { cover: null, pages: ["stories/x/art/page-01.png", null, null] } as unknown as StoryArt;
  assert.deepEqual(undrawn(art), [0, 2, 3]);
});

test("stand-in pictures: clearly pretend, the words wrapped and escaped", async () => {
  const { standInPicture, wrapWords } = await import("@/lib/server/illustrator");
  assert.deepEqual(wrapWords("one two three four five six", 9, 2), ["one two", "three…"]);
  assert.deepEqual(wrapWords("short", 20, 3), ["short"]);
  const svg = standInPicture({ aspect: "4:3", standIn: { heading: "Page 1", caption: "Mia & the <giant>", style: "watercolor", seed: "a" } });
  assert.match(svg, /^<svg[^>]+viewBox="0 0 1200 900"/);
  assert.match(svg, /Mia &amp; the &lt;giant&gt;/);
  assert.match(svg, /Stand-in picture/);
  assert.doesNotMatch(svg, /<script/);
});

/** A picture book ready to draw: planned, with Gwendolyn's sketch chosen. */
async function pictureBook(title: string) {
  const { createHousehold, createBook, createStory, updateStory, changeStoryArt } = await import("@/lib/server/db");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { newArt } = await import("@/lib/server/art");
  const { householdDir } = await import("@/lib/server/files");
  const household = createHousehold(title, `${title.replace(/\W+/g, "").toLowerCase()}@example.com`, "hash");
  const book = createBook(household, { title, kind: "idea" });
  const story = createStory(household, { bookId: book, profileId: null, mode: "create", title, settings: defaultSettings({ source: "idea", pictures: true }), status: "ready" });
  updateStory(story, { script });
  const sketch = `stories/${story}/art/sketch-fairy-1.png`;
  fs.mkdirSync(path.join(householdDir(household), `stories/${story}/art`), { recursive: true });
  fs.writeFileSync(path.join(householdDir(household), sketch), PNG);
  changeStoryArt(story, () => ({
    ...newArt("watercolor", 3),
    characters: [
      { id: "fairy", name: "Gwendolyn", look: "a giant, green and lumpy", main: true, drawing: null, sketches: [sketch], chosen: 0 },
      { id: "mia", name: "Mia", look: "curly hair", main: false, drawing: null, sketches: [], chosen: null },
    ],
    coverScene: "Mia and Gwendolyn under the moon.",
    scenes: [1, 2, 3].map((page) => ({ page, scene: `Scene ${page}`, characters: ["fairy", "mia"] })),
  }));
  return { household, book, story };
}

async function untilDrawn(story: string) {
  const { artBusy } = await import("@/lib/server/art");
  for (let i = 0; i < 200 && artBusy(story); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(artBusy(story), false, "the illustrator finished");
}

test("drawing a book: the cover first, then each page from the chosen sketch and the cover, within the approved price", async () => {
  process.env.GEMINI_API_KEY = "test-google-key";
  mode = "ok";
  asked.length = 0;
  const { getStoryArt, getBook } = await import("@/lib/server/db");
  const { startDrawing } = await import("@/lib/server/art");
  const { recordSpend, getPurchase, spendingSummary } = await import("@/lib/server/spending");
  const { picturePrice } = await import("@/lib/server/prices");
  const { householdDir } = await import("@/lib/server/files");
  const { household, book, story } = await pictureBook("The Giant Tooth Fairy");

  const approved = picturePrice() * 4;
  const purchase = recordSpend(household, { storyId: story, service: "pictures", kind: "draw", what: "Drew the book", approved });
  assert.ok(startDrawing(story, [0, 1, 2, 3], purchase));
  assert.equal(startDrawing(story, [1], purchase), false, "one job at a time");
  const { startedAt, ...job } = getStoryArt(story)!.job!;
  assert.deepEqual(
    job,
    { kind: "drawing", targets: [0, 1, 2, 3], total: 4, finished: [], seconds: 75, purchaseId: purchase },
    "the family can see what's being drawn, and about how long it takes (and it can carry on after a restart)",
  );
  assert.ok(Math.abs(Date.now() - startedAt) < 5_000);
  await untilDrawn(story);

  const art = getStoryArt(story)!;
  assert.equal(art.error, null);
  assert.equal(art.job, null, "done: nothing at work");
  assert.ok(art.cover && art.pages.every(Boolean), "the cover and every page are drawn");
  for (const rel of [art.cover!, ...(art.pages as string[])]) assert.ok(fs.existsSync(path.join(householdDir(household), rel)));
  assert.deepEqual(getPurchase(purchase), { approved, spent: DRAWN * 4, pictures: 4 }, "what it really cost, within what was approved");
  assert.equal(spendingSummary(household).month.pictureCount, 4);
  assert.ok(getBook(household, book)!.coverUrl, "the book has its first picture book's cover");

  assert.equal(asked.length, 4);
  const first = asked[0];
  assert.match(first.url, /\/v1beta\/models\/gemini-nano-banana-2\.1:generateContent$/);
  assert.equal(first.headers["x-goog-api-key"], "test-google-key");
  assert.deepEqual(first.body.generationConfig, { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3", imageSize: "2K" } });
  const parts = (r: (typeof asked)[number]) => r.body.contents[0].parts as { text?: string; inlineData?: { mimeType: string } }[];
  assert.match(parts(first).at(-1)!.text!, /front cover/, "the cover comes first");
  assert.equal(parts(first).filter((p) => p.inlineData).length, 1, "drawn from Gwendolyn's sketch");
  for (const page of asked.slice(1)) {
    const n = Number(/page (\d) of/.exec(parts(page).at(-1)!.text!)![1]);
    // Pages 1 and 2 are drawn together, before any page is; page 3 after, beside a page already drawn.
    assert.equal(parts(page).filter((p) => p.inlineData).length, n === 3 ? 3 : 2, `page ${n}: Gwendolyn's sketch and the cover${n === 3 ? ", and a page already drawn" : ""}`);
    assert.match(parts(page).at(-1)!.text!, /Gwendolyn looks exactly like reference picture 1.*Mia: curly hair/);
    if (n === 3) assert.match(parts(page).at(-1)!.text!, /Reference picture 3 is another page of this same book/);
  }
  assert.ok(
    asked.flatMap(parts).every((p) => !p.inlineData || p.inlineData.mimeType === "image/jpeg"),
    "the reference pictures go small, as JPEGs, so they're quick and never too big for one request",
  );
});

test("the whole book drawn again: every picture replaced, the new pages matching each other, within the approval", async () => {
  process.env.GEMINI_API_KEY = "test-google-key";
  mode = "ok";
  const { getStoryArt } = await import("@/lib/server/db");
  const { startDrawing } = await import("@/lib/server/art");
  const { recordSpend, getPurchase } = await import("@/lib/server/spending");
  const { picturePrice } = await import("@/lib/server/prices");
  const { householdDir } = await import("@/lib/server/files");
  const { household, story } = await pictureBook("Drawn Twice");
  const all = [0, 1, 2, 3];
  const first = recordSpend(household, { storyId: story, service: "pictures", kind: "draw", what: "Drew the book", approved: picturePrice() * 4 });
  assert.ok(startDrawing(story, all, first));
  await untilDrawn(story);
  const before = getStoryArt(story)!;

  asked.length = 0;
  const again = recordSpend(household, { storyId: story, service: "pictures", kind: "draw", what: "Drew the book again", approved: picturePrice() * 4 });
  assert.ok(startDrawing(story, all, again));
  await untilDrawn(story);
  const after = getStoryArt(story)!;
  assert.equal(after.error, null);
  assert.equal(asked.length, 4, "the cover and every page, once each");
  for (const [i, rel] of [after.cover, ...after.pages].entries()) {
    const old = [before.cover, ...before.pages][i]!;
    assert.ok(rel && rel !== old, `picture ${i} is new`);
    assert.ok(fs.existsSync(path.join(householdDir(household), rel)));
    assert.ok(!fs.existsSync(path.join(householdDir(household), old)), `the old picture ${i} is gone`);
  }
  assert.deepEqual(getPurchase(again), { approved: picturePrice() * 4, spent: DRAWN * 4, pictures: 4 });
  // Every page beside a page of the book (page 3 after a new one, pages 1 and 2 beside the old ones they replace)
  const parts = (r: (typeof asked)[number]) => r.body.contents[0].parts as { text?: string; inlineData?: unknown }[];
  for (const page of asked.slice(1)) assert.match(parts(page).at(-1)!.text!, /is another page of this same book/);
});

test("a picture that doesn't come is tried again by itself, within the same approval", async () => {
  process.env.GEMINI_API_KEY = "test-google-key";
  mode = "ok";
  asked.length = 0;
  const { getStoryArt } = await import("@/lib/server/db");
  const { startDrawing } = await import("@/lib/server/art");
  const { recordSpend, getPurchase } = await import("@/lib/server/spending");
  const { picturePrice } = await import("@/lib/server/prices");
  const { household, story } = await pictureBook("Try Again");
  emptyOnce.add("front cover");
  emptyOnce.add("page 2 of");
  const approved = picturePrice() * 4;
  const purchase = recordSpend(household, { storyId: story, service: "pictures", kind: "draw", what: "Drew the book", approved });
  startDrawing(story, [0, 1, 2, 3], purchase);
  await untilDrawn(story);

  const art = getStoryArt(story)!;
  assert.equal(art.error, null, "nothing for the family to do");
  assert.ok(art.cover && art.pages.every(Boolean), "every picture is drawn in the end");
  assert.equal(asked.length, 6, "the cover and page 2 were each tried once more");
  const prompt = (i: number) => asked[i].body.contents[0].parts.at(-1).text as string;
  assert.ok(/front cover/.test(prompt(0)) && /front cover/.test(prompt(1)), "the cover again straight away, so the pages can match it");
  assert.deepEqual(getPurchase(purchase), { approved, spent: DRAWN * 4 + EMPTY * 2, pictures: 4 }, "on the same purchase, with the empty replies counted");
});

test("after a restart, the illustrator carries on where it stopped, on the same purchase", async () => {
  process.env.GEMINI_API_KEY = "test-google-key";
  mode = "ok";
  asked.length = 0;
  const { getStoryArt, changeStoryArt } = await import("@/lib/server/db");
  const { resumeLostArt } = await import("@/lib/server/art");
  const { recordSpend, getPurchase } = await import("@/lib/server/spending");
  const { picturePrice } = await import("@/lib/server/prices");
  const { household, story } = await pictureBook("Carry On");
  const approved = picturePrice() * 4;
  const purchase = recordSpend(household, { storyId: story, service: "pictures", kind: "draw", what: "Drew the book", approved });
  // What a restart leaves behind: the cover drawn, the pages not, and the job still marked as at work.
  changeStoryArt(
    story,
    (a) =>
      a && {
        ...a,
        status: "drawing",
        cover: a.characters[0].sketches[0],
        job: { kind: "drawing", targets: [0, 1, 2, 3], total: 4, finished: [0], startedAt: Date.now() - 60_000, seconds: 75, purchaseId: purchase },
      },
  );
  resumeLostArt(story);
  await untilDrawn(story);
  const art = getStoryArt(story)!;
  assert.equal(art.error, null);
  assert.ok(art.pages.every(Boolean), "the pages are drawn");
  assert.equal(asked.length, 3, "just the pages still to draw");
  assert.equal(getPurchase(purchase)!.pictures, 3);

  // A job from before jobs were kept this way is settled, for the family to carry on.
  changeStoryArt(story, (a) => a && { ...a, status: "drawing", job: null });
  resumeLostArt(story);
  assert.equal(getStoryArt(story)!.status, "idle");
  assert.match(getStoryArt(story)!.error ?? "", /interrupted/);
});

test("the illustrator never draws more than the purchase covers, and a refusal or a bad key is said plainly", async () => {
  process.env.GEMINI_API_KEY = "test-google-key";
  mode = "ok";
  const { getStoryArt } = await import("@/lib/server/db");
  const { startDrawing, startSketches } = await import("@/lib/server/art");
  const { recordSpend, getPurchase } = await import("@/lib/server/spending");
  const { picturePrice } = await import("@/lib/server/prices");

  const short = await pictureBook("Two Pictures Only");
  const purchase = recordSpend(short.household, { storyId: short.story, service: "pictures", kind: "draw", what: "x", approved: picturePrice() * 2 });
  startDrawing(short.story, [0, 1, 2], purchase);
  await untilDrawn(short.story);
  const art = getStoryArt(short.story)!;
  assert.equal([art.cover, ...art.pages].filter(Boolean).length, 2);
  assert.match(art.error ?? "", /couldn't be drawn\. That's all the approved purchase covers\. It wasn't charged\./);
  assert.deepEqual(art.problem, { kind: "drawing", targets: [2] }, "the problem is shown with the picture it's about");
  assert.equal(getPurchase(purchase)!.pictures, 2);

  mode = "forbidden";
  const locked = await pictureBook("A Bad Key");
  const p2 = recordSpend(locked.household, { storyId: locked.story, service: "pictures", kind: "draw", what: "x", approved: picturePrice() });
  startDrawing(locked.story, [1], p2);
  await untilDrawn(locked.story);
  assert.match(getStoryArt(locked.story)!.error ?? "", /Google key wasn't accepted.*API key not valid/);
  assert.equal(getPurchase(p2)!.spent, 0, "a refused request costs nothing");

  mode = "blocked";
  const shy = await pictureBook("A Shy Illustrator");
  const p3 = recordSpend(shy.household, { storyId: shy.story, service: "pictures", kind: "sketch", what: "x", approved: picturePrice() * 3 });
  startSketches(shy.story, ["fairy", "fairy", "fairy"], p3);
  await untilDrawn(shy.story);
  assert.match(getStoryArt(shy.story)!.error ?? "", /wouldn't draw this one/);
  assert.deepEqual(getStoryArt(shy.story)!.problem, { kind: "sketching", characterId: "fairy", characterIds: ["fairy"] });
  assert.deepEqual(getPurchase(p3), { approved: picturePrice() * 3, spent: 500 * 0.5 * 3, pictures: 0 }, "what a picture-less reply cost is still counted");
  mode = "ok";
});

test("without the illustrator's key, the pictures are free stand-ins", async () => {
  delete process.env.GEMINI_API_KEY;
  asked.length = 0;
  const { getStoryArt } = await import("@/lib/server/db");
  const { startSketches } = await import("@/lib/server/art");
  const { recordSpend, getPurchase } = await import("@/lib/server/spending");
  const { household, story } = await pictureBook("Stand-in Sketches");
  const purchase = recordSpend(household, { storyId: story, service: "pictures", kind: "sketch", what: "x", approved: 0, standIn: true });
  startSketches(story, ["mia", "mia", "mia"], purchase);
  const job = getStoryArt(story)!.job!;
  assert.deepEqual([job.kind, job.characterId, job.total, job.seconds], ["sketching", "mia", 3, 3], "stand-ins take a moment");
  await untilDrawn(story);
  assert.equal(getStoryArt(story)!.job, null);
  const mia = getStoryArt(story)!.characters.find((c) => c.id === "mia")!;
  assert.equal(mia.sketches.length, 3);
  assert.ok(mia.sketches.every((p) => p.endsWith(".svg")));
  assert.deepEqual(getPurchase(purchase), { approved: 0, spent: 0, pictures: 3 });
  assert.equal(asked.length, 0, "Google wasn't asked");
});

test("a picture is priced from what pictures have really cost lately, so a purchase covers every picture in it", async () => {
  const { picturePrice, noteRecentPictureCost } = await import("@/lib/server/prices");
  const { recordSpend, addToPurchase, refreshPictureCost } = await import("@/lib/server/spending");
  const { createHousehold } = await import("@/lib/server/db");
  const listed = picturePrice();
  const hh = createHousehold("The Thrift Family", "thrift@example.com", "x");
  // Google's thinking made the latest pictures dearer than the list price allowed for: 13¢ each.
  for (let i = 0; i < 12; i++) {
    const dear = recordSpend(hh, { service: "pictures", kind: "sketch", what: "Sketches", approved: 300_000 });
    addToPurchase(dear, 130_000);
    addToPurchase(dear, 130_000);
  }
  assert.equal(picturePrice(), Math.round(130_000 * 1.25), "what they really cost, with room to spare");
  // Stand-ins don't count, nor do purchases with no pictures yet.
  recordSpend(hh, { service: "pictures", kind: "draw", what: "Stand-ins", approved: 0, standIn: true, pictures: 5 });
  recordSpend(hh, { service: "pictures", kind: "draw", what: "Just approved", approved: 500_000 });
  refreshPictureCost();
  assert.equal(picturePrice(), Math.round(130_000 * 1.25));
  // Cheaper pictures never bring it below the list price.
  for (let i = 0; i < 12; i++) addToPurchase(recordSpend(hh, { service: "pictures", kind: "draw", what: "Pages", approved: 500_000 }), 20_000);
  assert.equal(picturePrice(), listed);
  noteRecentPictureCost(null);
});

test("everyone can be sketched at once, on one purchase, and a restart carries on with whoever's left", async () => {
  delete process.env.GEMINI_API_KEY;
  const { getStoryArt, changeStoryArt } = await import("@/lib/server/db");
  const { startSketches, resumeLostArt } = await import("@/lib/server/art");
  const { recordSpend, getPurchase } = await import("@/lib/server/spending");
  const { household, story } = await pictureBook("Everyone at Once");
  const purchase = recordSpend(household, { storyId: story, service: "pictures", kind: "sketch", what: "x", approved: 0, standIn: true });
  const count = (id: string) => getStoryArt(story)!.characters.find((c) => c.id === id)!.sketches.length;
  const before = { mia: count("mia"), fairy: count("fairy") };
  startSketches(story, ["mia", "mia", "fairy", "fairy"], purchase);
  const job = getStoryArt(story)!.job!;
  assert.deepEqual([job.kind, job.characterId, job.whose, job.total], ["sketching", undefined, ["mia", "mia", "fairy", "fairy"], 4]);
  assert.equal(getStoryArt(story)!.progress?.step, "Sketching the characters");
  await untilDrawn(story);
  assert.deepEqual([count("mia") - before.mia, count("fairy") - before.fairy], [2, 2], "two each, one purchase");
  assert.equal(getPurchase(purchase)!.pictures, 4);

  // Stopped by a restart after Mia's first sketch and the fairy's first: it carries on with one more of each.
  changeStoryArt(story, (a) => a && { ...a, status: "sketching", job: { kind: "sketching", whose: ["mia", "mia", "fairy", "fairy"], total: 4, finished: [0, 2], startedAt: Date.now(), seconds: 3, purchaseId: purchase } });
  resumeLostArt(story);
  assert.deepEqual(getStoryArt(story)!.job?.whose, ["mia", "fairy"]);
  await untilDrawn(story);
  assert.deepEqual([count("mia") - before.mia, count("fairy") - before.fairy], [3, 3]);
});

test("a character drawn for another of the family's books is offered again, free, and copied in when used", async () => {
  const { createStory, updateStory, changeStoryArt, getStoryArt, createBook } = await import("@/lib/server/db");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { newArt, drawnBefore, useDrawnBefore } = await import("@/lib/server/art");
  const { householdDir } = await import("@/lib/server/files");
  // The family's first book: Gwendolyn's sketch is chosen (see pictureBook).
  const first = await pictureBook("The First Tooth");
  // A new book with Gwendolyn in it again (written a little differently), and someone new.
  const book = createBook(first.household, { title: "The Second Tooth", kind: "idea" });
  const second = createStory(first.household, { bookId: book, profileId: null, mode: "create", title: "The Second Tooth", settings: defaultSettings({ source: "idea", pictures: true }), status: "ready" });
  updateStory(second, { script });
  changeStoryArt(second, () => ({
    ...newArt("watercolor", 3),
    characters: [
      { id: "gwen", name: " gwendolyn ", look: "a giant", main: true, drawing: null, sketches: [], chosen: null },
      { id: "pip", name: "Pip", look: "a mouse", main: true, drawing: null, sketches: [], chosen: null },
    ],
    coverScene: "x",
    scenes: [1, 2, 3].map((page) => ({ page, scene: `Scene ${page}`, characters: ["gwen"] })),
  }));
  const offered = drawnBefore(first.household, second);
  assert.deepEqual(Object.keys(offered), ["gwen"], "only the character drawn before");
  assert.deepEqual(offered.gwen.map((d) => [d.storyId, d.title]), [[first.story, "The First Tooth"]]);
  assert.equal(await useDrawnBefore(first.household, second, "gwen", "not-a-story"), false);
  assert.equal(await useDrawnBefore(first.household, second, "gwen", first.story), true);
  const gwen = getStoryArt(second)!.characters.find((c) => c.id === "gwen")!;
  assert.equal(gwen.chosen, 0, "chosen straight away");
  assert.ok(gwen.sketches[0].startsWith(`stories/${second}/art/`), "copied into the new book, so it stays if the first one goes");
  assert.deepEqual(fs.readFileSync(path.join(householdDir(first.household), gwen.sketches[0])), PNG);
  // Another family's books never come into it.
  const other = await pictureBook("Someone Else's Book");
  assert.deepEqual(drawnBefore(first.household, second).gwen.map((d) => d.storyId), [first.story]);
  assert.deepEqual(drawnBefore(other.household, second), {}, "nor is a story looked at for a family it isn't theirs");
});

test("each picture style's example: drawn once, small, the way a page is, and drawn again when the style changes", async () => {
  process.env.GEMINI_API_KEY = "test-google-key";
  mode = "ok";
  const { styleSamples, samplesDrawn, sampleFile, sampleRequest } = await import("@/lib/server/styleSamples");
  const { ART_STYLES } = await import("@/lib/shared/art");
  const styles = Object.keys(ART_STYLES) as (keyof typeof ART_STYLES)[];
  const before = asked.length;
  const first = styleSamples();
  assert.ok(first.drawing, "asking starts drawing them");
  assert.ok(styles.every((s) => first.samples[s] === null), "none is there yet");
  assert.equal(styleSamples().drawing, true, "asking again doesn't start a second batch");
  await samplesDrawn();
  const drawn = asked.slice(before);
  assert.equal(drawn.length, styles.length, "one picture a style");
  assert.ok(drawn.every((a) => a.body.generationConfig.imageConfig.imageSize === "1K"), "drawn small");
  for (const style of styles) {
    assert.ok(drawn.some((a) => a.body.contents[0].parts.at(-1).text === sampleRequest(style).prompt), `${style} drawn from its own prompt`);
    assert.ok(sampleRequest(style).prompt.startsWith(`Art style, the most important instruction of all: ${ART_STYLES[style].prompt}.`));
  }
  const ready = styleSamples();
  assert.equal(ready.drawing, false);
  for (const style of styles) {
    assert.match(ready.samples[style] ?? "", new RegExp(`^/api/art-styles/${style}/sample\\?v=[0-9a-f]{10}$`));
    assert.ok(fs.readFileSync(sampleFile(style)!).subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "kept as a JPEG");
  }
  assert.equal(asked.length, before + styles.length, "kept, not drawn again");

  // A style described differently is drawn again, and its old example goes.
  const old = sampleFile("cartoon")!;
  const was = ART_STYLES.cartoon.prompt;
  ART_STYLES.cartoon.prompt = `${was} (with more bounce)`;
  try {
    assert.equal(styleSamples().samples.cartoon, null);
    await samplesDrawn();
    assert.equal(asked.length, before + styles.length + 1, "only that one");
    assert.ok(sampleFile("cartoon"));
    assert.equal(fs.existsSync(old), false);
  } finally {
    ART_STYLES.cartoon.prompt = was;
  }
});

test("a book saved in a style (or a kind of story) that's no longer offered carries on in the default", async () => {
  const { changeStoryArt, getStoryArt, getStoryById, updateStory } = await import("@/lib/server/db");
  const { story } = await pictureBook("The Pastel Moon");
  changeStoryArt(story, (art) => ({ ...art!, style: "pastel" as never }));
  updateStory(story, { settings: { ...getStoryById(story)!.settings, artStyle: "comic" as never, mood: "bedtime" as never } });
  assert.equal(getStoryArt(story)!.style, "watercolor");
  assert.equal(getStoryById(story)!.settings.artStyle, "watercolor");
  // Likewise a kind of story no longer offered (Cozy bedtime).
  assert.equal(getStoryById(story)!.settings.mood, "heartwarming");
});

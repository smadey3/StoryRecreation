import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { changeStoryArt, familyStoryArt, fileUrl, getBook, getStoryArt, getStoryById, storiesWithArtAtWork, updateBook, updateStory } from "./db";
import { mediaTypeFor, removeDir, removeHouseholdFile, resolveHouseholdPath, storyDir } from "./files";
import { drawPicture, IllustratorError, illustratorReady, REFERENCE_TYPES, smallReference, type Picture, type PictureRequest, type Reference } from "./illustrator";
import { picturePrice } from "./prices";
import { addToPurchase, getPurchase, recordSpend } from "./spending";
import { planPictures, StorytellerError, type PicturePlan } from "./storyteller";
import { demoPicturePlan } from "./demo-storyteller";
import { expectedSeconds, noteWorkTime } from "./timing";
import { ART_STYLES, DEFAULT_ART_STYLE, drawingSeconds, formatMoney, planningSeconds } from "@/lib/shared/art";
import { MOODS } from "@/lib/shared/options";
import type { ArtCharacter, ArtJob, ArtProblem, ArtStyle, DrawnBefore, Mood, StoryArt } from "@/lib/shared/types";

// Picture books. After a story is written, the storyteller plans its pictures
// (who's in them, what they look like, what each page shows). The family
// meets the main characters as sketches and picks the right one; then the
// cover is drawn, and each page is drawn from the chosen sketches and the
// cover, so the characters and colors stay the same all the way through.
// Drawing is bought: each job runs on a purchase a grown-up approved, and
// stops before it would spend more than that.

const globalForArt = globalThis as unknown as { __storyhollowArt?: Set<string> };
const busy = (globalForArt.__storyhollowArt ??= new Set<string>());

/** True while the illustrator is working on this story's pictures. */
export const artBusy = (storyId: string) => busy.has(storyId);

export function newArt(style: ArtStyle, pages: number): StoryArt {
  return { style, status: "idle", progress: null, error: null, characters: [], coverScene: "", scenes: [], cover: null, pages: Array(pages).fill(null), job: null };
}

/** A job that ended with some of its pictures not made: what went wrong, and which ones. */
class MissedPictures extends IllustratorError {
  constructor(
    message: string,
    public problem: ArtProblem,
  ) {
    super(message);
  }
}

/**
 * Run the illustrator in the background, one job per story at a time. The job says what it's
 * making and about how long it takes, so the family can see it at work. False when it's already busy.
 */
function launchArt(storyId: string, step: string, job: Omit<ArtJob, "finished" | "startedAt">, fn: () => Promise<void>): boolean {
  if (busy.has(storyId)) return false;
  busy.add(storyId);
  // Real work is timed, so the waits like it say how long they really take (`job.seconds` is the rule of thumb);
  // stand-ins and the demo storyteller take a moment.
  const timed = job.kind === "planning" ? Boolean(config.anthropicKey) || !config.demoMode : illustratorReady();
  const startedAt = Date.now();
  changeStoryArt(
    storyId,
    (a) =>
      a && {
        ...a,
        status: job.kind,
        error: null,
        problem: null,
        progress: { step, done: 0, total: job.total },
        job: { ...job, seconds: timed ? expectedSeconds(job.kind, job.seconds) : job.seconds, finished: [], startedAt },
      },
  );
  fn()
    .then(() => {
      if (timed) noteWorkTime(job.kind, job.seconds, startedAt);
    })
    .catch((err) => {
      console.error(`[art] ${storyId}`, err);
      const message = err instanceof IllustratorError || err instanceof StorytellerError ? err.message : "The illustrator hit a snag. Please try again.";
      const finishedSoFar = getStoryArt(storyId)?.job?.finished ?? [];
      const problem: ArtProblem =
        err instanceof MissedPictures ? err.problem : { kind: job.kind, characterId: job.characterId, targets: job.targets?.filter((t) => !finishedSoFar.includes(t)) };
      changeStoryArt(storyId, (a) => a && { ...a, error: message, problem });
    })
    .finally(() => {
      busy.delete(storyId);
      changeStoryArt(storyId, (a) => a && { ...a, status: "idle", progress: null, job: null });
    });
  return true;
}

const progress = (storyId: string, step: string, done: number, total: number) =>
  changeStoryArt(storyId, (a) => a && { ...a, progress: { step, done, total } });

/** One of the job's pictures is finished (made, or given up on), with any change to the pictures it brings. */
const finished = (storyId: string, n: number, change: (a: StoryArt) => StoryArt = (a) => a) =>
  changeStoryArt(storyId, (a) => a && change({ ...a, job: a.job ? { ...a.job, finished: [...a.job.finished, n] } : a.job }));

/** Run `n` tasks, `width` at a time. */
async function inTurns(n: number, width: number, task: (i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, n) }, async () => {
    while (next < n) await task(next++);
  }));
}

/**
 * What's left of an approved purchase. A picture's price is set aside before
 * it's drawn, and settled with what it really cost, so the pictures drawn at
 * the same time can never add up to more than was approved.
 */
class Budget {
  private held = 0;
  constructor(
    private purchaseId: string,
    private price: number,
  ) {}
  take(): boolean {
    const p = getPurchase(this.purchaseId);
    if (!p || p.spent + this.held + this.price > p.approved) return false;
    this.held += this.price;
    return true;
  }
  settle(cost: number, pictures: number) {
    this.held -= this.price;
    addToPurchase(this.purchaseId, cost, pictures);
  }
}

const pictureBudget = (purchaseId: string) => new Budget(purchaseId, illustratorReady() ? picturePrice() : 0);

/** A picture that didn't come: why, what the attempts still cost, and whether trying again might help. */
interface Missed {
  problem: string;
  cost: number;
  retry: boolean;
}

const OVER_BUDGET: Missed = { problem: "That's all the approved purchase covers.", cost: 0, retry: false };

const isMissed = (p: Picture | Missed): p is Missed => "problem" in p;

/** Draw one picture on the budget (its price already taken), settling what it cost. A problem comes back as words. */
async function drawWithin(budget: Budget, req: PictureRequest): Promise<Picture | Missed> {
  try {
    const pic = await drawPicture(req);
    budget.settle(pic.cost, 1);
    return pic;
  } catch (err) {
    budget.settle(err instanceof IllustratorError ? err.cost : 0, 0);
    if (err instanceof IllustratorError) return { problem: err.message, cost: err.cost, retry: err.retry };
    throw err;
  }
}

/** Which of the job's pictures are waiting to be tried once more. */
const setRetrying = (storyId: string, change: (retrying: number[]) => number[]) =>
  changeStoryArt(storyId, (a) => a && { ...a, job: a.job && { ...a.job, retrying: change(a.job.retrying ?? []) } });

/**
 * A picture that didn't come: remembered with what all its attempts cost, then either given up on, or (for a
 * passing reason, the first time) left waiting to be tried once more.
 */
function miss(storyId: string, missed: Map<number, Missed>, tried: Set<number>, n: number, m: Missed) {
  missed.set(n, { ...m, cost: (missed.get(n)?.cost ?? 0) + m.cost });
  if (m.retry && !tried.has(n)) setRetrying(storyId, (r) => [...r, n]);
  else finished(storyId, n);
}

/**
 * Try the pictures that didn't come for a passing reason once more, one at a time after a short pause,
 * within the same approved purchase: the family asked for them, and shouldn't have to ask again.
 */
async function tryAgain(storyId: string, missed: Map<number, Missed>, tried: Set<number>, draw: (n: number) => Promise<void>) {
  const again = [...missed].filter(([n, m]) => m.retry && !tried.has(n)).map(([n]) => n);
  if (!again.length) return;
  await new Promise((r) => setTimeout(r, config.illustratorRetryPauseMs));
  for (const n of again) {
    tried.add(n);
    setRetrying(storyId, (r) => r.filter((x) => x !== n));
    await draw(n);
  }
}

/** What missed pictures cost: "They weren't charged." or what Google charged for the empty replies. */
function chargedFor(missed: Missed[]): string {
  const cost = missed.reduce((n, m) => n + m.cost, 0);
  if (cost > 0) return ` Google charged about ${formatMoney(cost)} for the tries that came back without a picture.`;
  return missed.length > 1 ? " They weren't charged." : " It wasn't charged.";
}

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg" };

/** Keep a picture with the story, returning its household-relative path. */
async function savePicture(householdId: string, storyId: string, name: string, pic: Picture): Promise<string> {
  const rel = `stories/${storyId}/art/${name}-${randomUUID().slice(0, 8)}${EXTENSIONS[pic.mime] ?? ".png"}`;
  const full = resolveHouseholdPath(householdId, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, pic.bytes);
  return rel;
}

/** A kept picture, to show the illustrator; null for a stand-in (an SVG the model can't take). */
async function reference(householdId: string, rel: string | null, label: string): Promise<Reference | null> {
  if (!rel) return null;
  const mime = mediaTypeFor(rel);
  if (!REFERENCE_TYPES.has(mime)) return null;
  try {
    return await smallReference({ data: await fs.promises.readFile(resolveHouseholdPath(householdId, rel)), mime, label });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- prompts

const RULES =
  "It is for a children's picture book. No words, letters, numbers, signs, captions, signatures or speech bubbles anywhere in the picture. Warm, friendly and safe, never frightening.";

/** The art style, first and above all: the illustrator otherwise drifts toward the same smooth look whatever was chosen. */
const styleFirst = (style: ArtStyle) => `Art style, the most important instruction of all: ${ART_STYLES[style].prompt}.`;

/** A sketch of one character, alone, to choose between (or a child's drawing of them, made into a picture-book character). */
export function characterPrompt(c: Pick<ArtCharacter, "name" | "look">, style: ArtStyle, fromDrawing: boolean): string {
  const pose = `Show the whole character in a simple standing pose, facing slightly toward us, alone ${ART_STYLES[style].alone}.`;
  return fromDrawing
    ? `${styleFirst(style)} Reference picture 1 is a child's own drawing of ${c.name}. Redraw that exact character as a finished picture-book character, made in that art style. Keep the child's design, its colors, its shapes, how many eyes, arms and legs it has, its clothes and every funny detail, so the child knows it at once, and make it lovable.${c.look ? ` About ${c.name}: ${c.look}.` : ""} ${pose} ${RULES}`
    : `${styleFirst(style)} A character for a children's picture book, made in exactly that art style: ${c.name}${c.look ? `, ${c.look}` : ""}. ${pose} ${RULES}`;
}

/** The cover (page 0) or a page: its scene, with each character shown from their chosen sketch, and the cover for style. */
export function sceneRequest(o: {
  title: string;
  page: number;
  scene: string;
  characters: ArtCharacter[];
  sketches: Map<string, Reference>;
  cover: Reference | null;
  style: ArtStyle;
  mood: Mood;
  note?: string;
  seed: string;
}): PictureRequest {
  const references: Reference[] = [];
  const who = o.characters.slice(0, 6).map((c) => {
    const sketch = references.length < 4 ? o.sketches.get(c.id) : undefined;
    if (sketch) {
      references.push(sketch);
      return `${c.name} looks exactly like reference picture ${references.length}${c.look ? ` (${c.look})` : ""}`;
    }
    return `${c.name}: ${c.look || "as the story describes"}`;
  });
  if (o.cover && o.page > 0) references.push(o.cover);
  const prompt = [
    styleFirst(o.style),
    o.page === 0
      ? `The front cover picture for the picture book "${o.title}", in that art style. The title is added separately, so leave calm space near the top.`
      : `The picture for page ${o.page} of the picture book "${o.title}", in that art style.`,
    `Scene: ${o.scene}`,
    who.length ? `Characters: ${who.join("; ")}.` : "",
    who.length && references.length ? "Keep every character's design, colors, proportions and clothes exactly as in their reference picture." : "",
    o.cover && o.page > 0 ? `Match the style, palette and lighting of the cover (reference picture ${references.length}).` : "",
    `Mood: ${MOODS[o.mood].label.toLowerCase()}.`,
    o.note ? `The family asked for this change: ${o.note}` : "",
    RULES,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    prompt,
    references,
    aspect: "4:3",
    standIn: { heading: o.page === 0 ? o.title : `Page ${o.page}`, caption: o.scene, style: o.style, seed: o.seed },
  };
}

// ----------------------------------------------------------------- planning

/** Turn a story into a picture book (or start its pictures over): the storyteller plans the pictures. */
export function startPictureBook(storyId: string, style: ArtStyle): boolean {
  const story = getStoryById(storyId);
  if (!story?.script || busy.has(storyId)) return false;
  const had = getStoryArt(storyId);
  changeStoryArt(storyId, () => newArt(style, story.script!.pages.length));
  if (had) void removeDir(path.join(storyDir(story.householdId, storyId), "art"));
  if (!story.settings.pictures || story.settings.artStyle !== style) updateStory(storyId, { settings: { ...story.settings, pictures: true, artStyle: style } });
  return startPlanning(storyId);
}

const startPlanning = (storyId: string) =>
  launchArt(
    storyId,
    "Reading the story",
    { kind: "planning", total: 1, seconds: planningSeconds(Boolean(config.anthropicKey) || !config.demoMode) },
    () => plan(storyId),
  );

/** A new story that's to be a picture book has just been written. */
export function planPicturesAfterWriting(storyId: string) {
  startPictureBook(storyId, getStoryById(storyId)?.settings.artStyle ?? DEFAULT_ART_STYLE);
}

async function plan(storyId: string) {
  const story = getStoryById(storyId);
  if (!story?.script) return;
  const s = story.settings;
  let result: { plan: PicturePlan; cost: number };
  if (config.anthropicKey || !config.demoMode) {
    result = await planPictures(story.script, { description: s.description, heroes: s.heroes, mood: MOODS[s.mood].label });
  } else {
    result = { plan: demoPicturePlan(story.script), cost: 0 };
  }
  if (result.cost > 0) {
    recordSpend(story.householdId, { storyId, service: "storyteller", kind: "plan", what: `Planned the pictures for “${story.script.title}”`, spent: result.cost });
  }
  changeStoryArt(
    storyId,
    (a) =>
      a && {
        ...a,
        characters: result.plan.characters.map((c) => ({ ...c, drawing: null, sketches: [], chosen: null })),
        coverScene: result.plan.cover,
        scenes: result.plan.pages,
        pages: story.script!.pages.map(() => null),
      },
  );
}

// ---------------------------------------------------------------- sketching

/**
 * Sketch characters to choose between, on an approved purchase: `whose` has a character's id once for each sketch
 * of them to make (everyone at once, or just one character), and they're made in that order, two at a time.
 */
export function startSketches(storyId: string, whose: string[], purchaseId: string): boolean {
  const art = getStoryArt(storyId);
  const names = [...new Set(whose)].map((id) => art?.characters.find((c) => c.id === id)?.name ?? "");
  const job = {
    kind: "sketching" as const,
    whose,
    ...(names.length === 1 ? { characterId: whose[0] } : {}),
    purchaseId,
    total: whose.length,
    seconds: drawingSeconds(whose.length, false, illustratorReady()),
  };
  return launchArt(storyId, names.length === 1 ? `Sketching ${names[0]}` : "Sketching the characters", job, () => sketch(storyId, whose, purchaseId));
}

async function sketch(storyId: string, whose: string[], purchaseId: string) {
  const story = getStoryById(storyId);
  const art = getStoryArt(storyId);
  if (!story || !art) return;
  const cast = new Map(art.characters.map((c) => [c.id, c]));
  const order = whose.filter((id) => cast.has(id));
  const budget = pictureBudget(purchaseId);
  const drawings = new Map<string, Reference | null>();
  for (const id of new Set(order)) {
    const c = cast.get(id)!;
    drawings.set(id, await reference(story.householdId, c.drawing, `a child's drawing of ${c.name}`));
  }
  const label = new Set(order).size === 1 ? `Sketching ${cast.get(order[0])?.name}` : "Sketching the characters";
  const missed = new Map<number, Missed>();
  const tried = new Set<number>();
  let done = 0;
  progress(storyId, label, 0, order.length);
  const one = async (i: number) => {
    const c = cast.get(order[i])!;
    const drawing = drawings.get(c.id) ?? null;
    const pic = budget.take()
      ? await drawWithin(budget, {
          prompt: characterPrompt(c, art.style, Boolean(drawing)),
          references: drawing ? [drawing] : [],
          aspect: "1:1",
          standIn: { heading: c.name, caption: c.look || `What ${c.name} looks like`, style: art.style, seed: `${storyId}-${c.id}-${Date.now()}-${i}` },
        })
      : OVER_BUDGET;
    if (isMissed(pic)) {
      console.warn(`[art] ${storyId}: a sketch of ${c.name} didn't come: ${pic.problem}`);
      return miss(storyId, missed, tried, i, pic);
    }
    missed.delete(i);
    const rel = await savePicture(story.householdId, storyId, `sketch-${c.id}`, pic);
    finished(storyId, i, (a) => ({ ...a, characters: a.characters.map((x) => (x.id === c.id ? { ...x, sketches: [...x.sketches, rel] } : x)) }));
    progress(storyId, label, ++done, order.length);
  };
  await inTurns(order.length, 2, one);
  await tryAgain(storyId, missed, tried, one);
  if (missed.size) {
    const why = [...missed.values()];
    const made = order.length - missed.size;
    const short = [...new Set([...missed.keys()].map((i) => order[i]))];
    const names = short.map((id) => cast.get(id)!.name);
    const whom = short.length === new Set(order).size ? "" : ` (${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} still to come)`;
    throw new MissedPictures(`${made ? `${made} of ${order.length} sketches were made${whom}. ` : ""}${why[0].problem}${chargedFor(why)}`, {
      kind: "sketching",
      ...(short.length === 1 ? { characterId: short[0] } : {}),
      characterIds: short,
    });
  }
}

// ---------------------------------------------------------- characters drawn before

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * For each main character of this book, the same character (by name) as chosen in the family's other picture books:
 * the newest first, a few at most. Adaline drawn once can be in every book.
 */
export function drawnBefore(householdId: string, storyId: string): Record<string, DrawnBefore[]> {
  const art = getStoryArt(storyId);
  if (!art || getStoryById(storyId)?.householdId !== householdId) return {};
  const others = familyStoryArt(householdId).filter((s) => s.id !== storyId);
  const out: Record<string, DrawnBefore[]> = {};
  for (const c of art.characters.filter((x) => x.main)) {
    const found = others.flatMap((s) =>
      s.art.characters
        .filter((o) => sameName(o.name, c.name) && o.chosen !== null && o.sketches[o.chosen])
        .map((o) => ({ storyId: s.id, title: s.title, picture: o.sketches[o.chosen!], style: s.art.style })),
    );
    // The same picture chosen in several books is offered once.
    const unique = found.filter((f, i) => found.findIndex((g) => g.picture === f.picture) === i).slice(0, 3);
    if (unique.length) out[c.id] = unique;
  }
  return out;
}

/** The same, with the browser's file addresses for the pictures. */
export function drawnBeforeUrls(householdId: string, storyId: string): Record<string, DrawnBefore[]> {
  return Object.fromEntries(
    Object.entries(drawnBefore(householdId, storyId)).map(([id, list]) => [id, list.map((d) => ({ ...d, picture: fileUrl(d.picture)! }))]),
  );
}

/** Use a character's picture from another of the family's books: copied into this one (so it stays if that book goes), and chosen. */
export async function useDrawnBefore(householdId: string, storyId: string, characterId: string, fromStoryId: string): Promise<boolean> {
  const choice = drawnBefore(householdId, storyId)[characterId]?.find((d) => d.storyId === fromStoryId);
  if (!choice) return false;
  const rel = `stories/${storyId}/art/sketch-${characterId}-${randomUUID().slice(0, 8)}${path.extname(choice.picture) || ".png"}`;
  const dest = resolveHouseholdPath(householdId, rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(resolveHouseholdPath(householdId, choice.picture), dest);
  changeStoryArt(
    storyId,
    (a) =>
      a && {
        ...a,
        characters: a.characters.map((c) => (c.id === characterId ? { ...c, sketches: [...c.sketches, rel], chosen: c.sketches.length } : c)),
      },
  );
  return true;
}

// ------------------------------------------------------------------ drawing

/** Draw the cover (0) and the given pages, on an approved purchase. */
export function startDrawing(storyId: string, targets: number[], purchaseId: string, note?: string): boolean {
  const step = targets.length === 1 ? (targets[0] === 0 ? "Drawing the cover" : `Drawing page ${targets[0]}`) : "Drawing the book";
  const job = {
    kind: "drawing" as const,
    targets,
    purchaseId,
    note,
    total: targets.length,
    seconds: drawingSeconds(targets.length, targets.includes(0), illustratorReady()),
  };
  return launchArt(storyId, step, job, () => draw(storyId, targets, purchaseId, note));
}

/** What still needs drawing: the cover (0) and any page without a picture. */
export function undrawn(art: StoryArt): number[] {
  return [...(art.cover ? [] : [0]), ...art.pages.flatMap((p, i) => (p ? [] : [i + 1]))];
}

async function draw(storyId: string, targets: number[], purchaseId: string, note?: string) {
  const story = getStoryById(storyId);
  const art = getStoryArt(storyId);
  if (!story?.script || !art) return;
  const householdId = story.householdId;
  const budget = pictureBudget(purchaseId);

  // Each main character is drawn from their chosen sketch.
  const sketches = new Map<string, Reference>();
  for (const c of art.characters) {
    const chosen = c.chosen !== null ? c.sketches[c.chosen] : null;
    const ref = c.main && chosen ? await reference(householdId, chosen, `${c.name}${c.look ? `, ${c.look}` : ""}`) : null;
    if (ref) sketches.set(c.id, ref);
  }
  let cover = await reference(householdId, art.cover, "the book's cover");

  const missed = new Map<number, Missed>();
  const tried = new Set<number>();
  let done = 0;
  const total = targets.length;
  const drawOne = async (target: number) => {
    const label = target === 0 ? "the cover" : `page ${target}`;
    progress(storyId, `Drawing ${label}`, done, total);
    const scene = target === 0 ? art.coverScene : (art.scenes.find((s) => s.page === target)?.scene ?? "");
    const ids = target === 0 ? art.characters.filter((c) => c.main).map((c) => c.id) : (art.scenes.find((s) => s.page === target)?.characters ?? []);
    const pic = budget.take()
      ? await drawWithin(
          budget,
          sceneRequest({
            title: story.script!.title,
            page: target,
            scene,
            characters: ids.map((id) => art.characters.find((c) => c.id === id)).filter((c): c is ArtCharacter => Boolean(c)),
            sketches,
            cover,
            style: art.style,
            mood: story.settings.mood,
            note,
            seed: `${storyId}-${target}-${Date.now()}`,
          }),
        )
      : OVER_BUDGET;
    if (isMissed(pic)) {
      console.warn(`[art] ${storyId}: ${label} wasn't drawn: ${pic.problem}`);
      return miss(storyId, missed, tried, target, pic);
    }
    missed.delete(target);
    const rel = await savePicture(householdId, storyId, target === 0 ? "cover" : `page-${String(target).padStart(2, "0")}`, pic);
    let replaced: string | null = null;
    finished(storyId, target, (a) => {
      replaced = target === 0 ? a.cover : (a.pages[target - 1] ?? null);
      if (target === 0) return { ...a, cover: rel };
      const pages = [...a.pages];
      pages[target - 1] = rel;
      return { ...a, pages };
    });
    // A redrawn picture replaces the old one.
    if (replaced) await removeHouseholdFile(householdId, replaced).catch(() => undefined);
    if (target === 0) {
      cover = REFERENCE_TYPES.has(pic.mime) ? await smallReference({ data: pic.bytes, mime: pic.mime, label: "the book's cover" }) : null;
      if (!pic.standIn) await coverTheBook(householdId, story.bookId, pic);
    }
    progress(storyId, `Drawing ${label}`, ++done, total);
  };

  // The cover first, so every page can match its colors and style (tried again straight away if it didn't come);
  // then the pages, two at a time, and once more for any that didn't come for a passing reason.
  const pages = targets.filter((t) => t !== 0);
  if (targets.includes(0)) {
    await drawOne(0);
    await tryAgain(storyId, missed, tried, drawOne);
  }
  await inTurns(pages.length, 2, (i) => drawOne(pages[i]));
  await tryAgain(storyId, missed, tried, drawOne);

  if (missed.size) {
    const failed = [...missed.keys()].sort((a, b) => a - b);
    const which = failed.map((t) => (t === 0 ? "the cover" : `page ${t}`));
    const list = which.length > 1 ? `${which.slice(0, -1).join(", ")} and ${which.at(-1)}` : which[0];
    const why = [...missed.values()];
    throw new MissedPictures(`${list.charAt(0).toUpperCase()}${list.slice(1)} couldn't be drawn. ${why[0].problem}${chargedFor(why)}`, {
      kind: "drawing",
      targets: failed,
    });
  }
}

/** A book dreamed up from an idea has no cover of its own: its first picture book's cover becomes it. */
async function coverTheBook(householdId: string, bookId: string, pic: Picture) {
  const book = getBook(householdId, bookId);
  if (!book || book.coverUrl || book.kind !== "idea") return;
  const rel = `books/${bookId}/cover-${randomUUID().slice(0, 8)}${EXTENSIONS[pic.mime] ?? ".png"}`;
  const full = resolveHouseholdPath(householdId, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, pic.bytes);
  updateBook(householdId, bookId, { coverPath: rel });
}

/**
 * A restart (an update to the app, say) stops the illustrator mid-job. What it finished is kept, and it carries
 * on by itself: sketches and pictures on the purchase the family approved, within what's left of it, and the
 * planning from the start. A job from before jobs were kept this way is settled, for the family to carry on.
 */
/** The sketches a sketching job hadn't made yet: whose each is. */
function sketchesLeft(job: ArtJob): string[] {
  const whose = job.whose ?? (job.characterId ? Array.from({ length: job.total }, () => job.characterId!) : []);
  return whose.filter((_, i) => !job.finished.includes(i));
}

export function resumeLostArt(storyId: string) {
  const art = getStoryArt(storyId);
  if (!art || art.status === "idle" || busy.has(storyId)) return;
  const job = art.job;
  const left = job ? (job.targets ?? []).filter((t) => !job.finished.includes(t)) : [];
  const resumed =
    job?.kind === "planning"
      ? startPlanning(storyId)
      : job?.kind === "sketching" && job.purchaseId && sketchesLeft(job).length
        ? startSketches(storyId, sketchesLeft(job), job.purchaseId)
        : job?.kind === "drawing" && job.purchaseId && left.length
          ? startDrawing(storyId, left, job.purchaseId, job.note)
          : false;
  if (resumed) return console.log(`[art] ${storyId}: carrying on with the ${job!.kind} after a restart`);
  changeStoryArt(
    storyId,
    (a) => a && { ...a, status: "idle", progress: null, job: null, error: "The illustrator was interrupted. Anything finished is kept: carry on when you're ready." },
  );
}

/** When the app starts, the illustrator carries on with whatever a restart stopped (never stopping the app itself). */
export function resumeLostArtSoon() {
  setTimeout(() => {
    try {
      for (const id of storiesWithArtAtWork()) {
        try {
          resumeLostArt(id);
        } catch (err) {
          console.error(`[art] ${id}: couldn't carry on after a restart`, err);
        }
      }
    } catch (err) {
      console.error("[art] couldn't look for pictures to carry on with", err);
    }
  }, 3_000).unref();
}

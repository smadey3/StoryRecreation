import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config";
import {
  fileUrl,
  getBook,
  getStoryById,
  recordTurnedDown,
  listBookCharacters,
  listPageRows,
  nameBookAfterStory,
  previousStoriesForBook,
  rememberCharacters,
  replacePages,
  storiesBeingMade,
  updateBook,
  updateStory,
  type PageRow,
} from "./db";
import { readImageForModel, storyDir } from "./files";
import { castableVoices, voiceCatalog } from "./voices";
import { NotForChildrenError, OutOfCreditError, spotSoundEffects, writeScript, StorytellerError, type StoryRequest } from "./storyteller";
import { demoSoundCues, writeDemoScript } from "./demo-storyteller";
import { performAmbience, performLines, performSoundEffect, PerformerError } from "./performer";
import { encodeMp3, floatToPcm16, mixStory, pcm16ToFloat, type Clip, type PlacedEffect } from "./audio";
import { loadClassic } from "./classics";
import { forgetVoiceCredits } from "./credits";
import { alertStoryFailed, checkVoiceCreditLow } from "./alerts";
import { recordSpend } from "./spending";
import { planPicturesAfterWriting } from "./art";
import { sectionText, stripTags, withTheEnd } from "./text";
import { expectedSeconds, noteWorkTime } from "./timing";
import { forStory, turns, type Place } from "./line";
import { personaFor } from "@/lib/shared/personas";
import { SAYINGS, guessLanguage, languageOf } from "@/lib/shared/languages";
import { LENGTHS, WORDS_PER_MINUTE, estimateMinutes } from "@/lib/shared/options";
import type { ScriptLine, ScriptPage, SoundCue, Story, StoryScript, StorySettings } from "@/lib/shared/types";

// Stories are written and recorded in the background so a phone can lock, or
// a parent can wander off to brush teeth, without losing anything. Progress
// lives in the database; the page polls it.

const globalForJobs = globalThis as unknown as { __storyhollowJobs?: Set<string>; __storyhollowMaking?: Map<string, Promise<Clip>> };
const running = (globalForJobs.__storyhollowJobs ??= new Set());

export function isRunning(storyId: string): boolean {
  return running.has(storyId);
}

/** Run a job in the background. It may return a follow-up job to start once it has finished. */
function launch(key: string, storyId: string, fn: () => Promise<(() => void) | void>) {
  if (running.has(storyId)) return;
  running.add(storyId);
  let next: (() => void) | void;
  fn()
    .then((followUp) => {
      next = followUp;
    })
    .catch((err) => {
      console.error(`[${key}] ${storyId}`, err);
      const friendly =
        err instanceof StorytellerError || err instanceof PerformerError || (err instanceof Error && err.name === "ClassicsError")
          ? err.message
          : "Something went wrong. Please try again.";
      updateStory(storyId, { status: "error", error: friendly, progress: null });
      // What the storyteller wouldn't make is shown to the grown-ups, like what was turned down before it began.
      const story = err instanceof NotForChildrenError ? getStoryById(storyId) : null;
      if (story) {
        const s = story.settings;
        const asked = [s.description, s.text, s.extra].find((t) => t?.trim()) ?? (story.mode === "read" ? `Reading “${story.title}”` : "Photos for a new story");
        recordTurnedDown(story.householdId, { profileId: story.profileId, place: "pictures", kind: "pictures, pages or wishes that aren't for children", asked });
      }
      // Out of storyteller credit has an email of its own, already sent.
      if (!(err instanceof OutOfCreditError)) void alertStoryFailed(storyId, friendly).catch(() => undefined);
    })
    .finally(() => {
      running.delete(storyId);
      next?.();
    });
}

// -------------------------------------------------------------- writing

/** Write a story (or prepare a reading). `resumed` counts the times a restart has picked it up again. */
export function startWriting(storyId: string, resumed = 0) {
  const story = getStoryById(storyId);
  const work = story?.mode === "read" ? "reading" : "writing";
  const guess = story ? writingSeconds(story.settings, story.mode) : null;
  const startedAt = Date.now();
  const seconds = story && guess ? readyInSeconds(story, guess) : 5;
  updateStory(storyId, { status: "writing", error: null, progress: { step: "Opening the book", done: 0, total: 1, startedAt, seconds, ...(resumed ? { resumed } : {}) } });
  // Its turn in the line for the voices begins now: pages voiced as they're written, and the recording that follows,
  // all wait in this place.
  const place = { story: storyId, since: startedAt };
  launch("write", storyId, () =>
    forStory(place, async () => {
      const recordNext = await writeStory(storyId, place);
      if (guess) noteWorkTime(work, guess, startedAt);
      if (recordNext) return () => startRecording(storyId, place.since);
    }),
  );
}

/**
 * How long until a story the storyteller is about to write (taking about `writing` seconds, by the rule of thumb) is
 * ready to hear: the writing, then the voices, unless the family reads it over first. The family waits for both, so
 * the wait they're told is both.
 */
export function readyInSeconds(story: Story, writing: number): number {
  const voices = story.settings.review ? null : unwrittenRecordingSeconds(story);
  return expectedSeconds(story.mode === "read" ? "reading" : "writing", writing) + (voices ? expectedSeconds("recording", voices) : 0);
}

/**
 * About how long the storyteller takes to write (or prepare the reading of) a story, by its length, a little longer
 * when it reads photos first; null when there's no storyteller to wait for (words read just as they're written, or the
 * demo), which takes a moment. Twice the first guesses, which families found far too short; the waits also learn
 * from every story since (timing.ts).
 */
function writingSeconds(s: StorySettings, mode: string): number | null {
  if (!config.anthropicKey && config.demoMode) return null;
  if ((s.source === "classic" || s.source === "text") && !s.fullCast) return null;
  const photos = s.source === "book" || s.source === "book_read" || s.source === "wild" ? 30 : 0;
  if (mode === "read") return 90 + photos;
  return { short: 80, medium: 120, long: 180 }[s.length] + photos;
}

function pageCountFor(source: string, length: string, photos: number): number {
  const byLength = length === "short" ? 4 : length === "long" ? 9 : 6;
  if (source === "wild") return Math.max(Math.min(photos, 12), byLength);
  return byLength;
}

/** Write the story; true when the voices record it next (nobody's reading it over first). */
async function writeStory(storyId: string, place: Place): Promise<boolean> {
  const story = getStoryById(storyId);
  if (!story) return false;
  const book = getBook(story.householdId, story.bookId);
  if (!book) throw new Error("Book is missing");
  const s = story.settings;
  // Each step keeps when the writing started and about how long it takes.
  const progress = (step: string, done: number, total: number) => updateStory(storyId, { progress: { ...story.progress, step, done, total } });

  const voices = castableVoices(await voiceCatalog(story.householdId), s.narratorVoiceId);
  const narratorVoice = s.narratorVoiceId ?? voices.find((v) => v.persona)?.voiceId ?? voices[0]?.voiceId ?? "";

  // Text to read aloud, for classics and pasted words.
  let text: string | undefined;
  // A chapter of a classic before its last ends with the end of the chapter, not of the book.
  let moreChapters = false;
  if (s.source === "classic" && s.classic) {
    progress("Fetching the book from the library", 0, 1);
    const classic = await loadClassic(s.classic.gutenbergId);
    const chapter = classic.chapters[s.classic.chapter];
    if (!chapter) throw new StorytellerError("That chapter couldn't be found.");
    text = chapter.text;
    moreChapters = s.classic.chapter < classic.chapters.length - 1;
  } else if (s.source === "text") {
    text = s.text ?? "";
  }

  let script: StoryScript;
  if (text !== undefined && !s.fullCast) {
    // One reader, exact words: no storyteller needed, so it's instant and free.
    const sections = sectionText(text, 900);
    const language = guessLanguage(text);
    script = {
      title: story.title,
      synopsis:
        story.synopsis ??
        `Read aloud by ${personaFor(narratorVoice)?.name ?? voices.find((v) => v.voiceId === narratorVoice)?.name ?? "a storyteller"}.`,
      ambience: "a quiet room with a softly crackling fire",
      cast: [{ id: "narrator", name: "Reader", description: "The reader", voiceBrief: "warm and clear", voiceId: narratorVoice }],
      pages: sections.map((t, i) => ({ page: i + 1, picture: "", lines: [{ speaker: "narrator", text: t }] })),
      ...(language !== "en" ? { language } : {}),
    };
  } else {
    const pageRows = s.source === "idea" || text !== undefined ? [] : listPageRows(book.id);
    const images = await Promise.all(pageRows.map((p) => readImageForModel(story.householdId, p.image_path)));
    const pageCount =
      s.source === "book" || s.source === "book_read" ? images.length : pageCountFor(s.source, s.length, images.length);
    if ((s.source === "book" || s.source === "book_read") && pageCount === 0) {
      throw new StorytellerError("This book has no page photos yet. Add some pictures first.");
    }
    const req: StoryRequest = {
      mode: story.mode,
      bookTitle: book.title,
      bookKind: book.kind,
      settings: { ...s, narratorVoiceId: s.narratorVoiceId },
      images,
      pageCount,
      text,
      previousStories: previousStoriesForBook(book.id, story.id),
      rememberedCharacters: listBookCharacters(book.id),
      voices,
      // Nobody's reading it over first: each page is voiced as soon as it's written, while the storyteller writes the
      // rest, and the recording that follows finds it made (or still being made, and waits for it).
      ...(!s.review && config.elevenLabsKey ? { onPage: (page: ScriptPage, cast: Voices) => voiceEarly(storyDir(story.householdId, storyId), page, cast, place) } : {}),
    };
    const written =
      config.anthropicKey || !config.demoMode ? await writeScript(req, progress) : await writeDemoScript(req, progress);
    script = written.script;
    if (written.photoOrder) applyPhotoOrder(story.householdId, book.id, pageRows, written.photoOrder);
    if (story.mode === "read") script.title = story.title || script.title;
    if (written.cost > 0) {
      recordSpend(story.householdId, {
        storyId,
        service: "storyteller",
        kind: story.mode === "read" ? "read" : `write:${s.length}`,
        what: `${story.mode === "read" ? "Prepared the reading of" : "Wrote"} “${script.title}”`,
        spent: written.cost,
      });
    }
  }

  // Every story ends by saying so, so everyone knows it's over.
  script = withTheEnd(script, moreChapters);

  updateStory(storyId, {
    script,
    title: script.title,
    synopsis: script.synopsis,
    status: "draft",
    progress: null,
  });
  if (story.mode === "create") nameBookAfterStory(story.householdId, book.id, script.title);

  // A picture book: the illustrator reads the story and plans what to draw, ready for the family to meet the characters.
  if (s.pictures && story.mode === "create") planPicturesAfterWriting(storyId);
  return !s.review;
}

/** A page written while the rest of the story is still being written: voiced now (in the story's place in line), ready for the recording. */
function voiceEarly(dir: string, page: ScriptPage, voices: Voices, place: Place) {
  void forStory(place, () => fs.promises.mkdir(dir, { recursive: true }).then(() => cachedPerformance(dir, pageClip(page.page), page.lines, voices))).catch(
    (err) => console.warn(`Page ${page.page} will be voiced with the rest:`, err),
  );
}

/**
 * The storyteller spotted that the photos were out of order (often a book
 * photographed back to front): put the book's pages in reading order so the
 * player, the studio and every future story show the right picture.
 */
export function applyPhotoOrder(householdId: string, bookId: string, sent: PageRow[], order: number[]) {
  const current = listPageRows(bookId);
  // Only if nobody changed the pages while the story was being written.
  if (current.length !== sent.length || current.some((r, i) => r.image_path !== sent[i].image_path)) return;
  const paths = order.map((n) => sent[n - 1].image_path);
  replacePages(bookId, paths);
  const book = getBook(householdId, bookId);
  if (book && book.coverUrl === fileUrl(sent[0].image_path)) updateBook(householdId, bookId, { coverPath: paths[0] });
}

// ------------------------------------------------------------ recording

/**
 * Record a story. `since` is when its turn in line began (when it was started, for a story recorded as soon as it's
 * written); `resumed` counts the times a restart has picked it up again.
 */
export function startRecording(storyId: string, since = Date.now(), resumed = 0) {
  const story = getStoryById(storyId);
  const step = story?.audioUrl ? "Opening the recordings" : "Warming up the voices";
  const guess = story?.script ? recordingSeconds(story.script, story.settings, storyDir(story.householdId, storyId)) : null;
  const startedAt = Date.now();
  const seconds = guess ? expectedSeconds("recording", guess) : 5;
  updateStory(storyId, { status: "recording", error: null, progress: { step, done: 0, total: 1, startedAt, seconds, ...(resumed ? { resumed } : {}) } });
  launch("record", storyId, () =>
    forStory({ story: storyId, since }, async () => {
      try {
        await recordStory(storyId);
        // Only the making counts, not the waiting in line.
        if (guess) noteWorkTime("recording", guess, startedAt, turns.voices.waitedSeconds(storyId) + turns.binding.waitedSeconds(storyId));
      } finally {
        turns.voices.forget(storyId);
        turns.binding.forget(storyId);
      }
    }),
  );
}

/**
 * A story being recorded, as its family should see it. Waiting its turn for a free storyteller, with nothing being
 * made for it, it says so, with its place in line and about how long; and the time it has spent waiting is added to
 * the wait it was told, which counted only the making.
 */
export function withPlaceInLine(story: Story): Story {
  const p = story.progress;
  if (story.status !== "recording" || !p?.startedAt || !p.seconds) return story;
  const waited = turns.voices.waitedSeconds(story.id) + turns.binding.waitedSeconds(story.id);
  const place = turns.voices.placeOf(story.id);
  if (!place) return waited ? { ...story, progress: { ...p, seconds: Math.round(p.seconds + waited) } } : story;
  const left = p.total > 0 ? 1 - p.done / p.total : 1;
  const step = `Waiting for a free storyteller · ${place.ahead ? `${ordinal(place.ahead + 1)} in line` : "next in line"}`;
  return { ...story, progress: { ...p, step, startedAt: Date.now(), seconds: Math.round(place.seconds + p.seconds * left) } };
}

/** "2nd", "3rd", "11th", "21st" */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

// ------------------------------------------------------------ after a restart

const INTERRUPTED = 'The storyteller was interrupted. Press "Try again" to pick up where it left off.';

/**
 * A story a restart stopped midway (an update, say) carries on by itself: the writing starts again, or the recording
 * picks up with the pages already made. One that has already been picked up twice is let go, with a word to try again,
 * so a story that keeps stopping the app can't keep it from starting.
 */
export function resumeLostStory(storyId: string) {
  const story = getStoryById(storyId);
  if (!story || (story.status !== "writing" && story.status !== "recording") || isRunning(storyId)) return;
  const resumed = (story.progress?.resumed ?? 0) + 1;
  if (resumed > 2) {
    updateStory(storyId, { status: "error", error: INTERRUPTED, progress: null });
    return;
  }
  // It keeps its place in line: when it was started.
  if (story.status === "recording" && story.script) startRecording(storyId, story.progress?.startedAt ?? Date.now(), resumed);
  else startWriting(storyId, resumed);
}

/** Once the app has started: every story it stopped midway carries on. */
export function resumeLostStoriesSoon() {
  setTimeout(() => {
    try {
      for (const id of storiesBeingMade()) {
        try {
          resumeLostStory(id);
        } catch (err) {
          console.error(`[story] ${id}: couldn't carry on after a restart`, err);
        }
      }
    } catch (err) {
      console.error("[story] couldn't look for stories to carry on with", err);
    }
  }, 2_000).unref();
}

/**
 * About how long the voices take to record a story, by the rule of thumb: only what isn't made yet counts (switching
 * sound effects on keeps the voices, so it's just the new sounds). Null for the demo's voices, which take a moment.
 */
function recordingSeconds(script: StoryScript, s: StorySettings, dir: string): number | null {
  if (!config.elevenLabsKey && config.demoMode) return null;
  const toVoice = script.pages.filter((p) => !isRecorded(dir, pageClip(p.page), p.lines, script));
  return voicingSeconds(
    toVoice.map((p) => p.lines.reduce((n, l) => n + stripTags(l.text).length, 0)),
    {
      welcome: s.intro && !fs.existsSync(path.join(dir, "intro-a.json")),
      soundscape: Boolean(s.ambience && script.ambience && !fs.existsSync(ambienceFile(dir, script.ambience))),
      effects: !s.effects ? 0 : script.effects ? script.effects.filter((cue) => !fs.existsSync(effectFile(dir, cue))).length : null,
    },
  );
}

/**
 * The same, for a story not written yet, as long as stories like it usually run. Its pages are voiced as they're
 * written, so what's left once the writing's done is about the last page, with the welcome and sounds alongside it,
 * and the binding.
 */
function unwrittenRecordingSeconds(story: Story): number | null {
  if (!config.elevenLabsKey && config.demoMode) return null;
  const s = story.settings;
  const photos = s.source === "book" || s.source === "book_read" || s.source === "wild" ? listPageRows(story.bookId).length : 0;
  // A book read aloud from its photos: about 200 letters a page. Anything else, by the length chosen.
  const chars =
    s.source === "book_read"
      ? photos * 200
      : s.source === "text"
        ? (s.text ?? "").length
        : (s.source === "book" ? estimateMinutes(s.length, Math.max(1, photos)) : LENGTHS[s.length].minutes) * WORDS_PER_MINUTE * 6;
  const pages = s.source === "book_read" ? photos : s.source === "text" ? Math.ceil(chars / 900) : pageCountFor(s.source, s.length, photos);
  return voicingSeconds([chars / Math.max(1, pages)], { welcome: s.intro, soundscape: s.ambience, effects: s.effects ? null : 0 });
}

/**
 * The rule of thumb for voicing pages of these many letters: each takes about 0.6 seconds for every second it's heard,
 * several at a time (VOICES_AT_ONCE), so the longest page or all of them shared out, whichever is longer. The welcome,
 * a soundscape and the sound effects are made alongside (`effects` is how many to make, or null when they're still to
 * be chosen, a quick word with the storyteller), and then it's all bound together. The waits also learn from every
 * story (timing.ts).
 */
function voicingSeconds(pages: number[], extras: { welcome: boolean; soundscape: boolean; effects: number | null }): number {
  const heard = pages.map((chars) => chars / 15);
  const voices = Math.max(Math.max(0, ...heard) * 0.6, (heard.reduce((a, b) => a + b, 0) * 0.6) / config.voicesAtOnce);
  const effects = extras.effects === null ? 25 : 3 * extras.effects;
  return Math.round(20 + voices + (extras.welcome ? 4 : 0) + (extras.soundscape ? 6 : 0) + effects);
}

function introLines(
  script: StoryScript,
  opts: { chime: boolean; mode: string; source: string; bookTitle: string },
): { before: ScriptLine[]; after: ScriptLine[] } {
  const narrator = script.cast.find((c) => c.id === "narrator");
  const persona = narrator ? personaFor(narrator.voiceId) : undefined;
  const chapter = stripTags(script.title);
  // In the story's own language: "Welcome to Storyhollow…", "Bienvenue à Storyhollow…".
  const say = SAYINGS[languageOf(script.language)];
  // A chapter of a classic is introduced with its book: "The Wind in the Willows: The River Bank".
  const title = opts.mode === "read" && opts.bookTitle && chapter !== opts.bookTitle ? `${opts.bookTitle}: ${chapter}` : chapter;
  const readBy = opts.mode === "read" && persona ? say.readBy(persona.name) : "";
  const bookish = opts.source === "book" || opts.source === "book_read";
  if (opts.chime && bookish) {
    return {
      before: [{ speaker: "narrator", text: `[warmly] ${say.welcome(title, readBy)} ${say.followAlong}` }],
      after: [{ speaker: "narrator", text: say.firstPage }],
    };
  }
  return { before: [{ speaker: "narrator", text: `[warmly] ${say.welcome(title, readBy)} ${say.snuggleIn}` }], after: [] };
}

function hashOf(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Who has which voice, and the language: all a set of lines needs to be performed. */
type Voices = Pick<StoryScript, "cast" | "language">;

interface CachedClip {
  hash: string;
  words: Clip["words"];
}

const pageClip = (page: number) => `page-${String(page).padStart(3, "0")}`;

/** What a set of lines sounds like: the words, who says them, the voice model and the language. Recorded again only when it changes. */
function performanceHash(lines: ScriptLine[], script: Voices): string {
  const voices = Object.fromEntries(script.cast.map((c) => [c.id, c.voiceId]));
  const language = languageOf(script.language);
  return hashOf({
    lines,
    voices: lines.map((l) => voices[l.speaker]),
    model: config.voiceModel,
    demo: !config.elevenLabsKey,
    // (English stories were recorded before languages: their recordings stay as they are)
    ...(language !== "en" ? { language } : {}),
  });
}

/** Whether a set of lines is recorded already, unchanged. */
function isRecorded(dir: string, name: string, lines: ScriptLine[], script: Voices): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")) as CachedClip).hash === performanceHash(lines, script);
  } catch {
    return false;
  }
}

/**
 * Recordings being made right now, by where they'll be kept and what they say. One asked for again meanwhile (a page
 * voiced while the story was still being written, then by the recording) is waited for rather than made twice.
 */
const making = (globalForJobs.__storyhollowMaking ??= new Map());

/** Record a set of lines, reusing the saved audio if nothing changed. */
async function cachedPerformance(dir: string, name: string, lines: ScriptLine[], script: Voices): Promise<Clip> {
  const hash = performanceHash(lines, script);
  const pcmPath = path.join(dir, `${name}.pcm`);
  const metaPath = path.join(dir, `${name}.json`);
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf8")) as CachedClip;
    if (meta.hash === hash) return { samples: pcm16ToFloat(await fs.promises.readFile(pcmPath)), words: meta.words };
  } catch {
    // not recorded yet
  }
  const key = `${pcmPath}#${hash}`;
  const already = making.get(key);
  // (If that one didn't come, it's made again here.)
  const madeAlready = already && (await already.catch(() => null));
  if (madeAlready) return madeAlready;
  const work = (async () => {
    const clip = await performLines(lines, script.cast, languageOf(script.language));
    await fs.promises.writeFile(pcmPath, floatToPcm16(clip.samples));
    await fs.promises.writeFile(metaPath, JSON.stringify({ hash, words: clip.words } satisfies CachedClip));
    return clip;
  })();
  making.set(key, work);
  try {
    return await work;
  } finally {
    if (making.get(key) === work) making.delete(key);
  }
}

async function recordStory(storyId: string) {
  const story = getStoryById(storyId);
  if (!story?.script) throw new Error("Nothing to record yet");
  const { script, settings } = story;
  const dir = storyDir(story.householdId, storyId);
  await fs.promises.mkdir(dir, { recursive: true });

  // Everything is asked for at once, and ElevenLabs makes a few at a time (performer.ts keeps to the account's limit):
  // the welcome, every page, the soundscape, and each page's sound effects once its words are timed. Each piece
  // counts as it's done; then it's all bound together.
  const soundscape = Boolean(settings.ambience && script.ambience);
  const total = script.pages.length + (settings.intro ? 1 : 0) + (soundscape ? 1 : 0) + (settings.effects ? 1 : 0) + 1;
  let done = 0;
  const report = (step: string) => updateStory(storyId, { progress: { ...story.progress, step, done, total } });
  const counted = async <T>(work: Promise<T>): Promise<T> => {
    const value = await work;
    done++;
    report("Recording the voices");
    return value;
  };
  report("Recording the voices");

  const bookTitle = getBook(story.householdId, story.bookId)?.title ?? "";
  const welcome = settings.intro
    ? counted(
        (async () => {
          const lines = introLines(script, { chime: settings.chime.enabled, mode: story.mode, source: settings.source, bookTitle });
          const [before, after] = await Promise.all([cachedPerformance(dir, "intro-a", lines.before, script), cachedPerformance(dir, "intro-b", lines.after, script)]);
          return { before, after };
        })(),
      )
    : null;
  const ambience = soundscape ? counted(cachedAmbience(dir, script.ambience)) : null;
  // The sound effects are chosen (the first time) while the voices record. A story is still lovely without them, so
  // a hiccup with them never stops it.
  const cues = settings.effects
    ? chooseEffects(storyId, script).catch((err) => {
        console.warn("Sound effects unavailable:", err);
        return [];
      })
    : null;

  // Every page is asked for at once, so the story holds its place in line for all of them (line.ts gives them their
  // turns, the earliest story's first, a few at a time).
  const pages: { page: number; clip: Clip }[] = new Array(script.pages.length);
  const pageSounds: Promise<PlacedEffect[]>[] = new Array(script.pages.length);
  const voicing = script.pages.map(async (p, i) => {
    const clip = await counted(cachedPerformance(dir, pageClip(p.page), p.lines, script));
    pages[i] = { page: p.page, clip };
    if (cues) pageSounds[i] = pageEffects(dir, p, clip, cues);
  });
  const [intro, ambienceSound] = await Promise.all([welcome, ambience, Promise.all(voicing)]);
  const effects = cues ? (await counted(Promise.all(pageSounds))).flatMap((e) => e ?? []) : [];

  report("Binding the story together");
  await finishMix(storyId, dir, { pages, intro, ambience: ambienceSound, effects });

  if (story.mode === "create") {
    rememberCharacters(
      story.bookId,
      script.cast
        .filter((c) => c.id !== "narrator")
        .map((c) => ({ name: c.name, description: c.description || c.voiceBrief, voiceId: c.voiceId })),
    );
  }
}

const ambienceFile = (dir: string, description: string) => path.join(dir, `ambience-${hashOf({ description, demo: !config.elevenLabsKey })}.pcm`);

async function cachedAmbience(dir: string, description: string): Promise<Float32Array | null> {
  const pcmPath = ambienceFile(dir, description);
  try {
    return pcm16ToFloat(await fs.promises.readFile(pcmPath));
  } catch {
    const loop = await performAmbience(description);
    if (loop) await fs.promises.writeFile(pcmPath, floatToPcm16(loop));
    return loop;
  }
}

// ------------------------------------------------------------ sound effects

const tokens = (text: string) => text.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * When a cue's word is spoken, in seconds from the start of its page's
 * recording. Null when the word is no longer on the page (it was edited).
 */
export function cueTime(page: ScriptPage, clip: Clip, cue: SoundCue): number | null {
  const counts = page.lines.map((l) => tokens(l.text).length);
  const lineStart = counts.slice(0, cue.line).reduce((n, c) => n + c, 0);
  const inLine = tokens(page.lines[cue.line]?.text ?? "").findIndex((w) => bare(w) === bare(cue.word));
  const onPage = inLine >= 0 ? lineStart + inLine : page.lines.flatMap((l) => tokens(l.text)).findIndex((w) => bare(w) === bare(cue.word));
  if (onPage < 0) return null;
  if (!clip.words.length) return 0;
  // Spoken words can drift a little from the written ones; take the nearest match.
  let at = Math.min(onPage, clip.words.length - 1);
  for (let d = 0; d <= 8; d++) {
    const k = [onPage - d, onPage + d].find((i) => clip.words[i] && bare(clip.words[i].w) === bare(cue.word));
    if (k !== undefined) {
      at = k;
      break;
    }
  }
  return Math.max(0, clip.words[at].t - 0.05);
}

const effectFile = (dir: string, cue: SoundCue) =>
  path.join(dir, `sfx-${hashOf({ sound: cue.sound, seconds: cue.seconds, demo: !config.elevenLabsKey })}.pcm`);

/** Choose the sound effects (once per script), make any not yet made, and place them. */
/** The story's sound effects: chosen by the storyteller the first time (and kept with the script), then the same each time. */
async function chooseEffects(storyId: string, script: StoryScript): Promise<SoundCue[]> {
  if (script.effects) return script.effects;
  if (config.anthropicKey || !config.demoMode) {
    const { cues, cost } = await spotSoundEffects(script);
    script.effects = cues;
    const householdId = getStoryById(storyId)?.householdId;
    if (householdId && cost > 0) {
      recordSpend(householdId, { storyId, service: "storyteller", kind: "sounds", what: `Chose the sound effects for “${script.title}”`, spent: cost });
    }
  } else {
    script.effects = demoSoundCues(script);
  }
  updateStory(storyId, { script });
  return script.effects;
}

/** A page's sound effects, made (or found made already) once its words are timed, each placed on its word. */
async function pageEffects(dir: string, page: ScriptPage, clip: Clip, cues: Promise<SoundCue[]>): Promise<PlacedEffect[]> {
  try {
    const placed: PlacedEffect[] = [];
    for (const cue of (await cues).filter((c) => c.page === page.page)) {
      const at = cueTime(page, clip, cue);
      if (at === null) continue;
      const file = effectFile(dir, cue);
      let samples: Float32Array;
      try {
        samples = pcm16ToFloat(await fs.promises.readFile(file));
      } catch {
        samples = await performSoundEffect(cue.sound, cue.seconds);
        await fs.promises.writeFile(file, floatToPcm16(samples));
      }
      placed.push({ page: cue.page, at, samples });
    }
    return placed;
  } catch (err) {
    console.warn(`Sound effects for page ${page.page} unavailable:`, err);
    return [];
  }
}

async function finishMix(
  storyId: string,
  dir: string,
  parts: { pages: { page: number; clip: Clip }[]; intro: { before: Clip; after: Clip } | null; ambience: Float32Array | null; effects: PlacedEffect[] },
) {
  const story = getStoryById(storyId)!;
  // One story is put together at a time, the earliest first, so each is done as soon as it can be.
  const { timeline } = await turns.binding.run(async () => {
    const mix = await mixStory({ ...parts, chime: story.settings.chime });
    await fs.promises.writeFile(path.join(dir, "story.mp3"), await encodeMp3(mix.samples));
    return mix;
  });
  forgetVoiceCredits(); // the recording used some: the next look at the balance asks again
  void checkVoiceCreditLow().catch(() => undefined);
  updateStory(storyId, {
    status: "ready",
    progress: null,
    error: null,
    audioPath: `stories/${storyId}/story.mp3`,
    timeline,
    duration: timeline.duration,
  });
}

/**
 * Re-bind an already-recorded story with new chime or pause settings. Uses
 * the saved recordings, so it costs no voice credits.
 */
export async function remixStory(storyId: string): Promise<boolean> {
  const story = getStoryById(storyId);
  if (!story?.script) return false;
  const dir = storyDir(story.householdId, storyId);
  const load = async (name: string): Promise<Clip | null> => {
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(dir, `${name}.json`), "utf8")) as CachedClip;
      return { samples: pcm16ToFloat(await fs.promises.readFile(path.join(dir, `${name}.pcm`))), words: meta.words };
    } catch {
      return null;
    }
  };
  const pages: { page: number; clip: Clip }[] = [];
  for (const p of story.script.pages) {
    const clip = await load(pageClip(p.page));
    if (!clip) return false;
    pages.push({ page: p.page, clip });
  }
  let intro: { before: Clip; after: Clip } | null = null;
  if (story.settings.intro) {
    const before = await load("intro-a");
    const after = await load("intro-b");
    if (!before || !after) return false;
    intro = { before, after };
  }
  let ambience: Float32Array | null = null;
  if (story.settings.ambience && story.script.ambience) {
    try {
      ambience = pcm16ToFloat(
        await fs.promises.readFile(path.join(dir, `ambience-${hashOf({ description: story.script.ambience, demo: !config.elevenLabsKey })}.pcm`)),
      );
    } catch {
      return false;
    }
  }
  const effects: PlacedEffect[] = [];
  if (story.settings.effects) {
    if (!story.script.effects) return false;
    for (const cue of story.script.effects) {
      const i = story.script.pages.findIndex((p) => p.page === cue.page);
      const at = i >= 0 ? cueTime(story.script.pages[i], pages[i].clip, cue) : null;
      if (at === null) continue;
      try {
        effects.push({ page: cue.page, at, samples: pcm16ToFloat(await fs.promises.readFile(effectFile(dir, cue))) });
      } catch {
        return false;
      }
    }
  }
  await finishMix(storyId, dir, { pages, intro, ambience, effects });
  return true;
}

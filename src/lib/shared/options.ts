import type {
  AgeBand,
  BookKind,
  ChimeStyle,
  LengthPreset,
  Mood,
  StorySettings,
} from "./types";

/** Unhurried read-aloud pace for young listeners. */
export const WORDS_PER_MINUTE = 140;

export const LENGTHS: Record<LengthPreset, { label: string; minutes: number; blurb: string }> = {
  short: { label: "Short & sweet", minutes: 3, blurb: "About 3 minutes" },
  medium: { label: "Just right", minutes: 6, blurb: "About 6 minutes" },
  long: { label: "Long & cozy", minutes: 10, blurb: "About 10 minutes" },
};

export const MOODS: Record<Mood, { label: string; emoji: string; direction: string }> = {
  bedtime: {
    label: "Cozy bedtime",
    emoji: "🌙",
    direction:
      "A soothing bedtime story. Warm and gentle, with the energy winding down page by page until the last page feels sleepy, safe and quiet.",
  },
  silly: {
    label: "Silly & giggly",
    emoji: "🤪",
    direction:
      "Playful and funny: delightful nonsense, funny sounds, silly misunderstandings, a running joke that pays off at the end.",
  },
  adventure: {
    label: "Brave adventure",
    emoji: "🧭",
    direction:
      "An exciting quest with a little peril that always feels safe, clever problem-solving and a triumphant, heart-lifting ending.",
  },
  mystery: {
    label: "Mystery",
    emoji: "🔍",
    direction:
      "A real mystery to solve: a puzzling problem, clues along the way that a sharp listener can spot (and in the pictures, when there are some), a red herring or two, a curious hero who notices things, and a satisfying \"aha!\" that makes sense of every clue. Exciting but never scary, and kind in the end.",
  },
  heartwarming: {
    label: "Heartwarming",
    emoji: "💛",
    direction:
      "Tender and emotional in a good way: friendship, belonging, kindness, and an ending that feels like a hug.",
  },
  spooky: {
    label: "Spooky-ish",
    emoji: "🎃",
    direction:
      "Delightfully spooky but never frightening: creaky doors, friendly ghosts, shadows that turn out to be something lovely. Always reassuring.",
  },
};

export const AGES: Record<AgeBand, { label: string; guidance: string }> = {
  "2-3": {
    label: "Ages 2–3",
    guidance:
      "Very simple words, short sentences, lots of repetition and a refrain they can join in with, animal sounds, naming things in the picture.",
  },
  "4-5": {
    label: "Ages 4–5",
    guidance:
      "Simple, vivid language with a sprinkle of delicious new words, a clear problem and solution, a repeating phrase, gentle humor.",
  },
  "6-8": {
    label: "Ages 6–8",
    guidance:
      "Richer vocabulary and longer sentences, real stakes, wit, characters with feelings and motivations, a twist they won't see coming.",
  },
  "9-12": {
    label: "Ages 9–12",
    guidance:
      "Sophisticated storytelling: layered characters, clever wordplay, atmosphere, real emotional depth and a satisfying arc.",
  },
};

export const CHIMES: Record<ChimeStyle, { label: string; emoji: string }> = {
  bell: { label: "Tinkling bell", emoji: "🔔" },
  sparkle: { label: "Wand sparkle", emoji: "✨" },
  windchime: { label: "Wind chime", emoji: "🎐" },
};

export const AVATARS = ["🦉", "🦊", "🐻", "🐰", "🐉", "🦄", "🐱", "🦔", "🐼", "🐸", "🦁", "🐢", "🐧", "🦋", "🐿️", "🐳"];

export const PROFILE_COLORS = ["#b8433a", "#2f6b4f", "#2d4f86", "#b07a1f", "#6e3b7a", "#3f7f86", "#a1506d", "#5b6b2b"];

export const DEFAULT_SHELVES: Record<BookKind, string> = {
  shadow_book: "Shadow Books",
  picture_book: "Picture Books",
  wild: "Tales from the Wild",
  idea: "Dreamed-Up Tales",
  classic: "The Classic Treasury",
  own_text: "Letters & Poems",
};

export const BOOK_KINDS: Record<BookKind, { label: string; emoji: string }> = {
  shadow_book: { label: "Shadow book", emoji: "🔦" },
  picture_book: { label: "Picture book", emoji: "📕" },
  wild: { label: "From the wild", emoji: "🌿" },
  idea: { label: "Dreamed up", emoji: "💭" },
  classic: { label: "Classic", emoji: "📜" },
  own_text: { label: "Our words", emoji: "✉️" },
};

/** What a new book is called when the family doesn't name it: a dreamed-up one goes by the first words of its idea. */
export function madeUpBookTitle(kind: BookKind, idea?: string | null): string {
  if (kind === "wild") return "Our Adventure";
  if (kind === "idea") return (idea ?? "").trim().split(/[.!?\n]/)[0].slice(0, 60).trim() || "A Dreamed-Up Tale";
  return "My Book";
}

/** A dreamed-up book (or one from the wild) that nobody named, and so takes the title of its first story. */
export function namedByItsStory(book: { kind: BookKind; title: string; notes: string | null }): boolean {
  return (book.kind === "idea" || book.kind === "wild") && book.title === madeUpBookTitle(book.kind, book.notes);
}

/** The order shelves appear in the library; custom shelves come after these. */
export const SHELF_ORDER = [
  "Shadow Books",
  "Picture Books",
  "Tales from the Wild",
  "Dreamed-Up Tales",
  "The Classic Treasury",
  "Letters & Poems",
];

export function defaultSettings(overrides: Partial<StorySettings> = {}): StorySettings {
  return {
    source: "book",
    length: "medium",
    mood: "bedtime",
    age: "4-5",
    heroes: [],
    lesson: "",
    extra: "",
    surprise: false,
    keepNames: true,
    description: "",
    narratorVoiceId: null,
    fullCast: true,
    chime: { enabled: true, style: "bell", gapSeconds: 3 },
    intro: true,
    ambience: false,
    effects: false,
    review: true,
    ...overrides,
  };
}

/** Target words for one page of narration, given the book length and page count. */
export function wordsPerPage(length: LengthPreset, pageCount: number): number {
  const total = LENGTHS[length].minutes * WORDS_PER_MINUTE;
  const perPage = Math.round(total / Math.max(1, pageCount));
  return Math.min(220, Math.max(25, perPage));
}

export function estimateMinutes(length: LengthPreset, pageCount: number): number {
  return Math.max(1, Math.round((wordsPerPage(length, pageCount) * Math.max(1, pageCount)) / WORDS_PER_MINUTE));
}

/** "a few seconds", "about 30 seconds", "about a minute", "about 2 minutes". */
export function aboutTime(seconds: number): string {
  if (seconds <= 10) return "a few seconds";
  if (seconds < 50) return `about ${Math.round(seconds / 10) * 10} seconds`;
  if (seconds < 90) return "about a minute";
  return `about ${Math.round(seconds / 60)} minutes`;
}

// How long the slower things usually take, for the waits that say so.

/** The storyteller copying out the words in a few photos. */
export const readingWordsSeconds = (pictures: number) => 10 + 6 * pictures;
/** ElevenLabs conjuring three voices from a description, and keeping the one chosen. */
export const DESIGN_VOICES_SECONDS = 20;
export const KEEP_VOICE_SECONDS = 5;
/** ElevenLabs learning a voice from `ms` of recordings: cleaning up background noise takes longer. */
export const familyVoiceSeconds = (ms: number, cleanNoise: boolean) => Math.round((10 + (ms / 60_000) * 4) * (cleanNoise ? 1.6 : 1));
/** Binding a story `seconds` long together again with new sounds (its voices are kept). */
export const rebindSeconds = (seconds: number | null) => Math.round(3 + (seconds ?? 300) / 40);

/** How a wait is going, in words: what's left, or that it's taking longer than usual. */
export function timeLeft(startedAt: number, seconds: number, now: number): string {
  const elapsed = Math.max(0, (now - startedAt) / 1000);
  if (elapsed < seconds) return `${aboutTime(seconds - elapsed)} left`;
  return elapsed > seconds * 1.5 ? "taking a little longer than usual" : "almost done";
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  return `${Math.round(seconds / 60)} min`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

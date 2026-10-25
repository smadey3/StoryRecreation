// Shapes shared by the server, the API routes and the browser.

export type BookKind =
  | "shadow_book" // a projector / flashlight book: pages are silhouettes
  | "picture_book" // a physical picture book you own
  | "wild" // photos of something you saw out in the world
  | "idea" // a story dreamed up from a description alone
  | "classic" // a public-domain book from Project Gutenberg
  | "own_text"; // text you pasted in (a poem, a letter from Grandma...)

export type StoryMode = "create" | "read";

export type StoryStatus = "writing" | "draft" | "recording" | "ready" | "error";

export type Mood = "bedtime" | "silly" | "adventure" | "mystery" | "heartwarming" | "spooky";
export type LengthPreset = "short" | "medium" | "long";
export type AgeBand = "2-3" | "4-5" | "6-8" | "9-12";
export type ChimeStyle = "bell" | "sparkle" | "windchime";

export interface Profile {
  id: string;
  name: string;
  avatar: string;
  color: string;
  age: number | null;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  kind: BookKind;
  shelf: string;
  /** The folder it's kept in on its shelf, if any. */
  folder: string | null;
  /** Starred by the family, to find it among their favorites. */
  favorite: boolean;
  coverUrl: string | null;
  sourceRef: string | null;
  notes: string | null;
  pageCount: number;
  storyCount: number;
  createdAt: number;
}

export interface BookPage {
  id: string;
  pageNumber: number;
  imageUrl: string;
}

export interface CastMember {
  /** "narrator" or a short slug like "ollie-owl" */
  id: string;
  name: string;
  /** Who this character is in the story. */
  description: string;
  /** What they should sound like, in plain words (used for casting & voice design). */
  voiceBrief: string;
  voiceId: string;
}

export interface ScriptLine {
  speaker: string;
  text: string;
}

/** A little moving touch drawn over a page's picture while it's read ("living pictures"). */
export type SceneEffect = "none" | "sparkles" | "snow" | "rain" | "fireflies" | "leaves" | "stars" | "bubbles" | "petals";

export interface ScriptPage {
  /** 1-based page number; 0 is reserved for the read-along intro. */
  page: number;
  /** What the storyteller saw in the picture (helps grown-ups check the match). */
  picture: string;
  lines: ScriptLine[];
  /** Chosen by the storyteller to suit the scene. */
  effect?: SceneEffect;
  /** For a story in another language: the page's words in English, for the family to see when they want. */
  translation?: string;
}

/** One short sound effect, landing on a word as it's spoken. */
export interface SoundCue {
  /** The page it belongs to (1-based). */
  page: number;
  /** Which line on that page (0-based). */
  line: number;
  /** The word in that line where the sound happens, e.g. "creaked". */
  word: string;
  /** What the sound is, for the sound generator: "a small wooden door creaks open". */
  sound: string;
  /** About how long it lasts. */
  seconds: number;
}

export interface StoryScript {
  title: string;
  synopsis: string;
  /** A short sound description for an optional looping background bed. */
  ambience: string;
  cast: CastMember[];
  pages: ScriptPage[];
  /** Sound effects chosen for this script, once they've been asked for. */
  effects?: SoundCue[];
  /** The language it's told in (English when it isn't said). */
  language?: StoryLanguage;
}

export interface ChimeSettings {
  enabled: boolean;
  style: ChimeStyle;
  /** Quiet seconds after the chime so little hands can turn the page. */
  gapSeconds: number;
}

export type StorySource =
  | "book" // a new story for a physical book's pictures
  | "wild" // photos of something seen in the world
  | "idea" // description only
  | "classic" // read a public-domain book aloud
  | "book_read" // read your own book aloud from page photos
  | "text"; // read pasted text aloud

/** The languages a story can be told in. */
export type StoryLanguage = "en" | "fr" | "es";

export interface StorySettings {
  source: StorySource;
  length: LengthPreset;
  mood: Mood;
  age: AgeBand;
  heroes: string[];
  lesson: string;
  extra: string;
  /** The language to tell it in (English when it isn't said). */
  language?: StoryLanguage;
  /** For someone learning that language: simpler words, at a gentler pace. */
  learner?: boolean;
  surprise: boolean;
  /** Keep character names printed in the book, so familiar friends get new adventures. */
  keepNames: boolean;
  description: string;
  /** null = let the casting director choose */
  narratorVoiceId: string | null;
  fullCast: boolean;
  chime: ChimeSettings;
  intro: boolean;
  /** A continuous soundscape under the whole story. */
  ambience: boolean;
  /** A few short sound effects at just the right moments. */
  effects: boolean;
  review: boolean;
  /** Draw pictures for it too: a picture book (stories dreamed up from an idea). */
  pictures?: boolean;
  artStyle?: ArtStyle;
  /** For read-aloud: a classic chapter reference. */
  classic?: { gutenbergId: number; chapter: number };
  /** For read-aloud of pasted text. */
  text?: string;
}

export interface StoryProgress {
  step: string;
  done: number;
  total: number;
  /** When the writing or recording started, and about how long it takes, in seconds: so the family knows how long to wait. */
  startedAt?: number;
  seconds?: number;
  /** How many times a restart (an update, say) has picked it up again. */
  resumed?: number;
}

export interface TimelineWord {
  /** start time (seconds, absolute in the story audio) */
  t: number;
  /** end time */
  e: number;
  w: string;
  speaker: string;
}

export interface TimelinePage {
  page: number;
  /** When this page's narration starts. */
  start: number;
  /** When the narration for this page finishes. */
  speechEnd: number;
  /** When the page-turn chime rings (null if no chime after this page). */
  chimeAt: number | null;
  /** When the next page begins. */
  next: number;
  words: TimelineWord[];
}

export interface StoryTimeline {
  duration: number;
  pages: TimelinePage[];
}

export type ArtStyle = "watercolor" | "gouache" | "pencil" | "papercut" | "shadow";

/** A character the illustrator draws, and the sketches the family chose between. */
export interface ArtCharacter {
  /** The cast id, or a short slug for someone who never speaks. */
  id: string;
  name: string;
  /** What they look like, in plain words. The family can change it. */
  look: string;
  /** Sketched first, then drawn from the chosen sketch on every page, so they look the same throughout. */
  main: boolean;
  /** A child's own drawing of them, when the family added one. */
  drawing: string | null;
  sketches: string[];
  /** Which sketch is them (an index into sketches). */
  chosen: number | null;
}

/** What to draw on one page. */
export interface ArtScene {
  page: number;
  scene: string;
  /** Ids of the characters in the picture. */
  characters: string[];
}

/** What the illustrator is doing right now, so the family can see it at work and how long it takes. */
export interface ArtJob {
  kind: "planning" | "sketching" | "drawing";
  /** Sketching just one character: who. */
  characterId?: string;
  /** Sketching: whose each sketch is, in the order they're made (a character's id once for each of their sketches). */
  whose?: string[];
  /** Drawing: the cover (0) and the pages being drawn. */
  targets?: number[];
  /** How many pictures it makes, and which are finished (sketch numbers, or the cover and page numbers). */
  total: number;
  finished: number[];
  /** Pictures that didn't come the first time, waiting to be tried once more. */
  retrying?: number[];
  startedAt: number;
  /** About how long it takes, in seconds. */
  seconds: number;
  /** The approved purchase it's drawn on, so it can carry on by itself after a restart. */
  purchaseId?: string;
  /** Drawing: the family's note about what to change. */
  note?: string;
}

/** What the illustrator's last problem was with, so it's shown there: the planning, a character's sketches, or the pictures not drawn. */
export interface ArtProblem {
  kind: ArtJob["kind"];
  characterId?: string;
  /** Sketching: the characters whose sketches didn't all come. */
  characterIds?: string[];
  targets?: number[];
}

/** A character's chosen picture in another of the family's books, to use again for free. */
export interface DrawnBefore {
  storyId: string;
  title: string;
  /** Its file address (its stored path, on the server). */
  picture: string;
  /** The style it was drawn in: a character brings their style to every page they're on. */
  style: ArtStyle;
}

/** A picture book's pictures. Pictures are file URLs (paths, in the database); stand-ins are .svg. */
export interface StoryArt {
  style: ArtStyle;
  /** What the illustrator is doing right now. */
  status: "idle" | "planning" | "sketching" | "drawing";
  progress: StoryProgress | null;
  error: string | null;
  /** What `error` is about. */
  problem?: ArtProblem | null;
  characters: ArtCharacter[];
  coverScene: string;
  scenes: ArtScene[];
  cover: string | null;
  /** One picture per page (index = page - 1), null until drawn. */
  pages: (string | null)[];
  /** While the illustrator works. */
  job?: ArtJob | null;
}

export interface Story {
  id: string;
  bookId: string;
  profileId: string | null;
  mode: StoryMode;
  title: string;
  synopsis: string | null;
  settings: StorySettings;
  script: StoryScript | null;
  status: StoryStatus;
  progress: StoryProgress | null;
  error: string | null;
  audioUrl: string | null;
  timeline: StoryTimeline | null;
  duration: number | null;
  favorite: boolean;
  playCount: number;
  lastPlayedAt: number | null;
  createdAt: number;
  /** Its own pictures, when it's a picture book. */
  art: StoryArt | null;
}

export interface StoryCard {
  id: string;
  bookId: string;
  bookTitle: string;
  bookKind: BookKind;
  /** The story's own cover when it's a picture book, otherwise its book's. */
  coverUrl: string | null;
  profileId: string | null;
  mode: StoryMode;
  title: string;
  synopsis: string | null;
  status: StoryStatus;
  duration: number | null;
  favorite: boolean;
  playCount: number;
  lastPlayedAt: number | null;
  createdAt: number;
  /** The voice reading the narration, once the story has been written. */
  narratorVoiceId: string | null;
  /** How the family knows that voice, filled in where cards are shown. */
  narrator?: VoiceLabel | null;
  /** The language it's told in, when it isn't English. */
  language?: StoryLanguage;
}

/** A voice as the family knows it: "Professor Hoot" 🦉, "Gram T" 💛. */
export interface VoiceLabel {
  name: string;
  emoji: string;
}

export interface VoiceOption {
  voiceId: string;
  name: string;
  /** e.g. "warm, gravelly grandfather" */
  description: string;
  gender: string | null;
  age: string | null;
  accent: string | null;
  previewUrl: string | null;
  /** "persona" voices come with a friendly storybook name. */
  persona: { name: string; emoji: string; tagline: string } | null;
  source: "default" | "account" | "designed" | "family";
  /** Starred by the family, so it's easy to find again. */
  favorite?: boolean;
}

/** A family recording kept just as it was: a voicemail, a voice memo, a child reading. */
export interface Keepsake {
  id: string;
  person: string;
  title: string;
  recordedOn: string | null;
  audioUrl: string;
  durationMs: number;
  createdAt: number;
}

/** A storytelling voice learned from a grown-up's keepsake recordings. */
export interface FamilyVoice {
  voiceId: string;
  name: string;
  person: string;
  previewUrl: string | null;
  createdAt: number;
}

/** The family's ElevenLabs voice credit this month (one credit is about one letter read aloud). */
export interface VoiceCredits {
  left: number;
  used: number;
  limit: number;
  /** When the month's credit tops up again. */
  resetsAt: number | null;
  plan: string;
  /** Demo mode's pretend numbers. */
  demo?: boolean;
}

export interface AppStatus {
  demoMode: boolean;
  storyteller: boolean;
  voices: boolean;
  storyModel: string;
  voiceModel: string;
  /** The storyteller's dollars per million tokens, for estimates. */
  storytellerRates: { input: number; output: number };
  /** Pictures: drawn by the illustrator once its key is set, stand-ins (free) until then. */
  illustrator: boolean;
  pictureModel: string;
  /** About what one picture costs, in millionths of a dollar (what it would cost, while stand-ins are free). */
  picturePrice: number;
  /** How the pictures' waits have really gone lately, where the page estimates them (1 = as the rule of thumb says). */
  pace?: PicturePace;
}

/** How many times its rule of thumb each kind of picture work has really taken lately. */
export interface PicturePace {
  planning: number;
  sketching: number;
  drawing: number;
}

/** What the family has spent, for the Grown-ups' corner. Amounts are millionths of a dollar. */
export interface SpendingItem {
  id: string;
  storyId: string | null;
  service: "pictures" | "storyteller";
  what: string;
  /** What a grown-up approved with the PIN (pictures). */
  approved: number | null;
  spent: number;
  pictures: number;
  standIn: boolean;
  createdAt: number;
}

export interface SpendingSummary {
  /** This calendar month, by service. */
  month: { pictures: number; storyteller: number; pictureCount: number; stories: number };
  recent: SpendingItem[];
}

/** About what writing a story costs the family, by length, in millionths of a dollar. */
export type WriteCosts = Record<LengthPreset, number>;

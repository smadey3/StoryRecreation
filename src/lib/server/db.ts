import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config";
import { DEFAULT_SHELVES, namedByItsStory } from "@/lib/shared/options";
import { languageOf } from "@/lib/shared/languages";
import { gutenbergCover } from "@/lib/shared/gutenberg";
import { pdfOfferFor, pdfSeconds } from "@/lib/shared/pdf";
import type {
  Book,
  BookKind,
  BookPage,
  FamilyVoice,
  Keepsake,
  Profile,
  Story,
  StoryArt,
  StoryCard,
  StoryMode,
  StoryProgress,
  StoryScript,
  StorySettings,
  StoryStatus,
  StoryTimeline,
} from "@/lib/shared/types";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  profile_id TEXT,
  grownup_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  color TEXT NOT NULL,
  age INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  kind TEXT NOT NULL,
  shelf TEXT NOT NULL,
  cover_path TEXT,
  source_ref TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS books_household ON books(household_id);

CREATE TABLE IF NOT EXISTS book_pages (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_book ON book_pages(book_id, page_number);

-- Remembers which voice played which character in a book, so the owl keeps
-- the same voice from one night's story to the next.
CREATE TABLE IF NOT EXISTS book_characters (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, name)
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  title TEXT NOT NULL,
  synopsis TEXT,
  settings TEXT NOT NULL,
  script TEXT,
  status TEXT NOT NULL,
  progress TEXT,
  error TEXT,
  audio_path TEXT,
  timeline TEXT,
  duration REAL,
  favorite INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stories_household ON stories(household_id, created_at);
CREATE INDEX IF NOT EXISTS stories_book ON stories(book_id);

-- Voices conjured with ElevenLabs Voice Design, kept in the family's wardrobe.
CREATE TABLE IF NOT EXISTS designed_voices (
  voice_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, voice_id)
);

-- Family recordings kept as they are, and voices learned from a grown-up's recordings.
CREATE TABLE IF NOT EXISTS keepsakes (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  title TEXT NOT NULL,
  recorded_on TEXT,
  audio_path TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS keepsakes_household ON keepsakes(household_id, person, created_at);

CREATE TABLE IF NOT EXISTS family_voices (
  voice_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  person TEXT NOT NULL,
  keepsake_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, voice_id)
);

CREATE TABLE IF NOT EXISTS classics_cache (
  gutenberg_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS catalogue_books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  topics TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalogue_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_voices (
  household_id TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, voice_id)
);

CREATE TABLE IF NOT EXISTS favorite_classics (
  household_id TEXT NOT NULL,
  gutenberg_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  cover TEXT,
  emoji TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, gutenberg_id)
);

-- Each automatic backup to the family's own cloud storage, kept for the Grown-ups' corner.
CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  uploaded_files INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

-- Problem alerts emailed to the grown-ups, so the same problem isn't sent twice and the last few can be shown.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS alerts_by_key ON alerts (kind, key, sent_at);

-- What the family has spent: pictures a grown-up approved with the PIN (approved_micros is
-- the most they agreed to), and what the storyteller cost to write each story. Amounts are
-- millionths of a dollar.
CREATE TABLE IF NOT EXISTS spending (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  story_id TEXT,
  service TEXT NOT NULL,
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  approved_micros INTEGER,
  spent_micros INTEGER NOT NULL DEFAULT 0,
  pictures INTEGER NOT NULL DEFAULT 0,
  stand_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spending_household ON spending (household_id, created_at);

-- How long the slow work (writing, recording, pictures) really took, beside what its rule of thumb said, both in
-- seconds: later waits are judged from it. Only the latest of each kind are kept.
CREATE TABLE IF NOT EXISTS work_times (
  work TEXT NOT NULL,
  guess REAL NOT NULL,
  took REAL NOT NULL,
  finished_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS work_times_by_work ON work_times (work, finished_at);
`;

type Row = Record<string, unknown>;

const globalForDb = globalThis as unknown as { __storyhollowDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!globalForDb.__storyhollowDb) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const conn = new DatabaseSync(path.join(config.dataDir, "storyhollow.db"));
    // If the old and new versions overlap for a moment during an update, wait
    // for the other to finish writing rather than failing.
    conn.exec("PRAGMA busy_timeout = 5000");
    conn.exec(SCHEMA);
    // Columns added after the first families had libraries.
    const storyColumns = (conn.prepare("PRAGMA table_info(stories)").all() as Row[]).map((c) => c.name);
    if (!storyColumns.includes("art")) conn.exec("ALTER TABLE stories ADD COLUMN art TEXT");
    const householdColumns = (conn.prepare("PRAGMA table_info(households)").all() as Row[]).map((c) => c.name);
    if (!householdColumns.includes("pin_digits")) conn.exec("ALTER TABLE households ADD COLUMN pin_digits INTEGER");
    const bookColumns = (conn.prepare("PRAGMA table_info(books)").all() as Row[]).map((c) => c.name);
    if (!bookColumns.includes("folder")) conn.exec("ALTER TABLE books ADD COLUMN folder TEXT");
    if (!bookColumns.includes("favorite")) conn.exec("ALTER TABLE books ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
    globalForDb.__storyhollowDb = conn;
  }
  return globalForDb.__storyhollowDb;
}

export const newId = () => randomUUID().replace(/-/g, "").slice(0, 16);

export function fileUrl(relPath: string | null | undefined): string | null {
  return relPath ? `/api/files/${relPath}` : null;
}

/** A picture book's pictures as the browser sees them: the stored paths become file addresses. */
export function artUrls(art: StoryArt | null): StoryArt | null {
  if (!art) return null;
  const url = (p: string | null) => fileUrl(p);
  return {
    ...art,
    cover: url(art.cover),
    pages: art.pages.map(url),
    characters: art.characters.map((c) => ({ ...c, drawing: url(c.drawing), sketches: c.sketches.map((p) => fileUrl(p)!) })),
  };
}

function json<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- households

export interface HouseholdRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  pin_hash: string | null;
  /** How many digits the PIN has, so the pad checks it the moment it's all in. Null for a PIN from before this was kept, until it's next entered. */
  pin_digits: number | null;
}

export function findHouseholdByEmail(email: string): HouseholdRow | undefined {
  return db().prepare("SELECT * FROM households WHERE email = ?").get(email.toLowerCase()) as
    | HouseholdRow
    | undefined;
}

export function getHousehold(id: string): HouseholdRow | undefined {
  return db().prepare("SELECT * FROM households WHERE id = ?").get(id) as HouseholdRow | undefined;
}

export function countHouseholds(): number {
  return Number((db().prepare("SELECT COUNT(*) AS n FROM households").get() as Row).n);
}

export function createHousehold(name: string, email: string, passwordHash: string): string {
  const id = newId();
  db()
    .prepare("INSERT INTO households (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, email.toLowerCase(), passwordHash, Date.now());
  return id;
}

export function setHouseholdPin(id: string, pinHash: string | null, digits: number | null = null) {
  db().prepare("UPDATE households SET pin_hash = ?, pin_digits = ? WHERE id = ?").run(pinHash, pinHash ? digits : null, id);
}

/** A PIN from before its length was kept has just been entered correctly: remember how long it is. */
export function rememberPinDigits(id: string, digits: number) {
  db().prepare("UPDATE households SET pin_digits = ? WHERE id = ? AND pin_digits IS NULL").run(digits, id);
}

export function renameHousehold(id: string, name: string) {
  db().prepare("UPDATE households SET name = ? WHERE id = ?").run(name, id);
}

// ------------------------------------------------------------------ sessions

export interface SessionRow {
  id: string;
  household_id: string;
  profile_id: string | null;
  grownup_until: number;
  expires_at: number;
}

export function createSession(householdId: string, ttlMs: number): string {
  const id = randomUUID() + randomUUID();
  const now = Date.now();
  db()
    .prepare("INSERT INTO sessions (id, household_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(id, householdId, now, now + ttlMs);
  return id;
}

export function getSession(id: string): SessionRow | undefined {
  const row = db().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (row && row.expires_at < Date.now()) {
    deleteSession(id);
    return undefined;
  }
  return row;
}

export function deleteSession(id: string) {
  db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function setSessionProfile(id: string, profileId: string | null) {
  db().prepare("UPDATE sessions SET profile_id = ? WHERE id = ?").run(profileId, id);
}

export function setSessionGrownup(id: string, until: number) {
  db().prepare("UPDATE sessions SET grownup_until = ? WHERE id = ?").run(until, id);
}

// ------------------------------------------------------------------ profiles

function toProfile(r: Row): Profile {
  return {
    id: r.id as string,
    name: r.name as string,
    avatar: r.avatar as string,
    color: r.color as string,
    age: (r.age as number | null) ?? null,
  };
}

export function listProfiles(householdId: string): Profile[] {
  return (
    db().prepare("SELECT * FROM profiles WHERE household_id = ? ORDER BY created_at").all(householdId) as Row[]
  ).map(toProfile);
}

export function getProfile(householdId: string, id: string): Profile | undefined {
  const r = db().prepare("SELECT * FROM profiles WHERE household_id = ? AND id = ?").get(householdId, id) as
    | Row
    | undefined;
  return r ? toProfile(r) : undefined;
}

export function createProfile(householdId: string, p: Omit<Profile, "id">): Profile {
  const id = newId();
  db()
    .prepare(
      "INSERT INTO profiles (id, household_id, name, avatar, color, age, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, householdId, p.name, p.avatar, p.color, p.age, Date.now());
  return { id, ...p };
}

export function updateProfile(householdId: string, id: string, p: Partial<Omit<Profile, "id">>) {
  const cur = getProfile(householdId, id);
  if (!cur) return;
  const next = { ...cur, ...p };
  db()
    .prepare("UPDATE profiles SET name = ?, avatar = ?, color = ?, age = ? WHERE household_id = ? AND id = ?")
    .run(next.name, next.avatar, next.color, next.age, householdId, id);
}

export function deleteProfile(householdId: string, id: string) {
  db().prepare("DELETE FROM profiles WHERE household_id = ? AND id = ?").run(householdId, id);
}

// --------------------------------------------------------------------- books

/** A book's own cover photo, or for a classic, its cover from Project Gutenberg. */
function coverFor(coverPath: unknown, kind: unknown, sourceRef: unknown): string | null {
  return fileUrl(coverPath as string | null) ?? (kind === "classic" && sourceRef ? gutenbergCover(sourceRef as string) : null);
}

function toBook(r: Row): Book {
  return {
    id: r.id as string,
    title: r.title as string,
    author: (r.author as string | null) ?? null,
    kind: r.kind as BookKind,
    shelf: r.shelf as string,
    folder: (r.folder as string | null) ?? null,
    favorite: Boolean(r.favorite),
    coverUrl: coverFor(r.cover_path, r.kind, r.source_ref),
    sourceRef: (r.source_ref as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    pageCount: Number(r.page_count ?? 0),
    storyCount: Number(r.story_count ?? 0),
    createdAt: r.created_at as number,
  };
}

const BOOK_SELECT = `
  SELECT b.*,
    (SELECT COUNT(*) FROM book_pages p WHERE p.book_id = b.id) AS page_count,
    (SELECT COUNT(*) FROM stories s WHERE s.book_id = b.id) AS story_count
  FROM books b`;

export function listBooks(householdId: string): Book[] {
  return (
    db().prepare(`${BOOK_SELECT} WHERE b.household_id = ? ORDER BY b.updated_at DESC`).all(householdId) as Row[]
  ).map(toBook);
}

export function getBook(householdId: string, id: string): Book | undefined {
  const r = db().prepare(`${BOOK_SELECT} WHERE b.household_id = ? AND b.id = ?`).get(householdId, id) as
    | Row
    | undefined;
  return r ? toBook(r) : undefined;
}

export function findBookBySource(householdId: string, kind: BookKind, sourceRef: string): Book | undefined {
  const r = db()
    .prepare(`${BOOK_SELECT} WHERE b.household_id = ? AND b.kind = ? AND b.source_ref = ?`)
    .get(householdId, kind, sourceRef) as Row | undefined;
  return r ? toBook(r) : undefined;
}

export function createBook(
  householdId: string,
  b: {
    title: string;
    author?: string | null;
    kind: BookKind;
    shelf?: string;
    folder?: string | null;
    sourceRef?: string | null;
    notes?: string | null;
  },
): string {
  const id = newId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO books (id, household_id, title, author, kind, shelf, folder, source_ref, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      householdId,
      b.title,
      b.author ?? null,
      b.kind,
      b.shelf?.trim() || DEFAULT_SHELVES[b.kind],
      b.folder?.trim() ? folderNamed(householdId, b.folder) : null,
      b.sourceRef ?? null,
      b.notes ?? null,
      now,
      now,
    );
  return id;
}

/** Classic books whose cover is still only on Project Gutenberg's site. */
export function classicsWithoutCovers(): { householdId: string; id: string; sourceRef: string }[] {
  return (
    db()
      .prepare("SELECT household_id, id, source_ref FROM books WHERE kind = 'classic' AND cover_path IS NULL AND source_ref IS NOT NULL")
      .all() as Row[]
  ).map((r) => ({ householdId: r.household_id as string, id: r.id as string, sourceRef: r.source_ref as string }));
}

export function updateBook(
  householdId: string,
  id: string,
  b: Partial<{ title: string; author: string | null; shelf: string; folder: string | null; notes: string | null; coverPath: string | null }>,
) {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (b.title !== undefined) (sets.push("title = ?"), vals.push(b.title));
  if (b.author !== undefined) (sets.push("author = ?"), vals.push(b.author));
  if (b.shelf !== undefined) (sets.push("shelf = ?"), vals.push(b.shelf));
  if (b.folder !== undefined) (sets.push("folder = ?"), vals.push(b.folder?.trim() ? folderNamed(householdId, b.folder) : null));
  if (b.notes !== undefined) (sets.push("notes = ?"), vals.push(b.notes));
  if (b.coverPath !== undefined) (sets.push("cover_path = ?"), vals.push(b.coverPath));
  sets.push("updated_at = ?");
  vals.push(Date.now());
  db()
    .prepare(`UPDATE books SET ${sets.join(", ")} WHERE household_id = ? AND id = ?`)
    .run(...vals, householdId, id);
}

/** The books the family has starred. */
export function favoriteBookIds(householdId: string): Set<string> {
  return new Set((db().prepare("SELECT id FROM books WHERE household_id = ? AND favorite = 1").all(householdId) as Row[]).map((r) => r.id as string));
}

/** Star a book, or take its star away (it isn't a change to the book itself). */
export function setBookFavorite(householdId: string, id: string, favorite: boolean) {
  db().prepare("UPDATE books SET favorite = ? WHERE household_id = ? AND id = ?").run(favorite ? 1 : 0, householdId, id);
}

export function touchBook(id: string) {
  db().prepare("UPDATE books SET updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function deleteBook(householdId: string, id: string) {
  db().prepare("DELETE FROM books WHERE household_id = ? AND id = ?").run(householdId, id);
}

export function listShelves(householdId: string): string[] {
  return (
    db().prepare("SELECT DISTINCT shelf FROM books WHERE household_id = ? ORDER BY shelf").all(householdId) as Row[]
  ).map((r) => r.shelf as string);
}

/**
 * A dreamed-up book (or one from the wild) that nobody named goes by the first words of its idea until its first
 * story has a title: then it takes that one. A book the family named keeps its name.
 */
export function nameBookAfterStory(householdId: string, bookId: string, storyTitle: string) {
  const book = getBook(householdId, bookId);
  const title = storyTitle.trim().slice(0, 120);
  if (!book || !title || !namedByItsStory(book)) return;
  db().prepare("UPDATE books SET title = ? WHERE household_id = ? AND id = ?").run(title, householdId, bookId);
}

/** Books made before books were named after their stories: each takes its first written story's title. */
export function nameUnnamedBooks() {
  const rows = db()
    .prepare(
      `SELECT b.household_id, b.id,
         (SELECT s.title FROM stories s WHERE s.book_id = b.id AND s.mode = 'create' AND s.script IS NOT NULL ORDER BY s.created_at LIMIT 1) AS story_title
       FROM books b WHERE b.kind IN ('idea', 'wild')`,
    )
    .all() as Row[];
  for (const r of rows) if (r.story_title) nameBookAfterStory(r.household_id as string, r.id as string, r.story_title as string);
}

// -------------------------------------------------------------- folders
// A folder holds books the family keeps together (a series, a season's books) and stands on the shelf as one. It's
// only a name on its books: a folder is there while there's a book in it.

/** The family's folders, A to Z. */
export function listFolders(householdId: string): string[] {
  return (
    db()
      .prepare("SELECT DISTINCT folder FROM books WHERE household_id = ? AND folder IS NOT NULL ORDER BY folder COLLATE NOCASE")
      .all(householdId) as Row[]
  ).map((r) => r.folder as string);
}

/** A folder's name as the family already has it, when it's one of theirs in any case ("twinkle" is "Twinkle"), apart from `except`. */
function folderNamed(householdId: string, name: string, except?: string | null): string {
  const given = name.trim().slice(0, 40);
  return listFolders(householdId).find((f) => f !== except && f.localeCompare(given, undefined, { sensitivity: "base" }) === 0) ?? given;
}

/**
 * Put these books in a folder, and only these: any others it had (under its old name `from`, when it's being changed)
 * go back on their shelves. A name like one of the family's folders joins that one, and no books unpacks it. Returns
 * the folder's name as kept, or null when it has no books.
 */
export function fileBooks(householdId: string, f: { from?: string | null; name: string; bookIds: string[] }): string | null {
  const conn = db();
  const name = folderNamed(householdId, f.name, f.from);
  conn.exec("BEGIN");
  try {
    if (f.from) conn.prepare("UPDATE books SET folder = NULL WHERE household_id = ? AND folder = ?").run(householdId, f.from);
    const put = conn.prepare("UPDATE books SET folder = ? WHERE household_id = ? AND id = ?");
    if (name) for (const id of f.bookIds) put.run(name, householdId, id);
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
  const kept = conn.prepare("SELECT COUNT(*) AS n FROM books WHERE household_id = ? AND folder = ?").get(householdId, name) as Row;
  return name && Number(kept.n) > 0 ? name : null;
}

// ---------------------------------------------------------------- book pages

export interface PageRow {
  id: string;
  page_number: number;
  image_path: string;
}

export function listPageRows(bookId: string): PageRow[] {
  return db()
    .prepare("SELECT id, page_number, image_path FROM book_pages WHERE book_id = ? ORDER BY page_number")
    .all(bookId) as unknown as PageRow[];
}

export function listPages(bookId: string): BookPage[] {
  return listPageRows(bookId).map((r) => ({
    id: r.id,
    pageNumber: r.page_number,
    imageUrl: fileUrl(r.image_path)!,
  }));
}

export function replacePages(bookId: string, imagePaths: string[]) {
  const conn = db();
  conn.exec("BEGIN");
  try {
    conn.prepare("DELETE FROM book_pages WHERE book_id = ?").run(bookId);
    const ins = conn.prepare("INSERT INTO book_pages (id, book_id, page_number, image_path) VALUES (?, ?, ?, ?)");
    imagePaths.forEach((p, i) => ins.run(newId(), bookId, i + 1, p));
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------- book characters

export interface RememberedCharacter {
  name: string;
  description: string;
  voiceId: string;
}

export function listBookCharacters(bookId: string): RememberedCharacter[] {
  return (
    db()
      .prepare("SELECT name, description, voice_id FROM book_characters WHERE book_id = ? ORDER BY updated_at DESC")
      .all(bookId) as Row[]
  ).map((r) => ({ name: r.name as string, description: r.description as string, voiceId: r.voice_id as string }));
}

export function rememberCharacters(bookId: string, chars: RememberedCharacter[]) {
  const stmt = db().prepare(
    `INSERT INTO book_characters (book_id, name, description, voice_id, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(book_id, name) DO UPDATE SET description = excluded.description, voice_id = excluded.voice_id, updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  for (const c of chars) stmt.run(bookId, c.name, c.description, c.voiceId, now);
}

// ------------------------------------------------------------------- stories

function toStory(r: Row): Story {
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    profileId: (r.profile_id as string | null) ?? null,
    mode: r.mode as StoryMode,
    title: r.title as string,
    synopsis: (r.synopsis as string | null) ?? null,
    settings: json<StorySettings>(r.settings)!,
    script: json<StoryScript>(r.script),
    status: r.status as StoryStatus,
    progress: json<StoryProgress>(r.progress),
    error: (r.error as string | null) ?? null,
    audioUrl: r.audio_path ? `${fileUrl(r.audio_path as string)}?v=${r.updated_at}` : null,
    timeline: json<StoryTimeline>(r.timeline),
    duration: (r.duration as number | null) ?? null,
    favorite: Boolean(r.favorite),
    playCount: Number(r.play_count ?? 0),
    lastPlayedAt: (r.last_played_at as number | null) ?? null,
    createdAt: r.created_at as number,
    art: artUrls(json<StoryArt>(r.art)),
  };
}

export function getStory(householdId: string, id: string): Story | undefined {
  const r = db().prepare("SELECT * FROM stories WHERE household_id = ? AND id = ?").get(householdId, id) as
    | Row
    | undefined;
  return r ? toStory(r) : undefined;
}

/** For background jobs, which run outside a request. */
export function getStoryById(id: string): (Story & { householdId: string }) | undefined {
  const r = db().prepare("SELECT * FROM stories WHERE id = ?").get(id) as Row | undefined;
  return r ? { ...toStory(r), householdId: r.household_id as string } : undefined;
}

/** Every story with its words and recording, for the family's backup download. */
export function listStoriesForBackup(householdId: string): {
  id: string;
  bookId: string;
  title: string;
  synopsis: string | null;
  mode: StoryMode;
  script: StoryScript | null;
  audioPath: string | null;
  duration: number | null;
  createdAt: number;
  /** A picture book's pictures, as stored paths. */
  art: StoryArt | null;
}[] {
  const rows = db()
    .prepare("SELECT id, book_id, title, synopsis, mode, script, audio_path, duration, created_at, art FROM stories WHERE household_id = ? ORDER BY created_at")
    .all(householdId) as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    bookId: r.book_id as string,
    title: r.title as string,
    synopsis: (r.synopsis as string | null) ?? null,
    mode: r.mode as StoryMode,
    script: json<StoryScript>(r.script),
    audioPath: (r.audio_path as string | null) ?? null,
    duration: (r.duration as number | null) ?? null,
    createdAt: r.created_at as number,
    art: json<StoryArt>(r.art),
  }));
}

/** A picture book's pictures as stored, with paths (for the illustrator, which reads them). */
export function getStoryArt(id: string): StoryArt | null {
  const r = db().prepare("SELECT art FROM stories WHERE id = ?").get(id) as Row | undefined;
  return json<StoryArt>(r?.art);
}

/** A family's picture books, newest first, with their pictures as stored (to offer a character drawn before). */
export function familyStoryArt(householdId: string): { id: string; title: string; art: StoryArt }[] {
  return (db().prepare("SELECT id, title, art FROM stories WHERE household_id = ? AND art IS NOT NULL ORDER BY created_at DESC").all(householdId) as Row[]).flatMap(
    (r) => {
      const art = json<StoryArt>(r.art);
      return art ? [{ id: r.id as string, title: r.title as string, art }] : [];
    },
  );
}

/** Stories being written or recorded, by what the database says (after a restart, none of them really is). */
export function storiesBeingMade(): string[] {
  return (db().prepare("SELECT id FROM stories WHERE status IN ('writing', 'recording') ORDER BY updated_at").all() as Row[]).map((r) => r.id as string);
}

/** The family's story being written or recorded just now, other than this one: a family makes one at a time. */
export function storyBeingMade(householdId: string, exceptId = ""): { id: string; title: string } | null {
  const r = db()
    .prepare("SELECT id, title FROM stories WHERE household_id = ? AND status IN ('writing', 'recording') AND id <> ? ORDER BY updated_at DESC LIMIT 1")
    .get(householdId, exceptId) as Row | undefined;
  return r ? { id: r.id as string, title: r.title as string } : null;
}

/** Stories whose illustrator was at work, by what the database says (after a restart, nothing is). */
export function storiesWithArtAtWork(): string[] {
  return (db().prepare("SELECT id FROM stories WHERE art IS NOT NULL AND json_extract(art, '$.status') != 'idle'").all() as Row[]).map((r) => r.id as string);
}

/**
 * Change a picture book's pictures. Read and written in one step, so the
 * illustrator and the family's own changes never undo each other.
 */
export function changeStoryArt(id: string, fn: (art: StoryArt | null) => StoryArt | null): StoryArt | null {
  const next = fn(getStoryArt(id));
  // updated_at is left alone: it versions the recording's address, and pictures don't change the recording.
  db().prepare("UPDATE stories SET art = ? WHERE id = ?").run(next ? JSON.stringify(next) : null, id);
  return next;
}

export function getStoryAudioPath(id: string): string | null {
  const r = db().prepare("SELECT audio_path FROM stories WHERE id = ?").get(id) as Row | undefined;
  return (r?.audio_path as string | null) ?? null;
}

const CARD_SELECT = `
  SELECT s.id, s.book_id, s.profile_id, s.mode, s.title, s.synopsis, s.status, s.duration, s.favorite,
         s.play_count, s.last_played_at, s.created_at, b.title AS book_title, b.kind AS book_kind, b.cover_path, b.source_ref AS book_source_ref,
         json_extract(s.art, '$.cover') AS art_cover,
         (SELECT json_extract(c.value, '$.voiceId') FROM json_each(s.script, '$.cast') c
          WHERE json_extract(c.value, '$.id') = 'narrator') AS narrator_voice_id,
         COALESCE(json_extract(s.script, '$.language'), json_extract(s.settings, '$.language')) AS language,
         s.audio_path, s.updated_at, json_extract(s.settings, '$.source') AS source, json_array_length(s.script, '$.pages') AS script_pages
  FROM stories s JOIN books b ON b.id = s.book_id`;

function toCard(r: Row): StoryCard {
  const source = (r.source as StorySettings["source"] | null) ?? undefined;
  const pages = Number(r.script_pages ?? 0);
  const pdf = pdfOfferFor(source, pages);
  return {
    id: r.id as string,
    bookId: r.book_id as string,
    bookTitle: r.book_title as string,
    bookKind: r.book_kind as BookKind,
    coverUrl: r.art_cover ? fileUrl(r.art_cover as string) : coverFor(r.cover_path, r.book_kind, r.book_source_ref),
    profileId: (r.profile_id as string | null) ?? null,
    mode: r.mode as StoryMode,
    title: r.title as string,
    synopsis: (r.synopsis as string | null) ?? null,
    status: r.status as StoryStatus,
    duration: (r.duration as number | null) ?? null,
    favorite: Boolean(r.favorite),
    playCount: Number(r.play_count ?? 0),
    lastPlayedAt: (r.last_played_at as number | null) ?? null,
    createdAt: r.created_at as number,
    narratorVoiceId: (r.narrator_voice_id as string | null) ?? null,
    ...(languageOf(r.language) !== "en" ? { language: languageOf(r.language) } : {}),
    audioUrl: r.audio_path ? `${fileUrl(r.audio_path as string)}?v=${r.updated_at}` : null,
    pdf: pdf && { holds: pdf, seconds: pdfSeconds(pdf === "all" && (Boolean(r.art_cover) || source === "wild"), pages) },
  };
}

export function listStoryCards(householdId: string, opts: { bookId?: string } = {}): StoryCard[] {
  const rows = opts.bookId
    ? (db()
        .prepare(`${CARD_SELECT} WHERE s.household_id = ? AND s.book_id = ? ORDER BY s.created_at DESC`)
        .all(householdId, opts.bookId) as Row[])
    : (db()
        .prepare(`${CARD_SELECT} WHERE s.household_id = ? ORDER BY s.created_at DESC`)
        .all(householdId) as Row[]);
  return rows.map(toCard);
}

/** Titles and synopses of earlier stories for a book, so tonight's is different. */
export function previousStoriesForBook(bookId: string, excludeId: string): { title: string; synopsis: string }[] {
  return (
    db()
      .prepare(
        `SELECT title, synopsis FROM stories WHERE book_id = ? AND id != ? AND mode = 'create' AND synopsis IS NOT NULL
         ORDER BY created_at DESC LIMIT 12`,
      )
      .all(bookId, excludeId) as Row[]
  ).map((r) => ({ title: r.title as string, synopsis: r.synopsis as string }));
}

export function createStory(
  householdId: string,
  s: { bookId: string; profileId: string | null; mode: StoryMode; title: string; settings: StorySettings; status: StoryStatus },
): string {
  const id = newId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO stories (id, household_id, book_id, profile_id, mode, title, settings, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, householdId, s.bookId, s.profileId, s.mode, s.title, JSON.stringify(s.settings), s.status, now, now);
  touchBook(s.bookId);
  return id;
}

export interface StoryPatch {
  title?: string;
  synopsis?: string | null;
  settings?: StorySettings;
  script?: StoryScript | null;
  status?: StoryStatus;
  progress?: StoryProgress | null;
  error?: string | null;
  audioPath?: string | null;
  timeline?: StoryTimeline | null;
  duration?: number | null;
  favorite?: boolean;
}

export function updateStory(id: string, patch: StoryPatch) {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const add = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.title !== undefined) add("title", patch.title);
  if (patch.synopsis !== undefined) add("synopsis", patch.synopsis);
  if (patch.settings !== undefined) add("settings", JSON.stringify(patch.settings));
  if (patch.script !== undefined) add("script", patch.script ? JSON.stringify(patch.script) : null);
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.progress !== undefined) add("progress", patch.progress ? JSON.stringify(patch.progress) : null);
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.audioPath !== undefined) add("audio_path", patch.audioPath);
  if (patch.timeline !== undefined) add("timeline", patch.timeline ? JSON.stringify(patch.timeline) : null);
  if (patch.duration !== undefined) add("duration", patch.duration);
  if (patch.favorite !== undefined) add("favorite", patch.favorite ? 1 : 0);
  add("updated_at", Date.now());
  db().prepare(`UPDATE stories SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function markPlayed(householdId: string, id: string) {
  db()
    .prepare("UPDATE stories SET play_count = play_count + 1, last_played_at = ? WHERE household_id = ? AND id = ?")
    .run(Date.now(), householdId, id);
}

export function deleteStory(householdId: string, id: string) {
  db().prepare("DELETE FROM stories WHERE household_id = ? AND id = ?").run(householdId, id);
}

// ----------------------------------------------------------- designed voices

export function listDesignedVoices(householdId: string): { voiceId: string; name: string; description: string }[] {
  return (
    db()
      .prepare("SELECT voice_id, name, description FROM designed_voices WHERE household_id = ? ORDER BY created_at DESC")
      .all(householdId) as Row[]
  ).map((r) => ({ voiceId: r.voice_id as string, name: r.name as string, description: r.description as string }));
}

export function saveDesignedVoice(householdId: string, v: { voiceId: string; name: string; description: string }) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO designed_voices (voice_id, household_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(v.voiceId, householdId, v.name, v.description, Date.now());
}

// ---------------------------------------------------------------- keepsakes

function keepsakeFromRow(r: Row): Keepsake {
  return {
    id: r.id as string,
    person: r.person as string,
    title: r.title as string,
    recordedOn: (r.recorded_on as string | null) ?? null,
    audioUrl: fileUrl(r.audio_path as string)!,
    durationMs: r.duration_ms as number,
    createdAt: r.created_at as number,
  };
}

export function listKeepsakes(householdId: string): Keepsake[] {
  return (
    db()
      .prepare("SELECT * FROM keepsakes WHERE household_id = ? ORDER BY person COLLATE NOCASE, created_at")
      .all(householdId) as Row[]
  ).map(keepsakeFromRow);
}

/** The keepsakes with these ids, with their files, for this family only. */
export function keepsakeFiles(householdId: string, ids: string[]): { id: string; person: string; audioPath: string; durationMs: number }[] {
  if (!ids.length) return [];
  const rows = db()
    .prepare(`SELECT id, person, audio_path, duration_ms FROM keepsakes WHERE household_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .all(householdId, ...ids) as Row[];
  return rows.map((r) => ({ id: r.id as string, person: r.person as string, audioPath: r.audio_path as string, durationMs: r.duration_ms as number }));
}

export function addKeepsake(
  householdId: string,
  k: { person: string; title: string; recordedOn: string | null; audioPath: string; durationMs: number },
): Keepsake {
  const id = newId();
  const now = Date.now();
  db()
    .prepare(
      "INSERT INTO keepsakes (id, household_id, person, title, recorded_on, audio_path, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, householdId, k.person, k.title, k.recordedOn, k.audioPath, k.durationMs, now);
  return { id, person: k.person, title: k.title, recordedOn: k.recordedOn, audioUrl: fileUrl(k.audioPath)!, durationMs: k.durationMs, createdAt: now };
}

export function updateKeepsake(householdId: string, id: string, patch: { person?: string; title?: string; recordedOn?: string | null }) {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (patch.person !== undefined) (sets.push("person = ?"), vals.push(patch.person));
  if (patch.title !== undefined) (sets.push("title = ?"), vals.push(patch.title));
  if (patch.recordedOn !== undefined) (sets.push("recorded_on = ?"), vals.push(patch.recordedOn));
  if (!sets.length) return;
  db().prepare(`UPDATE keepsakes SET ${sets.join(", ")} WHERE household_id = ? AND id = ?`).run(...vals, householdId, id);
}

/** Removes the keepsake and returns its audio path so the file can go too. */
export function deleteKeepsake(householdId: string, id: string): string | null {
  const row = db().prepare("SELECT audio_path FROM keepsakes WHERE household_id = ? AND id = ?").get(householdId, id) as Row | undefined;
  if (!row) return null;
  db().prepare("DELETE FROM keepsakes WHERE household_id = ? AND id = ?").run(householdId, id);
  return row.audio_path as string;
}

// ------------------------------------------------------------ family voices

export function listFamilyVoices(householdId: string): FamilyVoice[] {
  const rows = db()
    .prepare("SELECT voice_id, name, person, keepsake_ids, created_at FROM family_voices WHERE household_id = ? ORDER BY created_at")
    .all(householdId) as Row[];
  return rows.map((r) => {
    // the person's own recording doubles as the voice's "Hear me" sample
    const first = keepsakeFiles(householdId, json<string[]>(r.keepsake_ids) ?? [])[0];
    return {
      voiceId: r.voice_id as string,
      name: r.name as string,
      person: r.person as string,
      previewUrl: first ? fileUrl(first.audioPath) : null,
      createdAt: r.created_at as number,
    };
  });
}

export function saveFamilyVoice(householdId: string, v: { voiceId: string; name: string; person: string; keepsakeIds: string[] }) {
  db()
    .prepare("INSERT OR REPLACE INTO family_voices (voice_id, household_id, name, person, keepsake_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(v.voiceId, householdId, v.name, v.person, JSON.stringify(v.keepsakeIds), Date.now());
}

export function deleteFamilyVoice(householdId: string, voiceId: string): boolean {
  return db().prepare("DELETE FROM family_voices WHERE household_id = ? AND voice_id = ?").run(householdId, voiceId).changes > 0;
}

// ------------------------------------------------------------ classics cache

export function getCachedClassic(id: number): { title: string; author: string | null; text: string } | undefined {
  return db().prepare("SELECT title, author, text FROM classics_cache WHERE gutenberg_id = ?").get(id) as
    | { title: string; author: string | null; text: string }
    | undefined;
}

export function cacheClassic(id: number, title: string, author: string | null, text: string) {
  db()
    .prepare("INSERT OR REPLACE INTO classics_cache (gutenberg_id, title, author, text, fetched_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, title, author, text, Date.now());
}

// ---------------------------------------------------------------- favorites

export function favoriteVoiceIds(householdId: string): Set<string> {
  const rows = db().prepare("SELECT voice_id FROM favorite_voices WHERE household_id = ?").all(householdId) as { voice_id: string }[];
  return new Set(rows.map((r) => r.voice_id));
}

export function setFavoriteVoice(householdId: string, voiceId: string, favorite: boolean) {
  if (favorite) {
    db().prepare("INSERT OR IGNORE INTO favorite_voices (household_id, voice_id, created_at) VALUES (?, ?, ?)").run(householdId, voiceId, Date.now());
  } else {
    db().prepare("DELETE FROM favorite_voices WHERE household_id = ? AND voice_id = ?").run(householdId, voiceId);
  }
}

/** A book the family starred, kept with enough to show it without asking the library. */
export interface FavoriteClassic {
  gutenbergId: number;
  title: string;
  author: string | null;
  cover: string | null;
  emoji: string | null;
}

export function listFavoriteClassics(householdId: string): FavoriteClassic[] {
  const rows = db()
    .prepare("SELECT gutenberg_id, title, author, cover, emoji FROM favorite_classics WHERE household_id = ? ORDER BY created_at DESC")
    .all(householdId) as { gutenberg_id: number; title: string; author: string | null; cover: string | null; emoji: string | null }[];
  return rows.map((r) => ({ gutenbergId: r.gutenberg_id, title: r.title, author: r.author, cover: r.cover, emoji: r.emoji }));
}

export function setFavoriteClassic(householdId: string, book: FavoriteClassic, favorite: boolean) {
  if (favorite) {
    db()
      .prepare(
        "INSERT OR REPLACE INTO favorite_classics (household_id, gutenberg_id, title, author, cover, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(householdId, book.gutenbergId, book.title, book.author, book.cover, book.emoji, Date.now());
  } else {
    db().prepare("DELETE FROM favorite_classics WHERE household_id = ? AND gutenberg_id = ?").run(householdId, book.gutenbergId);
  }
}

// --------------------------------------------------------------- catalogue

/** One English book from Project Gutenberg's catalogue; "topics" is its subjects and shelves, lowercased. */
export interface CatalogueRow {
  id: number;
  title: string;
  author: string | null;
  topics: string;
}

export function replaceCatalogue(rows: CatalogueRow[]) {
  const conn = db();
  conn.exec("BEGIN");
  try {
    conn.exec("DELETE FROM catalogue_books");
    const ins = conn.prepare("INSERT OR REPLACE INTO catalogue_books (id, title, author, topics) VALUES (?, ?, ?, ?)");
    for (const r of rows) ins.run(r.id, r.title, r.author, r.topics);
    conn.prepare("INSERT OR REPLACE INTO catalogue_meta (key, value) VALUES ('loaded_at', ?)").run(String(Date.now()));
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

export function catalogueLoadedAt(): number | null {
  const r = db().prepare("SELECT value FROM catalogue_meta WHERE key = 'loaded_at'").get() as { value: string } | undefined;
  return r ? Number(r.value) : null;
}

/** How many books the whole library holds (0 until it's first fetched). */
export function catalogueSize(): number {
  return Number((db().prepare("SELECT COUNT(*) AS n FROM catalogue_books").get() as { n: number }).n);
}

export function catalogueBook(id: number): Omit<CatalogueRow, "topics"> | undefined {
  return db().prepare("SELECT id, title, author FROM catalogue_books WHERE id = ?").get(id) as Omit<CatalogueRow, "topics"> | undefined;
}

const likeWords = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Books for a search or a kind of story. A search is groups of words: every
 * group must be found in the title, author, subjects or shelves, and any word
 * in a group will do ("romance" or "love stories"). A kind of story is
 * phrases, any of which its subjects or shelves must hold.
 *
 * Titles that match come first, then authors, then subjects; children's books
 * before grown-ups'; then lower Gutenberg numbers, because the best-known
 * classics were among the first to be added.
 */
interface CatalogueFilter {
  search?: { groups: string[][]; phrase: string };
  match?: readonly string[];
  /** One subject the books must also have ("dogs"), to narrow a long list down. */
  refine?: string;
}

function catalogueWhere({ search, match, refine }: CatalogueFilter) {
  const where: string[] = [];
  const args: string[] = [];
  for (const group of search?.groups ?? []) {
    where.push(`(${group.map(() => "title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR topics LIKE ? ESCAPE '\\'").join(" OR ")})`);
    for (const w of group) args.push(likeWords(w), likeWords(w), likeWords(w));
  }
  if (match?.length) {
    where.push(`(${match.map(() => "topics LIKE ? ESCAPE '\\'").join(" OR ")})`);
    args.push(...match.map((m) => likeWords(m.toLowerCase())));
  }
  if (refine) {
    where.push("topics LIKE ? ESCAPE '\\'");
    args.push(likeWords(refine.toLowerCase()));
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

/** The subjects of every book a search or kind finds, to offer ways to narrow it down. */
export function catalogueTopicsOf(filter: CatalogueFilter): string[] {
  const { clause, args } = catalogueWhere(filter);
  return (db().prepare(`SELECT topics FROM catalogue_books ${clause}`).all(...args) as { topics: string }[]).map((r) => r.topics);
}

export function queryCatalogue({
  search,
  match,
  refine,
  limit,
  offset,
}: CatalogueFilter & {
  limit: number;
  offset: number;
}) {
  const { clause, args } = catalogueWhere({ search, match, refine });
  const total = (db().prepare(`SELECT COUNT(*) AS n FROM catalogue_books ${clause}`).get(...args) as { n: number }).n;
  const young = "(topics LIKE '%juvenile%' OR topics LIKE '%children%')";
  const order = search
    ? `ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 WHEN title LIKE ? ESCAPE '\\' THEN 1 WHEN author LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END, ${young} DESC, id`
    : "ORDER BY id";
  const orderArgs = search ? [likeWords(search.phrase).slice(1), likeWords(search.phrase), likeWords(search.phrase)] : [];
  const rows = db()
    .prepare(`SELECT id, title, author FROM catalogue_books ${clause} ${order} LIMIT ? OFFSET ?`)
    .all(...args, ...orderArgs, limit, offset) as Omit<CatalogueRow, "topics">[];
  return { rows, total };
}

/** What to hear when a story ends: the classic's next chapter (made already, or still to make), or the book's next story. */
export type UpNext = { kind: "story"; id: string; title: string; ready: boolean } | { kind: "chapter"; gutenbergId: number; chapter: number } | null;

export function upNext(householdId: string, story: Story): UpNext {
  const rows = db()
    .prepare("SELECT id, title, status, settings FROM stories WHERE household_id = ? AND book_id = ? ORDER BY created_at ASC")
    .all(householdId, story.bookId) as Row[];
  const classic = story.settings.source === "classic" ? story.settings.classic : undefined;
  if (classic) {
    // Made already (or being made): that one, rather than a second copy.
    const made = rows.find((r) => r.status !== "error" && json<StorySettings>(r.settings)?.classic?.chapter === classic.chapter + 1);
    return made
      ? { kind: "story", id: made.id as string, title: made.title as string, ready: made.status === "ready" }
      : { kind: "chapter", gutenbergId: classic.gutenbergId, chapter: classic.chapter + 1 };
  }
  const next = rows.slice(rows.findIndex((r) => r.id === story.id) + 1).find((r) => r.status === "ready");
  return next ? { kind: "story", id: next.id as string, title: next.title as string, ready: true } : null;
}

/** Stories the family made (not read-alouds), with how each was made, newest first: for "make one like…". */
export function madeStories(
  householdId: string,
  limit = 40,
  include?: string,
): { id: string; title: string; bookId: string; bookTitle: string; bookKind: BookKind; settings: StorySettings; createdAt: number }[] {
  const rows = db()
    .prepare(
      `SELECT s.id, s.title, s.settings, s.created_at, s.book_id, b.title AS book_title, b.kind AS book_kind FROM stories s JOIN books b ON b.id = s.book_id
        WHERE s.household_id = ? AND s.mode = 'create' AND s.status != 'error' AND (s.id = ? OR s.id IN
          (SELECT id FROM stories WHERE household_id = ? AND mode = 'create' AND status != 'error' ORDER BY created_at DESC LIMIT ?))
        ORDER BY s.created_at DESC`,
    )
    .all(householdId, include ?? "", householdId, limit) as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    bookId: r.book_id as string,
    bookTitle: r.book_title as string,
    bookKind: r.book_kind as BookKind,
    settings: json<StorySettings>(r.settings)!,
    createdAt: r.created_at as number,
  }));
}

/** The settings used last time a story was made for this book, for "another one tonight". */
export function lastSettingsForBook(bookId: string, mode: StoryMode): StorySettings | null {
  const r = db()
    .prepare("SELECT settings FROM stories WHERE book_id = ? AND mode = ? ORDER BY created_at DESC LIMIT 1")
    .get(bookId, mode) as Row | undefined;
  return r ? json<StorySettings>(r.settings) : null;
}

// --------------------------------------------------------------------- automatic backups

export interface BackupRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  uploadedFiles: number;
  uploadedBytes: number;
  totalFiles: number;
  totalBytes: number;
  error: string | null;
}

const toRun = (r: Row): BackupRun => ({
  id: Number(r.id),
  startedAt: Number(r.started_at),
  finishedAt: (r.finished_at as number | null) ?? null,
  ok: r.ok === null || r.ok === undefined ? null : Boolean(r.ok),
  uploadedFiles: Number(r.uploaded_files),
  uploadedBytes: Number(r.uploaded_bytes),
  totalFiles: Number(r.total_files),
  totalBytes: Number(r.total_bytes),
  error: (r.error as string | null) ?? null,
});

export function startBackupRun(): number {
  return Number(db().prepare("INSERT INTO backup_runs (started_at) VALUES (?)").run(Date.now()).lastInsertRowid);
}

export function finishBackupRun(
  id: number,
  result: { ok: boolean; uploadedFiles: number; uploadedBytes: number; totalFiles: number; totalBytes: number; error?: string },
) {
  db()
    .prepare(
      `UPDATE backup_runs SET finished_at = ?, ok = ?, uploaded_files = ?, uploaded_bytes = ?, total_files = ?, total_bytes = ?, error = ?
       WHERE id = ?`,
    )
    .run(Date.now(), result.ok ? 1 : 0, result.uploadedFiles, result.uploadedBytes, result.totalFiles, result.totalBytes, result.error ?? null, id);
}

/** The latest backups, newest first. */
export function recentBackupRuns(limit = 5): BackupRun[] {
  return (db().prepare("SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toRun);
}

export function lastGoodBackup(): BackupRun | null {
  const r = db().prepare("SELECT * FROM backup_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1").get() as Row | undefined;
  return r ? toRun(r) : null;
}

/** A backup cut short by a restart never finished: say so instead of leaving it "running". */
export function closeUnfinishedBackups() {
  db()
    .prepare("UPDATE backup_runs SET finished_at = ?, ok = 0, error = 'Interrupted by a restart.' WHERE finished_at IS NULL")
    .run(Date.now());
}

/**
 * A consistent copy of the database at this moment, without the library catalogue and
 * fetched book texts (both are fetched again from Project Gutenberg when needed), and
 * without anyone's sign-in (a copy that went astray can't be used to get in; after a
 * restore, everyone signs in again).
 */
export function snapshotDatabase(toPath: string) {
  db().exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(toPath);
  try {
    copy.exec("DELETE FROM catalogue_books; DELETE FROM catalogue_meta; DELETE FROM classics_cache; DELETE FROM sessions; VACUUM;");
  } finally {
    copy.close();
  }
}

// --------------------------------------------------------------------- problem alerts

export interface AlertRecord {
  kind: string;
  subject: string;
  sentAt: number;
  ok: boolean;
  error: string | null;
}

export function recordAlert(a: { kind: string; key: string; subject: string; ok: boolean; error?: string }) {
  db()
    .prepare("INSERT INTO alerts (kind, key, subject, sent_at, ok, error) VALUES (?, ?, ?, ?, ?, ?)")
    .run(a.kind, a.key, a.subject, Date.now(), a.ok ? 1 : 0, a.error ?? null);
}

/** When this alert was last sent (successfully), if ever. */
export function lastAlertSent(kind: string, key: string): number | null {
  const r = db().prepare("SELECT MAX(sent_at) AS at FROM alerts WHERE kind = ? AND key = ? AND ok = 1").get(kind, key) as { at: number | null };
  return r.at ?? null;
}

export function alertsSentSince(since: number): number {
  return Number((db().prepare("SELECT COUNT(*) AS n FROM alerts WHERE sent_at > ?").get(since) as { n: number }).n);
}

export function recentAlerts(limit = 5): AlertRecord[] {
  return (db().prepare("SELECT kind, subject, sent_at, ok, error FROM alerts ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
    kind: r.kind as string,
    subject: r.subject as string,
    sentAt: Number(r.sent_at),
    ok: Boolean(r.ok),
    error: (r.error as string | null) ?? null,
  }));
}

// --------------------------------------------------------------------- how long work takes

/** The latest times for a kind of work, newest first: what its rule of thumb said, and what it took (seconds). */
export function recentWorkTimes(work: string, limit: number): { guess: number; took: number }[] {
  return (db().prepare("SELECT guess, took FROM work_times WHERE work = ? ORDER BY finished_at DESC, rowid DESC LIMIT ?").all(work, limit) as Row[]).map(
    (r) => ({ guess: Number(r.guess), took: Number(r.took) }),
  );
}

/** Some work finished: how long it took, beside what its rule of thumb said. The latest 50 of each kind are kept. */
export function saveWorkTime(work: string, guess: number, took: number) {
  const conn = db();
  conn.prepare("INSERT INTO work_times (work, guess, took, finished_at) VALUES (?, ?, ?, ?)").run(work, guess, took, Date.now());
  conn
    .prepare("DELETE FROM work_times WHERE work = ? AND rowid NOT IN (SELECT rowid FROM work_times WHERE work = ? ORDER BY finished_at DESC, rowid DESC LIMIT 50)")
    .run(work, work);
}

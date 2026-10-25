import fs from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import sharp from "sharp";
import { artForPage } from "@/lib/shared/art";
import { languageOf, SAYINGS } from "@/lib/shared/languages";
import { imageForPage } from "@/lib/shared/pages";
import { pdfOffer } from "@/lib/shared/pdf";
import type { Book, BookPage, ScriptLine, Story, StoryLanguage } from "@/lib/shared/types";
import { resolveHouseholdPath } from "./files";
import { stripTags } from "./text";

// A story as a book to keep, share or print: a cover, its pages (each page's picture, with its words beneath), and
// The End. Six by nine inches, a usual size for a book, in the app's own type: IM Fell English for titles, and Andika,
// made for children learning to read, for the words. Pictures are made just big enough for the page, so a picture
// book stays small enough to send by message or email.

const W = 432;
const H = 648;
const MARGIN = 40;
const TOP = H - 46;
const BOTTOM = 54;
const WIDTH = W - MARGIN * 2;
const AREA = TOP - BOTTOM;
/** Between a picture and its words. */
const GAP = 20;

const INK = rgb(0.23, 0.13, 0.07);
const SOFT = rgb(0.45, 0.34, 0.22);
const GOLD = rgb(0.62, 0.43, 0.15);

const FONTS = {
  title: "@fontsource/im-fell-english/files/im-fell-english-latin-400-normal.woff",
  words: "@fontsource/andika/files/andika-latin-400-normal.woff",
  wordsItalic: "@fontsource/andika/files/andika-latin-400-italic.woff",
};
type Fonts = Record<keyof typeof FONTS, PDFFont>;

let fontFiles: Promise<Record<string, Buffer>> | null = null;
/** The fonts' files, read once (and read again next time if that went wrong). */
function readFonts() {
  fontFiles ??= Promise.all(
    Object.entries(FONTS).map(async ([name, file]) => [name, await fs.promises.readFile(path.join(process.cwd(), "node_modules", file))] as const),
  ).then(Object.fromEntries, (err) => {
    fontFiles = null;
    throw err;
  });
  return fontFiles;
}

/** The book's own words, in the story's language. */
const WORDS: Record<StoryLanguage, { theEnd: string; more: string; chapter: string; page: string; quotes: [string, string] }> = {
  en: { theEnd: "The End", more: "To be continued…", chapter: "Chapter", page: "Page", quotes: ["“", "”"] },
  fr: { theEnd: "Fin", more: "À suivre…", chapter: "Chapitre", page: "Page", quotes: ["« ", " »"] },
  es: { theEnd: "Fin", more: "Continuará…", chapter: "Capítulo", page: "Página", quotes: ["«", "»"] },
};

/** French puts a space inside « » and before ! ? ; : that mustn't be split from them at the end of a line. */
const frenchSpaces = (text: string) => text.replace(/«\s*/g, "« ").replace(/\s*([»!?;:])/g, " $1");

/**
 * A page's lines as a printed book has them: the narration in paragraphs, and what the characters say in quotation
 * marks (the script leaves them out, for the voices), in the paragraph that leads up to it. "…she whispered" after
 * something said stays with it; someone else speaking, or narration after someone has spoken, starts a new paragraph.
 */
export function pageParagraphs(lines: ScriptLine[], language: StoryLanguage = "en"): string[] {
  const [open, close] = WORDS[language].quotes;
  const paragraphs: string[] = [];
  // Who has spoken in the paragraph being written, and who said the line before.
  let speaker: string | null = null;
  let last: string | null = null;
  for (const line of lines) {
    const parts = line.text
      .replace(/\[[^\]]{1,40}\]\s*/g, "")
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!parts.length) continue;
    if (line.speaker === "narrator") {
      parts.forEach((p, i) => {
        if (i === 0 && last !== null && last !== "narrator" && /^[\p{Ll},;:—–]/u.test(p)) paragraphs[paragraphs.length - 1] += ` ${p}`;
        else {
          paragraphs.push(p);
          speaker = null;
        }
      });
    } else {
      const said = parts.join(" ");
      const quoted = /^["“«„‘'—–-]/.test(said) ? said : `${open}${said}${close}`;
      if (paragraphs.length && (speaker === null || speaker === line.speaker)) paragraphs[paragraphs.length - 1] += ` ${quoted}`;
      else paragraphs.push(quoted);
      speaker = line.speaker;
    }
    last = line.speaker;
  }
  return language === "fr" ? paragraphs.map(frenchSpaces) : paragraphs;
}

// ------------------------------------------------------------------ type

interface Style {
  font: PDFFont;
  size: number;
  leading: number;
  color: RGB;
  center?: boolean;
}
interface Block {
  text: string;
  style: Style;
  /** The space above it, unless it's the first thing on a page. */
  before: number;
  /** A heading stays on the same page as what follows it. */
  heading?: boolean;
}
/** A line of a block, and whether it's the block's first or last. */
type Line = Block & { first: boolean; last: boolean };

const charSets = new WeakMap<PDFFont, Set<number>>();
/** Text the font can show: anything it has no letter for (an emoji in a title, say) is left out. */
function printable(font: PDFFont, text: string): string {
  let chars = charSets.get(font);
  if (!chars) charSets.set(font, (chars = new Set(font.getCharacterSet())));
  let out = "";
  for (const ch of text.replace(/ /g, " ")) out += chars.has(ch.codePointAt(0)!) ? ch : /\s/.test(ch) ? " " : "";
  return out.replace(/ {2,}/g, " ").trim();
}

/** Text in lines no wider than `width`, broken at spaces (a word longer than a line, at the line's end). */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    const longer = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(longer, size) <= width) {
      line = longer;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (rest.length > 1 && font.widthOfTextAtSize(rest, size) > width) {
      let n = rest.length - 1;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/** Lines of about even length, so a title doesn't leave a word alone on its last line. */
function balanced(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines = wrap(text, font, size, width);
  if (lines.length < 2) return lines;
  let [lo, hi] = [width / 2, width];
  while (hi - lo > 2) {
    const mid = (lo + hi) / 2;
    if (wrap(text, font, size, mid).length > lines.length) lo = mid;
    else hi = mid;
  }
  return wrap(text, font, size, hi);
}

const linesOf = (blocks: Block[]): Line[] =>
  blocks.flatMap((b) => {
    const texts = wrap(printable(b.style.font, b.text), b.style.font, b.style.size, WIDTH);
    return texts.map((text, i) => ({ ...b, text, before: i ? 0 : b.before, first: i === 0, last: i === texts.length - 1 }));
  });

/** How tall lines are, set together. */
const heightOf = (lines: Block[]) => lines.reduce((h, l, i) => h + (i ? l.before : 0) + l.style.leading, 0);

function drawLine(page: PDFPage, l: Block, bottom: number) {
  const { font, size, leading, color, center } = l.style;
  const x = center ? (W - font.widthOfTextAtSize(l.text, size)) / 2 : MARGIN;
  page.drawText(l.text, { x, y: bottom + (leading - size) / 2 + size * 0.22, size, font, color });
}

/** Lines set from `top` down; where they end. */
function drawLines(page: PDFPage, lines: Block[], top: number): number {
  let y = top;
  lines.forEach((l, i) => {
    y -= (i ? l.before : 0) + l.style.leading;
    drawLine(page, l, y);
  });
  return y;
}

/**
 * Lines poured onto the page from `from` down (or from the top of a new page), onto a new page whenever one is full.
 * A heading never ends a page, and a paragraph never leaves one line alone: its first at the foot of a page, or its
 * last at the top of the next. Where they end.
 */
function pour(lines: Line[], newPage: () => PDFPage, from?: { page: PDFPage; y: number }): { page: PDFPage; y: number } {
  // First where each line goes (which page, counting from the first, and how low), then they're set.
  const spots: { sheet: number; y: number; top: boolean }[] = [];
  let sheet = 0;
  let y = from?.y ?? TOP;
  let fresh = !from;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = l.heading ? lines[i + 1] : undefined;
    const need = (fresh ? 0 : l.before) + l.style.leading + (next ? next.before + next.style.leading : 0);
    if (!fresh && y - need < BOTTOM) {
      const prev = spots[i - 1];
      [sheet, y, fresh] = [sheet + 1, TOP, true];
      if (prev && prev.sheet === sheet - 1 && !prev.top && !l.first && (lines[i - 1].first || l.last)) {
        // The line before comes over to the new page too, and a heading just above it.
        let k = i - 1;
        spots.pop();
        while (k > 0 && lines[k - 1].heading && spots[k - 1].sheet === sheet - 1 && !spots[k - 1].top) {
          spots.pop();
          k--;
        }
        i = k - 1;
        continue;
      }
    }
    y -= (fresh ? 0 : l.before) + l.style.leading;
    spots.push({ sheet, y, top: fresh });
    fresh = false;
  }
  let page = from?.page ?? newPage();
  let at = 0;
  lines.forEach((l, i) => {
    for (; at < spots[i].sheet; at++) page = newPage();
    drawLine(page, l, spots[i].y);
  });
  return { page, y };
}

/** A small gold flourish: a line, a diamond, a line. */
function flourish(page: PDFPage, y: number) {
  const cx = W / 2;
  page.drawLine({ start: { x: cx - 70, y }, end: { x: cx - 12, y }, thickness: 0.75, color: GOLD });
  page.drawLine({ start: { x: cx + 12, y }, end: { x: cx + 70, y }, thickness: 0.75, color: GOLD });
  page.drawSvgPath("M 0 -4.5 L 4.5 0 L 0 4.5 L -4.5 0 Z", { x: cx, y, color: GOLD });
}

function pageNumber(page: PDFPage, fonts: Fonts, n: number) {
  const text = String(n);
  page.drawText(text, { x: (W - fonts.words.widthOfTextAtSize(text, 10)) / 2, y: 26, size: 10, font: fonts.words, color: SOFT });
}

/** A picture's size to fit within `width` × `height`. */
function fit(picture: PDFImage, width: number, height: number) {
  const s = Math.min(width / picture.width, height / picture.height);
  return { w: picture.width * s, h: picture.height * s };
}

// ------------------------------------------------------------------ pictures

/** A stored picture, ready for a page: turned the right way up, no bigger than the page needs, as a JPEG. */
async function preparePicture(householdId: string, url: string): Promise<Buffer | null> {
  const rel = url.startsWith("/api/files/") ? decodeURIComponent(url.slice("/api/files/".length).split("?")[0]) : null;
  if (!rel) return null;
  try {
    const file = await fs.promises.readFile(resolveHouseholdPath(householdId, rel));
    return await sharp(file, { failOn: "none", ...(rel.endsWith(".svg") ? { density: 144 } : {}) })
      .rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn(`A picture couldn't go in the PDF (${rel}):`, err);
    return null; // its page keeps its words
  }
}

/** `work` done for each item, a few at a time (a family's photos can be big). */
async function fewAtATime<T, R>(items: T[], work: (item: T) => Promise<R>, at = 3): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(at, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]);
      }
    }),
  );
  return out;
}

// ------------------------------------------------------------------ the book

export interface StoryPdf {
  householdId: string;
  familyName: string;
  story: Story;
  book: Book;
  photos: BookPage[];
}

/** A story as a PDF: see the top of this file. Only for a story with one to make (see `pdfOffer`). */
export async function storyPdf({ householdId, familyName, story, book, photos }: StoryPdf): Promise<Uint8Array> {
  const script = story.script;
  if (!script || !pdfOffer(story)) throw new Error("This story has no PDF to make.");
  const language = languageOf(script.language);
  const words = WORDS[language];
  const source = story.settings.source;
  const count = script.pages.length;

  // "The end." (said by the voices to close every story) becomes the closing page; so does a chapter's ending.
  const say = SAYINGS[language];
  const pages = script.pages.map((p) => ({ ...p, lines: [...p.lines] }));
  const ending = pages.at(-1)?.lines.at(-1);
  const closing = ending?.speaker === "narrator" ? stripTags(ending.text) : "";
  const more = closing === say.chapterEnd;
  if (more || closing === say.theEnd) pages.at(-1)!.lines.pop();

  // The pictures: a picture book's own, or the family's photos of something they saw. A real book's pages stay home.
  const pictureOf = (page: number) => artForPage(story.art, page) ?? (source === "wild" ? imageForPage(page, photos, source, count) : null);
  const coverUrl = story.art?.cover ?? (source === "wild" ? (photos[0]?.imageUrl ?? null) : null);
  const urls = [...new Set([coverUrl, ...pages.map((p) => pictureOf(p.page))].filter((u): u is string => Boolean(u)))];

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const files = await readFonts();
  const fonts = Object.fromEntries(
    await Promise.all(Object.keys(FONTS).map(async (name) => [name, await doc.embedFont(files[name], { subset: true })] as const)),
  ) as Fonts;
  const prepared = await fewAtATime(urls, (url) => preparePicture(householdId, url));
  const pictures = new Map<string, PDFImage>();
  for (const [i, bytes] of prepared.entries()) if (bytes) pictures.set(urls[i], await doc.embedJpg(bytes));
  const picture = (url: string | null) => (url ? (pictures.get(url) ?? null) : null);

  doc.setTitle(script.title, { showInWindowTitleBar: true });
  doc.setAuthor(familyName);
  doc.setCreator("Storyhollow");
  doc.setProducer("Storyhollow");
  doc.setLanguage(language);

  const body = (size: number): Style => ({ font: fonts.words, size, leading: size * 1.5, color: INK });
  /** A page's words: its heading (if it has one), its paragraphs, and its English for a story in another language. */
  const blocksOf = (p: (typeof pages)[number], size: number, heading?: string, lead = 0): Block[] => {
    const style = body(size);
    // (Headings are in the words' type: the title type's old-style numbers read oddly in "Page 1".)
    const blocks: Block[] = heading ? [{ text: heading, style: { font: fonts.words, size: 15, leading: 22, color: GOLD }, before: lead || 34, heading: true }] : [];
    pageParagraphs(p.lines, language).forEach((text, i) => blocks.push({ text, style, before: i || heading ? (i ? size * 0.6 : 4) : lead }));
    const english = language !== "en" ? p.translation?.trim() : "";
    if (english && blocks.length) {
      const italic: Style = { font: fonts.wordsItalic, size: size * 0.82, leading: size * 1.2, color: SOFT };
      blocks.push({ text: "In English", style: { ...italic, size: size * 0.7, color: GOLD }, before: size * 1.1, heading: true });
      for (const text of english.split(/\n\s*\n/)) blocks.push({ text: text.replace(/\s+/g, " "), style: italic, before: 2 });
    }
    return blocks;
  };

  // The cover: the picture (if there is one), the title, and who it's from.
  {
    const page = doc.addPage([W, H]);
    let size = 30;
    let titleLines = balanced(printable(fonts.title, script.title), fonts.title, size, WIDTH);
    while (titleLines.length > 3 && size > 18) titleLines = balanced(printable(fonts.title, script.title), fonts.title, (size -= 2), WIDTH);
    const title: Block[] = titleLines.map((text) => ({ text, style: { font: fonts.title, size, leading: size * 1.18, color: INK, center: true }, before: 0 }));
    const small: Style = { font: fonts.words, size: 11.5, leading: 17, color: SOFT, center: true };
    const notes = [
      ...(source === "book" ? [`A new story for the pictures in “${book.title}”`, "Read it with your copy of the book, page by page."] : []),
      ...(story.mode === "read" && book.author ? [`by ${book.author}`] : []),
      story.mode === "read" ? `From the library of ${familyName}` : `Made by ${familyName}`,
    ];
    const smallPrint = linesOf(notes.map((text, i) => ({ text, style: small, before: i ? 4 : 0 })));
    const lettering = heightOf(title) + 44 + heightOf(smallPrint);
    const cover = picture(coverUrl);
    let top = H * 0.6 + lettering / 2;
    if (cover) {
      const { w, h } = fit(cover, WIDTH, Math.max(120, Math.min(H * 0.55, AREA - lettering - 34)));
      page.drawImage(cover, { x: (W - w) / 2, y: TOP - h, width: w, height: h });
      top = TOP - h - 34;
    }
    const y = drawLines(page, title, top);
    flourish(page, y - 20);
    drawLines(page, smallPrint, y - 40);
  }

  const newPage = () => doc.addPage([W, H]);
  if (pages.some((p) => picture(pictureOf(p.page)))) {
    // A picture book, or a story of the family's photos: a page for each page, its picture with its words beneath.
    for (const p of pages) {
      const art = picture(pictureOf(p.page));
      if (!art && !pageParagraphs(p.lines, language).length) continue;
      const page = newPage();
      if (count > 1) pageNumber(page, fonts, p.page);
      if (!art) {
        pour(linesOf(blocksOf(p, 14)), newPage, { page, y: TOP }); // its picture isn't drawn yet: the words alone
        continue;
      }
      let placed = false;
      for (const size of [15, 14, 13, 12]) {
        const lines = linesOf(blocksOf(p, size));
        const text = lines.length ? heightOf(lines) + GAP : 0;
        const room = Math.min(AREA * 0.64, AREA - text);
        if (room < AREA * 0.4) continue;
        const { w, h } = fit(art, WIDTH, room);
        // The picture and its words sit together, a little above the middle of the page.
        const top = TOP - Math.max(0, (AREA - h - text) * 0.3);
        page.drawImage(art, { x: (W - w) / 2, y: top - h, width: w, height: h });
        drawLines(page, lines, top - h - GAP);
        placed = true;
        break;
      }
      if (!placed) {
        // Too many words to sit beneath the picture: it has this page to itself, and the words follow.
        const { w, h } = fit(art, WIDTH, AREA);
        page.drawImage(art, { x: (W - w) / 2, y: BOTTOM + (AREA - h) / 2, width: w, height: h });
        pour(linesOf(blocksOf(p, 14)), newPage);
      }
    }
  } else {
    // The words alone, flowing from page to page: under "Page 3" to read with a real book, a new page for each chapter
    // of a longer story, and a reading straight through.
    let at: { page: PDFPage; y: number } | undefined;
    for (const p of pages) {
      if (!pageParagraphs(p.lines, language).length) continue;
      if (source === "book") at = pour(linesOf(blocksOf(p, 13.5, `${words.page} ${p.page}`)), newPage, at);
      else if (story.mode === "create" && count > 1) at = pour(linesOf(blocksOf(p, 13.5, `${words.chapter} ${p.page}`)), newPage);
      else at = pour(linesOf(blocksOf(p, 13.5, undefined, at ? 13.5 * 0.6 : 0)), newPage, at);
    }
  }

  // The End (or, for a chapter with more to come, To be continued…).
  {
    const page = newPage();
    const big: Block = { text: printable(fonts.title, more ? words.more : words.theEnd), style: { font: fonts.title, size: 40, leading: 48, color: INK, center: true }, before: 0 };
    const y = drawLines(page, [big], H * 0.62);
    flourish(page, y - 20);
    const made = new Date(story.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    drawLines(page, linesOf([{ text: `Made with Storyhollow · ${made}`, style: { font: fonts.words, size: 10.5, leading: 16, color: SOFT, center: true }, before: 0 }]), y - 40);
  }

  return doc.save({ objectsPerTick: 25 });
}

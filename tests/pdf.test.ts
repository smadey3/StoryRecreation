// A story as a PDF book: its words set as a printed book has them, what each kind of story may share, and the PDF
// itself (a cover, a page for each page, The End), with a real book's photos never in it.

import { before, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { Book, BookPage, Story, StoryScript } from "@/lib/shared/types";

let pageParagraphs: typeof import("@/lib/server/pdf").pageParagraphs;
let storyPdf: typeof import("@/lib/server/pdf").storyPdf;
let pdfOffer: typeof import("@/lib/shared/pdf").pdfOffer;
let pdfFileName: typeof import("@/lib/shared/pdf").pdfFileName;
let data = "";

before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-pdf-test-"));
  process.env.DATA_DIR = data;
  ({ pageParagraphs, storyPdf } = await import("@/lib/server/pdf"));
  ({ pdfOffer, pdfFileName } = await import("@/lib/shared/pdf"));
});

/** A picture saved where the family's files are, and its file address. */
async function picture(rel: string, width: number, height: number) {
  const full = path.join(data, "households", "hh", rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: "#a8792b" } })
    .png()
    .toFile(full);
  return `/api/files/${rel}`;
}

const script = (pages: number, language: StoryScript["language"] = "en"): StoryScript => ({
  title: "Juniper and the Lighthouse Whale",
  synopsis: "",
  ambience: "",
  cast: [],
  language,
  pages: Array.from({ length: pages }, (_, i) => ({
    page: i + 1,
    picture: "",
    lines: [
      { speaker: "narrator", text: "Juniper watched the waves." },
      { speaker: "juniper", text: "[whispers] Is the whale lonely?" },
      ...(i === pages - 1 ? [{ speaker: "narrator", text: "The end." }] : []),
    ],
  })),
});
const story = (over: Partial<Story>): Story =>
  ({
    id: "s1",
    bookId: "b1",
    profileId: null,
    mode: "create",
    title: "Juniper and the Lighthouse Whale",
    synopsis: null,
    settings: { source: "idea" },
    script: script(3),
    status: "ready",
    progress: null,
    error: null,
    audioUrl: null,
    timeline: null,
    duration: null,
    favorite: false,
    playCount: 0,
    lastPlayedAt: null,
    createdAt: Date.UTC(2026, 9, 20),
    art: null,
    ...over,
  }) as Story;
const book = { id: "b1", title: "The Lighthouse", author: null, kind: "idea" } as Book;
const make = (s: Story, photos: BookPage[] = [], b: Book = book) => storyPdf({ householdId: "hh", familyName: "The Lantern Family", story: s, book: b, photos });
const pagesIn = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();
const imagesIn = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").split("/Subtype /Image").length - 1;

test("what the characters say is in quotation marks, in the paragraph that leads up to it", () => {
  const paragraphs = pageParagraphs([
    { speaker: "narrator", text: "Juniper pressed her nose to the window." },
    { speaker: "juniper", text: "[whispers] Do you think the whale is lonely?" },
    { speaker: "narrator", text: "she whispered." },
    { speaker: "grandpa", text: "Everyone gets lonely sometimes." },
    { speaker: "grandpa", text: "That's why we keep the light burning." },
    { speaker: "narrator", text: "Far away, a song rose from the deep.\n\nAnd Juniper smiled." },
  ]);
  assert.deepEqual(paragraphs, [
    "Juniper pressed her nose to the window. “Do you think the whale is lonely?” she whispered.",
    "“Everyone gets lonely sometimes.” “That's why we keep the light burning.”",
    "Far away, a song rose from the deep.",
    "And Juniper smiled.",
  ]);
});

test("quotation marks as each language has them, and nothing quoted twice", () => {
  assert.deepEqual(pageParagraphs([{ speaker: "hero", text: "Tu as vu ça ? Tournons la page !" }], "fr"), ["« Tu as vu ça ? Tournons la page ! »"]);
  assert.deepEqual(pageParagraphs([{ speaker: "hero", text: "¿Viste eso?" }], "es"), ["«¿Viste eso?»"]);
  assert.deepEqual(pageParagraphs([{ speaker: "hero", text: "“Already quoted,” said the book." }]), ["“Already quoted,” said the book."]);
});

test("a story's PDF has its pictures and words, a new story for a real book its words alone, and a reading of a real book none", () => {
  assert.equal(pdfOffer(story({})), "all");
  assert.equal(pdfOffer(story({ settings: { source: "wild" } as Story["settings"] })), "all");
  assert.equal(pdfOffer(story({ settings: { source: "book" } as Story["settings"] })), "words");
  assert.equal(pdfOffer(story({ settings: { source: "book_read" } as Story["settings"] })), null);
  assert.equal(pdfOffer(story({ script: null })), null);
  assert.equal(pdfFileName('The Owl: "Who?" / Part 1'), "The Owl Who Part 1.pdf");
});

test("a picture book: the cover, a page for each page with its picture, and The End", async () => {
  const art = {
    cover: await picture("stories/s1/art/cover.png", 600, 600),
    pages: [await picture("stories/s1/art/1.png", 600, 600), await picture("stories/s1/art/2.png", 800, 600), null],
  } as Story["art"];
  const bytes = await make(story({ art }));
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  assert.equal(await pagesIn(bytes), 5);
  assert.equal(imagesIn(bytes), 3, "the cover and the two pictures drawn");
});

test("a new story for a real book leaves the book's own photos out", async () => {
  const photos = [{ id: "p1", pageNumber: 1, imageUrl: await picture("books/b1/page1.png", 600, 800) }];
  const bytes = await make(story({ settings: { source: "book" } as Story["settings"] }), photos, { ...book, kind: "picture_book" });
  assert.equal(imagesIn(bytes), 0);
  assert.ok((await pagesIn(bytes)) >= 3);
});

test("the family's own photos are in a story of something they saw, and a missing one leaves its page with its words", async () => {
  const photos = [
    { id: "p1", pageNumber: 1, imageUrl: await picture("books/b2/one.png", 600, 800) },
    { id: "p2", pageNumber: 2, imageUrl: "/api/files/books/b2/gone.png" },
  ];
  const bytes = await make(story({ settings: { source: "wild" } as Story["settings"], script: script(2) }), photos);
  assert.equal(await pagesIn(bytes), 4, "the cover, two pages and The End");
  assert.equal(imagesIn(bytes), 1);
});

test("a story in French, with emoji in its title, still makes its book", async () => {
  const bytes = await make(story({ script: { ...script(2, "fr"), title: "🌙 Juniper et la baleine" } }));
  assert.ok((await pagesIn(bytes)) >= 4);
});

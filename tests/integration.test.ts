// Exercises the real Claude and ElevenLabs SDK calls against a local fake of
// both APIs, checking what we send (models, fallbacks, schema, voices) and
// that we read the replies (streamed JSON, PCM audio, timings) correctly.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}
const captured: Captured[] = [];
let server: http.Server;
let scriptJson = "";
let catalogueDownloads = 0;

// A slice of Project Gutenberg's pg_catalog.csv, awkward bits included.
const CATALOGUE_CSV = [
  "Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves",
  '11,Text,2008-06-27,Alice\'s Adventures in Wonderland,en,"Carroll, Lewis, 1832-1898; Tenniel, John, 1820-1914 [Illustrator]","Fantasy fiction; Children\'s stories; Imaginary places -- Juvenile fiction",PR,Category: Children & Young Adult Reading',
  '16,Text,1994-07-01,"Peter Pan\nor, The Boy Who Wouldn\'t Grow Up",en,"Barrie, J. M. (James Matthew), 1860-1937","Fairy tales; Peter Pan (Fictitious character) -- Juvenile fiction",PR,Children\'s Literature',
  '14838,Text,2005-01-30,The Tale of Peter Rabbit,en,"Potter, Beatrix, 1866-1943","Rabbits -- Juvenile fiction; Animals -- Juvenile fiction",PZ,Children\'s Picture Books',
  '271,Text,1995-04-01,Black Beauty,en,"Sewell, Anna, 1820-1878","Horses -- Juvenile fiction",PZ,"Children\'s Literature, Animals"',
  '19033,Text,2006-08-12,Le Petit Prince,fr,"Someone, A.","Juvenile fiction",PQ,',
  '26223,Sound,2008-08-01,Just So Stories (audio),en,"Kipling, Rudyard, 1865-1936","Animals -- Juvenile fiction",PZ,',
  '2591,Text,2001-04-01,Grimms\' Fairy Tales,en,"Grimm, Jacob, 1785-1863; Grimm, Wilhelm, 1786-1859","Fairy tales -- Germany",GR,',
  '21,Text,1991-01-01,Aesop\'s Fables,en,"Aesop, 621? BCE-565? BCE","Fables, Greek",PA,',
  '1342,Text,1998-06-01,Pride and Prejudice,en,"Austen, Jane, 1775-1817","Love stories; England -- Fiction",PR,',
  '1400,Text,1998-01-01,All Hallows Eve Sermons,en,"Grey, Thomas","Halloween; Sermons",BV,',
  '3000,Text,2002-01-01,The Pumpkin Party,en,"Bell, Ada, 1900-1950","Halloween -- Juvenile fiction",PZ,',
  '5000,Text,2004-01-01,Tilly and the Dragon,en,"Moss, May","Dragons -- Juvenile fiction",PZ,',
].join("\r\n");
let soundJson = "";

const PERSONA_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const OWL_VOICE = "pqHfZKP75CvOlQylNhV4";

// A storyteller that writes slowly (milliseconds between pieces), and voices that take a while, to watch what happens
// while each is at work: when the script finished, and every recording asked for, when, and how many at once.
let busyFor = 0; // the storyteller's next few requests are turned away: too many this minute
let creditGone = false; // the storyteller's prepaid credit is used up
let writingPause = 0;
let writingEndedAt = 0;
let voicingPause = 0;
let voicingNow = 0;
let mostVoicingAtOnce = 0;
const voiced: { text: string; at: number }[] = [];

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const pieces = Array.from({ length: Math.ceil(text.length / 40) }, (_, i) => text.slice(i * 40, i * 40 + 40));
  const finish = () => {
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 200 } });
    send("message_stop", { type: "message_stop" });
    writingEndedAt = Date.now();
    res.end();
  };
  const next = (i: number) => {
    if (i === pieces.length) return finish();
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: pieces[i] } });
    if (writingPause) setTimeout(() => next(i + 1), writingPause);
    else next(i + 1);
  };
  next(0);
}

function pcmBase64(seconds: number): string {
  const n = Math.round(24000 * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 24000) * 6000), i * 2);
  return buf.toString("base64");
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw && String(req.headers["content-type"] ?? "").includes("json") ? JSON.parse(raw) : raw || null;
      captured.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url!.startsWith("/v1/messages")) {
        if (creditGone) {
          // what Anthropic says once the prepaid credit is used up (with auto reload off)
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
            }),
          );
        }
        if (busyFor > 0) {
          busyFor--;
          res.writeHead(429, { "content-type": "application/json", "retry-after-ms": "150" });
          return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many tokens this minute." } }));
        }
        if ((body as { stream?: boolean }).stream) return sse(res, scriptJson);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
            content: [{ type: "text", text: soundJson }], usage: { input_tokens: 10, output_tokens: 40 },
          }),
        );
      }
      if (req.url!.startsWith("/pg_catalog.csv.gz")) {
        catalogueDownloads++;
        res.writeHead(200, { "content-type": "application/gzip" });
        return res.end(gzipSync(CATALOGUE_CSV));
      }
      if (req.url!.startsWith("/v1/user/subscription")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ tier: "creator", character_count: 12000, character_limit: 100000, next_character_count_reset_unix: 1790000000 }));
      }
      if (req.url!.startsWith("/v1/sound-generation")) {
        res.writeHead(200, { "content-type": "audio/pcm" });
        return res.end(Buffer.from(pcmBase64(1.5), "base64"));
      }
      if (req.url!.startsWith("/v1/text-to-dialogue/with-timestamps")) {
        const inputs = (body as { inputs: { text: string; voice_id: string }[] }).inputs;
        const text = inputs.map((i) => i.text).join(" ");
        voiced.push({ text, at: Date.now() });
        mostVoicingAtOnce = Math.max(mostVoicingAtOnce, ++voicingNow);
        const chars = [...text];
        let at = 0;
        const segments = inputs.map((inp, idx) => {
          const seg = {
            voice_id: inp.voice_id,
            start_time_seconds: at * 0.05,
            end_time_seconds: (at + inp.text.length) * 0.05,
            character_start_index: at,
            character_end_index: at + inp.text.length,
            dialogue_input_index: idx,
          };
          at += inp.text.length + 1;
          return seg;
        });
        const reply = () => {
          voicingNow--;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
          JSON.stringify({
            audio_base64: pcmBase64(chars.length * 0.05),
            alignment: {
              characters: chars,
              character_start_times_seconds: chars.map((_, i) => i * 0.05),
              character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.045),
            },
            voice_segments: segments,
          }),
          );
        };
        return voicingPause ? void setTimeout(reply, voicingPause) : reply();
      }
      if (req.url!.startsWith("/v1/text-to-voice/design")) {
        // ElevenLabs turns some descriptions down; the reason rides in detail.message
        const desc = String((body as { voice_description?: string }).voice_description);
        const [code, detail] = desc.includes("no permission")
          ? [401, { status: "missing_permissions", message: "The API key you used is missing the permission text_to_voice." }]
          : [400, { status: "invalid_voice_description", message: "This voice description isn't allowed." }];
        res.writeHead(code, { "content-type": "application/json" });
        return res.end(JSON.stringify({ detail }));
      }
      if (req.url!.startsWith("/v1/voices/add")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ voice_id: "famVoice123", requires_verification: false }));
      }
      if (req.method === "DELETE" && req.url!.startsWith("/v1/voices/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "ok" }));
      }
      if (req.url!.startsWith("/v2/voices")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            voices: [
              { voice_id: PERSONA_VOICE, name: "George", category: "premade", labels: { gender: "male", age: "middle_aged", accent: "british", descriptive: "warm" }, preview_url: "https://example.com/george.mp3" },
              { voice_id: OWL_VOICE, name: "Bill", category: "premade", labels: { gender: "male", age: "old", accent: "american" } },
              { voice_id: "customMouse123", name: "Squeaky Mouse", category: "generated", labels: {}, description: "tiny squeaky mouse" },
            ],
            has_more: false,
            total_count: 3,
          }),
        );
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ELEVENLABS_API_KEY = "test-eleven";
  process.env.ELEVENLABS_BASE_URL = base;
  process.env.GUTENBERG_CATALOG_URL = `${base}/pg_catalog.csv.gz`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-test-"));
  delete process.env.DEMO_MODE;
});

after(() => server.close());

test("the storyteller sends pictures, settings and the voice catalog, and reads the streamed script", async () => {
  const { writeScript } = await import("@/lib/server/storyteller");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { voiceCatalog } = await import("@/lib/server/voices");

  const voices = await voiceCatalog("household-1");
  assert.ok(voices.find((v) => v.voiceId === PERSONA_VOICE)?.persona, "personas are matched to account voices");
  assert.equal(voices.find((v) => v.voiceId === "customMouse123")?.source, "account");
  assert.equal(voices.find((v) => v.voiceId === PERSONA_VOICE)?.previewUrl, "https://example.com/george.mp3");

  scriptJson = JSON.stringify({
    title: "The Owl Who Borrowed the Moon",
    synopsis: "Ollie borrows the moon for one night.",
    ambience: "soft crickets",
    cast: [
      { id: "narrator", name: "Narrator", description: "storyteller", voice_brief: "warm", voice_id: PERSONA_VOICE },
      { id: "Ollie Owl", name: "Ollie the Owl", description: "a wise owl", voice_brief: "old and creaky", voice_id: OWL_VOICE },
    ],
    pages: [
      { page: 1, photo: 1, picture: "An owl on a tree", lines: [{ speaker: "narrator", text: "High in the old oak sat Ollie." }, { speaker: "ollie-owl", text: "[sleepily] Hoo..." }] },
      { page: 2, photo: 2, picture: "A fox", lines: [{ speaker: "mystery-guest", text: "Who goes there?" }] },
      { page: 3, photo: 3, picture: "extra page the model shouldn't have added", lines: [] },
    ],
  });

  const progress: string[] = [];
  const tinyJpeg = Buffer.from("/9j/4AAQSkZJRgABAQ==", "base64").toString("base64");
  const { script, photoOrder, cost } = await writeScript(
    {
      mode: "create",
      bookTitle: "The Moonlit Woods",
      bookKind: "shadow_book",
      settings: defaultSettings({ heroes: ["Mia"], mood: "silly", lesson: "Sharing" }),
      images: [
        { data: tinyJpeg, mediaType: "image/jpeg" },
        { data: tinyJpeg, mediaType: "image/jpeg" },
      ],
      pageCount: 2,
      previousStories: [{ title: "Old Tale", synopsis: "Something that happened before." }],
      rememberedCharacters: [{ name: "Ollie the Owl", description: "wise owl", voiceId: OWL_VOICE }],
      voices,
    },
    (step, done, total) => progress.push(`${step} ${done}/${total}`),
  );

  const req = captured.find((c) => c.url.startsWith("/v1/messages"))!;
  assert.ok(req, "Claude was called");
  // what it cost, at Claude Opus 5.5's prices: 10 tokens in at $4 a million, 200 out at $20 a million
  assert.equal(cost, 10 * 4 + 200 * 20);
  const effects = (req.body as Record<string, any>).output_config.format.schema.properties.pages.items.properties.effect.enum;
  assert.ok(effects.includes("sparkles") && effects.includes("none"), "the storyteller picks a moving touch for each page");
  const body = req.body as Record<string, any>;
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.equal(req.headers["x-api-key"], "test-key");
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.output_config.effort, "high");
  assert.equal(body.output_config.format.type, "json_schema");
  const voiceEnum = body.output_config.format.schema.properties.cast.items.properties.voice_id.enum;
  assert.ok(voiceEnum.includes(PERSONA_VOICE) && voiceEnum.includes("customMouse123"));
  assert.ok(!body.output_config.format.schema.properties.pages.items.required.includes("translation"), "an English story has no English version");
  const content = body.messages[0].content as { type: string; text?: string }[];
  assert.equal(content.filter((c) => c.type === "image").length, 2);
  const ask = content.at(-1)!.text!;
  for (const expected of ["exactly 2 pages", "Mia", "Sharing", "Old Tale", "Ollie the Owl", "<voice_catalog>", "Silly & giggly", "Page order", "keep those names"]) {
    assert.ok(ask.includes(expected), `prompt mentions ${expected}`);
  }

  assert.equal(photoOrder, null, "no reordering when the pages were already in order");
  assert.equal(script.title, "The Owl Who Borrowed the Moon");
  assert.equal(script.pages.length, 2, "pages line up with the pictures");
  assert.equal(script.cast[1].id, "ollie-owl", "speaker ids are slugged");
  assert.equal(script.pages[0].lines[1].speaker, "ollie-owl");
  assert.equal(script.pages[1].lines[0].speaker, "narrator", "unknown speakers fall back to the narrator");
  assert.ok(progress.some((p) => p.startsWith("Writing the pages")));
});

test("the performer sends a multi-voice dialogue and returns PCM with word timings", async () => {
  const { performLines } = await import("@/lib/server/performer");
  const cast = [
    { id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: PERSONA_VOICE },
    { id: "ollie-owl", name: "Ollie", description: "", voiceBrief: "", voiceId: OWL_VOICE },
  ];
  const clip = await performLines(
    [
      { speaker: "narrator", text: "High in the old oak sat Ollie." },
      { speaker: "ollie-owl", text: "[sleepily] Hoo... who's there?" },
    ],
    cast,
  );
  const req = captured.find((c) => c.url.startsWith("/v1/text-to-dialogue/with-timestamps"))!;
  assert.ok(req, "ElevenLabs dialogue was called");
  assert.match(req.url, /output_format=pcm_24000/);
  assert.equal(req.headers["xi-api-key"], "test-eleven");
  const body = req.body as { inputs: { text: string; voice_id: string }[]; model_id: string };
  assert.equal(body.model_id, "eleven_v4");
  assert.deepEqual(body.inputs.map((i) => i.voice_id), [PERSONA_VOICE, OWL_VOICE]);
  assert.equal(body.inputs[1].text, "[sleepily] Hoo... who's there?", "delivery tags are sent to the voice model");
  assert.equal((body as { language_code?: string }).language_code, undefined, "English is performed as it always was");

  assert.ok(clip.samples.length > 24000, "audio decoded");
  assert.deepEqual(
    clip.words.map((w) => w.w),
    ["High", "in", "the", "old", "oak", "sat", "Ollie.", "Hoo...", "who's", "there?"],
  );
  assert.equal(clip.words[0].speaker, "narrator");
  assert.equal(clip.words.at(-1)!.speaker, "ollie-owl");
});

test("a story in French: written in French with each page in English, voiced in French, welcomed in French", async () => {
  const { writeScript } = await import("@/lib/server/storyteller");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { voiceCatalog } = await import("@/lib/server/voices");
  const db = await import("@/lib/server/db");
  const { startRecording, isRunning } = await import("@/lib/server/jobs");
  const voices = await voiceCatalog("household-1");
  const from = captured.length;

  scriptJson = JSON.stringify({
    title: "Le Petit Phare",
    synopsis: "Élodie aide un phare à se réveiller.",
    ambience: "gentle waves on a pebble beach",
    cast: [
      { id: "narrator", name: "Narrateur", description: "storyteller", voice_brief: "warm", voice_id: PERSONA_VOICE },
      { id: "Élodie", name: "Élodie", description: "a brave girl", voice_brief: "bright", voice_id: OWL_VOICE },
    ],
    pages: [
      { page: 1, photo: 0, picture: "A lighthouse at dusk", effect: "stars", translation: "The little lighthouse was asleep.", lines: [{ speaker: "narrator", text: "Le petit phare dormait." }] },
      { page: 2, photo: 0, picture: "A girl on the rocks", effect: "none", translation: "“Wake up!” said Élodie.", lines: [{ speaker: "élodie", text: "[excitedly] Réveille-toi !" }] },
    ],
  });
  const { script } = await writeScript(
    {
      mode: "create",
      bookTitle: "Le Phare",
      bookKind: "idea",
      settings: defaultSettings({ source: "idea", language: "fr", learner: true, heroes: ["Élodie"] }),
      images: [],
      pageCount: 2,
      previousStories: [],
      rememberedCharacters: [],
      voices,
    },
    () => undefined,
  );
  const body = captured.slice(from).find((c) => c.url.startsWith("/v1/messages"))!.body as Record<string, any>;
  const ask = body.messages[0].content.at(-1).text as string;
  for (const expected of ["tell the whole story in French", "Delivery tags stay in English", "learning French", '"translation"', "speak French"]) {
    assert.ok(ask.includes(expected), `the storyteller is told: ${expected}`);
  }
  const pageSchema = body.output_config.format.schema.properties.pages.items;
  assert.ok(pageSchema.required.includes("translation"), "every page comes in English too");
  assert.equal(body.output_config.format.schema.properties.language, undefined, "a new story's language is the family's choice");
  assert.equal(script.language, "fr");
  assert.deepEqual(script.pages.map((p) => p.translation), ["The little lighthouse was asleep.", "“Wake up!” said Élodie."]);
  assert.equal(script.cast[1].id, "elodie", "accents are taken off ids");
  assert.equal(script.pages[1].lines[0].speaker, "elodie");

  // Recorded: the welcome in French, and ElevenLabs told the language.
  const hh = db.createHousehold("The Phare Family", "phare@example.com", "x");
  const book = db.createBook(hh, { title: "Le Phare", kind: "idea" });
  const settings = { ...defaultSettings({ source: "idea", language: "fr" }), intro: true, chime: { enabled: false, style: "bell" as const, gapSeconds: 3 } };
  const id = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: script.title, settings, status: "draft" });
  db.updateStory(id, { script });
  const before = captured.length;
  startRecording(id);
  for (let i = 0; i < 400 && isRunning(id); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(db.getStoryById(id)!.status, "ready");
  const dialogue = captured.slice(before).filter((c) => c.url.startsWith("/v1/text-to-dialogue")).map((c) => c.body as { inputs: { text: string }[]; language_code?: string });
  assert.ok(dialogue.length >= 3 && dialogue.every((d) => d.language_code === "fr"), "every page and the welcome are performed in French");
  assert.ok(
    dialogue.some((d) => d.inputs[0].text === "[warmly] Bienvenue à Storyhollow. L'histoire de ce soir s'appelle Le Petit Phare. Alors, installe-toi bien... et commençons."),
    "the welcome is in French",
  );
  assert.equal(db.listStoryCards(hh)[0].language, "fr", "its card says so");
});

test("a book read aloud in its own language: the reader says which, and gives each page in English", async () => {
  const { writeScript } = await import("@/lib/server/storyteller");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { voiceCatalog } = await import("@/lib/server/voices");
  const voices = await voiceCatalog("household-1");
  const tinyJpeg = Buffer.from("/9j/4AAQSkZJRgABAQ==", "base64").toString("base64");
  const read = async (language: string, translation: string) => {
    scriptJson = JSON.stringify({
      title: "El Gato",
      synopsis: "A cat.",
      ambience: "a quiet room",
      language,
      cast: [{ id: "narrator", name: "Narrator", description: "", voice_brief: "", voice_id: PERSONA_VOICE }],
      pages: [{ page: 1, photo: 1, picture: "", effect: "none", translation, lines: [{ speaker: "narrator", text: "El gato duerme." }] }],
    });
    const from = captured.length;
    const { script } = await writeScript(
      {
        mode: "read",
        bookTitle: "El Gato",
        bookKind: "picture_book",
        settings: defaultSettings({ source: "book_read", fullCast: false }),
        images: [{ data: tinyJpeg, mediaType: "image/jpeg" }],
        pageCount: 1,
        previousStories: [],
        rememberedCharacters: [],
        voices,
      },
      () => undefined,
    );
    const schema = (captured.slice(from).find((c) => c.url.startsWith("/v1/messages"))!.body as Record<string, any>).output_config.format.schema;
    assert.ok(schema.required.includes("language") && schema.properties.pages.items.required.includes("translation"));
    return script;
  };
  const spanish = await read("es", "The cat is sleeping.");
  assert.equal(spanish.language, "es");
  assert.equal(spanish.pages[0].translation, "The cat is sleeping.");
  const english = await read("en", "The cat is sleeping.");
  assert.equal(english.language, undefined, "an English book is just English");
  assert.equal(english.pages[0].translation, undefined, "and needs no English version");
});

test("pages photographed back to front are put back in reading order", async () => {
  const { writeScript, photoOrderFrom } = await import("@/lib/server/storyteller");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { applyPhotoOrder } = await import("@/lib/server/jobs");
  const db = await import("@/lib/server/db");

  const page = (n: number, photo: number) => ({ page: n, photo, picture: `page ${n}`, lines: [{ speaker: "narrator", text: `Page ${n}.` }] });
  scriptJson = JSON.stringify({
    title: "Back to Front",
    synopsis: "A test.",
    ambience: "wind",
    cast: [{ id: "narrator", name: "Narrator", description: "", voice_brief: "", voice_id: PERSONA_VOICE }],
    pages: [page(1, 3), page(2, 2), page(3, 1)],
  });
  const img = { data: Buffer.from("x").toString("base64"), mediaType: "image/jpeg" as const };
  const req = {
    mode: "create" as const,
    bookTitle: "Halloween",
    bookKind: "shadow_book" as const,
    settings: defaultSettings({ keepNames: false }),
    images: [img, img, img],
    pageCount: 3,
    previousStories: [],
    rememberedCharacters: [],
    voices: [{ voiceId: PERSONA_VOICE, name: "George", description: "", gender: null, age: null, accent: null, previewUrl: null, persona: null, source: "default" as const }],
  };
  const { photoOrder } = await writeScript(req, () => undefined);
  assert.deepEqual(photoOrder, [3, 2, 1]);
  const ask = (captured.filter((c) => c.url.startsWith("/v1/messages")).at(-1)!.body as any).messages[0].content.at(-1).text as string;
  assert.ok(ask.includes("give the characters fresh new names"));

  // Only complete, one-to-one orders are trusted.
  const raw = (order: number[]) => ({ title: "", synopsis: "", ambience: "", cast: [], pages: order.map((o, i) => page(i + 1, o)) });
  assert.equal(photoOrderFrom(raw([1, 1, 2]), req), null);
  assert.equal(photoOrderFrom(raw([1, 2, 4]), req), null);
  assert.equal(photoOrderFrom(raw([1, 2]), req), null);
  assert.equal(photoOrderFrom(raw([2, 1, 3]), { ...req, settings: defaultSettings({ source: "wild" }) }), null);

  // Applying it reorders the book and moves the cover to the real first page.
  const hid = db.createHousehold("Test", `t${Date.now()}@example.com`, "x");
  const bookId = db.createBook(hid, { title: "Halloween", kind: "shadow_book" });
  db.replacePages(bookId, ["books/p8.jpg", "books/p7.jpg", "books/p6.jpg"]);
  db.updateBook(hid, bookId, { coverPath: "books/p8.jpg" });
  const sent = db.listPageRows(bookId);
  applyPhotoOrder(hid, bookId, sent, [3, 2, 1]);
  assert.deepEqual(db.listPageRows(bookId).map((r) => r.image_path), ["books/p6.jpg", "books/p7.jpg", "books/p8.jpg"]);
  assert.equal(db.getBook(hid, bookId)!.coverUrl, "/api/files/books/p6.jpg");

  // If the pages changed meanwhile, leave them alone.
  applyPhotoOrder(hid, bookId, sent, [3, 2, 1]);
  assert.deepEqual(db.listPageRows(bookId).map((r) => r.image_path), ["books/p6.jpg", "books/p7.jpg", "books/p8.jpg"]);
});

test("a grown-up's recordings become a family voice that reads only when chosen", async () => {
  const db = await import("@/lib/server/db");
  const { cloneFamilyVoice, deleteAccountVoice } = await import("@/lib/server/performer");
  const { voiceCatalog, castableVoices, forgetVoiceCache } = await import("@/lib/server/voices");

  const voiceId = await cloneFamilyVoice("Grandma June", "Grandma June", [{ data: Buffer.from("ID3 fake audio"), filename: "recording-1.mp3" }], true);
  assert.equal(voiceId, "famVoice123");
  const req = captured.find((c) => c.url.startsWith("/v1/voices/add"))!;
  assert.equal(req.method, "POST");
  assert.match(String(req.headers["content-type"]), /multipart\/form-data/);
  const body = String(req.body);
  assert.match(body, /name="name"\r\n\r\nStoryhollow · Grandma June/);
  assert.match(body, /name="files"; filename="recording-1.mp3"/);
  assert.match(body, /name="remove_background_noise"\r\n\r\ntrue/);

  const hh = db.createHousehold("The Junes", "june@example.com", "x");
  const k = db.addKeepsake(hh, { person: "Grandma June", title: "Birthday voicemail", recordedOn: "2021", audioPath: "keepsakes/a.mp3", durationMs: 42_000 });
  db.saveFamilyVoice(hh, { voiceId, name: "Grandma June", person: "Grandma June", keepsakeIds: [k.id] });
  forgetVoiceCache();
  const voices = await voiceCatalog(hh);
  // first in every storyteller list, and "Hear me" is her voice reading a few lines of a story
  assert.equal(voices[0].voiceId, voiceId);
  assert.equal(voices[0].source, "family");
  assert.equal(voices[0].previewUrl, `/api/family-voices/${voiceId}/sample`);
  // never cast as a character unless the family picked her to tell the story
  assert.ok(!castableVoices(voices, null).some((v) => v.voiceId === voiceId));
  assert.ok(castableVoices(voices, voiceId).some((v) => v.voiceId === voiceId));

  await deleteAccountVoice(voiceId);
  assert.ok(captured.some((c) => c.method === "DELETE" && c.url === `/v1/voices/${voiceId}`));
  assert.ok(db.deleteFamilyVoice(hh, voiceId));
  assert.equal(db.deleteKeepsake(hh, k.id), "keepsakes/a.mp3");
});

test("a family voice's sample is the voice itself reading a few lines of a story, made once and kept", async () => {
  const { voiceSample, forgetVoiceSample, SAMPLE_TEXT } = await import("@/lib/server/voiceSample");
  const { resolveHouseholdPath } = await import("@/lib/server/files");
  const db = await import("@/lib/server/db");
  const hh = db.createHousehold("The Samples", "samples@example.com", "x");
  const asked = () => captured.filter((c) => c.url.startsWith("/v1/text-to-dialogue") && JSON.stringify(c.body).includes("a little fox"));
  const before = asked().length;

  // tapped twice at once, it's made once
  const [rel, again] = await Promise.all([voiceSample(hh, "famVoice123"), voiceSample(hh, "famVoice123")]);
  assert.equal(rel, again);
  assert.equal(rel, "voices/famVoice123-sample.mp3");
  const made = asked().slice(before);
  assert.equal(made.length, 1);
  const inputs = (made[0].body as { inputs: { text: string; voice_id: string }[] }).inputs;
  assert.deepEqual(inputs, [{ text: SAMPLE_TEXT, voice_id: "famVoice123" }]);
  const mp3 = fs.readFileSync(resolveHouseholdPath(hh, rel));
  assert.ok(mp3.length > 1000 && mp3[0] === 0xff, "an MP3");

  // after that it's simply played
  assert.equal(await voiceSample(hh, "famVoice123"), rel);
  assert.equal(asked().length, before + 1);
  // and a voice that's gone takes its sample with it
  forgetVoiceSample(hh, "famVoice123");
  assert.ok(!fs.existsSync(resolveHouseholdPath(hh, rel)));
});

test("when ElevenLabs turns a voice down, the family hears why", async () => {
  const { designVoicePreviews, elevenLabsReason } = await import("@/lib/server/performer");
  const refused = await designVoicePreviews("a voice ElevenLabs will turn down today").catch((e) => e);
  assert.equal(elevenLabsReason(refused), "ElevenLabs said: “This voice description isn't allowed.”");
  const locked = await designVoicePreviews("a key with no permission for voice design").catch((e) => e);
  assert.match(elevenLabsReason(locked)!, /isn't allowed to do this.*turn on every permission/);
  assert.equal(elevenLabsReason(new Error("socket hang up")), null);
});

test("download everything packs stories, recordings and photos into a ZIP that opens", async () => {
  const db = await import("@/lib/server/db");
  const { familyBackup } = await import("@/lib/server/backup");
  const { zipStream, crc32 } = await import("@/lib/server/zip");
  const { householdDir } = await import("@/lib/server/files");
  const { defaultSettings } = await import("@/lib/shared/options");

  const hh = db.createHousehold("The Hollow Hill Family", "hill@example.com", "x");
  const put = (rel: string, bytes: Buffer) => {
    const full = path.join(householdDir(hh), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  };
  const book = db.createBook(hh, { title: "Hollow Hill", kind: "shadow_book" });
  put("books/p1.jpg", Buffer.from("jpeg-bytes"));
  db.replacePages(book, ["books/p1.jpg"]);
  const story = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: "The Hundredth Star", settings: defaultSettings({}), status: "ready" });
  put("stories/s1.mp3", Buffer.from("ID3 the hundredth star"));
  db.updateStory(story, {
    audioPath: "stories/s1.mp3",
    duration: 125,
    script: { title: "The Hundredth Star", synopsis: "", ambience: "", cast: [{ id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: "v" }, { id: "owl", name: "Ollie", description: "", voiceBrief: "", voiceId: "v" }], pages: [{ page: 1, picture: "", lines: [{ speaker: "owl", text: "[softly] Ninety-nine... oh!" }] }] },
  });
  put("keepsakes/k1.mp3", Buffer.from("ID3 grandma"));
  db.addKeepsake(hh, { person: "Grandma June", title: "Birthday voicemail", recordedOn: "Spring 2021", audioPath: "keepsakes/k1.mp3", durationMs: 42_000 });

  const backup = familyBackup(hh);
  assert.deepEqual({ ...backup.summary, bytes: 0 }, { stories: 1, recordings: 1, photos: 1, bytes: 0 });
  const { stream, size } = zipStream(backup.entries);
  const zip = Buffer.concat(await Array.fromAsync(stream as unknown as AsyncIterable<Uint8Array>));
  assert.equal(zip.length, size, "Content-Length matches the bytes sent");
  assert.equal(backup.summary.bytes, size);

  // read the central directory back
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const len = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26);
    const data = zip.subarray(dataAt, dataAt + len);
    assert.equal(crc32(data), crc, `checksum of ${name}`);
    files[name.slice(backup.root.length + 1)] = data;
    at += 46 + nameLen;
  }
  assert.deepEqual(Object.keys(files).sort(), [
    "Book pages/Hollow Hill/page-01.jpg",
    "Family voices/Grandma June/Birthday voicemail (Spring 2021).mp3",
    "Read me.html",
    "Stories/Hollow Hill/The Hundredth Star.mp3",
  ]);
  assert.equal(files["Stories/Hollow Hill/The Hundredth Star.mp3"].toString(), "ID3 the hundredth star");
  const readme = files["Read me.html"].toString();
  assert.match(readme, /<b>Ollie<\/b> Ninety-nine\.\.\. oh!/); // the words, without delivery cues
  assert.match(readme, /src="Family%20voices\/Grandma%20June\/Birthday%20voicemail%20\(Spring%202021\)\.mp3"/);

  // and a real unzip tool agrees, where one is installed
  const out = path.join(os.tmpdir(), `storyhollow-${Date.now()}.zip`);
  fs.writeFileSync(out, zip);
  const { spawnSync } = await import("node:child_process");
  const check = spawnSync("unzip", ["-tq", out], { encoding: "utf8" });
  if (!check.error) assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("sign-ups close after the first family unless a sign-up code is set", async () => {
  const { signupMode, codeMatches } = await import("@/lib/server/signup");
  // Earlier tests created a household, so without a code the doors are closed.
  delete process.env.SIGNUP_CODE;
  assert.equal(signupMode(), "closed");
  process.env.SIGNUP_CODE = "moonlight";
  assert.equal(signupMode(), "code");
  assert.ok(codeMatches(" moonlight "));
  assert.ok(!codeMatches("moon"));
  assert.ok(!codeMatches(""));
  delete process.env.SIGNUP_CODE;
});

test("when the storyteller's credit runs out, it says so plainly, and isn't asked again and again", async () => {
  const { spotSoundEffects, OutOfCreditError } = await import("@/lib/server/storyteller");
  const script = {
    title: "The Little Door",
    synopsis: "",
    ambience: "",
    cast: [{ id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: PERSONA_VOICE }],
    pages: [{ page: 1, picture: "", lines: [{ speaker: "narrator", text: "Then the little door creaked open." }] }],
  };
  const before = captured.filter((c) => c.url.startsWith("/v1/messages")).length;
  creditGone = true;
  try {
    const err = await spotSoundEffects(script).catch((e: unknown) => e);
    assert.ok(err instanceof OutOfCreditError, String(err));
    assert.match(err.message, /Anthropic credit has run out\. Add credit at console\.anthropic\.com .* nothing made so far is lost/);
    assert.equal(captured.filter((c) => c.url.startsWith("/v1/messages")).length, before + 1, "asked once, not retried like a busy storyteller");
  } finally {
    creditGone = false;
  }
});

test("sound effects are chosen for a finished script, made short, and land on their word", async () => {
  const { spotSoundEffects } = await import("@/lib/server/storyteller");
  const { performSoundEffect } = await import("@/lib/server/performer");
  const { cueTime } = await import("@/lib/server/jobs");
  const { mixStory, SAMPLE_RATE } = await import("@/lib/server/audio");
  const { defaultSettings } = await import("@/lib/shared/options");
  const script = {
    title: "The Little Door",
    synopsis: "",
    ambience: "",
    cast: [{ id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: PERSONA_VOICE }],
    pages: [
      { page: 1, picture: "", lines: [{ speaker: "narrator", text: "Mia tiptoed down the hall." }, { speaker: "narrator", text: "[softly] Then the little door creaked open." }] },
      { page: 2, picture: "", lines: [{ speaker: "narrator", text: "An owl said hoo." }] },
    ],
  };
  soundJson = JSON.stringify({
    effects: [
      { page: 1, line: 1, word: "creaked", sound: "a small wooden door creaks slowly open", seconds: 2 },
      { page: 1, line: 0, word: "hall", sound: "a second sound on the same page", seconds: 2 },
      { page: 9, line: 0, word: "nope", sound: "a page that isn't there", seconds: 2 },
      { page: 2, line: 0, word: "hoo", sound: "a soft owl hoot", seconds: 30 },
    ],
  });
  const { cues, cost } = await spotSoundEffects(script);
  assert.equal(cost, 10 * 4 + 40 * 20, "what choosing the sounds cost is known");
  const req = captured.findLast((c) => c.url.startsWith("/v1/messages"))!;
  const body = req.body as Record<string, any>;
  assert.equal(body.stream, undefined, "a quick request, not a stream");
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.fallbacks, "default");
  assert.match(body.messages[0].content, /\[1\] Narrator: \[softly\] Then the little door creaked open\./);
  // one a page, only real pages, and never long
  assert.deepEqual(
    cues.map((c) => [c.page, c.word, c.seconds]),
    [
      [1, "creaked", 2],
      [2, "hoo", 4.5],
    ],
  );

  const sfx = await performSoundEffect(cues[0].sound, cues[0].seconds);
  const sfxReq = captured.findLast((c) => c.url.startsWith("/v1/sound-generation"))!;
  assert.match(String((sfxReq.body as Record<string, unknown>).text), /^a small wooden door creaks slowly open\./);
  assert.equal((sfxReq.body as Record<string, unknown>).duration_seconds, 2);
  assert.match(sfxReq.url, /output_format=pcm_24000/);
  assert.equal(sfx.length, Math.round(1.5 * SAMPLE_RATE));

  // "creaked" is the 9th spoken word on page 1 ([softly] isn't spoken)
  const words = "Mia tiptoed down the hall. Then the little door creaked open.".split(" ").map((w, i) => ({ t: i * 0.5, e: i * 0.5 + 0.4, w, speaker: "narrator" }));
  const clip = { samples: new Float32Array(SAMPLE_RATE * 6), words };
  assert.equal(cueTime(script.pages[0], clip, cues[0]), 4.45);
  // a word edited away means no sound, rather than one in the wrong place
  assert.equal(cueTime(script.pages[0], clip, { ...cues[0], word: "slammed" }), null);

  const silent = { samples: new Float32Array(SAMPLE_RATE * 6), words };
  const { samples, timeline } = await mixStory({
    pages: [{ page: 1, clip: silent }],
    chime: { ...defaultSettings().chime, enabled: false },
    effects: [{ page: 1, at: 4.45, samples: sfx }],
  });
  const at = Math.round((timeline.pages[0].start + 4.45) * SAMPLE_RATE);
  const loudest = (from: number, to: number) => samples.subarray(from, to).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.equal(loudest(0, at - 10), 0, "silent before the door creaks");
  assert.ok(loudest(at, at + SAMPLE_RATE) > 0.05, "the creak is heard");
  assert.ok(loudest(at, at + SAMPLE_RATE) <= 0.3, "and stays beneath the voices");
});

test("the words in a photo or screenshot are copied out exactly, a poem keeping its lines", async () => {
  const { readWordsFromPictures } = await import("@/lib/server/storyteller");
  soundJson = JSON.stringify({ title: "  The Owl  ", text: "  The owl looked up\nat the moon so bright,\n\nand hooted softly\nall through the night.  " });
  const pictures = [
    { data: Buffer.from("page one").toString("base64"), mediaType: "image/jpeg" as const },
    { data: Buffer.from("page two").toString("base64"), mediaType: "image/png" as const },
  ];
  const words = await readWordsFromPictures(pictures);
  assert.deepEqual(words, {
    title: "The Owl",
    text: "The owl looked up\nat the moon so bright,\n\nand hooted softly\nall through the night.",
    cost: 10 * 4 + 40 * 20,
  });
  const body = captured.findLast((c) => c.url.startsWith("/v1/messages"))!.body as Record<string, any>;
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.equal(body.output_config.effort, "medium");
  assert.deepEqual(Object.keys(body.output_config.format.schema.properties), ["title", "text"]);
  assert.match(body.system, /exactly as written/);
  const content = body.messages[0].content as { type: string; text?: string; source?: { media_type: string } }[];
  assert.deepEqual(
    content.map((b) => b.type === "image" ? b.source!.media_type : b.text),
    ["Picture 1:", "image/jpeg", "Picture 2:", "image/png", "Copy out the words in these pictures."],
  );

  soundJson = JSON.stringify({ title: "", text: "" });
  assert.deepEqual(await readWordsFromPictures(pictures.slice(0, 1)), { title: null, text: "", cost: 840 }, "no words, no title");
});

test("a Gutenberg text's title and author are read from its header", async () => {
  const { gutenbergHeader, CLASSICS } = await import("@/lib/server/classics");
  const raw = "\ufeffThe Project Gutenberg eBook of The Tale of Peter Rabbit\r\n\r\nTitle: The Tale of Peter Rabbit\r\n\r\nAuthor: Beatrix Potter\r\n\r\nRelease date: January 30, 2005 [eBook #14838]\r\n";
  assert.deepEqual(gutenbergHeader(raw), { title: "The Tale of Peter Rabbit", author: "Beatrix Potter" });
  assert.deepEqual(gutenbergHeader("no header here"), { title: null, author: null });
  // every treasury book opens by its Gutenberg number, with no catalogue search
  assert.ok(CLASSICS.every((c) => Number.isInteger(c.gutenbergId) && c.gutenbergId > 0));
  assert.equal(new Set(CLASSICS.map((c) => c.gutenbergId)).size, CLASSICS.length);
  assert.equal(CLASSICS.find((c) => c.slug === "peter-rabbit")?.gutenbergId, 14838);
});

test("the whole library comes from Gutenberg's own catalogue, kept here and browsed by kind of story", async () => {
  const { browseCatalogue, firstAuthor, parseCsv } = await import("@/lib/server/classics");
  assert.deepEqual([...parseCsv('a,"b, ""c""\nd"\r\n1,2')], [["a", 'b, "c"\nd'], ["1", "2"]]);
  assert.equal(firstAuthor("Aesop, 621? BCE-565? BCE"), "Aesop");

  const animals = await browseCatalogue({ topic: "animals" });
  assert.equal(catalogueDownloads, 1, "the catalogue is downloaded once");
  // English texts only (no French, no audio), best-known (lowest number) first, with names a child would know
  assert.deepEqual(
    animals.results.map((r) => [r.gutenbergId, r.title, r.author]),
    [
      [271, "Black Beauty", "Anna Sewell"],
      [14838, "The Tale of Peter Rabbit", "Beatrix Potter"],
    ],
  );
  assert.equal(animals.results[0].cover, "https://www.gutenberg.org/cache/epub/271/pg271.cover.medium.jpg");
  assert.equal(animals.more, false);

  const classics = await browseCatalogue({ topic: "loved" });
  assert.deepEqual(
    classics.results.map((r) => [r.gutenbergId, r.title, r.author]),
    [
      [11, "Alice's Adventures in Wonderland", "Lewis Carroll"],
      [16, "Peter Pan", "J. M. Barrie"],
      [271, "Black Beauty", "Anna Sewell"],
      [3000, "The Pumpkin Party", "Ada Bell"],
      [5000, "Tilly and the Dragon", "May Moss"],
      [14838, "The Tale of Peter Rabbit", "Beatrix Potter"],
    ],
  );
  const fairy = await browseCatalogue({ topic: "fairy" });
  assert.deepEqual(fairy.results.map((r) => r.gutenbergId), [16, 2591]);

  // search looks at titles, authors and subjects across everything, a title that starts with it first
  const titles = async (q: string) => (await browseCatalogue({ q })).results.map((r) => r.title);
  assert.deepEqual(await titles("peter"), ["Peter Pan", "The Tale of Peter Rabbit"]);
  assert.deepEqual((await browseCatalogue({ q: "grimm" })).results.map((r) => r.author), ["Jacob Grimm"]);
  // a kind of story the family thinks of: children's books before grown-ups'
  assert.deepEqual(await titles("Halloween"), ["The Pumpkin Party", "All Hallows Eve Sermons"]);
  assert.deepEqual(await titles("romance"), ["Pride and Prejudice"], "romance finds Gutenberg's 'Love stories'");
  assert.deepEqual(await titles("dragons"), ["Tilly and the Dragon"], "a plural finds the singular");
  assert.deepEqual(await titles("halloween juvenile"), ["The Pumpkin Party"], "every word must be found");
  assert.deepEqual((await browseCatalogue({ q: "100%_" })).results, [], "search text is never read as a pattern");
  assert.equal(catalogueDownloads, 1, "and every look after that is answered here");

  // a long list can be narrowed down by a subject its books share
  const rabbits = await browseCatalogue({ topic: "animals", refine: "rabbits" });
  assert.deepEqual(rabbits.results.map((r) => r.title), ["The Tale of Peter Rabbit"]);
  assert.equal(rabbits.refinements, undefined, "the ways to narrow down come with the whole list, not a narrowed one");
  assert.ok(Array.isArray(animals.refinements));
});

test("a long list offers its most shared subjects to narrow it down, in words a family would use", async () => {
  const { subjectRefinements } = await import("@/lib/server/classics");
  const book = (s: string) => `${s}; category: children & young adult reading`;
  const topics = [
    ...Array.from({ length: 6 }, () => book("dogs -- juvenile fiction; animals -- juvenile fiction")),
    ...Array.from({ length: 4 }, () => book("horses -- juvenile fiction; animals -- juvenile fiction; adventure and adventurers -- juvenile fiction")),
    book("cats -- juvenile fiction; animals -- juvenile fiction"),
  ];
  assert.deepEqual(subjectRefinements(topics, ["animals -- juvenile"]), [
    { id: "dogs", label: "Dogs", count: 6 },
    { id: "adventure and adventurers", label: "Adventure", count: 4 },
    { id: "horses", label: "Horses", count: 4 },
  ]);
});

test("favorite storytellers and books are kept for the whole family", async () => {
  const db = await import("@/lib/server/db");
  const hh = db.createHousehold("The Stars", "stars@example.com", "x");
  const other = db.createHousehold("The Neighbours", "next@example.com", "x");
  db.setFavoriteVoice(hh, PERSONA_VOICE, true);
  db.setFavoriteVoice(hh, PERSONA_VOICE, true); // starring twice is still one star
  db.setFavoriteVoice(hh, OWL_VOICE, true);
  db.setFavoriteVoice(hh, OWL_VOICE, false);
  assert.deepEqual([...db.favoriteVoiceIds(hh)], [PERSONA_VOICE]);
  assert.equal(db.favoriteVoiceIds(other).size, 0, "each family has its own stars");

  db.setFavoriteClassic(hh, { gutenbergId: 14838, title: "The Tale of Peter Rabbit", author: "Beatrix Potter", cover: null, emoji: "🐇" }, true);
  db.setFavoriteClassic(hh, { gutenbergId: 271, title: "Black Beauty", author: "Anna Sewell", cover: "https://www.gutenberg.org/cache/epub/271/pg271.cover.medium.jpg", emoji: null }, true);
  // newest first, with what's needed to show the book without asking the library
  assert.deepEqual(
    db.listFavoriteClassics(hh).map((b) => [b.gutenbergId, b.title, b.cover]),
    [
      [271, "Black Beauty", "https://www.gutenberg.org/cache/epub/271/pg271.cover.medium.jpg"],
      [14838, "The Tale of Peter Rabbit", null],
    ],
  );
  db.setFavoriteClassic(hh, { gutenbergId: 271, title: "Black Beauty", author: null, cover: null, emoji: null }, false);
  assert.deepEqual(db.listFavoriteClassics(hh).map((b) => b.gutenbergId), [14838]);
});

test("every story card says who reads it, as the family knows that voice", async () => {
  const db = await import("@/lib/server/db");
  const { storyCards, forgetVoiceCache } = await import("@/lib/server/voices");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { personaFor } = await import("@/lib/shared/personas");
  const hh = db.createHousehold("The Readers", "readers@example.com", "x");
  const book = db.createBook(hh, { title: "The Tale of Peter Rabbit", kind: "classic" });
  const read = db.createStory(hh, { bookId: book, profileId: null, mode: "read", title: "Part 1", settings: defaultSettings(), status: "ready" });
  const cast = (voiceId: string) => [
    { id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId },
    { id: "peter", name: "Peter", description: "", voiceBrief: "", voiceId: OWL_VOICE },
  ];
  db.updateStory(read, { script: { title: "Part 1", synopsis: "", ambience: "", cast: cast(PERSONA_VOICE), pages: [] } });
  const lost = db.createStory(hh, { bookId: book, profileId: null, mode: "read", title: "Part 2", settings: defaultSettings(), status: "ready" });
  db.updateStory(lost, { script: { title: "Part 2", synopsis: "", ambience: "", cast: cast("aVoiceSinceDeleted"), pages: [] } });
  const brewing = db.createStory(hh, { bookId: book, profileId: null, mode: "read", title: "Part 3", settings: defaultSettings(), status: "writing" });

  forgetVoiceCache();
  const cards = new Map((await storyCards(hh)).map((c) => [c.id, c]));
  const persona = personaFor(PERSONA_VOICE)!;
  assert.equal(cards.get(read)!.narratorVoiceId, PERSONA_VOICE, "the narrator, not the first character");
  assert.deepEqual(cards.get(read)!.narrator, { name: persona.name, emoji: persona.emoji });
  assert.deepEqual(cards.get(lost)!.narrator, { name: "A storyteller", emoji: "🗣️" }, "a voice that's gone still reads as someone");
  assert.equal(cards.get(brewing)!.narrator, null, "nobody reads a story that isn't written yet");
});

test("the voice credit left this month is read from ElevenLabs, and asked for at most once a minute", async () => {
  const { voiceCredits, forgetVoiceCredits } = await import("@/lib/server/credits");
  forgetVoiceCredits();
  const asks = () => captured.filter((c) => c.url === "/v1/user/subscription");
  const before = asks().length;
  assert.deepEqual(await voiceCredits(), { used: 12000, limit: 100000, left: 88000, resetsAt: 1790000000000, plan: "creator" });
  await voiceCredits();
  assert.equal(asks().length, before + 1, "the second look is answered here");
  assert.equal(asks()[0].headers["xi-api-key"], "test-eleven");
});

test("recording counts only what isn't made yet: switching sound effects on keeps the voices", async () => {
  const db = await import("@/lib/server/db");
  const { startRecording, isRunning } = await import("@/lib/server/jobs");
  const { expectedSeconds } = await import("@/lib/server/timing");
  const { defaultSettings } = await import("@/lib/shared/options");
  const hh = db.createHousehold("The Wren Family", "wren@example.com", "x");
  const book = db.createBook(hh, { title: "The Little Door", kind: "idea" });
  const script = {
    title: "The Little Door",
    synopsis: "",
    ambience: "",
    cast: [{ id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: PERSONA_VOICE }],
    pages: [
      { page: 1, picture: "", lines: [{ speaker: "narrator", text: "Mia tiptoed down the long hall, past the sleeping cat and the ticking clock, all the way to the end." }, { speaker: "narrator", text: "Then the little door creaked open, and a warm light spilled out across her slippers." }] },
      { page: 2, picture: "", lines: [{ speaker: "narrator", text: "An owl sat on a lamp inside. It said hoo, very politely, and Mia laughed so hard she had to sit down." }] },
    ],
  };
  const settings = { ...defaultSettings({}), intro: false, effects: false, ambience: false };
  const id = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: "The Little Door", settings, status: "draft" });
  db.updateStory(id, { script });
  const finished = async () => {
    for (let i = 0; i < 400 && isRunning(id); i++) await new Promise((r) => setTimeout(r, 25));
    return db.getStoryById(id)!;
  };
  const estimate = () => db.getStoryById(id)!.progress?.seconds;

  // Each estimate is the rule of thumb for what's still to make, at the pace recordings have really gone here.
  const binding = () => expectedSeconds("recording", 20);
  startRecording(id);
  const fresh = estimate()!;
  assert.ok(fresh > binding(), "every voice still to make");
  assert.equal((await finished()).status, "ready");

  soundJson = JSON.stringify({ effects: [{ page: 1, line: 1, word: "creaked", sound: "a small wooden door creaks open", seconds: 2 }] });
  db.updateStory(id, { settings: { ...settings, effects: true } });
  startRecording(id);
  assert.equal(estimate(), expectedSeconds("recording", 20 + 25), "the voices are kept: just choosing and making the sounds, and binding it together");
  assert.equal((await finished()).status, "ready");
  assert.equal(db.getStoryById(id)!.script!.effects!.length, 1);

  startRecording(id);
  assert.equal(estimate(), binding(), "everything made already: only binding it together");
  await finished();
});

test("conjured straight through: pages are voiced while the rest is still being written, a few at a time, and none twice", async () => {
  const db = await import("@/lib/server/db");
  const { startWriting, isRunning } = await import("@/lib/server/jobs");
  const { defaultSettings } = await import("@/lib/shared/options");
  const hh = db.createHousehold("The Brook Family", "brook@example.com", "x");
  const book = db.createBook(hh, { title: "The Long Brook", kind: "idea" });
  const words = (n: number) => `Page ${n}: the brook ran on past the mill and the willow, singing its long silver song.`;
  scriptJson = JSON.stringify({
    title: "The Long Brook",
    synopsis: "A brook's journey to the sea.",
    ambience: "",
    cast: [{ id: "narrator", name: "Narrator", description: "storyteller", voice_brief: "warm", voice_id: PERSONA_VOICE }],
    pages: [1, 2, 3, 4, 5, 6].map((n) => ({ page: n, photo: 0, picture: `The brook, part ${n}`, effect: "none", lines: [{ speaker: "narrator", text: words(n) }] })),
  });
  const settings = { ...defaultSettings({ source: "idea", length: "medium" }), review: false, intro: false, chime: { enabled: false, style: "bell" as const, gapSeconds: 3 } };
  const id = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: "A new story is brewing…", settings, status: "writing" });

  const from = voiced.length;
  process.env.VOICES_AT_ONCE = "2";
  writingPause = 25;
  voicingPause = 120;
  mostVoicingAtOnce = 0;
  try {
    startWriting(id);
    for (let i = 0; i < 600 && (isRunning(id) || db.getStoryById(id)!.status === "writing"); i++) await new Promise((r) => setTimeout(r, 25));
  } finally {
    delete process.env.VOICES_AT_ONCE;
    writingPause = 0;
    voicingPause = 0;
  }
  assert.equal(db.getStoryById(id)!.status, "ready");

  const pageVoiced = (n: number) => voiced.slice(from).filter((v) => v.text.startsWith(`Page ${n}:`));
  for (let n = 1; n <= 6; n++) assert.equal(pageVoiced(n).length, 1, `page ${n} is voiced once`);
  assert.ok(pageVoiced(1)[0].at < writingEndedAt && pageVoiced(2)[0].at < writingEndedAt, "the first pages are voiced while the rest is still being written");
  assert.ok(pageVoiced(6)[0].at >= writingEndedAt, "the last waits for the whole story, which ends by saying so");
  assert.match(pageVoiced(6)[0].text, /The end\.$/);
  assert.equal(mostVoicingAtOnce, 2, "two at a time (as VOICES_AT_ONCE says), never more");
});

test("when the storyteller is busy, the story waits its turn and carries on, saying so meanwhile", async () => {
  const { writeScript } = await import("@/lib/server/storyteller");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { voiceCatalog } = await import("@/lib/server/voices");
  scriptJson = JSON.stringify({
    title: "The Patient Owl",
    synopsis: "An owl waits.",
    ambience: "",
    cast: [{ id: "narrator", name: "Narrator", description: "storyteller", voice_brief: "warm", voice_id: PERSONA_VOICE }],
    pages: [{ page: 1, photo: 0, picture: "An owl", effect: "none", lines: [{ speaker: "narrator", text: "The owl waited, and waited." }] }],
  });
  // More busy replies than Anthropic's own quick retries ride out.
  busyFor = 5;
  const steps: string[] = [];
  const { script } = await writeScript(
    {
      mode: "create",
      bookTitle: "Owls",
      bookKind: "idea",
      settings: defaultSettings({ source: "idea" }),
      images: [],
      pageCount: 1,
      previousStories: [],
      rememberedCharacters: [],
      voices: await voiceCatalog("household-1"),
    },
    (step) => steps.push(step),
  );
  assert.equal(busyFor, 0);
  assert.equal(script.title, "The Patient Owl");
  assert.ok(steps.includes("The storyteller is busy, so the story waits a moment"), steps.join(" / "));
});

test("a family makes one story at a time", async () => {
  const db = await import("@/lib/server/db");
  const { defaultSettings } = await import("@/lib/shared/options");
  const hh = db.createHousehold("The One Family", "one@example.com", "x");
  const book = db.createBook(hh, { title: "One Book", kind: "idea" });
  const making = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: "The Busy Badger", settings: defaultSettings({ source: "idea" }), status: "writing" });
  const done = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: "The Sleepy Fox", settings: defaultSettings({ source: "idea" }), status: "ready" });
  assert.deepEqual(db.storyBeingMade(hh), { id: making, title: "The Busy Badger" });
  assert.deepEqual(db.storyBeingMade(hh, done), { id: making, title: "The Busy Badger" }, "re-recording another waits for it");
  assert.equal(db.storyBeingMade(hh, making), null, "but the story being made can carry on");
  assert.equal(db.storyBeingMade(db.createHousehold("The Two Family", "two@example.com", "x")), null, "and other families aren't held up");
  db.updateStory(making, { status: "ready" });
  assert.equal(db.storyBeingMade(hh), null);
});

test("two families making stories at once: the one started first is voiced first, and the other is told its place in line", async () => {
  const db = await import("@/lib/server/db");
  const { startRecording, isRunning, withPlaceInLine } = await import("@/lib/server/jobs");
  const { defaultSettings } = await import("@/lib/shared/options");
  const settings = { ...defaultSettings({ source: "idea" }), intro: false, chime: { enabled: false, style: "bell" as const, gapSeconds: 3 } };
  const story = (family: string) => {
    const hh = db.createHousehold(`The ${family} Family`, `${family.toLowerCase()}@example.com`, "x");
    const book = db.createBook(hh, { title: `${family}'s Book`, kind: "idea" });
    const id = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: `${family}'s Story`, settings, status: "draft" });
    db.updateStory(id, {
      script: {
        title: `${family}'s Story`,
        synopsis: "",
        ambience: "",
        cast: [{ id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: PERSONA_VOICE }],
        pages: [1, 2, 3].map((n) => ({ page: n, picture: "", lines: [{ speaker: "narrator", text: `${family}, page ${n}: once upon a time there was a lantern.` }] })),
      },
    });
    return id;
  };
  const first = story("Ash");
  const second = story("Birch");
  process.env.VOICES_AT_ONCE = "1";
  voicingPause = 60;
  const placesSaid = new Set<string>();
  try {
    startRecording(second, Date.now() + 1000); // asked for first, but started later
    startRecording(first, Date.now());
    for (let i = 0; i < 400 && (isRunning(first) || isRunning(second)); i++) {
      const step = withPlaceInLine(db.getStoryById(second)!).progress?.step;
      if (step?.startsWith("Waiting for a free storyteller")) placesSaid.add(step);
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    delete process.env.VOICES_AT_ONCE;
    voicingPause = 0;
  }
  assert.equal(db.getStoryById(first)!.status, "ready");
  assert.equal(db.getStoryById(second)!.status, "ready");
  const voicedPages = voiced.filter((v) => /^(Ash|Birch), page/.test(v.text)).map((v) => v.text.slice(0, v.text.indexOf(":")));
  const lastOfFirst = voicedPages.indexOf("Ash, page 3");
  // A turn the later story took before the earlier one asked (the line was free) can come first; nothing else of it does.
  assert.ok(voicedPages.slice(0, lastOfFirst).filter((p) => p.startsWith("Birch")).length <= 1, voicedPages.join(", "));
  assert.equal(voicedPages.length, 6, voicedPages.join(", "));
  assert.ok([...placesSaid].some((p) => /next in line|2nd in line/.test(p)), [...placesSaid].join(" / ") || "never said");
});

test("a story stopped midway by a restart carries on by itself, keeping the pages already voiced", async () => {
  const db = await import("@/lib/server/db");
  const { resumeLostStory, isRunning } = await import("@/lib/server/jobs");
  const { defaultSettings } = await import("@/lib/shared/options");
  const hh = db.createHousehold("The Restart Family", "restart@example.com", "x");
  const book = db.createBook(hh, { title: "Restarts", kind: "idea" });
  const settings = { ...defaultSettings({ source: "idea" }), intro: false, review: false, chime: { enabled: false, style: "bell" as const, gapSeconds: 3 } };
  const script = {
    title: "The Brave Kettle",
    synopsis: "",
    ambience: "",
    cast: [{ id: "narrator", name: "Narrator", description: "", voiceBrief: "", voiceId: PERSONA_VOICE }],
    pages: [{ page: 1, picture: "", lines: [{ speaker: "narrator", text: "The kettle sang, and the restart did not stop it." }] }],
  };
  const finished = async (id: string) => {
    for (let i = 0; i < 400 && isRunning(id); i++) await new Promise((r) => setTimeout(r, 25));
    return db.getStoryById(id)!;
  };

  // Recording when the app restarted: it picks up again.
  const recording = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: script.title, settings, status: "recording" });
  db.updateStory(recording, { script, progress: { step: "Recording the voices", done: 0, total: 2, startedAt: Date.now() - 5000, seconds: 30 } });
  resumeLostStory(recording);
  assert.equal(db.getStoryById(recording)!.progress?.resumed, 1);
  assert.equal((await finished(recording)).status, "ready");

  // Being written: the writing starts again.
  scriptJson = JSON.stringify({ ...script, cast: [{ id: "narrator", name: "Narrator", description: "", voice_brief: "", voice_id: PERSONA_VOICE }], pages: [{ page: 1, photo: 0, picture: "", effect: "none", lines: script.pages[0].lines }] });
  const writing = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: "…", settings: { ...settings, length: "short" as const }, status: "writing" });
  db.updateStory(writing, { progress: { step: "Writing the pages", done: 1, total: 4, startedAt: Date.now() - 5000, seconds: 60 } });
  resumeLostStory(writing);
  assert.equal((await finished(writing)).status, "ready");

  // One that keeps stopping the app is let go after two tries, with a word to try again.
  const stubborn = db.createStory(hh, { bookId: book, profileId: null, mode: "create", title: script.title, settings, status: "recording" });
  db.updateStory(stubborn, { script, progress: { step: "Recording the voices", done: 0, total: 2, startedAt: Date.now(), seconds: 30, resumed: 2 } });
  resumeLostStory(stubborn);
  const gaveUp = db.getStoryById(stubborn)!;
  assert.equal(gaveUp.status, "error");
  assert.match(gaveUp.error!, /Try again/);
});

test("a character's look can be written from a photo: the storyteller sees the photo and the family's words, and the photo isn't kept", async () => {
  const { describeFromPhoto } = await import("@/lib/server/storyteller");
  soundJson = JSON.stringify({ look: "A little girl about seven with curly golden hair, blue eyes and a gap-toothed smile, in a frilly pink nightgown.", problem: "" });
  const photo = { data: Buffer.from("not really a photo").toString("base64"), mediaType: "image/jpeg" as const };
  const { look, cost } = await describeFromPhoto(photo, { name: "Adaline", words: "Loves dresses, even for pajamas." });
  assert.match(look, /curly golden hair/);
  assert.ok(cost > 0);
  const body = captured.findLast((c) => c.url.startsWith("/v1/messages"))!.body as Record<string, any>;
  const [image, words] = body.messages[0].content;
  assert.equal(image.type, "image");
  assert.match(words.text, /called Adaline.*Loves dresses, even for pajamas/s);
  assert.match(body.system, /never the photo itself, the room, the background/);
  soundJson = JSON.stringify({ look: "", problem: "There's no one in this photo, just a cat." });
  await assert.rejects(describeFromPhoto(photo, { name: "Adaline", words: "" }), /just a cat/);
});

// A script streaming in from the storyteller, a few characters at a time: each page is handed over the moment it's
// complete, however the text happens to be cut up on its way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStream } from "@/lib/server/json-stream";

const script = {
  title: 'The {Curious} "Lantern"',
  synopsis: "Braces { and } and brackets [ ] in words, a comma, a colon: and a backslash \\ too.",
  ambience: "",
  language: "fr",
  pageCount: 3,
  learner: false,
  nothing: null,
  cast: [
    { id: "narrator", name: "Narrateur", voice_id: "v1" },
    { id: "mia", name: "Mia \"Moonbeam\"", voice_id: "v2" },
  ],
  pages: [
    { page: 1, picture: "A door {ajar}", lines: [{ speaker: "narrator", text: "Il était une fois…" }, { speaker: "mia", text: "[whispers] Qui est là ?" }] },
    { page: 2, picture: "Stars, [lots]", lines: [{ speaker: "mia", text: "Line \\\"two\\\"" }] },
    { page: 3, picture: "", lines: [] },
  ],
  score: 7.5,
};

/** Everything the stream says, as it says it. */
function watch(text: string, cut: (text: string) => string[]) {
  const said: string[] = [];
  const fields: Record<string, unknown> = {};
  const pages: unknown[] = [];
  const stream = new JsonStream({
    field: (key, json) => {
      fields[key] = JSON.parse(json);
      said.push(`field ${key}`);
    },
    begin: (key, i) => said.push(`begin ${key} ${i}`),
    item: (key, i, json) => {
      if (key === "pages") pages.push(JSON.parse(json));
      said.push(`item ${key} ${i}`);
    },
  });
  for (const piece of cut(text)) stream.push(piece);
  return { said, fields, pages };
}

const inPieces = (size: number) => (text: string) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

test("every field and every page comes out whole, whether the text arrives a letter at a time or all at once", () => {
  for (const text of [JSON.stringify(script), JSON.stringify(script, null, 2)]) {
    const all = watch(text, (t) => [t]);
    assert.deepEqual(all.fields, script);
    assert.deepEqual(all.pages, script.pages);
    for (const size of [1, 2, 3, 5, 7, 40, 333]) {
      const pieces = watch(text, inPieces(size));
      assert.deepEqual(pieces, all, `${size} at a time`);
    }
  }
});

test("each page is handed over the moment it's complete, before the rest has arrived", () => {
  const text = JSON.stringify(script);
  const said: string[] = [];
  const stream = new JsonStream({ begin: (key, i) => said.push(`begin ${key} ${i}`), item: (key, i) => said.push(`item ${key} ${i}`) });
  const firstPageEnds = text.indexOf("}]}", text.indexOf('"pages"')) + 3;
  stream.push(text.slice(0, firstPageEnds));
  assert.deepEqual(said.slice(-2), ["begin pages 0", "item pages 0"], "page 1 is out, and page 2 not yet begun");
  stream.push(text.slice(firstPageEnds, firstPageEnds + 2));
  assert.equal(said.at(-1), "begin pages 1", "page 2 has begun");
  assert.ok(!said.includes("item pages 1"));
});

test("the cast's members and the pages are told apart, in the order they come", () => {
  const { said } = watch(JSON.stringify(script), inPieces(9));
  assert.deepEqual(said, [
    "field title",
    "field synopsis",
    "field ambience",
    "field language",
    "field pageCount",
    "field learner",
    "field nothing",
    "begin cast 0",
    "item cast 0",
    "begin cast 1",
    "item cast 1",
    "field cast",
    "begin pages 0",
    "item pages 0",
    "begin pages 1",
    "item pages 1",
    "begin pages 2",
    "item pages 2",
    "field pages",
    "field score",
  ]);
});

test("whatever comes after the object is no part of it", () => {
  const { said } = watch(`${JSON.stringify({ pages: [{ page: 1 }] })}{"pages":[{"page":9}]}`, inPieces(4));
  assert.deepEqual(said, ["begin pages 0", "item pages 0", "field pages"]);
});

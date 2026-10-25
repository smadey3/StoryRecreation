import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { driveLink } from "../src/lib/shared/drive";
import { fetchFromDrive } from "../src/lib/client/drive";
import { mp4Sound } from "../src/lib/client/videoSound";

// A family video shared from Google Drive: its file, from however Drive wrote the link.

test("the file in a Drive link, whichever way Drive wrote it", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";
  for (const link of [
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/file/d/${id}/view?usp=drive_link`,
    `https://drive.google.com/file/u/0/d/${id}/preview`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?id=${id}&export=download`,
    `  https://drive.google.com/file/d/${id}  `,
  ]) {
    assert.deepEqual(driveLink(link), { id, resourceKey: null }, link);
  }
  // Some links shared before 2021 carry a key of their own.
  assert.deepEqual(driveLink(`https://drive.google.com/file/d/${id}/view?usp=sharing&resourcekey=0-AbC_dEf`), { id, resourceKey: "0-AbC_dEf" });
});

test("a folder, or something that isn't a Drive link, is told apart", () => {
  assert.deepEqual(driveLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz?usp=sharing"), { folder: true });
  assert.equal(driveLink("https://photos.app.goo.gl/abc123"), null);
  assert.equal(driveLink("https://example.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view"), null);
  assert.equal(driveLink("drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz"), null, "not a whole link");
  assert.equal(driveLink("https://drive.google.com/file/d/short/view"), null);
  assert.equal(driveLink("Grandma's birthday video"), null);
});

/** Google Drive, as far as a video shared from it goes: what it says the file is, and the file, in pieces or whole. */
function fakeDrive(t: { after: (fn: () => void) => void }, bytes: Buffer, { size = bytes.length, pieces = true } = {}) {
  const asked: { what: string; range: string | null }[] = [];
  const real = globalThis.fetch;
  t.after(() => void (globalThis.fetch = real));
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const range = new Headers(init?.headers).get("range");
    asked.push({ what: url.searchParams.has("fields") ? "about" : "media", range });
    if (url.searchParams.has("fields")) return Response.json({ name: "IMG_0042.MOV", mimeType: "video/quicktime", size: String(size) });
    const piece = pieces && range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (piece) return new Response(new Uint8Array(bytes.subarray(Number(piece[1]), Number(piece[2]) + 1)), { status: 206 });
    return new Response(new Uint8Array(bytes));
  };
  return asked;
}
const LINK = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123/view?usp=sharing";
const movie = () => fs.readFileSync("tests/fixtures/videos/iphone.mov");

test("a video in Drive: only its sound is fetched, a piece at a time, however big the video", async (t) => {
  const asked = fakeDrive(t, movie(), { size: 900 * 1024 * 1024 });
  const file = await fetchFromDrive(LINK, "key");
  assert.equal(file.name, "IMG_0042.m4a");
  assert.equal(file.type, "audio/mp4");
  const media = asked.filter((a) => a.what === "media");
  assert.ok(media.length && media.every((a) => a.range), "every piece asked for by its range");
  const found = await mp4Sound(new Blob([movie()]));
  assert.ok(found && found !== "silent");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(await (await found.read()).arrayBuffer()));
});

test("if Drive won't send pieces, the video comes whole, as before (and a very big one is turned away)", async (t) => {
  fakeDrive(t, movie(), { pieces: false });
  const file = await fetchFromDrive(LINK, "key");
  assert.equal(file.type, "video/quicktime");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), movie());

  fakeDrive(t, movie(), { pieces: false, size: 900 * 1024 * 1024 });
  await assert.rejects(fetchFromDrive(LINK, "key"), /too big to open on a phone/);
});

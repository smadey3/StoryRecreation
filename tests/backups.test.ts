// Automatic backups against a local stand-in for S3-compatible storage (Backblaze B2,
// Cloudflare R2): what's sent, that only new files go up, that old daily copies are
// pruned, that a bad key is explained, and that the restore script brings it all back.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

const BUCKET = "family-backups";
const objects = new Map<string, Buffer>();
const authorizations: string[] = [];
let server: http.Server;
let endpoint = "";
let dataDir = "";

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const auth = String(req.headers.authorization ?? "");
      authorizations.push(auth);
      if (auth.includes("Credential=BAD/")) {
        res.writeHead(403, { "content-type": "application/xml" });
        return res.end("<Error><Code>InvalidAccessKeyId</Code><Message>Bad key</Message></Error>");
      }
      const url = new URL(req.url!, "http://x");
      if (req.method === "GET" && url.pathname === "/") {
        // the buckets this key can see
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(`<ListAllMyBucketsResult><Buckets><Bucket><Name>${BUCKET}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`);
      }
      const [, bucket, ...rest] = url.pathname.split("/");
      if (bucket !== BUCKET) return res.writeHead(404).end("<Error><Code>NoSuchBucket</Code></Error>");
      const key = rest.map(decodeURIComponent).join("/");
      if (req.method === "PUT") {
        // Like Backblaze, an upload has to say how big it is.
        if (req.headers["content-length"] === undefined) {
          res.writeHead(411, { "content-type": "application/xml" });
          return res.end("<Error><Code>MissingContentLength</Code><Message>You must provide the Content-Length HTTP header.</Message></Error>");
        }
        objects.set(key, Buffer.concat(chunks));
        return res.writeHead(200).end();
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      if (req.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
        // three at a time, so paging is exercised
        const all = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
        const from = Number(url.searchParams.get("continuation-token") ?? 0);
        const page = all.slice(from, from + 3);
        const more = from + 3 < all.length;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<ListBucketResult><IsTruncated>${more}</IsTruncated>${page
            .map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${objects.get(k)!.length}</Size></Contents>`)
            .join("")}${more ? `<NextContinuationToken>${from + 3}</NextContinuationToken>` : ""}</ListBucketResult>`,
        );
      }
      if (req.method === "GET" && objects.has(key)) return res.writeHead(200).end(objects.get(key));
      res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-backup-test-"));
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    BACKUP_ENDPOINT: endpoint,
    BACKUP_BUCKET: BUCKET,
    BACKUP_KEY_ID: "KEY123",
    BACKUP_SECRET_KEY: "secret",
    BACKUP_REGION: "us-west-004",
    STORYHOLLOW_ENV: "production",
  });
});

after(() => server.close());

const write = (rel: string, data: Buffer | string) => {
  fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, rel), data);
};
const keys = (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();

test("every night's backup copies the database and every file, then only what's new", async () => {
  const { createHousehold, createSession, replaceCatalogue } = await import("@/lib/server/db");
  const { runBackup, backupStatus } = await import("@/lib/server/offsite");
  createSession(createHousehold("The Moss Family", "moss@example.com", "hash"), 60_000);
  replaceCatalogue([{ id: 11, title: "Alice", author: "Lewis Carroll", topics: "fantasy" }]);
  write("households/h1/stories/s1/story.mp3", Buffer.alloc(5000, 1));
  write("households/h1/books/b1/page-1.jpg", Buffer.alloc(3000, 2));

  const first = await runBackup();
  assert.equal(first.ok, true, first.error);
  assert.equal(first.uploadedFiles, 4, "two copies of the database and two files");
  assert.equal(first.totalFiles, 3);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(keys("production/"), [
    "production/database/latest.db",
    `production/database/storyhollow-${today}.db`,
    "production/files/households/h1/books/b1/page-1.jpg",
    "production/files/households/h1/stories/s1/story.mp3",
  ]);
  assert.deepEqual(objects.get("production/files/households/h1/stories/s1/story.mp3"), Buffer.alloc(5000, 1));
  assert.ok(authorizations.every((a) => a.startsWith("AWS4-HMAC-SHA256 Credential=KEY123/") && a.includes("/us-west-004/s3/")), "signed for S3");

  // the database copy is the family's library, without the re-fetchable Gutenberg catalogue
  const copy = path.join(dataDir, "..", `copy-${Date.now()}.db`);
  fs.writeFileSync(copy, objects.get("production/database/latest.db")!);
  const conn = new DatabaseSync(copy);
  assert.equal((conn.prepare("SELECT name FROM households").get() as { name: string }).name, "The Moss Family");
  assert.equal((conn.prepare("SELECT COUNT(*) AS n FROM catalogue_books").get() as { n: number }).n, 0);
  assert.equal((conn.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0, "no one's sign-in");
  conn.close();

  const second = await runBackup();
  assert.equal(second.uploadedFiles, 2, "nothing new but the database");
  write("households/h1/stories/s1/story.mp3", Buffer.alloc(6000, 3));
  write("households/h1/keepsakes/k1.mp3", Buffer.alloc(100, 4));
  const third = await runBackup();
  assert.equal(third.uploadedFiles, 4, "the changed story and the new recording");
  assert.equal(objects.get("production/files/households/h1/stories/s1/story.mp3")!.length, 6000);

  const status = backupStatus();
  assert.equal(status.configured, true);
  assert.equal(status.destination, `${BUCKET} at ${new URL(endpoint).host}`);
  assert.equal(status.lastGood?.ok, true);
  assert.equal(status.recent.length, 3);
});

test("only the last 14 daily copies of the database are kept", async () => {
  const { runBackup } = await import("@/lib/server/offsite");
  for (let d = 1; d <= 20; d++) objects.set(`production/database/storyhollow-2020-01-${String(d).padStart(2, "0")}.db`, Buffer.from("old"));
  assert.equal((await runBackup()).ok, true);
  const dailies = keys("production/database/storyhollow-");
  assert.equal(dailies.length, 14);
  assert.equal(dailies[0], "production/database/storyhollow-2020-01-08.db", "the oldest went first");
});

test("a key the storage turns down is explained, and the failed night is recorded", async () => {
  const { runBackup, backupStatus } = await import("@/lib/server/offsite");
  process.env.BACKUP_KEY_ID = "BAD";
  try {
    const failed = await runBackup();
    assert.equal(failed.ok, false);
    assert.match(failed.error!, /turned the key down.*BACKUP_KEY_ID/);
    const status = backupStatus();
    assert.equal(status.recent[0].ok, false);
    assert.equal(status.lastGood?.ok, true, "the last good backup is still known");
  } finally {
    process.env.BACKUP_KEY_ID = "KEY123";
  }
});

test("a bucket name that's wrong is explained with the names of the buckets the key can see", async () => {
  const { runBackup } = await import("@/lib/server/offsite");
  process.env.BACKUP_BUCKET = "family-backup";
  try {
    const failed = await runBackup();
    assert.equal(failed.ok, false);
    assert.match(failed.error!, /no bucket called “family-backup”\. This key can see “family-backups”: set BACKUP_BUCKET to that/);
  } finally {
    process.env.BACKUP_BUCKET = BUCKET;
  }
});

test("the restore script brings a backup back into a data folder", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-restore-"));
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, ["scripts/restore-backup.mjs", ...args], { env: { ...process.env, STORYHOLLOW_ENV: "staging" } });
  await run(["--from", "production", target]);
  assert.deepEqual(fs.readFileSync(path.join(target, "households/h1/stories/s1/story.mp3")), Buffer.alloc(6000, 3));
  assert.deepEqual(fs.readFileSync(path.join(target, "households/h1/keepsakes/k1.mp3")), Buffer.alloc(100, 4));
  const conn = new DatabaseSync(path.join(target, "storyhollow.db"));
  assert.equal((conn.prepare("SELECT name FROM households").get() as { name: string }).name, "The Moss Family");
  conn.close();
  // it won't write over a library by accident
  await assert.rejects(run(["--from", "production", target]), /already has a library/);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { config, type BackupStorage } from "./config";
import { alertBackupFailed } from "./alerts";
import { closeUnfinishedBackups, finishBackupRun, lastGoodBackup, recentBackupRuns, snapshotDatabase, startBackupRun, type BackupRun } from "./db";

// Automatic backups: every night, everything the family has made is copied to
// cloud storage they own, away from the server. The bucket holds, for each
// copy of the app (live, test):
//   <folder>/files/…                    the data folder as it is (photos, audio, recordings), only what's new each night
//   <folder>/database/latest.db         the database, as of the last backup
//   <folder>/database/storyhollow-<date>.db   one a day, the last 14 kept
// To bring it all back, see scripts/restore-backup.mjs.

const DAY = 24 * 3600 * 1000;
const KEEP_DAILY = 14;
const DATABASE_FILES = /^storyhollow\.db(-wal|-shm|-journal)?$/;

export class BackupError extends Error {}

/** Just enough of the S3 API (put, list, delete) for any S3-compatible storage. */
export class BucketClient {
  private aws: AwsClient;
  private endpoint: string;
  private bucket: string;
  private base: string;

  constructor(store: BackupStorage) {
    this.aws = new AwsClient({ accessKeyId: store.keyId, secretAccessKey: store.secret, region: store.region, service: "s3" });
    this.endpoint = store.endpoint;
    this.bucket = store.bucket;
    this.base = `${store.endpoint}/${encodeURIComponent(store.bucket)}`;
  }

  /** The buckets this key can see, or none if it isn't allowed to list them. */
  async buckets(): Promise<string[]> {
    try {
      const res = await this.aws.fetch(`${this.endpoint}/`, { method: "GET" });
      if (!res.ok) return [];
      return [...(await res.text()).matchAll(/<Bucket>[\s\S]*?<Name>([\s\S]*?)<\/Name>/g)].map((m) => unescapeXml(m[1]));
    } catch {
      return [];
    }
  }

  /**
   * What to say when there's no bucket by the name given: the names of the ones this key can see, asked of the
   * storage itself, so the right one can be copied into BACKUP_BUCKET without signing in to the storage's website.
   */
  private async noSuchBucket(): Promise<string> {
    const seen = await this.buckets();
    const missing = `The backup storage has no bucket called “${this.bucket}”.`;
    if (!seen.length) return `${missing} Check BACKUP_BUCKET: it must match the bucket's name exactly.`;
    return `${missing} This key can see ${seen.map((name) => `“${name}”`).join(", ")}: set BACKUP_BUCKET to ${seen.length === 1 ? "that" : "one of those"}, exactly.`;
  }

  private url(key: string) {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private async send(url: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.aws.fetch(url, init);
    } catch (err) {
      throw new BackupError(`The backup storage couldn't be reached (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
      const message = body.match(/<Message>([^<]+)<\/Message>/)?.[1];
      if (res.status === 403 || code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch" || code === "AccessDenied")
        throw new BackupError(`The backup storage turned the key down (${code ?? res.status}). Check BACKUP_KEY_ID and BACKUP_SECRET_KEY.`);
      if (code === "NoSuchBucket") throw new BackupError(await this.noSuchBucket());
      throw new BackupError(`Couldn't ${what} (${[res.status, code, message].filter(Boolean).join(" · ")}).`);
    }
    return res;
  }

  async put(key: string, body: Buffer, contentType = "application/octet-stream") {
    await this.send(this.url(key), { method: "PUT", body: new Uint8Array(body), headers: { "content-type": contentType } }, `save ${key}`);
  }

  async remove(key: string) {
    await this.send(this.url(key), { method: "DELETE" }, `remove ${key}`);
  }

  /** Every object under a prefix, with its size. */
  async list(prefix: string): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
      if (token) params.set("continuation-token", token);
      const xml = await (await this.send(`${this.base}?${params}`, { method: "GET" }, "look in the backup storage")).text();
      for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = item.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        const size = item.match(/<Size>(\d+)<\/Size>/)?.[1];
        if (key) found.set(unescapeXml(key), Number(size ?? 0));
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] : undefined;
      if (token) token = unescapeXml(token);
    } while (token);
    return found;
  }
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Every file in the data folder except the live database (copied separately, safely) and photos still on
 * their way into a new book, as paths relative to it.
 */
function dataFiles(dir: string, rel = ""): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (rel === "" && entry.name === "incoming") continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...dataFiles(dir, r));
    else if (entry.isFile() && !(rel === "" && DATABASE_FILES.test(entry.name))) out.push({ rel: r, size: fs.statSync(path.join(dir, r)).size });
  }
  return out;
}

const TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".db": "application/vnd.sqlite3" };
const typeOf = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

export interface BackupResult {
  ok: boolean;
  uploadedFiles: number;
  uploadedBytes: number;
  totalFiles: number;
  totalBytes: number;
  error?: string;
}

const globalForBackups = globalThis as unknown as { __storyhollowBackup?: Promise<BackupResult> | null };

/** Back everything up now (or join the backup already running). */
export function runBackup(): Promise<BackupResult> {
  if (globalForBackups.__storyhollowBackup) return globalForBackups.__storyhollowBackup;
  const run = backUp().finally(() => {
    globalForBackups.__storyhollowBackup = null;
  });
  globalForBackups.__storyhollowBackup = run;
  return run;
}

export const backupRunning = () => Boolean(globalForBackups.__storyhollowBackup);

async function backUp(): Promise<BackupResult> {
  const store = config.backupStorage;
  if (!store) throw new BackupError("Automatic backups aren't set up yet.");
  const bucket = new BucketClient(store);
  const folder = config.backupFolder;
  const runId = startBackupRun();
  const result: BackupResult = { ok: false, uploadedFiles: 0, uploadedBytes: 0, totalFiles: 0, totalBytes: 0 };
  try {
    // 1. The database: a consistent snapshot, as today's copy and as the latest.
    const snapshot = path.join(os.tmpdir(), `storyhollow-backup-${process.pid}-${Date.now()}.db`);
    let database: Buffer;
    try {
      snapshotDatabase(snapshot);
      database = fs.readFileSync(snapshot);
    } finally {
      fs.rmSync(snapshot, { force: true });
    }
    const day = new Date().toISOString().slice(0, 10);
    await bucket.put(`${folder}/database/storyhollow-${day}.db`, database, typeOf(".db"));
    await bucket.put(`${folder}/database/latest.db`, database, typeOf(".db"));
    result.uploadedFiles += 2;
    result.uploadedBytes += database.length * 2;

    // 2. The files: only those not already there (or changed in size).
    const local = dataFiles(config.dataDir);
    const remote = await bucket.list(`${folder}/files/`);
    result.totalFiles = local.length + 1;
    result.totalBytes = local.reduce((n, f) => n + f.size, database.length);
    const todo = local.filter((f) => remote.get(`${folder}/files/${f.rel}`) !== f.size);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const f = todo[next++];
        const data = fs.readFileSync(path.join(config.dataDir, f.rel));
        await bucket.put(`${folder}/files/${f.rel}`, data, typeOf(f.rel));
        result.uploadedFiles++;
        result.uploadedBytes += data.length;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    // 3. Keep the last 14 daily database copies.
    const dailies = [...(await bucket.list(`${folder}/database/storyhollow-`)).keys()].sort();
    for (const old of dailies.slice(0, Math.max(0, dailies.length - KEEP_DAILY))) await bucket.remove(old);

    result.ok = true;
    return result;
  } catch (err) {
    result.error = err instanceof BackupError ? err.message : `The backup stopped: ${err instanceof Error ? err.message : String(err)}`;
    console.error("Backup failed:", err);
    void alertBackupFailed(result.error).catch(() => undefined);
    return result;
  } finally {
    finishBackupRun(runId, result);
  }
}

export interface BackupStatus {
  configured: boolean;
  /** Where backups go, e.g. "storyhollow-backups at s3.us-west-004.backblazeb2.com". */
  destination: string | null;
  running: boolean;
  lastGood: BackupRun | null;
  recent: BackupRun[];
}

export function backupStatus(): BackupStatus {
  const store = config.backupStorage;
  return {
    configured: Boolean(store),
    destination: store ? `${store.bucket} at ${new URL(store.endpoint).host}` : null,
    running: backupRunning(),
    lastGood: lastGoodBackup(),
    recent: recentBackupRuns(5),
  };
}

/**
 * Once the server is up: back up whenever the last good backup is a day old, checking every hour
 * (so a failed night is tried again within the hour, and a restart doesn't cause an extra one).
 */
export function startBackupSchedule() {
  if (!config.backupStorage) {
    console.log("Automatic backups are off (no BACKUP_ENDPOINT, BACKUP_BUCKET, BACKUP_KEY_ID and BACKUP_SECRET_KEY).");
    return;
  }
  closeUnfinishedBackups();
  const due = () => {
    const last = lastGoodBackup();
    const lastTry = recentBackupRuns(1)[0];
    const tooSoon = lastTry && !lastTry.ok && Date.now() - lastTry.startedAt < 50 * 60 * 1000;
    return !backupRunning() && !tooSoon && (!last || Date.now() - (last.finishedAt ?? 0) > DAY - 30 * 60 * 1000);
  };
  const check = () => {
    if (due()) void runBackup();
  };
  setTimeout(check, 2 * 60 * 1000).unref();
  setInterval(check, 60 * 60 * 1000).unref();
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { HttpError } from "./auth";

// Every family's photos and audio live under data/households/<id>/. Paths
// stored in the database are relative to that folder, so a URL can never
// reach another family's files.

export function householdDir(householdId: string): string {
  return path.join(config.dataDir, "households", householdId);
}

export function resolveHouseholdPath(householdId: string, rel: string): string {
  const root = householdDir(householdId);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(404, "Not found.");
  return full;
}

export function storyDir(householdId: string, storyId: string): string {
  return resolveHouseholdPath(householdId, path.join("stories", storyId));
}

/** The photo types the library keeps, and the extension each is saved with. */
export const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Save an uploaded image, returning its household-relative path. */
export async function saveImage(householdId: string, folder: string, file: File): Promise<string> {
  const ext = IMAGE_TYPES[file.type];
  if (!ext) throw new HttpError(400, "Photos need to be JPEG, PNG, WebP or GIF.");
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(400, "That photo is too big (8 MB max).");
  const rel = `${folder}/${randomUUID()}${ext}`;
  const full = resolveHouseholdPath(householdId, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, Buffer.from(await file.arrayBuffer()));
  return rel;
}

/** Save an image the app fetched itself (a classic's cover), returning its household-relative path. */
export async function saveImageBytes(householdId: string, folder: string, bytes: Buffer, type: string): Promise<string> {
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new HttpError(400, "Images need to be JPEG, PNG, WebP or GIF.");
  const rel = `${folder}/${randomUUID()}${ext}`;
  const full = resolveHouseholdPath(householdId, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, bytes);
  return rel;
}

/** Twenty minutes of a recording at 192 kbps (29 MB), with room to spare. */
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

/** Save an uploaded recording (the browser has already turned it into an MP3). */
export async function saveAudio(householdId: string, folder: string, file: File): Promise<string> {
  if (file.type !== "audio/mpeg") throw new HttpError(400, "Recordings need to arrive as MP3.");
  if (file.size > MAX_AUDIO_BYTES) throw new HttpError(400, "That recording is too long (about 20 minutes at most).");
  const rel = `${folder}/${randomUUID()}.mp3`;
  const full = resolveHouseholdPath(householdId, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, Buffer.from(await file.arrayBuffer()));
  return rel;
}

export function mediaTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

export async function readImageForModel(
  householdId: string,
  rel: string,
): Promise<{ data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" }> {
  const full = resolveHouseholdPath(householdId, rel);
  const data = (await fs.promises.readFile(full)).toString("base64");
  return { data, mediaType: mediaTypeFor(full) as "image/jpeg" };
}

export async function removeDir(full: string) {
  await fs.promises.rm(full, { recursive: true, force: true });
}

export async function removeHouseholdFile(householdId: string, rel: string) {
  await fs.promises.rm(resolveHouseholdPath(householdId, rel), { force: true });
}

import path from "node:path";
import { picturePrice, storytellerRates } from "./prices";
import type { AppStatus } from "@/lib/shared/types";

export interface BackupStorage {
  endpoint: string;
  bucket: string;
  keyId: string;
  secret: string;
  region: string;
}

export const config = {
  get dataDir(): string {
    // Runtime data, not part of the build: keep the bundler from tracing it.
    return path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), "data"));
  },
  get demoMode(): boolean {
    return process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
  },
  get anthropicKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY || undefined;
  },
  get elevenLabsKey(): string | undefined {
    return process.env.ELEVENLABS_API_KEY || undefined;
  },
  /** Project Gutenberg's catalogue of every book (changeable for tests). */
  get gutenbergCatalogUrl(): string {
    return process.env.GUTENBERG_CATALOG_URL || "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz";
  },
  get storyModel(): string {
    return process.env.STORY_MODEL || "claude-opus-5-5";
  },
  /** The quick check that what a family asks for is for children: a small, fast model is plenty. */
  get guardModel(): string {
    return process.env.GUARD_MODEL || "claude-haiku-5-5";
  },
  get voiceModel(): string {
    return process.env.VOICE_MODEL || "eleven_v4";
  },
  /**
   * How many recordings ElevenLabs makes for the stories at once, between them: one under the plan's limit (Creator
   * allows 5, Pro 10), so a voice being designed or learned still gets a turn.
   */
  get voicesAtOnce(): number {
    const n = Number(process.env.VOICES_AT_ONCE);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, 30) : 4;
  },
  /** Google's picture model draws picture books (a Gemini API key from aistudio.google.com). */
  get illustratorKey(): string | undefined {
    return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined;
  },
  get pictureModel(): string {
    return process.env.PICTURE_MODEL?.trim() || "gemini-nano-banana-2.1";
  },
  /** The Gemini API's address (changeable for tests). */
  get illustratorBaseUrl(): string {
    return (process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  },
  /** How long to wait before trying a picture that didn't come once more (a busy Google often isn't, a few seconds later). Changeable for tests. */
  get illustratorRetryPauseMs(): number {
    const v = process.env.ART_RETRY_PAUSE_MS?.trim();
    return v && Number.isFinite(Number(v)) ? Number(v) : 8000;
  },
  /** For a picture model the app doesn't know the price of: dollars per picture, e.g. "0.08". */
  get picturePriceOverride(): number | null {
    const v = Number(process.env.PICTURE_PRICE);
    return Number.isFinite(v) && v > 0 ? v : null;
  },
  /**
   * A Google key for the browser (restricted to this app's addresses and the Drive API), so a family video shared
   * from Google Drive can come straight from Google to the phone. Never the Gemini key: this one is seen by browsers.
   */
  get googleDriveKey(): string | undefined {
    return process.env.GOOGLE_DRIVE_API_KEY?.trim() || undefined;
  },
  /** e.g. an ElevenLabs data-residency endpoint; defaults to the global API. */
  get elevenLabsBaseUrl(): string | undefined {
    return process.env.ELEVENLABS_BASE_URL || undefined;
  },
  /** When set, creating a library needs this code (keeps strangers off a public URL). */
  get signupCode(): string | undefined {
    return process.env.SIGNUP_CODE?.trim() || undefined;
  },
  /**
   * Where automatic backups go: any S3-compatible storage the family owns
   * (Backblaze B2, Cloudflare R2, Amazon S3). Off unless all four are set.
   */
  get backupStorage(): BackupStorage | null {
    const endpoint = process.env.BACKUP_ENDPOINT?.trim();
    const bucket = process.env.BACKUP_BUCKET?.trim();
    const keyId = process.env.BACKUP_KEY_ID?.trim();
    const secret = process.env.BACKUP_SECRET_KEY?.trim();
    if (!endpoint || !bucket || !keyId || !secret) return null;
    const url = (/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`).replace(/\/+$/, "");
    // Backblaze and Amazon name the region in the address ("s3.us-west-004.backblazeb2.com"); Cloudflare R2 uses "auto".
    const region = process.env.BACKUP_REGION?.trim() || url.match(/s3[.-]([a-z0-9-]+)\.(?:backblazeb2|amazonaws)\.com/)?.[1] || "auto";
    return { endpoint: url, bucket, keyId, secret, region };
  },
  /**
   * Problem alerts by email, through Resend (resend.com). Without a domain of your own, Resend
   * sends from onboarding@resend.dev, and only to the address the Resend account was made with.
   */
  get alerts(): { apiKey: string; to: string; from: string; apiBase: string } | null {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const to = process.env.ALERT_EMAIL?.trim();
    if (!apiKey || !to) return null;
    return {
      apiKey,
      to,
      from: process.env.ALERT_FROM?.trim() || "Storyhollow <onboarding@resend.dev>",
      apiBase: (process.env.RESEND_BASE_URL?.trim() || "https://api.resend.com").replace(/\/+$/, ""),
    };
  },
  /** The app's own address, for links in emails (Railway names it in RAILWAY_PUBLIC_DOMAIN). */
  get publicUrl(): string | null {
    const url = process.env.PUBLIC_URL?.trim() || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
    return url ? url.replace(/\/+$/, "") : null;
  },
  /** Each copy of the app (live, test) keeps its backups in its own folder of the bucket. */
  get backupFolder(): string {
    return (process.env.STORYHOLLOW_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || "storyhollow").replace(/[^a-z0-9_-]/gi, "-");
  },
  get secureCookies(): boolean {
    return process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1";
  },
};

/** Which engines are live. In demo mode, stand-ins are used for anything missing. */
export function appStatus(): AppStatus {
  return {
    demoMode: config.demoMode,
    storyteller: Boolean(config.anthropicKey),
    voices: Boolean(config.elevenLabsKey),
    storyModel: config.storyModel,
    voiceModel: config.voiceModel,
    storytellerRates: storytellerRates(),
    illustrator: Boolean(config.illustratorKey),
    pictureModel: config.pictureModel,
    picturePrice: picturePrice(),
  };
}

export function canWriteStories(): boolean {
  return Boolean(config.anthropicKey) || config.demoMode;
}

/**
 * True in the test copy: Railway names each environment ("production",
 * "staging"), and anything but the live one is for trying changes first.
 * Read it while handling a request; the build doesn't know which copy it's for.
 */
export function isTestCopy(): boolean {
  const name = process.env.STORYHOLLOW_ENV || process.env.RAILWAY_ENVIRONMENT_NAME;
  return Boolean(name) && name !== "production";
}

/** The app's name, marked in the test copy so the two are never confused. */
export const appName = () => (isTestCopy() ? "Storyhollow Test" : "Storyhollow");

export function canRecordStories(): boolean {
  return Boolean(config.elevenLabsKey) || config.demoMode;
}

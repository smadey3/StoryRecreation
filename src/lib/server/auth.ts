import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "./config";
import {
  createSession,
  deleteSession,
  getHousehold,
  getProfile,
  getSession,
  setSessionGrownup,
  storyBeingMade,
  type HouseholdRow,
  type SessionRow,
} from "./db";
import type { Profile } from "@/lib/shared/types";

export const SESSION_COOKIE = "ll_session";
const SESSION_TTL = 1000 * 60 * 60 * 24 * 180; // family devices stay signed in
const GROWNUP_UNLOCK_MS = 1000 * 60 * 30;
/** "Don't ask again on this device for 30 days." */
const GROWNUP_TRUST_MS = 1000 * 60 * 60 * 24 * 30;

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(secret, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  session: SessionRow;
  household: HouseholdRow;
  profile: Profile | null;
  /** True when no PIN is set, or the PIN was entered recently on this device. */
  grownup: boolean;
}

export async function currentCtx(): Promise<Ctx | null> {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const session = getSession(sid);
  if (!session) return null;
  const household = getHousehold(session.household_id);
  if (!household) return null;
  const profile = session.profile_id ? getProfile(household.id, session.profile_id) ?? null : null;
  const grownup = !household.pin_hash || session.grownup_until > Date.now();
  return { session, household, profile, grownup };
}

/** For pages: send signed-out visitors to the welcome door. */
export async function pageCtx(): Promise<Ctx> {
  const ctx = await currentCtx();
  if (!ctx) redirect("/welcome");
  return ctx;
}

/** For API routes. */
export async function apiCtx(): Promise<Ctx> {
  const ctx = await currentCtx();
  if (!ctx) throw new HttpError(401, "Please sign in first.", "signed_out");
  return ctx;
}

/** Spending credits or changing settings needs a grown-up when a PIN is set. */
export function requireGrownup(ctx: Ctx) {
  if (!ctx.grownup) throw new HttpError(403, "A grown-up needs to enter the PIN.", "pin_required");
}

/**
 * A family makes one story at a time, so every family gets its turn with the voices when many are making stories at
 * once: starting another (or re-recording one) waits until theirs is ready, and says which it is.
 */
export function oneStoryAtATime(ctx: Ctx, exceptId?: string) {
  const other = storyBeingMade(ctx.household.id, exceptId);
  if (other) throw new HttpError(409, `One story at a time: “${other.title}” is still being made. This one can start as soon as it's ready.`, "one_at_a_time");
}

/** Until when a PIN entered now unlocks this device: half an hour, or 30 days when it's to be remembered. */
export function grownupUnlockUntil(remember = false): number {
  return Date.now() + (remember ? GROWNUP_TRUST_MS : GROWNUP_UNLOCK_MS);
}

/** Unlock this device after the PIN was entered, never sooner than it already was (a remembered device stays so). */
export function unlockDevice(ctx: Ctx, remember: boolean) {
  setSessionGrownup(ctx.session.id, Math.max(ctx.session.grownup_until, grownupUnlockUntil(remember)));
}

export async function startSession(householdId: string) {
  const sid = createSession(householdId, SESSION_TTL);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

export async function endSession() {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  if (sid) deleteSession(sid);
  jar.delete(SESSION_COOKIE);
}

/** Wrap a route handler so thrown HttpErrors become tidy JSON responses. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message, code: err.code }, { status: err.status });
      }
      console.error(err);
      return Response.json({ error: "Something went wrong in the library." }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "That request didn't make sense.");
  }
}

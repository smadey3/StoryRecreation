import { recentWorkTimes, saveWorkTime } from "./db";
import type { PicturePace } from "@/lib/shared/types";

// How long the slow work really takes here, so every wait says so truthfully. Each finished job's time is kept
// beside what its rule of thumb said, and later waits are the rule of thumb at the pace the last dozen really went,
// with a little to spare, so a wait ends early more often than late. Until three have been timed, the rule of
// thumb stands. Faster plans, slower days and new models all show up in the waits by themselves.

/** Work that's timed: a story written, a reading prepared, a recording, and a picture book's pictures. */
export type Work = "writing" | "reading" | "recording" | "planning" | "sketching" | "drawing";

const RECENT = 12;
/** A little to spare. */
const CUSHION = 1.2;

/** How many times its rule of thumb this work has really taken lately. */
export function paceOf(work: Work): number {
  try {
    const times = recentWorkTimes(work, RECENT);
    if (times.length < 3) return 1;
    // A job that stalled (a service having a slow day) counts as no more than 4 times its rule of thumb.
    const took = times.reduce((n, t) => n + Math.min(t.took, t.guess * 4), 0);
    const guessed = times.reduce((n, t) => n + t.guess, 0);
    return Math.min(5, Math.max(0.5, (took / guessed) * CUSHION));
  } catch {
    return 1;
  }
}

/** About how long some work will take, in seconds: its rule of thumb, at the pace it really goes here. */
export const expectedSeconds = (work: Work, guess: number) => Math.round(guess * paceOf(work));

/** Some work finished: keep how long it took (since `startedAt`, less any `waited` in line), beside its rule of thumb. */
export function noteWorkTime(work: Work, guess: number, startedAt: number, waited = 0) {
  const took = (Date.now() - startedAt) / 1000 - waited;
  if (!(guess > 0) || !(took > 0)) return;
  try {
    saveWorkTime(work, guess, took);
  } catch (err) {
    console.error("Couldn't keep how long the work took:", err);
  }
}

/** The pace of a picture book's work, for the estimates the page makes before the work starts. */
export const picturePace = (): PicturePace => ({ planning: paceOf("planning"), sketching: paceOf("sketching"), drawing: paceOf("drawing") });

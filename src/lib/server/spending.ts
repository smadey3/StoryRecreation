import { db, newId, rememberPinDigits } from "./db";
import { HttpError, unlockDevice, verifySecret, type Ctx } from "./auth";
import { clearAttempts, recordAttempt, tooManyAttempts } from "./ratelimit";
import { noteRecentPictureCost, writeCostGuess } from "./prices";
import { LENGTHS } from "@/lib/shared/options";
import { formatMoney } from "@/lib/shared/art";
import type { LengthPreset, SpendingItem, SpendingSummary, WriteCosts } from "@/lib/shared/types";

// What the family spends, kept so it can be shown before and after. Pictures
// are bought: a grown-up approves each purchase (with the family PIN, unless
// it was entered on this device lately), and the illustrator never spends more
// than was approved. The storyteller's cost is recorded after each story is
// written, and guides the estimate for the next.

type Row = Record<string, unknown>;

export interface SpendRecord {
  storyId?: string | null;
  service: "pictures" | "storyteller";
  /** e.g. "write:medium", "sounds", "sketch", "draw". */
  kind: string;
  what: string;
  approved?: number | null;
  spent?: number;
  pictures?: number;
  standIn?: boolean;
}

export function recordSpend(householdId: string, s: SpendRecord): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO spending (id, household_id, story_id, service, kind, what, approved_micros, spent_micros, pictures, stand_in, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      householdId,
      s.storyId ?? null,
      s.service,
      s.kind,
      s.what.slice(0, 200),
      s.approved ?? null,
      Math.round(s.spent ?? 0),
      s.pictures ?? 0,
      s.standIn ? 1 : 0,
      Date.now(),
    );
  return id;
}

/** A picture drawn for an approved purchase. */
export function addToPurchase(id: string, micros: number, pictures = 1) {
  db().prepare("UPDATE spending SET spent_micros = spent_micros + ?, pictures = pictures + ? WHERE id = ?").run(Math.round(micros), pictures, id);
  refreshPictureCost();
}

/** What pictures have really cost lately, each (tries that came back empty included), so their price covers them. */
export function refreshPictureCost() {
  const rows = db()
    .prepare("SELECT spent_micros, pictures FROM spending WHERE service = 'pictures' AND stand_in = 0 AND pictures > 0 ORDER BY created_at DESC LIMIT 12")
    .all() as Row[];
  const pictures = rows.reduce((n, r) => n + Number(r.pictures), 0);
  noteRecentPictureCost(pictures ? rows.reduce((n, r) => n + Number(r.spent_micros), 0) / pictures : null);
}

export function getPurchase(id: string): { approved: number; spent: number; pictures: number } | null {
  const r = db().prepare("SELECT approved_micros, spent_micros, pictures FROM spending WHERE id = ?").get(id) as Row | undefined;
  return r ? { approved: Number(r.approved_micros ?? 0), spent: Number(r.spent_micros), pictures: Number(r.pictures) } : null;
}

/** What a story's pictures have cost so far. */
export function pictureSpendForStory(storyId: string): number {
  const r = db().prepare("SELECT COALESCE(SUM(spent_micros), 0) AS n FROM spending WHERE story_id = ? AND service = 'pictures'").get(storyId) as Row;
  return Number(r.n);
}

const toItem = (r: Row): SpendingItem => ({
  id: r.id as string,
  storyId: (r.story_id as string | null) ?? null,
  service: r.service as SpendingItem["service"],
  what: r.what as string,
  approved: (r.approved_micros as number | null) ?? null,
  spent: Number(r.spent_micros),
  pictures: Number(r.pictures),
  standIn: Boolean(r.stand_in),
  createdAt: r.created_at as number,
});

/** This month's totals and the latest few things, for the Grown-ups' corner. */
export function spendingSummary(householdId: string, now = new Date()): SpendingSummary {
  const since = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const t = db()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN service = 'pictures' THEN spent_micros END), 0) AS pictures,
         COALESCE(SUM(CASE WHEN service = 'pictures' AND stand_in = 0 THEN pictures END), 0) AS picture_count,
         COALESCE(SUM(CASE WHEN service = 'storyteller' THEN spent_micros END), 0) AS storyteller,
         COUNT(CASE WHEN kind LIKE 'write:%' OR kind = 'read' THEN 1 END) AS stories
       FROM spending WHERE household_id = ? AND created_at >= ?`,
    )
    .get(householdId, since) as Row;
  const recent = (
    db().prepare("SELECT * FROM spending WHERE household_id = ? ORDER BY created_at DESC LIMIT 15").all(householdId) as Row[]
  ).map(toItem);
  return {
    month: { pictures: Number(t.pictures), pictureCount: Number(t.picture_count), storyteller: Number(t.storyteller), stories: Number(t.stories) },
    recent,
  };
}

/** About what writing a story costs: the middle of the family's last few of that length, or a fair guess before there are any. */
export function writeCosts(householdId: string): WriteCosts {
  const out = {} as WriteCosts;
  for (const length of Object.keys(LENGTHS) as LengthPreset[]) {
    const costs = (
      db()
        .prepare("SELECT spent_micros FROM spending WHERE household_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 8")
        .all(householdId, `write:${length}`) as Row[]
    )
      .map((r) => Number(r.spent_micros))
      .sort((a, b) => a - b);
    out[length] = costs.length >= 2 ? costs[Math.floor(costs.length / 2)] : writeCostGuess(length);
  }
  return out;
}

export interface Approval {
  pin?: unknown;
  /** The price the grown-up was shown and said yes to. */
  micros?: unknown;
  /** "Don't ask again on this device for 30 days." */
  remember?: unknown;
}

/**
 * A grown-up said yes to spending money, at a price no lower than what it can cost. The family PIN is asked for
 * unless it was entered on this device lately (or this device is remembered for 30 days): then the yes is enough.
 */
export function approvePurchase(ctx: Ctx, approval: Approval | undefined, price: number) {
  if (!ctx.household.pin_hash) throw new HttpError(403, "Buying pictures needs a family PIN. Please choose one first.", "pin_needed");
  if (!ctx.grownup) {
    const key = `pin:${ctx.household.id}`;
    if (tooManyAttempts(key, 8)) throw new HttpError(429, "Too many tries. Please wait a few minutes.");
    const pin = typeof approval?.pin === "string" ? approval.pin : "";
    if (!pin || !verifySecret(pin, ctx.household.pin_hash)) {
      recordAttempt(key);
      throw new HttpError(401, pin ? "That's not the right PIN." : "A grown-up needs to enter the PIN.", pin ? "wrong_pin" : "pin_required");
    }
    clearAttempts(key);
    if (ctx.household.pin_digits === null) rememberPinDigits(ctx.household.id, pin.length);
    unlockDevice(ctx, approval?.remember === true);
  }
  // A picture's price moves by fractions of a cent as pictures are drawn (it follows what they really cost), so the
  // price said yes to is the one shown, to the cent (rounded up, as every price is shown). A real change is said, with
  // the new price for the page to show.
  const approved = Number(approval?.micros);
  const cents = (micros: number) => Math.ceil(micros / 10_000);
  if (!Number.isFinite(approved) || cents(approved) < cents(price)) {
    throw new HttpError(409, `The price has changed to ${formatMoney(price)}. Please look again before saying yes.`, "price_changed", { price });
  }
}

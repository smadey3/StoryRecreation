import { config, isTestCopy } from "./config";
import { alertsSentSince, getBook, getStoryById, lastAlertSent, recentAlerts, recordAlert, type AlertRecord } from "./db";
import { voiceCredits } from "./credits";

// Problem alerts: an email to the grown-ups when something goes wrong that they'd
// otherwise only find out about at bedtime: a story that didn't finish, a backup
// that failed, voice credit running low. Sent through Resend (resend.com). Each
// problem is sent once (or once a day while it lasts), and never more than 20 an hour.

export type AlertKind = "story" | "backup" | "credits" | "test";

const HOUR = 3600 * 1000;
const MAX_PER_HOUR = 20;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Email the grown-ups about a problem, unless the same one (kind and key) was sent within `quietFor`.
 * Returns whether an email went out.
 */
export async function sendAlert({
  kind,
  key,
  subject,
  lines,
  link,
  quietFor,
}: {
  kind: AlertKind;
  key: string;
  subject: string;
  lines: string[];
  link?: { label: string; path: string };
  quietFor: number;
}): Promise<boolean> {
  const mail = config.alerts;
  if (!mail) return false;
  const last = lastAlertSent(kind, key);
  if (last !== null && Date.now() - last < quietFor) return false;
  if (alertsSentSince(Date.now() - HOUR) >= MAX_PER_HOUR) {
    console.warn(`Alert not sent (more than ${MAX_PER_HOUR} this hour): ${subject}`);
    return false;
  }
  const fullSubject = `${isTestCopy() ? "🧪 Test copy · " : ""}Storyhollow: ${subject}`;
  const url = link && config.publicUrl ? `${config.publicUrl}${link.path}` : null;
  const text = [...lines, ...(url ? ["", `${link!.label}: ${url}`] : []), "", "Sent by Storyhollow's problem alerts (see the Grown-ups' corner)."].join("\n");
  const html = `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.5;color:#3a2616">${lines
    .map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`)
    .join("")}${
    url ? `<p style="margin:18px 0"><a href="${escapeHtml(url)}" style="color:#8e2a3a;font-weight:bold">${escapeHtml(link!.label)} →</a></p>` : ""
  }<p style="margin:24px 0 0;font-size:13px;color:#8a6e4e">Sent by Storyhollow's problem alerts (see the Grown-ups' corner).</p></div>`;
  try {
    const res = await fetch(`${mail.apiBase}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${mail.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: mail.from, to: [mail.to], subject: fullSubject, text, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(`Resend said ${res.status}${body.message ? `: ${body.message}` : ""}`);
    }
    recordAlert({ kind, key, subject: fullSubject, ok: true });
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("Alert email failed:", error);
    recordAlert({ kind, key, subject: fullSubject, ok: false, error });
    return false;
  }
}

/** A story that didn't finish writing or recording. At most once an hour for the same story. */
export async function alertStoryFailed(storyId: string, reason: string): Promise<boolean> {
  const story = getStoryById(storyId);
  if (!story) return false;
  const book = getBook(story.householdId, story.bookId);
  const name = `“${story.title}”${book && book.title !== story.title ? ` (${book.title})` : ""}`;
  return sendAlert({
    kind: "story",
    key: storyId,
    subject: `${story.title} didn't finish`,
    lines: [`${name} didn't finish.`, reason, "Nothing is lost: open it and press “Try again”."],
    link: { label: "Open the story", path: `/stories/${storyId}` },
    quietFor: HOUR,
  });
}

/** A nightly backup that failed. At most once a day while backups keep failing. */
export async function alertBackupFailed(reason: string): Promise<boolean> {
  return sendAlert({
    kind: "backup",
    key: "backup",
    subject: "last night's backup didn't finish",
    lines: [
      "The automatic backup to your cloud storage didn't finish.",
      reason,
      "It will try again within the hour. Your stories are safe in the app; this is only about the copy kept elsewhere.",
    ],
    link: { label: "See backups in the Grown-ups' corner", path: "/grownups#safe" },
    quietFor: 20 * HOUR,
  });
}

/**
 * The storyteller's prepaid Anthropic credit has run out (with auto reload off, it simply stops at nothing). Once a day
 * while it lasts: it's the same news, wherever the storyteller was turned down.
 */
export async function alertStorytellerOutOfCredit(): Promise<boolean> {
  return sendAlert({
    kind: "credits",
    key: "storyteller",
    subject: "the storyteller's Anthropic credit has run out",
    lines: [
      "Anthropic turned the storyteller down because the account's prepaid credit is used up, so new stories can't be written (or their pictures planned) until it's topped up.",
      "Add credit at console.anthropic.com (Settings → Billing), or turn on auto reload there. Then press “Try again” on any story that stopped: nothing already made is lost, and nothing is paid for twice.",
    ],
    link: { label: "Open Storyhollow", path: "/" },
    quietFor: 20 * HOUR,
  });
}

/** Under a tenth of the month's voice credit left: once a month. */
export async function checkVoiceCreditLow(): Promise<boolean> {
  const credits = await voiceCredits();
  if (!credits || credits.demo || !credits.limit || credits.left / credits.limit >= 0.1) return false;
  const tops = credits.resetsAt ? new Date(credits.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;
  return sendAlert({
    kind: "credits",
    key: `low:${credits.resetsAt ?? new Date().toISOString().slice(0, 7)}`,
    subject: "voice credits are running low",
    lines: [
      `Only ${credits.left.toLocaleString()} of this month's ${credits.limit.toLocaleString()} ElevenLabs voice credits are left${tops ? `, until they top up on ${tops}` : ""}.`,
      "A six-minute story uses about 5,000. Shorter stories, or a top-up at elevenlabs.io, will see you through.",
    ],
    link: { label: "See voice credits in the Grown-ups' corner", path: "/grownups#engines" },
    quietFor: Infinity,
  });
}

/** "Send a test email", from the Grown-ups' corner (at most once a minute). */
export async function sendTestAlert(): Promise<boolean> {
  return sendAlert({
    kind: "test",
    key: "test",
    subject: "problem alerts are working",
    lines: ["This is a test from Storyhollow's problem alerts. If something goes wrong, an email like this will tell you what and what to do."],
    link: { label: "Open Storyhollow", path: "/" },
    quietFor: 60 * 1000,
  });
}

export interface AlertsStatus {
  configured: boolean;
  to: string | null;
  recent: AlertRecord[];
}

export function alertsStatus(): AlertsStatus {
  const mail = config.alerts;
  return { configured: Boolean(mail), to: mail?.to ?? null, recent: recentAlerts(5) };
}

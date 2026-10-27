// Problem alerts against a local stand-in for Resend (and for ElevenLabs' account balance):
// what's emailed, that the same problem isn't sent twice, the test copy's emails are marked,
// a refused key is recorded, and the health check answers for an uptime monitor.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";

interface Email {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}
const emails: Email[] = [];
let auth = "";
let creditsLeft = 50_000;
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/emails" && req.method === "POST") {
        auth = String(req.headers.authorization);
        if (auth !== "Bearer re_good") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ statusCode: 401, name: "validation_error", message: "API key is invalid" }));
        }
        emails.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: `email_${emails.length}` }));
      }
      if (req.url === "/v1/user/subscription") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ tier: "creator", character_count: 100_000 - creditsLeft, character_limit: 100_000, next_character_count_reset_unix: 1793750400 }));
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "storyhollow-alerts-test-")),
    RESEND_API_KEY: "re_good",
    RESEND_BASE_URL: base,
    ALERT_EMAIL: "grownup@example.com",
    PUBLIC_URL: "https://stories.example.com/",
    ELEVENLABS_API_KEY: "test-eleven",
    ELEVENLABS_BASE_URL: base,
    STORYHOLLOW_ENV: "production",
  });
});

after(() => server.close());

test("a story that didn't finish is emailed once, with what went wrong and a link back to it", async () => {
  const { createHousehold, createBook, createStory } = await import("@/lib/server/db");
  const { defaultSettings } = await import("@/lib/shared/options");
  const { alertStoryFailed } = await import("@/lib/server/alerts");
  const household = createHousehold("The Moss Family", "moss@example.com", "hash");
  const bookId = createBook(household, { title: "Hoop Dreams", kind: "idea" });
  const storyId = createStory(household, {
    bookId,
    profileId: null,
    mode: "create",
    title: "Bounce and the Fun-Sized Champion",
    settings: defaultSettings({ source: "idea" }),
    status: "error",
  });

  assert.equal(await alertStoryFailed(storyId, "ElevenLabs says we're out of voice credits or going too fast. Try again later."), true);
  const email = emails.at(-1)!;
  assert.equal(email.from, "Storyhollow <onboarding@resend.dev>");
  assert.deepEqual(email.to, ["grownup@example.com"]);
  assert.equal(email.subject, "Storyhollow: Bounce and the Fun-Sized Champion didn't finish");
  assert.match(email.text, /“Bounce and the Fun-Sized Champion” \(Hoop Dreams\) didn't finish\./);
  assert.match(email.text, /out of voice credits/);
  assert.match(email.text, new RegExp(`Open the story: https://stories\\.example\\.com/stories/${storyId}`));
  assert.match(email.html, /href="https:\/\/stories\.example\.com\/stories\//);
  assert.equal(auth, "Bearer re_good");

  assert.equal(await alertStoryFailed(storyId, "Again"), false, "the same story isn't emailed again within the hour");
  assert.equal(emails.length, 1);
});

test("the storyteller's credit running out is emailed once a day while it lasts, saying how to fix it", async () => {
  const { alertStorytellerOutOfCredit } = await import("@/lib/server/alerts");
  assert.equal(await alertStorytellerOutOfCredit(), true);
  const email = emails.at(-1)!;
  assert.equal(email.subject, "Storyhollow: the storyteller's Anthropic credit has run out");
  assert.match(email.text, /console\.anthropic\.com \(Settings → Billing\), or turn on auto reload/);
  assert.match(email.text, /nothing already made is lost, and nothing is paid for twice/);
  assert.equal(await alertStorytellerOutOfCredit(), false, "not again the same day");
});

test("a failed backup is emailed at most once a day, and low voice credit once a month", async () => {
  const { alertBackupFailed, checkVoiceCreditLow } = await import("@/lib/server/alerts");
  const { forgetVoiceCredits } = await import("@/lib/server/credits");
  assert.equal(await alertBackupFailed("The backup storage turned the key down."), true);
  assert.equal(await alertBackupFailed("Still failing."), false);
  assert.match(emails.at(-1)!.subject, /backup didn't finish/);

  forgetVoiceCredits();
  assert.equal(await checkVoiceCreditLow(), false, "half left is fine");
  creditsLeft = 4_000;
  forgetVoiceCredits();
  assert.equal(await checkVoiceCreditLow(), true);
  assert.match(emails.at(-1)!.text, /Only 4,000 of this month's 100,000 ElevenLabs voice credits are left, until they top up on November \d+\./);
  forgetVoiceCredits();
  assert.equal(await checkVoiceCreditLow(), false, "once a month");
});

test("the test copy's emails say so, a refused key is recorded, and the Grown-ups' corner sees it all", async () => {
  const { sendTestAlert, alertsStatus } = await import("@/lib/server/alerts");
  process.env.STORYHOLLOW_ENV = "staging";
  try {
    assert.equal(await sendTestAlert(), true);
    assert.equal(emails.at(-1)!.subject, "🧪 Test copy · Storyhollow: problem alerts are working");
    assert.equal(await sendTestAlert(), false, "not twice in a minute");

    process.env.RESEND_API_KEY = "re_bad";
    const { sendAlert } = await import("@/lib/server/alerts");
    assert.equal(await sendAlert({ kind: "story", key: "x", subject: "x", lines: ["x"], quietFor: 0 }), false);
    const status = alertsStatus();
    assert.equal(status.configured, true);
    assert.equal(status.to, "grownup@example.com");
    assert.equal(status.recent[0].ok, false);
    assert.match(status.recent[0].error!, /Resend said 401: API key is invalid/);
    assert.equal(status.recent.filter((a) => a.ok).length, 4);
  } finally {
    process.env.STORYHOLLOW_ENV = "production";
    process.env.RESEND_API_KEY = "re_good";
  }
});

test("without the settings, nothing is sent", async () => {
  const { sendAlert, alertsStatus } = await import("@/lib/server/alerts");
  delete process.env.RESEND_API_KEY;
  try {
    assert.equal(await sendAlert({ kind: "story", key: "y", subject: "y", lines: ["y"], quietFor: 0 }), false);
    assert.equal(alertsStatus().configured, false);
  } finally {
    process.env.RESEND_API_KEY = "re_good";
  }
});

test("the health check answers an uptime monitor", async () => {
  const { GET } = await import("@/app/api/health/route");
  const res = GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/components/Grownup";
import { Avatar, ReaderEditor } from "@/components/Readers";
import { VoiceDesigner } from "@/components/VoiceDesigner";
import { FamilyVoices } from "@/components/FamilyVoices";
import { BackupsPanel } from "@/components/BackupsPanel";
import { DownloadEverything } from "@/components/DownloadEverything";
import { AlertsPanel } from "@/components/AlertsPanel";
import { CreditMeter, useCredits } from "@/components/Credits";
import { forgetOffline } from "@/components/Offline";
import { formatMoney } from "@/lib/shared/art";
import type { AppStatus, FamilyVoice, Keepsake, Profile, SpendingSummary, TurnedDown } from "@/lib/shared/types";
import type { BackupStatus } from "@/lib/server/offsite";
import type { AlertsStatus } from "@/lib/server/alerts";

/** A section of the corner that opens when it's wanted: its title, a word on how it stands, and a line on what it's for. */
function Fold({ id, title, note, about, children }: { id: string; title: string; note: React.ReactNode; about: string; children: React.ReactNode }) {
  return (
    <details className="parchment fold" id={id}>
      <summary>
        <h2>{title}</h2>
        <span className="fold-note">{note}</span>
        <span className="fold-about">{about}</span>
      </summary>
      <div className="stack fold-body">{children}</div>
    </details>
  );
}

/** Where something was turned down, in a few words. */
const TURNED_DOWN_PLACE: Record<TurnedDown["place"], string> = {
  story: "A new story",
  words: "Words to read aloud",
  edit: "Words changed in a story",
  voice: "A voice described",
  pictures: "A story's pictures or pages",
};

/** Open a section and bring it into view (from the line at the top, or a link to /grownups#section). */
function openFold(id: string) {
  const fold = document.getElementById(id);
  if (!(fold instanceof HTMLDetailsElement)) return;
  fold.open = true;
  fold.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function GrownupsView({
  familyName,
  email,
  unlocked,
  unlockedUntil,
  pinSet,
  profiles,
  designed,
  keepsakes,
  familyVoices,
  backup,
  backups,
  alerts,
  spending,
  turnedDown,
  status,
  driveKey,
}: {
  familyName: string;
  email: string;
  unlocked: boolean;
  /** Until when the PIN entered on this device is good for (null when there's no PIN). */
  unlockedUntil: number | null;
  pinSet: boolean;
  profiles: Profile[];
  designed: { voiceId: string; name: string; description: string }[];
  keepsakes: Keepsake[];
  familyVoices: FamilyVoice[];
  backup: { stories: number; recordings: number; photos: number; bytes: number } | null;
  backups: BackupStatus | null;
  alerts: AlertsStatus | null;
  spending: SpendingSummary | null;
  /** What the storyteller turned down because it wasn't for children (grown-ups only). */
  turnedDown: TurnedDown[] | null;
  status: AppStatus;
  /** The Google key for fetching family videos from Drive links, when it's set up. */
  driveKey: string | null;
}) {
  const api = useApi();
  const router = useRouter();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [designing, setDesigning] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  };

  // Times are in the phone's own time zone, so only once the page is on it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const follow = () => window.location.hash && openFold(window.location.hash.slice(1));
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const credits = useCredits();

  // How the backups stand, in a few words.
  const lastBackup = backups?.recent[0];
  const backedUp = (at: number) => {
    if (!mounted) return "Backed up";
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
    return `Backed up ${days === 0 ? "today" : days === 1 ? "yesterday" : new Date(at).toLocaleDateString([], { weekday: "long" })}`;
  };
  const backupNote = !backups
    ? null
    : !backups.configured
      ? { ok: false, text: "Nightly backups are off", short: "Backups off" }
      : backups.running
        ? { ok: true, text: "Backing up now", short: "Backing up" }
        : lastBackup && !lastBackup.ok
          ? { ok: false, text: "The last backup didn't finish", short: "Last one failed" }
          : backups.lastGood
            ? { ok: true, text: backedUp(backups.lastGood.finishedAt ?? backups.lastGood.startedAt), short: backedUp(backups.lastGood.finishedAt ?? backups.lastGood.startedAt) }
            : { ok: true, text: "First backup on its way", short: "First one soon" };
  const enginesOk = status.storyteller && status.voices;
  const glance = [
    enginesOk || status.demoMode ? null : { id: "engines", ok: false, text: "The storyteller or voices aren't connected" },
    backupNote && { id: "safe", ok: backupNote.ok, text: backupNote.text },
    alerts && { id: "alerts", ok: alerts.configured, text: alerts.configured ? "Problem alerts on" : "Problem alerts are off" },
    credits && { id: "engines", ok: credits.left > credits.limit * 0.1, text: `${credits.left.toLocaleString()} voice credits left` },
  ].filter((g): g is { id: string; ok: boolean; text: string } => Boolean(g));
  const names = profiles.map((p) => p.name);

  if (!unlocked) {
    return (
      <div className="parchment center stack">
        <div className="eyebrow">Grown-ups' corner</div>
        <h1>🗝️ This door is locked</h1>
        <p className="muted">Enter the family PIN to change settings.</p>
        <div>
          <button className="btn" onClick={() => act(async () => (await api.askPin()) || Promise.reject(new Error("Still locked.")))}>
            Enter the PIN
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ ["--gap" as string]: "26px" }}>
      <div className="center">
        <div className="eyebrow">{familyName}</div>
        <h1>Grown-ups' corner</h1>
      </div>
      {msg && <p className="notice center">{msg}</p>}
      {error && <p className="notice notice-error center">{error}</p>}

      {glance.length > 0 && (
        <p className="glance" aria-label="At a glance">
          {glance.map((g, i) => (
            <span key={g.text}>
              {i > 0 && <span aria-hidden="true"> · </span>}
              <button type="button" className={`glance-item ${g.ok ? "" : "glance-warn"}`} onClick={() => openFold(g.id)}>
                {g.ok ? "✓" : "⚠︎"} {g.text}
              </button>
            </span>
          ))}
        </p>
      )}

      <Fold
        id="engines"
        title="The engines"
        note={enginesOk ? "Connected" : status.demoMode ? "Demo mode" : "Not connected"}
        about="What writes and reads your stories."

      >
        <div className="status-list">
          <div className="status-item">
            <span className={`status-dot ${status.storyteller ? "on" : status.demoMode ? "demo" : "off"}`} />
            <div>
              <b>The storyteller</b>: {status.storyteller ? `connected (${status.storyModel})` : status.demoMode ? "demo stand-in" : "not connected"}
              <div className="small muted">
                Claude reads your photos and writes each story. Set <code>ANTHROPIC_API_KEY</code>.
              </div>
            </div>
          </div>
          <div className="status-item">
            <span className={`status-dot ${status.illustrator ? "on" : "demo"}`} />
            <div>
              <b>The illustrator</b>: {status.illustrator ? `connected (${status.pictureModel})` : "stand-in pictures, for free"}
              <div className="small muted">
                Google&apos;s picture model draws picture books, about {formatMoney(status.picturePrice)} a picture, each purchase approved by a
                grown-up first. Set <code>GEMINI_API_KEY</code>.
              </div>
            </div>
          </div>
          <div className="status-item">
            <span className={`status-dot ${status.voices ? "on" : status.demoMode ? "demo" : "off"}`} />
            <div>
              <b>The voices</b>: {status.voices ? `connected (${status.voiceModel})` : status.demoMode ? "demo hum" : "not connected"}
              <div className="small muted">
                ElevenLabs performs every character. Set <code>ELEVENLABS_API_KEY</code>. The Creator plan or higher is
                recommended: a six-minute story uses about 5,000 voice credits.
              </div>
              {(status.voices || status.demoMode) && (
                <div style={{ marginTop: 10 }}>
                  <CreditMeter />
                </div>
              )}
            </div>
          </div>
        </div>
        {(!status.storyteller || !status.voices) && (
          <p className="small muted" style={{ margin: 0 }}>
            Add the keys to <code>.env.local</code> next to the app (see <code>.env.example</code>) and restart it.
          </p>
        )}
      </Fold>

      <Fold
        id="readers"
        title="Readers"
        note={names.length ? (names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ")) : "None yet"}
        about="A card for each child who listens."

      >
        {editing ? (
          <ReaderEditor
            profile={editing === "new" ? undefined : editing}
            onSaved={() => {
              setEditing(null);
              router.refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="stack" style={{ ["--gap" as string]: "10px" }}>
            {profiles.map((p) => (
              <div key={p.id} className="cast-card spread">
                <div className="row">
                  <Avatar profile={p} size={44} />
                  <div>
                    <div className="cast-name">{p.name}</div>
                    {p.age != null && <div className="small muted">Age {p.age}</div>}
                  </div>
                </div>
                <div className="row">
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-quiet btn-sm"
                    onClick={() => confirm(`Remove ${p.name}'s reader card? Their stories stay in the library.`) && act(() => api.del(`/api/profiles/${p.id}`))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <div>
              <button className="btn btn-sm" onClick={() => setEditing("new")}>
                ＋ Add a reader
              </button>
            </div>
          </div>
        )}
      </Fold>

      <Fold id="pin" title="Grown-up PIN" note={pinSet ? "On" : "Off"} about="Keeps making stories, and buying, for grown-ups.">
        <p className="muted" style={{ margin: 0 }}>
          With a PIN, children can listen to anything on the shelves, but making new stories, buying pictures and changing settings
          needs a grown-up. Once it&apos;s entered, this device doesn&apos;t ask again for half an hour, or for 30 days if you tick
          &ldquo;Don&apos;t ask again&rdquo;.
        </p>
        {pinSet && unlockedUntil && unlockedUntil - Date.now() > 24 * 60 * 60 * 1000 && (
          <p className="small" style={{ margin: 0 }}>
            This device won&apos;t ask for the PIN until{" "}
            {new Date(unlockedUntil).toLocaleDateString("en-US", { month: "long", day: "numeric" })}. Before handing it to a child, tap{" "}
            <b>🔒 Lock now</b> to make it ask every time again.
          </p>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.put("/api/pin", { pin }), "PIN saved.").then(() => setPin(""));
          }}
        >
          <input
            className="input"
            inputMode="numeric"
            pattern="\d{4,8}"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            placeholder={pinSet ? "New PIN" : "4 to 8 digits"}
            style={{ maxWidth: 180 }}
            aria-label="PIN"
          />
          <button className="btn btn-sm" disabled={pin.length < 4}>
            {pinSet ? "Change PIN" : "Set PIN"}
          </button>
          {pinSet && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(() => api.del("/api/pin"), "Locked. Hand it over!")}>
                🔒 Lock now
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => act(() => api.put("/api/pin", { pin: null }), "PIN removed.")}>
                Remove PIN
              </button>
            </>
          )}
        </form>
      </Fold>

      {spending && (
        <Fold
          id="spending"
          title="Spending"
          note={`${formatMoney(spending.month.pictures + spending.month.storyteller, "Nothing")} this month`}
          about="What pictures and the storyteller have cost."
        >
          <div className="spend-totals">
            <div>
              <b>{formatMoney(spending.month.storyteller, "$0")}</b> storyteller
              <span className="small muted">
                {" "}
                · {spending.month.stories} {spending.month.stories === 1 ? "story" : "stories"} written this month
              </span>
            </div>
            <div>
              <b>{formatMoney(spending.month.pictures, "$0")}</b> pictures
              <span className="small muted">
                {" "}
                · {spending.month.pictureCount} drawn this month
              </span>
            </div>
          </div>
          {spending.recent.length > 0 && (
            <ul className="spend-list">
              {spending.recent.map((item) => (
                <li key={item.id}>
                  <span className="small muted">
                    {mounted ? new Date(item.createdAt).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}
                  </span>
                  <span>{item.what}</span>
                  <span className="spend-amount">
                    {item.standIn ? "free (stand-ins)" : formatMoney(item.spent, "$0")}
                    {item.approved !== null && !item.standIn ? <span className="small muted"> of {formatMoney(item.approved)} approved</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            Pictures are approved by a grown-up and never cost more than the price approved; Google bills them to the account the key belongs
            to. The storyteller&apos;s time is billed by Anthropic. Voices use your ElevenLabs credits, shown under The engines.
          </p>
        </Fold>
      )}

      <Fold
        id="family-voices"
        title="Family voices"
        note={keepsakes.length ? `${keepsakes.length} ${keepsakes.length === 1 ? "recording" : "recordings"}` : "None yet"}
        about="Recordings of the voices you love."

      >
        <FamilyVoices keepsakes={keepsakes} familyVoices={familyVoices} canMakeVoices={status.voices || status.demoMode} driveKey={driveKey} />
      </Fold>

      <Fold
        id="wardrobe"
        title="The voice wardrobe"
        note={designed.length ? `${designed.length} ${designed.length === 1 ? "voice" : "voices"}` : "None yet"}
        about="Extra voices you've made for characters."
      >
        <p className="muted" style={{ margin: 0 }}>
          Voices you conjure (a tiny squeaky mouse, an ancient sleepy dragon) join the cast for every future story. Voices you
          add to your ElevenLabs account from its Voice Library appear here automatically, too.
        </p>
        {designed.length ? (
          <div className="stack" style={{ ["--gap" as string]: "8px" }}>
            {designed.map((v) => (
              <div key={v.voiceId} className="cast-card">
                <div className="cast-name">🪄 {v.name}</div>
                <div className="small muted">{v.description}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="faint small">No conjured voices yet.</p>
        )}
        {status.voices && (
          <div>
            <button className="btn btn-sm" onClick={() => setDesigning(true)}>
              🪄 Conjure a voice
            </button>
          </div>
        )}
      </Fold>

      {turnedDown && (
        <Fold
          id="for-children"
          title="Child safety"
          note={turnedDown.length ? `${turnedDown.length} turned down` : "On"}
          about="What the storyteller won't make, and anything it turned down."
        >
          <p className="muted" style={{ margin: 0 }}>
            Every story idea, the words <i>Read to Me</i> is asked to read, words changed in a story and voices described are checked
            first, and the storyteller keeps the same rules. Hard things children meet (a pet dying, a hospital stay, a bully at school) are
            handled gently, but nothing a children&apos;s book wouldn&apos;t hold is made: sex, drugs or alcohol, self-harm, graphic
            violence, cruelty played for fun, hate or swearing. Anything turned down is listed here, with who asked.
          </p>
          {turnedDown.length > 0 && (
            <ul className="spend-list turned-down">
              {turnedDown.map((t) => (
                <li key={t.id}>
                  <span className="small muted">
                    {mounted ? new Date(t.createdAt).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}
                  </span>
                  <span>
                    <b>{TURNED_DOWN_PLACE[t.place]}</b>
                    {t.reader ? ` · as ${t.reader}` : ""} · {t.kind}
                    <span className="small muted turned-down-asked">“{t.asked}”</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Fold>
      )}

      <Fold id="safe" title="Keeping your stories safe" note={backupNote?.short ?? ""} about="Nightly backups, and a copy to download.">
        {backups && <BackupsPanel initial={backups} />}
        {backup && (
          <div className="stack">
            <h3 className="fold-sub">A copy of your own</h3>
            <p className="muted" style={{ margin: 0 }}>
              One file with every story as an MP3, your family recordings, the book photos, and the words of every story. Open{" "}
              <i>Read me</i> inside to browse and play it all. Keep it somewhere safe, like your computer or a cloud drive: it&apos;s
              yours, whatever happens to the app.
            </p>
            <p className="small" style={{ margin: 0 }}>
              {[
                `${backup.stories} ${backup.stories === 1 ? "story" : "stories"}`,
                `${backup.recordings} family ${backup.recordings === 1 ? "recording" : "recordings"}`,
                `${backup.photos} book ${backup.photos === 1 ? "photo" : "photos"}`,
                backup.bytes < 1024 * 1024 ? "under 1 MB" : `about ${Math.round(backup.bytes / (1024 * 1024))} MB`,
              ].join(" · ")}
            </p>
            <DownloadEverything bytes={backup.bytes} unlockedUntil={unlockedUntil} />
          </div>
        )}
      </Fold>

      {alerts && (
        <Fold id="alerts" title="Problem alerts" note={alerts.configured ? "On" : "Off"} about="An email when something needs you.">
          <AlertsPanel initial={alerts} />
        </Fold>
      )}

      <section className="panel spread">
        <div>
          <b>{familyName}</b>
          <div className="small faint">{email}</div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() =>
            act(async () => {
              await api.post("/api/auth/logout");
              await forgetOffline();
              window.location.href = "/welcome";
            })
          }
        >
          Sign out
        </button>
      </section>

      {designing && (
        <VoiceDesigner
          onClose={() => setDesigning(false)}
          onSaved={() => {
            setDesigning(false);
            setMsg("A new voice joined the wardrobe!");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

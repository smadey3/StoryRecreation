"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi } from "@/components/Grownup";
import { Spinner, WaitLine } from "@/components/Waiting";
import { clock, isVideo, prepareRecording } from "@/lib/client/audio";
import { fetchFromDrive } from "@/lib/client/drive";
import { keepAwake, sendTrouble, sentWords, upload } from "@/lib/client/upload";
import { familyVoiceSeconds } from "@/lib/shared/options";
import type { FamilyVoice, Keepsake, VoiceOption } from "@/lib/shared/types";

// A family's voices, kept: a voicemail from Grandma, a child reading at four,
// a bedtime song. A grown-up's recordings can also become a storytelling voice.

export function FamilyVoices({
  keepsakes,
  familyVoices,
  canMakeVoices,
  driveKey,
}: {
  keepsakes: Keepsake[];
  familyVoices: FamilyVoice[];
  canMakeVoices: boolean;
  /** The Google key for videos from Drive links, when it's set up. */
  driveKey: string | null;
}) {
  const api = useApi();
  const router = useRouter();
  // Adding a recording: for someone new (""), or for one of the people already here.
  const [adding, setAdding] = useState<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const people = [...new Set(keepsakes.map((k) => k.person))];
  const voiceFor = (person: string) => familyVoices.find((v) => v.person === person);
  // Each person's recordings are a folder: open when there's only one person, and when a recording was just added to it.
  const [opened, setOpened] = useState<Set<string>>(() => new Set(people.length === 1 ? people : []));
  const openFolder = (person: string, open: boolean) =>
    setOpened((cur) => {
      if (cur.has(person) === open) return cur;
      const next = new Set(cur);
      if (open) next.add(person);
      else next.delete(person);
      return next;
    });

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
  const saved = (person: string) => {
    setAdding(null);
    openFolder(person, true);
    setMsg(`Saved to ${person}'s recordings.`);
    router.refresh();
  };

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Keep the voices you love, just as they are: a voicemail from Grandma, your children reading at four, a song at bedtime.
        A grown-up&apos;s recordings can also become a storytelling voice, so they can read any book, poem or letter aloud.
        Recordings stay private to your family.
      </p>
      {adding === null && (
        <div>
          <button className="btn btn-sm" onClick={() => setAdding("")}>
            ＋ Add a recording or video
          </button>
        </div>
      )}

      {adding === "" && <KeepsakeAdder people={people} driveKey={driveKey} onClose={() => setAdding(null)} onSaved={saved} />}
      {msg && <p className="notice small">{msg}</p>}
      {error && <p className="notice notice-error small">{error}</p>}

      {people.length === 0 && adding === null && <p className="faint small">No recordings yet.</p>}

      {people.map((person) => {
        const mine = keepsakes.filter((k) => k.person === person);
        const voice = voiceFor(person);
        const total = mine.reduce((n, k) => n + k.durationMs, 0);
        return (
          <details key={person} className="voice-folder" open={opened.has(person)} onToggle={(e) => openFolder(person, e.currentTarget.open)}>
            <summary>
              <span className="voice-folder-face" aria-hidden="true">
                {voice ? "💛" : "🎙️"}
              </span>
              <span className="voice-folder-name">{person}</span>
              <span className="voice-folder-note">
                {mine.length} {mine.length === 1 ? "recording" : "recordings"} · {clock(total)}
                {voice ? ` · reads stories as “${voice.name}”` : ""}
              </span>
            </summary>
            <div className="voice-folder-body stack" style={{ ["--gap" as string]: "12px" }}>
              {voice ? (
                <div className="stack" style={{ ["--gap" as string]: "8px" }}>
                  <span className="keepsake-voice">💛 Reads stories as “{voice.name}”</span>
                  <div className="row" style={{ gap: 8 }}>
                    <Link href={`/read?reader=${encodeURIComponent(voice.voiceId)}`} className="btn btn-ghost btn-sm">
                      📖 Pick something to read
                    </Link>
                    <Link href={`/create?narrator=${encodeURIComponent(voice.voiceId)}`} className="btn btn-ghost btn-sm">
                      ✨ A new story, read by them
                    </Link>
                  </div>
                  <div>
                    <button
                      className="btn btn-quiet btn-sm"
                      onClick={() =>
                        act(() => api.del(`/api/family-voices/${encodeURIComponent(voice.voiceId)}`), `${voice.name} won't read stories any more. The recordings are still here.`)
                      }
                    >
                      Stop using {voice.name}&apos;s storytelling voice
                    </button>
                  </div>
                </div>
              ) : (
                making !== person && (
                  <div>
                    <button className="btn btn-ghost btn-sm" onClick={() => setMaking(person)}>
                      📖 Let {person} read stories
                    </button>
                  </div>
                )
              )}
              {making === person && (
                <VoiceMaker
                  person={person}
                  keepsakes={mine}
                  enabled={canMakeVoices}
                  onClose={() => setMaking(null)}
                  onMade={({ name }) => {
                    setMaking(null);
                    setMsg(`${name} can read to you now: find them first in Read to Me, or pick them as the storyteller when you make a story.`);
                    router.refresh();
                  }}
                />
              )}
              <ul className="keepsake-list">
                {mine.map((k) => (
                  <KeepsakeRow key={k.id} keepsake={k} onRemove={() => act(() => api.del(`/api/keepsakes/${k.id}`), "Recording removed.")} />
                ))}
              </ul>
              {adding === person ? (
                <KeepsakeAdder people={people} person={person} driveKey={driveKey} onClose={() => setAdding(null)} onSaved={saved} />
              ) : (
                <div>
                  <button className="btn btn-quiet btn-sm" onClick={() => setAdding(person)}>
                    ＋ Add another of {person}
                  </button>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

type FamilyRecordings = { keepsakes: Keepsake[]; familyVoices: FamilyVoice[]; canMakeVoices: boolean; driveKey: string | null };

/** A family voice as the storyteller lists know it. */
const asStoryteller = (v: { voiceId: string; name: string; person: string; previewUrl: string | null }): VoiceOption => ({
  voiceId: v.voiceId,
  name: v.name,
  description: `${v.person}, in their own voice`,
  gender: null,
  age: null,
  accent: null,
  previewUrl: v.previewUrl,
  persona: null,
  source: "family",
});

/**
 * A family voice made right where a storyteller is chosen (making a story, Read to Me), so nothing chosen there is
 * lost: a recording of them added, then their voice learned. The voice made, or one the family already has, is chosen.
 */
export function FamilyVoiceWindow({ onClose, onChosen }: { onClose: () => void; onChosen: (voice: VoiceOption) => void }) {
  const api = useApi();
  const [have, setHave] = useState<FamilyRecordings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What's open: a recording being added (for someone new, "", or someone here), or a person's voice being learned.
  const [adding, setAdding] = useState<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);

  const load = async () => {
    try {
      const got = await api.get<FamilyRecordings>("/api/keepsakes");
      setHave(got);
      return got;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your family's recordings couldn't be gathered.");
      return null;
    }
  };
  // With no recordings yet, the first thing to do is add one.
  useEffect(() => {
    void load().then((got) => got && !got.keepsakes.length && setAdding(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const people = [...new Set((have?.keepsakes ?? []).map((k) => k.person))];
  const voiceFor = (person: string) => have?.familyVoices.find((v) => v.person === person);
  const step = making !== null ? " · step 2 of 2" : adding !== null ? " · step 1 of 2" : "";

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="fvw-title">
      <div className="modal parchment stack" style={{ width: "min(620px, 100%)" }}>
        <div className="spread">
          <div>
            <div className="eyebrow">A family voice{step}</div>
            <h2 id="fvw-title" style={{ margin: 0 }}>
              💛 Someone you love
            </h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" style={{ color: "#3a2616", background: "rgba(255,255,255,.4)" }}>
            ✕
          </button>
        </div>
        {making === null && (
          <p className="muted" style={{ margin: 0 }}>
            Two steps: a recording of them (a voicemail, a video, or a minute or two of them reading aloud), then the storytellers
            learn their voice, so they can read any story to you. Recordings stay private to your family.
          </p>
        )}
        {error && <p className="notice notice-error small">{error}</p>}
        {!have ? (
          !error && (
            <div className="wait-line" role="status">
              <Spinner />
              <div>Gathering your family&apos;s recordings…</div>
            </div>
          )
        ) : making !== null ? (
          <VoiceMaker
            key={making}
            person={making}
            keepsakes={have.keepsakes.filter((k) => k.person === making)}
            enabled={have.canMakeVoices}
            onClose={() => setMaking(null)}
            onMade={async (v) => {
              const made = (await load())?.familyVoices.find((f) => f.voiceId === v.voiceId);
              onChosen(asStoryteller(made ?? { ...v, person: making, previewUrl: null }));
            }}
          />
        ) : adding !== null ? (
          <KeepsakeAdder
            key={adding}
            people={people}
            person={adding}
            driveKey={have.driveKey}
            onClose={() => (people.length ? setAdding(null) : onClose())}
            onSaved={async (person) => {
              await load();
              setAdding(null);
              setMaking(person);
            }}
          />
        ) : (
          <div className="stack" style={{ ["--gap" as string]: "8px" }}>
            {people.map((person) => {
              const mine = have.keepsakes.filter((k) => k.person === person);
              const voice = voiceFor(person);
              return (
                <div key={person} className="family-voice-person">
                  <span className="voice-folder-face" aria-hidden="true">
                    {voice ? "💛" : "🎙️"}
                  </span>
                  <span className="voice-folder-name">{person}</span>
                  <span className="voice-folder-note">
                    {voice
                      ? `Reads stories as “${voice.name}”`
                      : `${mine.length} ${mine.length === 1 ? "recording" : "recordings"} · ${clock(mine.reduce((n, k) => n + k.durationMs, 0))}`}
                  </span>
                  <span className="family-voice-do">
                    {voice ? (
                      <button className="btn btn-sm" onClick={() => onChosen(asStoryteller(voice))}>
                        Choose {voice.name}
                      </button>
                    ) : (
                      <>
                        <button className="btn btn-sm" onClick={() => setMaking(person)}>
                          📖 Let {person} read stories
                        </button>
                        <button className="btn btn-quiet btn-sm" onClick={() => setAdding(person)}>
                          ＋ Another recording
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
            <div>
              <button className="btn btn-ghost btn-sm" onClick={() => setAdding("")}>
                ＋ Someone new: add a recording or video
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One recording: a play button (one plays at a time) and, once it's playing, how far along it is, to move about in. */
function KeepsakeRow({ keepsake: k, onRemove }: { keepsake: Keepsake; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      document.querySelectorAll<HTMLAudioElement>("audio.keepsake-audio").forEach((other) => other !== a && other.pause());
      void a.play().catch(() => undefined);
    } else a.pause();
  };
  return (
    <li className="keepsake">
      <button type="button" className="keepsake-play" onClick={toggle} aria-label={playing ? `Pause ${k.title}` : `Play ${k.title}`}>
        {playing ? "❚❚" : "▶"}
      </button>
      <audio
        ref={audio}
        className="keepsake-audio"
        preload="none"
        src={k.audioUrl}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setAt(null)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
      <div className="keepsake-meta">
        <b>{k.title}</b>
        {at === null ? (
          <span className="small faint">{[k.recordedOn, clock(k.durationMs)].filter(Boolean).join(" · ")}</span>
        ) : (
          <span className="keepsake-seek small faint">
            {clock(at * 1000)}
            <input
              type="range"
              min={0}
              max={k.durationMs / 1000}
              step={0.1}
              value={Math.min(at, k.durationMs / 1000)}
              onChange={(e) => {
                if (audio.current) audio.current.currentTime = Number(e.target.value);
              }}
              aria-label={`Where in ${k.title}`}
            />
            {clock(k.durationMs)}
          </span>
        )}
      </div>
      {confirming ? (
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm btn-velvet" onClick={onRemove}>
            Remove for good
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </span>
      ) : (
        <button className="btn btn-quiet btn-sm" aria-label={`Remove ${k.title}`} onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
    </li>
  );
}

/**
 * Read aloud for a storytelling voice: about two minutes at a bedtime pace, with every sound of English in it, and
 * questions, a surprise, a chuckle and a whisper, so the voice learns how this person really reads. Written for
 * Storyhollow.
 */
const SCRIPT = {
  title: "The Lantern in the Hollow",
  paragraphs: [
    "Once upon a time, at the edge of a sleepy village, there stood a very old oak tree with a little round door. Behind that door lived a family of storytellers. Every evening, just as the sky turned from gold to plum, they lit a lantern and began to read.",
    "The youngest was a cheerful hedgehog named Juniper, who wore a woolly scarf and tiny brass spectacles. She measured the stars with a wooden ruler, kept a treasure box of shiny pebbles, and whistled whenever she was thinking. “Why does the moon follow us home?” she asked one night. “Does it want a story too?”",
    "“Perhaps it does,” chuckled old Grandfather Badger, sinking into his big velvet chair. “Shall we find out?” He opened a heavy book, and a puff of dust floated up like a tiny cloud. “Oh, look!” gasped Juniper. “The pages are glowing!” And they were. Soft yellow light spilled across the floor, and somewhere far away, a fox began to hum.",
    "Together they read about a boy who sailed the zigzag sea in a paper boat, about three silly geese who forgot how to fly, and about a brave little owl who was afraid of the dark, until she discovered that the dark was only the night, keeping everyone cozy.",
    "When the very last page was turned, Juniper gave the biggest yawn in the world. “Thank you,” she whispered. “That was the best story ever.” Grandfather Badger smiled, blew out the lantern, and the moon, quite satisfied, drifted off to bed as well. Good night, little one. Sleep tight, and sweet dreams.",
  ],
};

function KeepsakeAdder({
  people,
  person: forPerson = "",
  driveKey,
  onClose,
  onSaved,
}: {
  people: string[];
  /** Adding to someone's recordings: their name is already filled in. */
  person?: string;
  /** The Google key for videos from Drive links, when it's set up. */
  driveKey: string | null;
  onClose: () => void;
  onSaved: (person: string) => void;
}) {
  const api = useApi();
  const [mode, setMode] = useState<"upload" | "record">("upload");
  const [person, setPerson] = useState(forPerson);
  const [title, setTitle] = useState("");
  const [recordedOn, setRecordedOn] = useState("");
  const [ready, setReady] = useState<{ file: File; durationMs: number; url: string } | null>(null);
  // Whether what's ready was recorded here (to record again) or chosen from the phone.
  const [recorded, setRecorded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ started: number; recorder: MediaRecorder } | null>(null);
  const [now, setNow] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  // A video shared from Google Drive: the link being pasted, once the family asks for the box to paste it in.
  const [link, setLink] = useState<string | null>(null);
  // The screen stays on while recording, so reading the script doesn't let the phone lock and stop it.
  const awake = useRef<(() => void) | null>(null);
  // What it was made ready from (kept on the phone, to cut just part of it), and the part to keep, if not all of it.
  const source = useRef<{ blob: Blob; name: string } | null>(null);
  const [part, setPart] = useState<{ from: number; to: number } | null>(null);
  const preview = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => () => recording?.recorder.stream.getTracks().forEach((t) => t.stop()), [recording]);
  useEffect(() => () => awake.current?.(), []);

  const prepare = async (blob: Blob, name: string) => {
    setError(null);
    // From a video, only the sound is taken, here on the phone: the video itself is never sent or kept.
    const what = isVideo(blob) ? "Taking the sound from the video" : "Getting the recording ready";
    setBusy(`${what}…`);
    try {
      const out = await prepareRecording(blob, name, (f) => setBusy(`${what} (${Math.round(f * 100)}%)…`));
      source.current = { blob, name };
      setPart(null);
      setReady((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { ...out, url: URL.createObjectURL(out.file) };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That recording couldn't be opened.");
    } finally {
      setBusy(null);
    }
  };

  const startRecording = async () => {
    setError(null);
    try {
      // Untouched by the processing meant for calls (noise suppression smears a voice, gain control makes it pump):
      // a storytelling voice should learn from them as they sound in the room.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, { audioBitsPerSecond: 192_000 });
      } catch {
        recorder = new MediaRecorder(stream);
      }
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      awake.current = await keepAwake();
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        awake.current?.();
        awake.current = null;
        setRecorded(true);
        void prepare(new Blob(chunks, { type: recorder.mimeType }), title || person || "recording");
      };
      recorder.start(1000);
      setReady(null);
      setNow(Date.now());
      setRecording({ started: Date.now(), recorder });
    } catch {
      setError("The microphone isn't available. Allow microphone access for this site, or upload a recording instead.");
    }
  };
  const fromDrive = async () => {
    if (!driveKey || !link?.trim()) return;
    setError(null);
    setMode("upload");
    setBusy("Fetching it from Google Drive…");
    const release = await keepAwake();
    try {
      const file = await fetchFromDrive(link, driveKey, (f) => setBusy(`Fetching it from Google Drive (${Math.round(f * 100)}%)…`));
      setRecorded(false);
      setLink(null);
      await prepare(file, file.name.replace(/\.\w+$/, ""));
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : "That link couldn't be opened.");
    } finally {
      release();
    }
  };

  // While recording: how long so far, and whether that's enough yet.
  const elapsed = recording ? now - recording.started : 0;
  const pace =
    elapsed < 60_000
      ? "Keep going: a minute or two is just right."
      : elapsed < 180_000
        ? "That's plenty. Stop at the end of a paragraph."
        : "More than enough. Stop whenever you're ready.";

  const stopRecording = () => {
    recording?.recorder.stop();
    setRecording(null);
  };

  // Just part of it: from where to where, and a listen to that part alone.
  const trimmed = Boolean(ready && part && (part.from > 0 || part.to < ready.durationMs));
  const hearPart = () => {
    const a = preview.current;
    if (!a || !part) return;
    a.currentTime = part.from / 1000;
    stopAt.current = part.to / 1000;
    void a.play().catch(() => undefined);
  };

  const save = async () => {
    if (!ready || !person.trim()) return;
    setError(null);
    // A long recording can take a while to send on a weak signal: the screen stays on until it's in.
    const release = await keepAwake();
    try {
      let { file, durationMs } = ready;
      if (trimmed && part && source.current) {
        setBusy("Keeping just that part…");
        ({ file, durationMs } = await prepareRecording(source.current.blob, source.current.name, (f) => setBusy(`Keeping just that part (${Math.round(f * 100)}%)…`), {
          fromMs: part.from,
          toMs: part.to,
        }));
      }
      setBusy("Saving the recording…");
      const form = new FormData();
      form.set("audio", file);
      form.set("person", person.trim());
      form.set("title", title.trim() || (mode === "record" ? "Recorded here" : "A recording"));
      form.set("recordedOn", recordedOn.trim());
      form.set("durationMs", String(durationMs));
      await upload(api, "/api/keepsakes", form, (n, of) => setBusy(`${sentWords("Saving the recording", n, of)}…`));
      URL.revokeObjectURL(ready.url);
      onSaved(person.trim());
    } catch (err) {
      setError(sendTrouble(err, "That recording couldn't be saved."));
      setBusy(null);
    } finally {
      release();
    }
  };

  return (
    <div className="keepsake-box stack">
      <label className="field">
        <span>Whose voice is it?</span>
        <input className="input" list="keepsake-people" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Grandma June" maxLength={40} />
        <datalist id="keepsake-people">
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </label>
      <div className="row keepsake-fields">
        <label className="field" style={{ flex: "2 1 220px" }}>
          <span>What is it?</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Birthday voicemail" maxLength={80} />
        </label>
        <label className="field" style={{ flex: "1 1 140px" }}>
          <span>When (optional)</span>
          <input className="input" value={recordedOn} onChange={(e) => setRecordedOn(e.target.value)} placeholder="Spring 2021" maxLength={40} />
        </label>
      </div>

      {/* Two ways to add one, each doing its thing at the first tap: choose a file, or open the recorder. */}
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn btn-sm"
          onClick={() => {
            setMode("upload");
            fileRef.current?.click();
          }}
          disabled={!!busy || !!recording}
        >
          📁 Choose a recording or video
        </button>
        {mode !== "record" && (
          <button className="btn btn-ghost btn-sm" onClick={() => setMode("record")} disabled={!!busy}>
            🎙️ Record now
          </button>
        )}
        {driveKey && link === null && mode !== "record" && (
          <button type="button" className="link-button" onClick={() => setLink("")} disabled={!!busy}>
            🔗 Or paste a Google Drive link
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.caf,.mp4,.mov"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setRecorded(false);
            void prepare(f, f.name.replace(/\.\w+$/, ""));
          }}
        />
      </div>

      {link !== null && (
        <form
          className="drive-link"
          onSubmit={(e) => {
            e.preventDefault();
            void fromDrive();
          }}
        >
          <input
            className="input"
            type="url"
            inputMode="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://drive.google.com/file/d/…"
            aria-label="A Google Drive link"
            autoFocus
          />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" type="submit" disabled={!!busy || !link.trim()}>
              Get the sound
            </button>
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => setLink(null)} disabled={!!busy}>
              Never mind
            </button>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            In Google Drive, open the video, tap <i>Share</i>, set <i>General access</i> to “Anyone with the link”, then <i>Copy link</i>.
            It comes straight from Google to your phone, and only the sound is kept. You can make it private again afterwards.
          </p>
        </form>
      )}

      {mode === "upload" ? (
        <div className="stack" style={{ ["--gap" as string]: "8px" }}>
          <p className="hint" style={{ margin: 0 }}>
            <b>🎬 A video:</b> pick it from your photos. Only the sound is kept, taken out right here on your phone: the video
            itself is never sent or stored. Long ones are welcome, up to 20 minutes.
          </p>
          <p className="hint" style={{ margin: 0 }}>
            <b>📞 A voicemail on an iPhone:</b> open it in the Phone app, tap the share button, and choose <i>Save to Files</i>,
            then pick it here. On Android, share or save the message as an audio file. Voice memos work too.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ ["--gap" as string]: "10px" }}>
          {/* For a storytelling voice: a script with every sound of a voice in it, and how to record it well. */}
          <details className="script" open>
            <summary>📜 Making a storytelling voice? Read this aloud</summary>
            <ul className="script-tips small">
              <li>
                <b>A quiet room</b>, with soft things around (a bedroom is better than a kitchen), and no TV or music.
              </li>
              <li>
                <b>The phone a hand&apos;s width away</b>, a little below your mouth, and kept there. The screen stays on while you record.
              </li>
              <li>
                <b>Read it as you would at bedtime</b>: warm and unhurried, in your own voice. A little expression is good; save the
                character voices for the stories.
              </li>
              <li>
                <b>Stumbled?</b> Pause, and say that sentence again. There&apos;s no need to start over.
              </li>
              <li>
                <b>A minute or two is just right.</b> Stop at the end of any paragraph once you&apos;re past a minute.
              </li>
            </ul>
            <div className="script-text">
              <p className="script-title">{SCRIPT.title}</p>
              {SCRIPT.paragraphs.map((p) => (
                <p key={p.slice(0, 24)}>{p}</p>
              ))}
            </div>
          </details>
          <div className="record-bar">
            {recording ? (
              <>
                <button className="btn btn-sm btn-velvet" onClick={stopRecording}>
                  ■ Stop · {clock(elapsed)}
                </button>
                <span className="rec-dot" aria-label="Recording" />
                <span className="small record-pace">{pace}</span>
              </>
            ) : (
              <button className="btn btn-sm" onClick={startRecording} disabled={!!busy}>
                ● {ready && recorded ? "Record again" : "Start recording"}
              </button>
            )}
          </div>
        </div>
      )}

      {busy && (
        <div className="wait-line" role="status" aria-live="polite">
          <Spinner />
          <div>
            <b>{busy}</b>
          </div>
        </div>
      )}
      {ready && !busy && (
        <div className="stack" style={{ ["--gap" as string]: "6px" }}>
          <span className="small muted">
            Ready to keep · {trimmed && part ? `${clock(part.to - part.from)} of ${clock(ready.durationMs)}` : clock(ready.durationMs)}
          </span>
          <audio
            ref={preview}
            controls
            src={ready.url}
            onTimeUpdate={(e) => {
              if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
                stopAt.current = null;
                e.currentTarget.pause();
              }
            }}
          />
          {part ? (
            <PartPicker
              heading="Keep just part of it"
              note="Cut away the start or the end, to keep just the part that matters. There's no need to cut it for a storytelling voice: the part a voice learns from is chosen when it's made."
              durationMs={ready.durationMs}
              part={part}
              minMs={1000}
              allLabel="Keep it all"
              onChange={setPart}
              onHear={hearPart}
              onAll={() => setPart(null)}
            />
          ) : (
            ready.durationMs > 3000 && (
              <div>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setPart({ from: 0, to: ready.durationMs })}>
                  ✂️ Keep just part of it
                </button>
              </div>
            )
          )}
        </div>
      )}
      {error && <p className="notice notice-error small">{error}</p>}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={!!recording}>
          Cancel
        </button>
        <button className="btn btn-sm" onClick={save} disabled={!ready || !person.trim() || !!busy || !!recording}>
          Keep this recording
        </button>
      </div>
    </div>
  );
}

/** From where to where in a recording: two sliders, a listen to just that part, and a way back to all of it. */
function PartPicker({
  heading,
  note,
  durationMs,
  part,
  minMs,
  allLabel,
  onChange,
  onHear,
  onAll,
}: {
  heading: string;
  note: string;
  durationMs: number;
  part: { from: number; to: number };
  /** The shortest the part can be. */
  minMs: number;
  allLabel: string;
  onChange: (part: { from: number; to: number }) => void;
  onHear: () => void;
  onAll: () => void;
}) {
  return (
    <div className="keep-part stack" style={{ ["--gap" as string]: "6px" }}>
      <div className="small">
        <b>{heading}</b>
      </div>
      <div className="small muted">{note}</div>
      <label className="keep-part-row small">
        <span>From {clock(part.from)}</span>
        <input
          type="range"
          min={0}
          max={durationMs}
          step={100}
          value={part.from}
          onChange={(e) => onChange({ ...part, from: Math.max(0, Math.min(Number(e.target.value), part.to - minMs)) })}
        />
      </label>
      <label className="keep-part-row small">
        <span>To {clock(part.to)}</span>
        <input
          type="range"
          min={0}
          max={durationMs}
          step={100}
          value={part.to}
          onChange={(e) => onChange({ ...part, to: Math.min(durationMs, Math.max(Number(e.target.value), part.from + minMs)) })}
        />
      </label>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onHear}>
          ▶ Hear just that part
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onAll}>
          {allLabel}
        </button>
      </div>
    </div>
  );
}

/** What a voice learns from best: a minute to three minutes of clear speech (ElevenLabs' advice). More adds little, and can make it less steady. */
const BEST_MS = 3 * 60 * 1000;
/** ElevenLabs learns nothing from a shorter recording. */
const MIN_EACH_MS = 5000;

function VoiceMaker({
  person,
  keepsakes,
  enabled,
  onClose,
  onMade,
}: {
  person: string;
  keepsakes: Keepsake[];
  enabled: boolean;
  onClose: () => void;
  onMade: (voice: { voiceId: string; name: string }) => void;
}) {
  const api = useApi();
  const [chosen, setChosen] = useState<string[]>(keepsakes.filter((k) => k.durationMs >= MIN_EACH_MS).map((k) => k.id));
  // The part of a recording the voice learns from, when it isn't all of it (the recording itself stays whole).
  const [parts, setParts] = useState<Record<string, { from: number; to: number }>>({});
  const player = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const uid = useId();
  const [name, setName] = useState(person);
  const [adult, setAdult] = useState(false);
  const [consent, setConsent] = useState(false);
  const [cleanNoise, setCleanNoise] = useState(true);
  // When learning the voice began, and about how long it takes.
  const [busy, setBusy] = useState<{ startedAt: number; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lengthOf = (k: Keepsake) => (parts[k.id] ? parts[k.id].to - parts[k.id].from : k.durationMs);
  const totalMs = keepsakes.filter((k) => chosen.includes(k.id)).reduce((n, k) => n + lengthOf(k), 0);
  const tooMuch = totalMs > BEST_MS;
  const quality =
    totalMs < 10_000
      ? "Not quite enough yet: we need at least 10 seconds of their voice."
      : totalMs < 45_000
        ? "That's enough to try, though the voice may sound a little rough. A minute or more will help."
        : totalMs < 60_000
          ? "Nearly there: a minute or more sounds most like them."
          : !tooMuch
            ? "Just right: a minute to three minutes of them speaking clearly is what a voice learns from best."
            : "That's more than it needs. Past about three minutes, more doesn't help, and can make the voice less steady. Keep their clearest few minutes: untick the noisiest recordings, or use just part of a long one.";

  const hear = (k: Keepsake) => {
    const a = player.current;
    const p = parts[k.id];
    if (!a || !p) return;
    stopAt.current = p.to / 1000;
    a.src = `${k.audioUrl}#t=${p.from / 1000}`;
    try {
      a.currentTime = p.from / 1000;
    } catch {
      // An older phone won't move along a recording it hasn't opened yet: the #t= starts it there instead.
    }
    void a.play().catch(() => undefined);
  };

  const make = async () => {
    setBusy({ startedAt: Date.now(), seconds: familyVoiceSeconds(totalMs, cleanNoise) });
    setError(null);
    try {
      const learnFrom = Object.fromEntries(
        Object.entries(parts)
          .filter(([id]) => chosen.includes(id))
          .map(([id, p]) => [id, { fromMs: p.from, toMs: p.to }]),
      );
      const res = await api.post<{ voiceId: string; name: string }>("/api/family-voices", { name, keepsakeIds: chosen, parts: learnFrom, adult, consent, cleanNoise });
      onMade(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That voice couldn't be made.");
      setBusy(null);
    }
  };

  return (
    <div className="keepsake-box stack">
      <b>Teach the storytellers {person}&apos;s voice</b>
      <p className="small muted" style={{ margin: 0 }}>
        From these recordings, {person} can read any book, poem or letter aloud, in their own voice. A voice learns best from a minute
        to three minutes of them speaking clearly on their own, so choose their clearest recordings, or just the best part of a long
        one. Only a grown-up&apos;s voice can become a storyteller; children&apos;s recordings stay as keepsakes, exactly as they are.
      </p>
      <div className="stack" style={{ ["--gap" as string]: "6px" }}>
        {keepsakes.map((k) => {
          const on = chosen.includes(k.id);
          const short = k.durationMs < MIN_EACH_MS;
          const part = on ? parts[k.id] : undefined;
          return (
            <div key={k.id} className="stack" style={{ ["--gap" as string]: "6px" }}>
              {/* The way to use just part of it follows the name, and stays under it when it wraps. */}
              <div className="voice-source small">
                <input
                  type="checkbox"
                  id={`${uid}-${k.id}`}
                  checked={on}
                  disabled={short}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, k.id] : c.filter((x) => x !== k.id)))}
                />
                <span>
                  <label htmlFor={`${uid}-${k.id}`}>
                    {k.title}{" "}
                    <span className="faint">
                      ({part ? `${clock(part.to - part.from)} of ${clock(k.durationMs)}` : clock(k.durationMs)}
                      {short ? ", too short to learn from" : ""})
                    </span>
                  </label>
                  {on && !part && k.durationMs >= 15_000 && (
                    <>
                      {" "}
                      <button type="button" className="link-button" onClick={() => setParts((p) => ({ ...p, [k.id]: { from: 0, to: k.durationMs } }))}>
                        ✂️ Just part
                      </button>
                    </>
                  )}
                </span>
              </div>
              {part && (
                <PartPicker
                  heading={`The part ${person}'s voice learns from`}
                  note={`A stretch where only ${person} is talking, as clearly as can be. The recording itself is kept whole.`}
                  durationMs={k.durationMs}
                  part={part}
                  minMs={MIN_EACH_MS}
                  allLabel="Use all of it"
                  onChange={(next) => setParts((p) => ({ ...p, [k.id]: next }))}
                  onHear={() => hear(k)}
                  onAll={() =>
                    setParts((p) => {
                      const next = { ...p };
                      delete next[k.id];
                      return next;
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
      <audio
        ref={player}
        className="keepsake-audio"
        onTimeUpdate={(e) => {
          if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
            stopAt.current = null;
            e.currentTarget.pause();
          }
        }}
      />
      <p className={tooMuch ? "notice small" : "small"} style={{ margin: 0 }}>
        {clock(totalMs)} of their voice. {quality}
      </p>
      <label className="field">
        <span>Name in the storyteller list</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
        <span>
          <b>This is a grown-up&apos;s voice (18 or older)</b>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          <b>We have the right to use this voice</b>
          <span className="muted small">
            They&apos;ve agreed to it, or, for someone who has passed away, your family is at peace with it.
          </span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={cleanNoise} onChange={(e) => setCleanNoise(e.target.checked)} />
        <span>
          <b>Clean up background noise</b>
          <span className="muted small">Best for voicemails and phone recordings. Turn off for recordings made in a quiet room.</span>
        </span>
      </label>
      {!enabled && <p className="notice small">Making a storytelling voice needs your ElevenLabs key (see “The engines” in the Grown-ups&apos; corner).</p>}
      {error && <p className="notice notice-error small">{error}</p>}
      {busy ? (
        <WaitLine what={`Learning ${name}'s voice`} done={0} total={1} startedAt={busy.startedAt} seconds={busy.seconds} />
      ) : (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Not now
          </button>
          <button className="btn btn-sm" onClick={make} disabled={!enabled || !adult || !consent || totalMs < 10_000 || !name.trim()}>
            Make {name || person}&apos;s storytelling voice
          </button>
        </div>
      )}
    </div>
  );
}

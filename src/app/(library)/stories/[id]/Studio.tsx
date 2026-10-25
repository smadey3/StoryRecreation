"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/components/Grownup";
import { Brewing } from "@/components/Brewing";
import { toTop } from "@/components/Steps";
import { CreditNote } from "@/components/Credits";
import { ChimePicker, SoundsPicker, VoicePicker, VoiceSelect, soundsOf, useVoices, type SoundsChoice } from "@/components/Pickers";
import { VoiceDesigner } from "@/components/VoiceDesigner";
import { imageForPage } from "@/lib/shared/pages";
import { formatDuration, rebindSeconds } from "@/lib/shared/options";
import { WaitLine } from "@/components/Waiting";
import { formatMoney } from "@/lib/shared/art";
import { PagePicture, Pictures } from "./Pictures";
import type { AppStatus, Book, BookPage, ChimeSettings, DrawnBefore, Story, StoryScript, VoiceOption } from "@/lib/shared/types";

/** Whether someone is typing into the page just now. */
function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text");
}

export function Studio({
  initial,
  book,
  photos,
  status,
  pictureSpend,
  drawnBefore,
  planPrice,
  writeCost,
}: {
  initial: Story;
  book: Book;
  photos: BookPage[];
  status: AppStatus;
  /** What this story's pictures have cost so far. */
  pictureSpend: number;
  /** Its characters as drawn for the family's other picture books, to use again. */
  drawnBefore: Record<string, DrawnBefore[]>;
  /** About what planning its pictures would cost. */
  planPrice: number;
  /** About what writing it again would cost. */
  writeCost: number;
}) {
  const api = useApi();
  const router = useRouter();
  const [story, setStory] = useState(initial);
  const [spent, setSpent] = useState(pictureSpend);
  const [before, setBefore] = useState(drawnBefore);
  const [script, setScript] = useState<StoryScript | null>(initial.script);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(initial.status === "draft");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // New sounds being bound into the story: since when, and about how long it takes.
  const [rebinding, setRebinding] = useState<{ startedAt: number; seconds: number } | null>(null);
  const [designing, setDesigning] = useState<{ castId: string } | null>(null);
  const [newNarrator, setNewNarrator] = useState<string | null>(null);
  const [chime, setChime] = useState<ChimeSettings>(initial.settings.chime);
  const [sounds, setSounds] = useState<SoundsChoice>(soundsOf(initial.settings));
  const soundsChanged = sounds !== soundsOf(story.settings) || JSON.stringify(chime) !== JSON.stringify(story.settings.chime);
  const loadedVoices = useVoices();
  const [extraVoices, setExtraVoices] = useState<VoiceOption[]>([]);
  const voices = [...extraVoices, ...(loadedVoices ?? [])];

  const working = story.status === "writing" || story.status === "recording";
  // The illustrator works alongside the voices: its progress is watched the same way.
  const drawing = Boolean(story.art && story.art.status !== "idle");
  const lastStatus = useRef(initial.status);

  const refresh = useCallback(async () => {
    const res = await api.get<{ story: Story; pictureSpend: number; drawnBefore?: Record<string, DrawnBefore[]> }>(`/api/stories/${story.id}`);
    setSpent(res.pictureSpend);
    setBefore(res.drawnBefore ?? {});
    // The storyteller may have put the book's photos in order: reload them.
    if (lastStatus.current === "writing" && res.story.status !== "writing") router.refresh();
    lastStatus.current = res.story.status;
    setStory(res.story);
    if (res.story.status === "draft" || res.story.status === "ready") {
      setScript((cur) => (dirty && cur ? cur : res.story.script));
      if (res.story.status === "draft") setEditing(true);
    }
    return res.story;
  }, [api, story.id, dirty, router]);

  // Starting work (recording, rewriting, a new reader) and finishing it both change what's at the top of the page: go there,
  // unless someone is typing (a character's look while the voices record, say), who stays where they are.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (working !== wasWorking.current && !typing()) toTop();
    wasWorking.current = working;
  }, [working]);

  useEffect(() => {
    if (!working && !drawing) return;
    const t = setInterval(() => void refresh().catch(() => undefined), 1500);
    return () => clearInterval(t);
  }, [working, drawing, refresh]);

  // A change to the pictures (a purchase, a chosen sketch): show it, then keep watching while the illustrator works.
  const onArt = (next: Story) => {
    setStory((cur) => ({ ...cur, art: next.art, settings: next.settings }));
    void refresh().catch(() => undefined);
  };
  const canPicture = story.mode === "create" && story.settings.source === "idea" && Boolean(story.script);
  // A picture book whose pictures aren't all drawn yet: making them is what's next, so they come before listening.
  const picturesToMake = canPicture && Boolean(story.settings.pictures || story.art) && !(story.art?.cover && story.art.pages.every(Boolean));
  // Where the pictures go is settled once, as they first appear, and kept while the page is open: they don't jump away when the last one's drawn.
  // Leading the page, they have the way to listen just below them, so they don't offer it too.
  const [picturesFirst, setPicturesFirst] = useState<boolean | null>(canPicture ? picturesToMake : null);
  if (picturesFirst === null && canPicture) setPicturesFirst(picturesToMake);
  // The same panel all along, while the voices record and once the story is ready: the page around it changes, and the
  // key finds it again in its new place (both views share the outer stack), so a character's look half typed, a sketch
  // being chosen or a purchase half done carries on instead of starting over.
  const pictures = canPicture && (
    <Pictures
      key="pictures"
      story={story}
      status={status}
      spent={spent}
      drawnBefore={before}
      planPrice={planPrice}
      heroes={story.settings.heroes}
      listen={story.status === "ready" && story.audioUrl && !picturesFirst ? `/play/${story.id}` : null}
      onStory={onArt}
    />
  );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!script) return;
    const res = await api.patch<{ story: Story }>(`/api/stories/${story.id}`, { title: script.title, script });
    setStory(res.story);
    setScript(res.story.script);
    setDirty(false);
  };

  const record = () =>
    run(async () => {
      if (dirty) await saveDraft();
      await api.post(`/api/stories/${story.id}/record`);
      setEditing(false);
      await refresh();
    });

  const rewrite = () =>
    run(async () => {
      const cost = writeCost > 0 ? ` (About ${formatMoney(writeCost)} of storyteller time.)` : "";
      const what = story.art ? "This draft and its pictures will be replaced" : "This draft will be replaced";
      if (story.script && !confirm(`Write a completely different story? ${what}.${cost}`)) return;
      await api.post(`/api/stories/${story.id}/rewrite`);
      setDirty(false);
      await refresh();
    });

  // A recording that stumbled is tried again with the same words; only an unwritten story is rewritten.
  const retry = () =>
    run(async () => {
      await api.post(`/api/stories/${story.id}/${story.script ? "record" : "rewrite"}`);
      await refresh();
    });

  const remix = () =>
    run(async () => {
      setRebinding({ startedAt: Date.now(), seconds: rebindSeconds(story.duration) });
      try {
        const res = await api.post<{ story: Story }>(`/api/stories/${story.id}/remix`, {
          chime,
          effects: sounds === "effects",
          ambience: sounds === "soundscape",
        });
        setStory(res.story);
      } finally {
        setRebinding(null);
      }
    });

  // A new storyteller reads the same words: the story is recorded again in their voice.
  const changeNarrator = (voiceId: string) =>
    run(async () => {
      if (!script) return;
      const next = structuredClone(script);
      const narrator = next.cast.find((c) => c.id === "narrator");
      if (!narrator) return;
      narrator.voiceId = voiceId;
      // Read-alouds are described as "Read aloud by …", so that line follows the new reader.
      const v = voices.find((x) => x.voiceId === voiceId);
      if (v && /^Read aloud by .*\.$/.test(next.synopsis)) next.synopsis = `Read aloud by ${v.persona?.name ?? v.name}.`;
      await api.patch(`/api/stories/${story.id}`, { title: next.title, script: next });
      await api.post(`/api/stories/${story.id}/record`);
      setScript(next);
      setDirty(false);
      setNewNarrator(null);
      await refresh();
    });

  const remove = () =>
    run(async () => {
      if (!confirm("Delete this story for good?")) return;
      await api.del(`/api/stories/${story.id}`);
      router.push(`/books/${book.id}`);
      router.refresh();
    });

  const updateScript = (fn: (s: StoryScript) => StoryScript) => {
    setScript((s) => (s ? fn(structuredClone(s)) : s));
    setDirty(true);
  };

  // ------------------------------------------------------------------ views

  if (story.status === "writing") {
    return (
      <Brewing
        title={story.mode === "read" ? "Preparing the reading" : "The storyteller is at work"}
        progress={story.progress}
        note={`${story.settings.review ? "" : `${story.mode === "read" ? "Once the words are ready" : "Once it's written"}, the voices record it, and the time left counts both. `}You can leave this page. The story keeps brewing and will be waiting on the shelf.`}
      />
    );
  }
  if (story.status === "recording") {
    // About how long it takes is shown above the note when it's known (it can be much less than a minute or two).
    const howLong = story.progress?.startedAt && story.progress.seconds ? "" : "This takes a minute or two.";
    return (
      <div className="stack" style={{ ["--gap" as string]: "22px" }}>
        <Brewing
          title={story.audioUrl ? "Updating the story" : "The voices are recording"}
          progress={story.progress}
          note={
            story.audioUrl
              ? `${howLong} You can leave this page; the story will be waiting on the shelf.`.trim()
              : `Each character is stepping up to the microphone. ${howLong}`.trim()
          }
        />
        {pictures}
      </div>
    );
  }

  const chars = script ? script.pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.text.length, 0), 0) : 0;
  const castName = (id: string) => script?.cast.find((c) => c.id === id)?.name ?? id;
  const voiceName = (voiceId: string | undefined) => {
    const v = voices.find((x) => x.voiceId === voiceId);
    return v ? `${v.persona?.emoji ?? (v.source === "family" ? "💛" : v.source === "designed" ? "🪄" : "🗣️")} ${v.persona?.name ?? v.name}` : "A storyteller";
  };
  const narratorVoice = script?.cast.find((c) => c.id === "narrator")?.voiceId;

  return (
    <div className="stack" style={{ ["--gap" as string]: "22px" }}>
      <Link href={`/books/${book.id}`} className="back-link">
        ‹ Back to {book.title}
      </Link>
      <div className="center">
        <div className="eyebrow">
          <Link href={`/books/${book.id}`}>{book.title}</Link>
          {story.mode === "read" ? " · read aloud" : ""}
        </div>
        <h1>{script?.title ?? story.title}</h1>
        {story.synopsis && <p className="muted">{story.synopsis}</p>}
      </div>

      {story.status === "error" && (
        <div className="notice notice-error center">
          <p>{story.error ?? "Something went wrong."}</p>
          <button className="btn" onClick={retry} disabled={busy}>
            Try again
          </button>
        </div>
      )}

      {picturesFirst && pictures}

      {story.status === "ready" && story.audioUrl && (
        <div className="panel center stack">
          <div className="row" style={{ justifyContent: "center" }}>
            <Link href={`/play/${story.id}`} className={picturesToMake ? "btn btn-ghost" : "btn btn-lg"}>
              ▶ {picturesToMake ? "Listen now, before the pictures" : "Listen now"}
            </Link>
          </div>
          {picturesToMake && (
            <p className="small faint" style={{ margin: 0 }}>
              Until a page&apos;s picture is drawn, it shows the cover. Each one joins the story as it&apos;s made, with no need to record it again.
            </p>
          )}
          {story.mode === "create" && (
            <div>
              <Link href={`/create?like=${story.id}`} className="btn btn-ghost btn-sm">
                ✨ Make another like this
              </Link>
            </div>
          )}
          {narratorVoice && loadedVoices && (
            <div className="narrator-row">
              <span>
                Read by <b>{voiceName(narratorVoice)}</b>
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setNewNarrator(narratorVoice)} disabled={busy || !loadedVoices}>
                Change
              </button>
            </div>
          )}
          <p className="faint small">
            {formatDuration(story.duration)} ·{" "}
            <a href={`${story.audioUrl.split("?")[0]}?download=${encodeURIComponent((script?.title ?? "story") + ".mp3")}`}>
              Download the MP3
            </a>{" "}
            for a speaker, the car, or a make-your-own Yoto card.
          </p>
          <div className="parchment stack" style={{ textAlign: "left" }}>
            <SoundsPicker value={sounds} onChange={setSounds} />
            <details>
              <summary style={{ cursor: "pointer" }}>Change the page-turn chime</summary>
              <div style={{ marginTop: 14 }}>
                <ChimePicker value={chime} onChange={setChime} />
              </div>
            </details>
            {soundsChanged && (
              <div className="center stack" style={{ ["--gap" as string]: "8px" }}>
                {rebinding ? (
                  <WaitLine what="Binding the story together with its new sounds" done={0} total={1} startedAt={rebinding.startedAt} seconds={rebinding.seconds} />
                ) : (
                  <button className="btn btn-sm" onClick={remix} disabled={busy}>
                    Save the new sounds
                  </button>
                )}
                <p className="small" style={{ margin: 0, color: "var(--ink-soft)" }}>
                  The voices aren&apos;t re-recorded.
                  {sounds === "effects" && !story.settings.effects ? " New sound effects use a little ElevenLabs credit." : ""}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="notice notice-error">{error}</p>}

      {!picturesFirst && pictures}

      {script && (
        <div className="parchment stack" style={{ ["--gap" as string]: "22px" }}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>{editing ? "Read it over" : "The script"}</h2>
            {!editing && (
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                ✎ Edit & re-record
              </button>
            )}
          </div>

          {editing && (
            <label className="field">
              <span>Title</span>
              <input className="input" value={script.title} onChange={(e) => updateScript((s) => ({ ...s, title: e.target.value }))} />
            </label>
          )}

          <section>
            <h3>The cast</h3>
            <div className="cast-grid">
              {script.cast.map((c, ci) => (
                <div className="cast-card" key={c.id}>
                  <div className="cast-name">{c.name}</div>
                  {c.description && <div className="small muted">{c.description}</div>}
                  {c.voiceBrief && <div className="small tag">“{c.voiceBrief}”</div>}
                  {editing ? (
                    <div style={{ marginTop: 8 }} className="stack" >
                      {voices.length > 0 && (
                        <VoiceSelect
                          voices={voices}
                          value={c.voiceId}
                          onChange={(v) => updateScript((s) => ((s.cast[ci].voiceId = v), s))}
                        />
                      )}
                      {status.voices && (
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDesigning({ castId: c.id })}>
                          🪄 Conjure a new voice
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <span className="small faint">
                        🎙️ {voices.find((v) => v.voiceId === c.voiceId)?.persona?.name ?? voices.find((v) => v.voiceId === c.voiceId)?.name ?? "A storyteller"}
                      </span>
                      {/* A voice that suits them better: chosen, or made in the voice workshop, then the story re-recorded. */}
                      {!working && (
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(true)} aria-label={`Change ${c.name}'s voice`}>
                          ✎ Change
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>The pages</h3>
            {script.pages.map((p, pi) => {
              const img = imageForPage(p.page, photos, story.settings.source, script.pages.length);
              const art = Boolean(story.art?.scenes.length && story.art.pages.length === script.pages.length);
              return (
                <div className="script-page" key={p.page} style={img || art ? undefined : { gridTemplateColumns: "1fr" }}>
                  {art ? (
                    <PagePicture story={story} status={status} page={p.page} onStory={onArt} />
                  ) : (
                    img && (
                      <div className="script-pic">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img} alt={`Page ${p.page}`} loading="lazy" />
                      </div>
                    )
                  )}
                  <div>
                    <div className="eyebrow">
                      Page {p.page}
                      {p.picture ? <span className="faint small"> · {p.picture}</span> : null}
                    </div>
                    {p.lines.length === 0 && <p className="faint small">(No words on this page, just the chime.)</p>}
                    {p.lines.map((l, li) =>
                      editing ? (
                        <div className="line" key={li}>
                          <select
                            className="select speaker"
                            value={l.speaker}
                            onChange={(e) => updateScript((s) => ((s.pages[pi].lines[li].speaker = e.target.value), s))}
                            aria-label="Speaker"
                            style={{ padding: "6px 8px" }}
                          >
                            {script.cast.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start", gap: 6 }}>
                            <textarea
                              className="textarea"
                              value={l.text}
                              rows={Math.max(2, Math.ceil(l.text.length / 40))}
                              onChange={(e) => updateScript((s) => ((s.pages[pi].lines[li].text = e.target.value), s))}
                              aria-label={`Page ${p.page}, line ${li + 1}`}
                            />
                            <button
                              type="button"
                              className="btn-quiet btn btn-sm"
                              aria-label="Remove line"
                              onClick={() => updateScript((s) => (s.pages[pi].lines.splice(li, 1), s))}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="line-read" key={li}>
                          {script.cast.length > 1 && <b>{castName(l.speaker)}:</b>}
                          {l.text.split(/(\[[^\]]+\])/).map((part, k) =>
                            /^\[.*\]$/.test(part) ? (
                              <span className="tag" key={k}>
                                {part.slice(1, -1)}{" "}
                              </span>
                            ) : (
                              <span key={k}>{part}</span>
                            ),
                          )}
                        </p>
                      ),
                    )}
                    {/* A story in another language: the page in English, to check what it says before it's recorded. */}
                    {p.translation && (
                      <p className="page-english" lang="en">
                        <span className="page-english-label">In English</span> {p.translation}
                      </p>
                    )}
                    {editing && (
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => updateScript((s) => (s.pages[pi].lines.push({ speaker: "narrator", text: "" }), s))}
                      >
                        ＋ Add a line
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          {editing && (
            <div className="stack center">
              <p className="faint small">
                Tip: words in [brackets] tell the voices how to say a line, like [whispers] or [giggles].
                {story.audioUrl ? " Only pages you change are re-recorded, so it may well use less." : ""}
              </p>
              <CreditNote needed={chars} />
              <div className="row" style={{ justifyContent: "center" }}>
                {dirty && (
                  <button className="btn btn-ghost" onClick={() => run(saveDraft)} disabled={busy}>
                    Save changes
                  </button>
                )}
                {story.mode === "create" && (
                  <button className="btn btn-ghost" onClick={rewrite} disabled={busy}>
                    🎲 Write a different story
                  </button>
                )}
                <button className="btn btn-lg btn-velvet" onClick={record} disabled={busy || !status.voices && !status.demoMode}>
                  🎙️ {story.status === "ready" ? "Re-record" : "Record the story"}
                </button>
              </div>
              {!status.voices && !status.demoMode && (
                <p className="notice small">Recording needs an ElevenLabs API key. <Link href="/grownups">Set it up</Link>.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Read to the end of the words: what's next is listening (or, for a picture book still to draw, the pictures above). */}
      {story.status === "ready" && story.audioUrl && !editing && !picturesToMake && (
        <p className="center">
          <Link href={`/play/${story.id}`} className="btn btn-lg">
            ▶ Listen now
          </Link>
        </p>
      )}

      {!working && (
        <p className="center">
          <button className="btn btn-quiet btn-sm" onClick={remove} disabled={busy} style={{ color: "var(--danger)" }}>
            Delete this story
          </button>
        </p>
      )}

      {newNarrator !== null && script && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="narrator-title">
          <div className="modal parchment stack" style={{ width: "min(620px, 100%)" }}>
            <div className="spread">
              <div>
                <div className="eyebrow">{script.title}</div>
                <h2 id="narrator-title" style={{ margin: 0 }}>
                  🎙️ Who should read it?
                </h2>
              </div>
              <button className="icon-btn" onClick={() => setNewNarrator(null)} aria-label="Close" style={{ color: "#3a2616", background: "rgba(255,255,255,.4)" }}>
                ✕
              </button>
            </div>
            <VoicePicker voices={voices} value={newNarrator} onChange={(v) => v && setNewNarrator(v)} allowAuto={false} language={script.language} />
            <p className="small" style={{ margin: 0, color: "var(--ink-soft)" }}>
              The words stay just as they are. The story is recorded again in the new voice.
            </p>
            <CreditNote needed={chars} className="small muted" />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" onClick={() => setNewNarrator(null)}>
                Keep {voiceName(narratorVoice)}
              </button>
              <button className="btn btn-velvet" onClick={() => changeNarrator(newNarrator)} disabled={busy || newNarrator === narratorVoice}>
                {busy ? "Starting…" : `🎙️ Re-record with ${voiceName(newNarrator)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {designing && script && (
        <VoiceDesigner
          initialLanguage={script.language}
          initialName={script.cast.find((c) => c.id === designing.castId)?.name}
          initialDescription={(() => {
            const c = script.cast.find((x) => x.id === designing.castId);
            return [c?.voiceBrief, c?.description].filter(Boolean).join(". ");
          })()}
          onClose={() => setDesigning(null)}
          onSaved={(v) => {
            setExtraVoices((cur) => [
              { voiceId: v.voiceId, name: v.name, description: v.description, gender: null, age: null, accent: null, previewUrl: null, persona: null, source: "designed" },
              ...cur,
            ]);
            updateScript((s) => {
              const c = s.cast.find((x) => x.id === designing.castId);
              if (c) c.voiceId = v.voiceId;
              return s;
            });
            setDesigning(null);
          }}
        />
      )}
    </div>
  );
}

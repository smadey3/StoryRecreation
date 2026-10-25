"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi } from "@/components/Grownup";
import { PurchaseDialog, type PurchaseOffer } from "@/components/Purchase";
import { PictureViewer, type ViewerItem } from "@/components/PictureViewer";
import { Spinner, WaitLine, WaitPill, useNow } from "@/components/Waiting";
import { shrinkImage } from "@/lib/client/images";
import { sendTrouble, sentWords, upload } from "@/lib/client/upload";
import { StylePicker, bookEstimate } from "@/components/PictureBook";
import { ART_STYLES, DEFAULT_ART_STYLE, SKETCHES, bookPictures, drawingSeconds, formatMoney, isStandIn, planningSeconds } from "@/lib/shared/art";
import { aboutTime, timeLeft } from "@/lib/shared/options";
import type { AppStatus, ArtCharacter, ArtJob, ArtStyle, DrawnBefore, Story, StoryArt } from "@/lib/shared/types";

// A story's pictures, in the studio: meet the characters as sketches and
// choose the right ones, then draw the book. Everything that costs money
// shows its price first and asks a grown-up (with the PIN, unless it was entered lately). Whatever the
// illustrator is making shows where it will appear, with about how long it takes.

/** A purchase of pictures, for the dialog: the price comes from the app's status, and is free while the pictures are stand-ins. */
function useOffers(story: Story, status: AppStatus, onStory: (s: Story) => void) {
  const api = useApi();
  const [offer, setOffer] = useState<PurchaseOffer | null>(null);
  const offerPictures = (what: string, pictures: number, seconds: number, url: string, body: object) =>
    setOffer({
      what,
      pictures,
      each: status.picturePrice,
      real: status.illustrator,
      seconds,
      buy: async (approval) => onStory((await api.post<{ story: Story }>(url, { ...body, approval })).story),
    });
  const dialog = offer && <PurchaseDialog offer={offer} onDone={() => setOffer(null)} />;
  return { offerPictures, dialog };
}

/** The cover (0) or a page in a drawing job: being drawn now, waiting its turn, or not in it. */
function drawingNow(job: ArtJob | null | undefined, target: number): "drawing" | "waiting" | null {
  if (job?.kind !== "drawing" || !job.targets?.includes(target) || job.finished.includes(target)) return null;
  // One that didn't come the first time waits to be tried once more, after the rest.
  if (job.retrying?.includes(target)) return "waiting";
  // The cover comes first, on its own; then the pages, two at a time, in order.
  const left = job.targets.filter((t) => !job.finished.includes(t) && !job.retrying?.includes(t));
  if (left.includes(0)) return target === 0 ? "drawing" : "waiting";
  return left.indexOf(target) < 2 ? "drawing" : "waiting";
}

/** A character's part in a sketching job: how many of their sketches it makes, and how many are done. */
function sketchingFor(job: ArtJob | null | undefined, id: string): { total: number; done: number } | null {
  if (job?.kind !== "sketching") return null;
  const whose = job.whose ?? (job.characterId ? Array.from({ length: job.total }, () => job.characterId!) : []);
  const mine = whose.flatMap((w, i) => (w === id ? [i] : []));
  return mine.length ? { total: mine.length, done: mine.filter((i) => job.finished.includes(i)).length } : null;
}

/** "Mia, Zef and the Tooth Fairy" */
const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/** What a drawing job makes, in words. */
const drawingWhat = (job: ArtJob, art: StoryArt) => {
  const targets = job.targets ?? [];
  if (targets.length !== 1) return "Drawing the book";
  const t = targets[0];
  const redraw = Boolean(t === 0 ? art.cover : art.pages[t - 1]) && !job.finished.includes(t);
  return `${redraw ? "Redrawing" : "Drawing"} ${t === 0 ? "the cover" : `page ${t}`}`;
};

/** Every picture of the book drawn so far, for the viewer, starting from this one (0 is the cover). */
function bookViewer(art: StoryArt, page: number): { items: ViewerItem[]; start: number } {
  const all = [art.cover, ...art.pages].flatMap((src, i) => (src ? [{ src, caption: i === 0 ? "The cover" : `Page ${i} of ${art.pages.length}`, page: i }] : []));
  return { items: all, start: Math.max(0, all.findIndex((x) => x.page === page)) };
}

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });

/** Whether enough of the element with this id to see is on screen, between the header and the menu at the bottom. */
function useOnScreen(id: string | null, again: unknown): boolean {
  // Assumed on screen until the browser says otherwise, so the note doesn't flash up over the work itself.
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return setOn(false);
    const io = new IntersectionObserver(([e]) => setOn(e.intersectionRect.height >= Math.min(100, e.boundingClientRect.height * 0.6)), {
      rootMargin: "-80px 0px -100px 0px",
      threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
    });
    io.observe(el);
    return () => io.disconnect();
  }, [id, again]);
  return on;
}

type PillNote = { text: string; target: string; done?: boolean; problem?: boolean };

/**
 * A note that stays in view while the illustrator works, wherever the family scrolls, and says when it's done.
 * It steps aside while the work itself is on screen, and tapping it goes there.
 */
function ArtPill({ art }: { art: StoryArt }) {
  const job = art.job ?? null;
  const key = job ? `${job.kind}:${job.startedAt}` : null;
  // The job last seen, to tell when it finishes; then a word that it's done, for a little while.
  const [seen, setSeen] = useState<{ key: string | null; job: ArtJob | null }>({ key, job });
  const [after, setAfter] = useState<PillNote | null>(null);
  if (seen.key !== key) {
    setSeen({ key, job });
    setAfter(seen.job && !job ? finishedNote(seen.job, art) : null);
  }
  useEffect(() => {
    if (!after) return;
    const t = setTimeout(() => setAfter(null), after.problem ? 12_000 : 8_000);
    return () => clearTimeout(t);
  }, [after]);

  const note = job ? workingNote(job, art) : after;
  const onScreen = useOnScreen(note?.target ?? null, key);
  if (!note || onScreen) return null;
  const go = () => {
    scrollTo(note.target);
    if (!job) setAfter(null);
  };
  return <WaitPill text={note.text} done={note.done} problem={note.problem} onClick={go} />;
}

/** What the illustrator is doing, for the note, and where its work shows. */
function workingNote(job: ArtJob, art: StoryArt): PillNote {
  if (job.kind === "planning") return { text: "Planning the pictures…", target: "art-wait" };
  if (job.kind === "sketching") {
    if (!job.characterId) return { text: `Sketching the characters · ${job.finished.length} of ${job.total}`, target: "art-chars" };
    const name = art.characters.find((c) => c.id === job.characterId)?.name ?? "the character";
    return { text: `Sketching ${name} · ${job.finished.length} of ${job.total}`, target: `art-wait-${job.characterId}` };
  }
  if (job.total === 1) return { text: `${drawingWhat(job, art)}…`, target: `art-page-${job.targets?.[0] ?? 0}` };
  return { text: `Drawing the book · ${job.finished.length} of ${job.total}`, target: "art-wait" };
}

/** That the illustrator has finished (or run into trouble), for the note, and where to see it. */
function finishedNote(job: ArtJob, art: StoryArt): PillNote {
  if (art.error) {
    const p = art.problem;
    const target = p?.kind === "drawing" ? "art-book" : p?.kind === "sketching" ? (p.characterId ? `art-char-${p.characterId}` : "art-chars") : "art-panel";
    return { text: "⚠️ Something went wrong with the pictures. Take a look", target, done: true, problem: true };
  }
  if (job.kind === "planning") return { text: "✓ The pictures are planned: meet the characters", target: "art-chars", done: true };
  if (job.kind === "sketching") {
    if (!job.characterId) return { text: "✓ The sketches are ready: choose one for each", target: "art-chars", done: true };
    const name = art.characters.find((c) => c.id === job.characterId)?.name ?? "the character";
    return { text: `✓ The sketches of ${name} are ready`, target: `art-char-${job.characterId}`, done: true };
  }
  const targets = job.targets ?? [];
  if (targets.length === 1) return { text: `✓ ${targets[0] === 0 ? "The cover" : `Page ${targets[0]}`} is ready`, target: `art-page-${targets[0]}`, done: true };
  return { text: "✓ The pictures are ready", target: "art-book", done: true };
}

export function Pictures({
  story,
  status,
  spent,
  drawnBefore,
  planPrice,
  heroes,
  listen,
  onStory,
}: {
  story: Story;
  status: AppStatus;
  /** What this story's pictures have cost so far. */
  spent: number;
  /** Its characters as drawn for the family's other picture books, to use again for free. */
  drawnBefore: Record<string, DrawnBefore[]>;
  /** About what planning the pictures costs (storyteller time). */
  planPrice: number;
  heroes: string[];
  /** Where to hear it with its pictures, once it's recorded: after looking them over, that's what's next. */
  listen: string | null;
  onStory: (s: Story) => void;
}) {
  const api = useApi();
  const art = story.art;
  const [style, setStyle] = useState<ArtStyle>(art?.style ?? story.settings.artStyle ?? DEFAULT_ART_STYLE);
  const [looks, setLooks] = useState<Record<string, string>>({});
  const [skipSketches, setSkipSketches] = useState(false);
  // Who "Sketch everyone" sketches, when the family has changed it (otherwise everyone not sketched yet).
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  // A child's drawing on its way up: shrunk on the phone first, then sent (how far it's got, in words).
  const [adding, setAdding] = useState<{ id: string; words: string } | null>(null);
  // A photo a character's look is written from: sent once, looked at by the storyteller, and not kept.
  const [describing, setDescribing] = useState<{ id: string; what: string; startedAt: number; seconds: number } | null>(null);
  const { offerPictures, dialog } = useOffers(story, status, onStory);
  const each = status.picturePrice;
  const pages = story.script?.pages.length ?? 0;
  const working = Boolean(art && art.status !== "idle");
  const job = art?.job ?? null;
  const planSeconds = planningSeconds(status.storyteller || !status.demoMode, status.pace?.planning);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const plan = (again: boolean) =>
    run(async () => {
      if (again && !confirm("Start the pictures over? The characters and pictures so far will be set aside.")) return;
      onStory((await api.post<{ story: Story }>(`/api/stories/${story.id}/art`, { style })).story);
    });

  // The note that follows the page stays in the same place whatever the panel shows, so it can tell when a job finishes.
  const withPill = (panel: React.ReactNode) => (
    <>
      {art && <ArtPill art={art} />}
      {panel}
    </>
  );

  // ------------------------------------------------------------ not yet a picture book
  if (!art) {
    return withPill(
      <div className="parchment stack pictures" id="art-panel">
        <h2 style={{ margin: 0 }}>📖 Make it a picture book</h2>
        <p className="muted" style={{ margin: 0 }}>
          The illustrator draws a cover and a picture for every page. First you&apos;ll meet the main characters as sketches, and choose how they
          look together.
        </p>
        <StylePicker value={style} onChange={setStyle} />
        {error && <p className="notice notice-error">{error}</p>}
        <div>
          <button className="btn" onClick={() => plan(false)} disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Opening the sketchbook…
              </>
            ) : (
              "✨ Plan the pictures"
            )}
          </button>
        </div>
        <p className="small purchase-terms" style={{ margin: 0 }}>
          Planning takes {aboutTime(planSeconds)} and is storyteller time, about {formatMoney(planPrice)}. Drawing the book comes after, about{" "}
          {formatMoney(bookEstimate(pages, each))}
          {status.illustrator ? "" : " once the illustrator is set up (stand-in pictures are free until then)"}, and asks a grown-up first.
        </p>
      </div>,
    );
  }

  // ------------------------------------------------------------ planning
  if (art.status === "planning" || !art.scenes.length) {
    return withPill(
      <div className="parchment stack pictures" id="art-panel">
        <h2 style={{ margin: 0 }}>📖 The pictures</h2>
        {art.status === "planning" ? (
          <WaitLine
            id="art-wait"
            what="Reading the story and planning the pictures"
            done={0}
            total={1}
            startedAt={job?.startedAt ?? 0}
            seconds={job?.seconds ?? 0}
            note="You can leave this page; the characters will be waiting."
          />
        ) : (
          <>
            {art.error && <p className="notice notice-error">{art.error}</p>}
            <div>
              <button className="btn" onClick={() => plan(false)} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner /> Opening the sketchbook…
                  </>
                ) : (
                  "✨ Plan the pictures again"
                )}
              </button>
            </div>
            <p className="small purchase-terms" style={{ margin: 0 }}>
              Planning takes {aboutTime(planSeconds)} and is storyteller time, about {formatMoney(planPrice)}.
            </p>
          </>
        )}
      </div>,
    );
  }

  const mains = art.characters.filter((c) => c.main);
  const others = art.characters.filter((c) => !c.main);
  const unchosen = mains.filter((c) => c.chosen === null);
  const todo = (art.cover ? 0 : 1) + art.pages.filter((p) => !p).length;
  const drawn = bookPictures(art.pages.length) - todo;
  const standIns = [art.cover, ...art.pages].some((p) => isStandIn(p)) || art.characters.some((c) => c.sketches.some(isStandIn));
  const sketchSeconds = drawingSeconds(SKETCHES, false, status.illustrator, status.pace?.sketching);
  const bookSeconds = drawingSeconds(todo, !art.cover, status.illustrator, status.pace?.drawing);
  const pictureAt = (t: number) => (t === 0 ? art.cover : (art.pages[t - 1] ?? null));
  // The pictures the last drawing job couldn't make.
  const failedHere = art.error && art.problem?.kind === "drawing" ? (art.problem.targets ?? []) : [];
  // A redraw shows on its own picture; anything else being drawn shows here too.
  const redrawing = job?.kind === "drawing" && job.total === 1 && Boolean(pictureAt(job.targets?.[0] ?? 0));
  const drawingBook = job?.kind === "drawing" && !redrawing;

  const saveLook = async (c: ArtCharacter) => {
    const look = looks[c.id];
    if (look === undefined || look === c.look) return;
    onStory((await api.patch<{ story: Story }>(`/api/stories/${story.id}/art`, { looks: { [c.id]: look } })).story);
  };

  const sketch = (c: ArtCharacter) =>
    run(async () => {
      await saveLook(c);
      offerPictures(
        `${c.sketches.length ? "More sketches of" : "Sketches of"} ${c.name} (${SKETCHES} tries)`,
        SKETCHES,
        sketchSeconds,
        `/api/stories/${story.id}/art/sketch`,
        { characterId: c.id },
      );
    });

  // A character drawn for another book can be used again, free: offered until one is chosen for them.
  const before = (c: ArtCharacter) => (c.chosen === null ? (drawnBefore[c.id] ?? []) : []);
  const reuse = (c: ArtCharacter, d: DrawnBefore) =>
    run(async () => onStory((await api.patch<{ story: Story }>(`/api/stories/${story.id}/art`, { reuse: { characterId: c.id, fromStoryId: d.storyId } })).story));

  // Everyone at once: one purchase, then choose a favorite for each (anyone drawn before isn't ticked to begin with).
  const fresh = mains.filter((c) => !c.sketches.length && c.chosen === null && !before(c).length).map((c) => c.id);
  const chosenForAll = picked ?? new Set(fresh);
  const everyone = mains.filter((c) => chosenForAll.has(c.id));
  const togglePick = (id: string) =>
    setPicked(() => {
      const next = new Set(chosenForAll);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sketchEveryone = () =>
    run(async () => {
      for (const c of everyone) await saveLook(c);
      offerPictures(
        `Sketches of ${andList(everyone.map((c) => c.name))} (${SKETCHES} each)`,
        SKETCHES * everyone.length,
        drawingSeconds(SKETCHES * everyone.length, false, status.illustrator, status.pace?.sketching),
        `/api/stories/${story.id}/art/sketch`,
        { characterIds: everyone.map((c) => c.id) },
      );
      setPicked(null);
    });
  // A problem with several characters' sketches is said once, above them; with one, on its card.
  const sketchProblem = art.error && !working && art.problem?.kind === "sketching" ? art.problem : null;
  const problemFor = (id: string) =>
    sketchProblem && (sketchProblem.characterId ? sketchProblem.characterId === id : false) ? art.error : null;

  const choose = (c: ArtCharacter, index: number) =>
    run(async () => onStory((await api.patch<{ story: Story }>(`/api/stories/${story.id}/art`, { choose: { characterId: c.id, index } })).story));

  /** A character's drawing and sketches, big: swipe between them, and choose one from there. */
  const viewSketches = (c: ArtCharacter, start: number) => {
    const items: ViewerItem[] = [
      ...(c.drawing ? [{ src: c.drawing, caption: `Our drawing of ${c.name}` }] : []),
      ...c.sketches.map((src, i) => ({
        src,
        caption: `${c.name}, sketch ${i + 1} of ${c.sketches.length}`,
        action: {
          label: c.chosen === i ? `Chosen for ${c.name}` : `Choose this one for ${c.name}`,
          done: c.chosen === i,
          onClick: () => {
            setViewing(null);
            void choose(c, i);
          },
        },
      })),
    ];
    setViewing({ items, start: (c.drawing ? 1 : 0) + start });
  };

  const addDrawing = (c: ArtCharacter, file: File | undefined) =>
    run(async () => {
      if (!file) return;
      setAdding({ id: c.id, words: "Getting the photo ready…" });
      try {
        const form = new FormData();
        form.set("characterId", c.id);
        form.set("picture", await shrinkImage(file));
        const sent = (n: number, of: number) => setAdding({ id: c.id, words: n < of ? `${sentWords("Sending the drawing", n, of)}…` : "Adding the drawing…" });
        sent(0, 1);
        onStory((await upload<{ story: Story }>(api, `/api/stories/${story.id}/art/drawing`, form, sent)).story);
      } catch (err) {
        throw new Error(sendTrouble(err, "The drawing couldn't be added."));
      } finally {
        setAdding(null);
      }
    });

  const describe = (c: ArtCharacter, file: File | undefined) =>
    run(async () => {
      if (!file) return;
      const step = (what: string, seconds = 0) => setDescribing({ id: c.id, what, startedAt: Date.now(), seconds });
      step("Getting the photo ready");
      try {
        const form = new FormData();
        form.set("characterId", c.id);
        form.set("words", looks[c.id] ?? c.look);
        form.set("photo", await shrinkImage(file));
        step("Sending the photo");
        let sent = false;
        const res = await upload<{ story: Story }>(api, `/api/stories/${story.id}/art/describe`, form, (n, of) => {
          if (n < of) step(sentWords("Sending the photo", n, of));
          else if (!sent) {
            sent = true;
            step(`Looking at the photo of ${c.name}`, status.storyteller ? 12 : 0);
          }
        });
        // The look written from the photo shows in place of anything typed before it.
        setLooks(({ [c.id]: _typed, ...rest }) => rest);
        onStory(res.story);
      } catch (err) {
        throw new Error(sendTrouble(err, "That photo couldn't be described."));
      } finally {
        setDescribing(null);
      }
    });

  const changeStyle = (s: ArtStyle) =>
    run(async () => {
      setStyle(s);
      onStory((await api.patch<{ story: Story }>(`/api/stories/${story.id}/art`, { style: s })).story);
    });

  const drawBook = () =>
    offerPictures(
      drawn === 0 ? `The cover and ${art.pages.length} pages of “${story.title}”` : `The ${todo} ${todo === 1 ? "picture" : "pictures"} still to draw`,
      todo,
      bookSeconds,
      `/api/stories/${story.id}/art/draw`,
      {},
    );

  const isHero = (c: ArtCharacter) => heroes.some((h) => h.toLowerCase() === c.name.toLowerCase());

  return withPill(
    <div className="parchment stack pictures" id="art-panel" style={{ ["--gap" as string]: "20px" }}>
      <div className="spread">
        <h2 style={{ margin: 0 }}>📖 The pictures</h2>
        <span className="small muted">
          {ART_STYLES[art.style].emoji} {ART_STYLES[art.style].label}
        </span>
      </div>
      {error && <p className="notice notice-error">{error}</p>}
      {art.error && !working && (!art.problem || art.problem.kind === "planning") && <p className="notice notice-error">{art.error}</p>}

      <section className="stack" id="art-chars" style={{ ["--gap" as string]: "12px" }}>
        <h3 style={{ margin: 0 }}>Meet the characters</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Sketch each one and choose the right one together. Every page is drawn from the sketch you choose, so they look the same all the way
          through.
        </p>
        {mains.length > 1 && mains.some((c) => c.chosen === null) && !(job?.kind === "sketching") && (
          <div className="sketch-everyone">
            <b>Sketch everyone at once</b>
            <span className="small muted">
              {SKETCHES} sketches of each, in one go. Untick anyone you don&apos;t want drawn, then choose a favorite for each.
            </span>
            <div className="sketch-everyone-list">
              {mains.map((c) => (
                <label key={c.id} className="toggle-line small">
                  <input type="checkbox" checked={chosenForAll.has(c.id)} onChange={() => togglePick(c.id)} disabled={busy || working} />
                  <span>
                    {c.name}
                    {c.sketches.length > 0 ? (
                      <span className="faint"> (sketched already)</span>
                    ) : (
                      before(c).length > 0 && <span className="faint"> (drawn before: use that one, free)</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <div>
              <button className="btn" onClick={sketchEveryone} disabled={busy || working || everyone.length === 0}>
                {everyone.length === 0
                  ? "✏️ Tick who to sketch"
                  : `✏️ Sketch ${everyone.length === 1 ? everyone[0].name : `${everyone.length} characters`} · ${status.illustrator ? formatMoney(each * SKETCHES * everyone.length) : "free"}`}
              </button>
            </div>
            <span className="small muted">Takes {aboutTime(drawingSeconds(SKETCHES * Math.max(1, everyone.length), false, status.illustrator, status.pace?.sketching))}.</span>
          </div>
        )}
        {sketchProblem && !sketchProblem.characterId && <p className="notice notice-error small" style={{ margin: 0 }}>{art.error}</p>}
        {mains.map((c) => {
          const sketching = sketchingFor(job, c.id) && job;
          const mine = sketchingFor(job, c.id);
          const coming = mine ? Math.max(0, mine.total - mine.done) : 0;
          return (
            <div className="cast-card art-character" id={`art-char-${c.id}`} key={c.id}>
              <div className="cast-name">{c.name}</div>
              <label className="field" style={{ marginTop: 6 }}>
                <span className="small">What {c.name} looks like</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={looks[c.id] ?? c.look}
                  onChange={(e) => setLooks((l) => ({ ...l, [c.id]: e.target.value }))}
                  onBlur={() => void saveLook(c).catch((err) => setError(err instanceof Error ? err.message : "That didn't save."))}
                  placeholder={
                    isHero(c) ? `Describe ${c.name} in words: curly brown hair, freckles, a brand-new gap in a big smile…` : `Big, small, what colors, what they wear…`
                  }
                />
              </label>
              {describing?.id === c.id ? (
                <WaitLine what={describing.what} done={0} total={1} startedAt={describing.startedAt} seconds={describing.seconds} />
              ) : (
                <label className={`link-button describe-photo ${busy || working ? "disabled" : ""}`}>
                  📷 Describe {c.name} from a photo
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    disabled={busy || working}
                    onChange={(e) => {
                      describe(c, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
              <p className="small faint" style={{ margin: "4px 0 0" }}>
                Only the words go to the illustrator.{isHero(c) ? " A photo just helps write them:" : " A photo can help write them:"} the storyteller
                looks at it once, and it isn&apos;t kept.
              </p>
              {before(c).length > 0 && (
                <div className="drawn-before">
                  <span className="small">
                    <b>Drawn before.</b> Use the same {c.name} again, free:
                  </span>
                  <div className="drawn-before-list">
                    {before(c).map((d) => (
                      <button key={d.picture} type="button" className="drawn-before-pick" onClick={() => reuse(c, d)} disabled={busy}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={d.picture} alt="" />
                        <span className="small">from &ldquo;{d.title}&rdquo;</span>
                        <span className="small faint">
                          {ART_STYLES[d.style].emoji} {ART_STYLES[d.style].label}
                        </span>
                        <b className="small">Use this one</b>
                      </button>
                    ))}
                  </div>
                  {before(c).some((d) => d.style !== art.style) && (
                    <span className="small faint">
                      A character brings the style they were drawn in to every page they&apos;re on. For pages all in{" "}
                      {ART_STYLES[art.style].emoji} {ART_STYLES[art.style].label}, sketch them fresh.
                    </span>
                  )}
                </div>
              )}
              {(c.sketches.length > 0 || c.drawing || coming > 0) && (
                <div className="sketches" role="group" aria-label={`Sketches of ${c.name}`}>
                  {c.drawing && (
                    <button type="button" className="sketch drawing" aria-label={`Our drawing of ${c.name}: see it big`} onClick={() => viewSketches(c, -1)}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.drawing} alt="" />
                      <span className="sketch-caption">Our drawing</span>
                    </button>
                  )}
                  {c.sketches.map((url, i) => (
                    <button
                      key={url}
                      type="button"
                      className={`sketch ${c.chosen === i ? "chosen" : ""}`}
                      aria-label={`Sketch ${i + 1}${c.chosen === i ? ", chosen" : ""}: see it big`}
                      onClick={() => viewSketches(c, i)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" />
                    </button>
                  ))}
                  {Array.from({ length: coming }, (_, i) => (
                    <div className="sketch working" key={`coming-${i}`} aria-hidden="true">
                      <span>✏️</span>
                    </div>
                  ))}
                </div>
              )}
              {sketching && mine && (
                <WaitLine
                  id={`art-wait-${c.id}`}
                  what={coming ? `Sketching ${c.name}` : `${c.name}'s sketches are in`}
                  done={mine.done}
                  total={mine.total}
                  startedAt={sketching.startedAt}
                  seconds={coming ? sketching.seconds : 0}
                  note={coming ? "You can leave this page; the sketches will be waiting." : "Choose one now if you like, while the others are sketched."}
                />
              )}
              {problemFor(c.id) && (
                <p className="notice notice-error small" style={{ margin: "10px 0 0" }}>
                  {problemFor(c.id)}
                </p>
              )}
              {!sketching && c.sketches.length > 0 && (
                <p className="small" style={{ margin: "6px 0 0" }}>
                  {c.chosen === null ? `Which one is ${c.name}? Tap a sketch to see it big, and choose.` : "Tap a sketch to see it big."}
                </p>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn btn-sm" onClick={() => sketch(c)} disabled={busy || working}>
                  {sketching ? (
                    <>
                      <Spinner /> Sketching…
                    </>
                  ) : (
                    <>
                      ✏️ {c.sketches.length ? "Sketch again" : `Sketch ${c.name}`} · {status.illustrator ? formatMoney(each * SKETCHES) : "free"}
                    </>
                  )}
                </button>
                <label className={`btn btn-ghost btn-sm ${busy || working ? "disabled" : ""}`}>
                  {adding?.id === c.id ? (
                    <>
                      <Spinner /> {adding.words}
                    </>
                  ) : (
                    <>📷 {c.drawing ? "A different drawing" : "Use our own drawing"}</>
                  )}
                  <input type="file" accept="image/*" hidden disabled={busy || working} onChange={(e) => addDrawing(c, e.target.files?.[0])} />
                </label>
              </div>
              {c.drawing && !c.sketches.length && !sketching && (
                <p className="small faint" style={{ margin: "6px 0 0" }}>
                  The sketches will be made from the drawing, keeping its colors, shapes and funny details.
                </p>
              )}
            </div>
          );
        })}
        {others.length > 0 && (
          <details className="art-others">
            <summary className="small">
              Also in the pictures: {others.map((c) => c.name).join(", ")} (drawn from their descriptions)
            </summary>
            <div className="stack" style={{ ["--gap" as string]: "8px", marginTop: 10 }}>
              {others.map((c) => (
                <label className="field" key={c.id}>
                  <span className="small">{c.name}</span>
                  <textarea
                    className="textarea"
                    rows={2}
                    value={looks[c.id] ?? c.look}
                    onChange={(e) => setLooks((l) => ({ ...l, [c.id]: e.target.value }))}
                    onBlur={() => void saveLook(c).catch((err) => setError(err instanceof Error ? err.message : "That didn't save."))}
                  />
                </label>
              ))}
            </div>
          </details>
        )}
      </section>

      <section className="stack" id="art-book" style={{ ["--gap" as string]: "12px" }}>
        <h3 style={{ margin: 0 }}>The book</h3>
        <div className="art-cover-row">
          <PagePicture story={story} status={status} page={0} onStory={onStory} />
          <div className="stack" style={{ ["--gap" as string]: "8px" }}>
            <div className="small">
              {drawn === 0 && !drawingBook ? `A cover and ${art.pages.length} pages to draw.` : `${drawn} of ${bookPictures(art.pages.length)} pictures drawn.`}
            </div>
            {(drawn > 0 || drawingBook || failedHere.length > 0) && (
              <>
                <div className="book-strip" role="list" aria-label="The book's pictures">
                  {[art.cover, ...art.pages].map((url, page) => {
                    const now = drawingNow(job, page);
                    const failed = !now && !working && failedHere.includes(page);
                    const name = page === 0 ? "The cover" : `Page ${page}`;
                    const state = now === "drawing" ? "being drawn" : now === "waiting" ? "waiting its turn" : failed ? "couldn't be drawn" : url ? "see it big" : "to be drawn";
                    return (
                      <button
                        key={page}
                        type="button"
                        role="listitem"
                        className={`book-thumb ${url ? "drawn" : ""} ${now === "drawing" ? "working" : ""} ${failed ? "failed" : ""}`}
                        onClick={() => (url ? setViewing(bookViewer(art, page)) : scrollTo(`art-page-${page}`))}
                        aria-label={`${name}: ${state}`}
                      >
                        <span className="book-thumb-pic">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {url && <img src={url} alt="" loading="lazy" />}
                          {(now || failed) && <span className="book-thumb-mark">{now === "drawing" ? <Spinner /> : now === "waiting" ? "⏳" : "⚠️"}</span>}
                        </span>
                        <span className="book-thumb-label">{page === 0 ? "Cover" : `Page ${page}`}</span>
                      </button>
                    );
                  })}
                </div>
                {drawn > 0 && <p className="small muted" style={{ margin: 0 }}>Tap one to see it big. Each page&apos;s picture is also beside its words, below.</p>}
              </>
            )}
            {drawn === 0 && !drawingBook && (
              <div>
                <span className="small muted">Style: </span>
                {(Object.keys(ART_STYLES) as ArtStyle[]).map((s) => (
                  <button key={s} type="button" className="chip" aria-pressed={art.style === s} onClick={() => changeStyle(s)} disabled={busy || working}>
                    {ART_STYLES[s].emoji} {ART_STYLES[s].label}
                  </button>
                ))}
              </div>
            )}
            {drawingBook && job && (
              <WaitLine
                id="art-wait"
                what={drawingWhat(job, art)}
                done={job.finished.length}
                total={job.total}
                startedAt={job.startedAt}
                seconds={job.seconds}
                note={`${job.total > 1 && job.targets?.includes(0) ? "The cover first, so the pages can match it, then two pages at a time. " : ""}You can leave this page; the pictures will be waiting.`}
              />
            )}
            {art.error && !working && art.problem?.kind === "drawing" && <p className="notice notice-error small" style={{ margin: 0 }}>{art.error}</p>}
            {todo > 0 && (
              <div>
                <button className="btn" onClick={drawBook} disabled={busy || working || (unchosen.length > 0 && !skipSketches)}>
                  {drawingBook ? (
                    <>
                      <Spinner /> Drawing…
                    </>
                  ) : (
                    <>
                      🎨 {drawn === 0 ? "Draw the book" : `Draw the ${todo} still to do`} · {status.illustrator ? formatMoney(each * todo) : "free"}
                    </>
                  )}
                </button>
              </div>
            )}
            {todo > 0 && !drawingBook && (
              <p className="small muted" style={{ margin: 0 }}>
                Takes {aboutTime(bookSeconds)}. Before drawing, look over what each picture will show (beside its words, below) and change
                anything that isn&apos;t right: that&apos;s free.
              </p>
            )}
            {todo > 0 && unchosen.length > 0 && !skipSketches && !drawingBook && (
              <p className="small" style={{ margin: 0 }}>
                First choose a sketch for {unchosen.map((c) => c.name).join(" and ")}, so they look the same on every page.{" "}
                <button type="button" className="link-button" onClick={() => setSkipSketches(true)}>
                  Or draw without sketches
                </button>
              </p>
            )}
            {todo === 0 && <p className="small muted" style={{ margin: 0 }}>Every picture is drawn. To redraw one, tap ↻ beside it.</p>}
            <p className="small purchase-terms" style={{ margin: 0 }}>
              {status.illustrator
                ? `Pictures for this story so far: ${formatMoney(spent, "nothing yet")}.`
                : standIns
                  ? "Stand-in pictures, free, while the illustrator isn't set up."
                  : `Stand-in pictures are free until the illustrator is set up; then about ${formatMoney(each)} a picture.`}
            </p>
          </div>
        </div>
      </section>
      {listen && (
        <div className="center stack pictures-listen" style={{ ["--gap" as string]: "8px" }}>
          <div>
            <Link href={listen} className="btn btn-lg">
              ▶ Listen now
            </Link>
          </div>
          {todo > 0 && !working && (
            <p className="small muted" style={{ margin: 0 }}>
              Pages without their picture yet show the book&apos;s cover instead.
            </p>
          )}
        </div>
      )}
      {viewing && <PictureViewer items={viewing.items} start={viewing.start} onClose={() => setViewing(null)} />}
      {dialog}
    </div>,
  );
}

/** The cover (page 0), or a page beside its words in the studio: its picture (or what it will show), and a redraw. */
export function PagePicture({ story, status, page, onStory }: { story: Story; status: AppStatus; page: number; onStory: (s: Story) => void }) {
  const api = useApi();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  // Before it's drawn, what it will show can be changed in the family's own words: free, unlike a redraw.
  const [changing, setChanging] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ items: ViewerItem[]; start: number } | null>(null);
  const { offerPictures, dialog } = useOffers(story, status, (s) => {
    setAsking(false);
    setNote("");
    onStory(s);
  });
  const art = story.art!;
  const cover = page === 0;
  const url = cover ? art.cover : art.pages[page - 1];
  const scene = cover ? art.coverScene : (art.scenes.find((s) => s.page === page)?.scene ?? "");
  const working = art.status !== "idle";
  const now = drawingNow(art.job, page);
  const job = art.job;
  const single = Boolean(job && job.total === 1);
  const clock = useNow(Boolean(now) && single, job?.startedAt ?? 0);

  const view = () => setViewing(bookViewer(art, page));
  const saveScene = async () => {
    if (changing === null) return;
    setSaving(true);
    setSceneError(null);
    try {
      onStory((await api.patch<{ story: Story }>(`/api/stories/${story.id}/art`, { scene: { page, text: changing } })).story);
      setChanging(null);
    } catch (err) {
      setSceneError(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setSaving(false);
    }
  };
  // The last drawing job couldn't make this one: why, here too (all of it when it's about just this picture).
  const problem = !working && art.error && art.problem?.kind === "drawing" && art.problem.targets?.includes(page) ? art.problem : null;

  return (
    <div className={`script-pic page-picture ${cover ? "art-cover" : ""}`} id={`art-page-${page}`}>
      {url ? (
        <div className={`picture-frame ${now ? "redrawing" : ""}`}>
          <button type="button" className="picture-open" onClick={view} aria-label={`${cover ? "The cover" : `Page ${page}`}: see it big`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={cover ? `The cover of ${story.title}` : `Page ${page}`} loading="lazy" />
          </button>
          {now && (
            <div className="picture-working">
              <Spinner />
              <b>{now === "drawing" ? "Redrawing…" : "Waiting its turn"}</b>
              {now === "drawing" && single && job && <span>{timeLeft(job.startedAt, job.seconds, clock)}</span>}
            </div>
          )}
        </div>
      ) : (
        <div className={`picture-to-be small ${now === "drawing" ? "working" : now === "waiting" ? "queued" : ""} ${changing !== null ? "changing" : ""}`}>
          {now ? (
            <b className="row" style={{ gap: 8 }}>
              {now === "drawing" ? (
                <>
                  <Spinner /> {cover ? "Drawing the cover…" : "Drawing…"}
                </>
              ) : (
                "⏳ Waiting its turn"
              )}
            </b>
          ) : (
            <b>{cover ? "The cover, to be drawn" : "To be drawn"}</b>
          )}
          {changing === null ? (
            <span>{scene}</span>
          ) : (
            <span className="stack scene-change" style={{ ["--gap" as string]: "6px" }}>
              <textarea
                className="textarea"
                rows={4}
                value={changing}
                onChange={(e) => setChanging(e.target.value)}
                aria-label={`What ${cover ? "the cover" : `page ${page}`} will show`}
                autoFocus
              />
              {sceneError && <span className="pin-error">{sceneError}</span>}
              <span className="row">
                <button type="button" className="btn btn-sm" onClick={() => void saveScene()} disabled={saving || !changing.trim()}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setChanging(null)} disabled={saving}>
                  Cancel
                </button>
              </span>
            </span>
          )}
          {!now && !working && changing === null && (
            <button type="button" className="link-button scene-edit" onClick={() => setChanging(scene)}>
              ✏️ Change what it shows (free)
            </button>
          )}
          {now === "drawing" && single && job && <span className="faint">{timeLeft(job.startedAt, job.seconds, clock)}</span>}
        </div>
      )}
      {problem && (
        <p className="small picture-problem">
          ⚠️ {problem.targets?.length === 1 ? art.error : `This picture couldn't be drawn this time. Why, and the button to try again, are under “The book” above.`}
        </p>
      )}
      {(url || problem) && !asking && !now && (
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAsking(true)} disabled={working}>
          {url ? "↻ Redraw" : "✏️ Try it with a note"}
        </button>
      )}
      {asking && (
        <div className="stack" style={{ ["--gap" as string]: "6px", marginTop: 6 }}>
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What should change? (say, “only two beds”)"
            aria-label="What should change"
          />
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                offerPictures(
                  `${url ? "Redraw" : "Draw"} ${cover ? "the cover" : `page ${page}`}`,
                  1,
                  drawingSeconds(1, cover, status.illustrator, status.pace?.drawing),
                  `/api/stories/${story.id}/art/draw`,
                  { pages: [page], note },
                )
              }
              disabled={working}
            >
              {url ? "↻ Redraw" : "🎨 Draw it"} · {status.illustrator ? formatMoney(status.picturePrice) : "free"}
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {viewing && <PictureViewer items={viewing.items} start={viewing.start} onClose={() => setViewing(null)} />}
      {dialog}
    </div>
  );
}

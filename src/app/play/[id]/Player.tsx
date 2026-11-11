"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cover } from "@/components/Books";
import { useApi } from "@/components/Grownup";
import { keepForOffline } from "@/components/Offline";
import { DriftingImage, SceneEffects } from "@/components/LivingPicture";
import { imageForPage } from "@/lib/shared/pages";
import { artForPage } from "@/lib/shared/art";
import { formatClock } from "@/lib/shared/options";
import type { Book, BookPage, Story, TimelinePage, VoiceLabel } from "@/lib/shared/types";
import type { UpNext } from "@/lib/server/db";

// The player follows one continuous audio file (narration, chimes and pauses
// all baked in) using the page timeline, so it works on a lock screen or a
// Bluetooth speaker exactly as it does on screen.

const CUE_SECONDS = 3.2;

function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`storyhollow:${key}`);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // private mode etc.
    }
  }, [key]);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`storyhollow:${key}`, JSON.stringify(v));
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [value, set];
}

/** A phone turned sideways: too short for the picture and the words together. */
function useSideways(): boolean {
  const [sideways, setSideways] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(orientation: landscape) and (max-height: 540px)");
    const update = () => setSideways(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return sideways;
}

/** Words that came back run together across two lines ("me!Floss"), spaced as they're read (but not "U.S.A."). */
const spaced = (word: string) => word.replace(/([.!?…,;:"”)])(?=["“(]?\p{L}\p{L})/gu, "$1 ");

type IconName = "close" | "prev" | "next" | "play" | "pause" | "again" | "bigger" | "smaller" | "back10" | "ahead10";

/** Drawn icons, so the controls look the same on every phone (emoji vary). */
function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  const shapes: Record<IconName, React.ReactNode> = {
    close: <path d="M6 6l12 12M18 6L6 18" {...line} />,
    prev: (
      <>
        <rect x="5" y="5" width="2.6" height="14" rx="1" />
        <path d="M19 5.5v13L9 12z" />
      </>
    ),
    next: (
      <>
        <rect x="16.4" y="5" width="2.6" height="14" rx="1" />
        <path d="M5 5.5v13L15 12z" />
      </>
    ),
    play: <path d="M8 4.8v14.4L20 12z" />,
    pause: (
      <>
        <rect x="6" y="5" width="4" height="14" rx="1.2" />
        <rect x="14" y="5" width="4" height="14" rx="1.2" />
      </>
    ),
    again: (
      <>
        <path d="M5.6 9.2A7 7 0 1 1 5 12" {...line} />
        <path d="M4.6 4.6v4.8h4.8" {...line} />
      </>
    ),
    // A turning arrow around "10": back, or ahead, ten seconds.
    back10: (
      <>
        <path d="M5.2 8.4A8 8 0 1 1 4 12.6" {...line} strokeWidth={2} />
        <path d="M4.4 3.8v4.8h4.8" {...line} strokeWidth={2} />
        <text x="12.6" y="15.6" fontSize="8" fontWeight="700" textAnchor="middle" fontFamily="system-ui, sans-serif">
          10
        </text>
      </>
    ),
    ahead10: (
      <>
        <path d="M18.8 8.4A8 8 0 1 0 20 12.6" {...line} strokeWidth={2} />
        <path d="M19.6 3.8v4.8h-4.8" {...line} strokeWidth={2} />
        <text x="11.4" y="15.6" fontSize="8" fontWeight="700" textAnchor="middle" fontFamily="system-ui, sans-serif">
          10
        </text>
      </>
    ),
    bigger: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" {...line} />,
    smaller: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" {...line} />,
  };
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      {shapes[name]}
    </svg>
  );
}

/** A player option that says plainly whether it's on. */
function Toggle({ on, onClick, icon, label, title }: { on: boolean; onClick: () => void; icon: string; label: string; title?: string }) {
  return (
    <button className="dark-chip toggle-chip" aria-pressed={on} onClick={onClick} title={title}>
      <span aria-hidden="true">{icon}</span> {label}
      <span className="toggle-state" aria-hidden="true">
        {on ? "On" : "Off"}
      </span>
    </button>
  );
}

function pageAt(pages: TimelinePage[], t: number): number {
  let lo = 0;
  let hi = pages.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= t + 0.05) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function Player({
  story,
  book,
  photos,
  narrator,
  next,
  autoplay,
}: {
  story: Story;
  book: Book;
  photos: BookPage[];
  narrator: VoiceLabel | null;
  /** What to hear when this one ends. */
  next: UpNext;
  /** Arrived from "Next" at the end of the last story: carry straight on. */
  autoplay: boolean;
}) {
  const api = useApi();
  const router = useRouter();
  const timeline = story.timeline!;
  const pages = timeline.pages;
  const storyPages = pages.filter((p) => p.page > 0).length;
  const audio = useRef<HTMLAudioElement>(null);
  const released = useRef(new Set<number>());
  const counted = useRef(false);
  const saved = useRef(false);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [t, setT] = useState(0);
  const [waiting, setWaiting] = useState(false);
  // The story is on its way (starting, or caught up with on a weak signal): the play button says so.
  const [loading, setLoading] = useState(false);
  const [favorite, setFavorite] = useState(story.favorite);

  const physical = story.settings.source === "book" || story.settings.source === "book_read";
  const [waitMode, setWaitMode] = usePref("waitForMe", false);
  const [showWords, setShowWords] = usePref("showWords", true);
  // Off until asked for: a near-black screen is for shadows on the wall, and
  // it looks broken to anyone who didn't choose it.
  const [lightsOut, setLightsOut] = usePref("lightsOut", false);
  // A story in another language has each page in English too, under the words when it's asked for.
  const [showEnglish, setShowEnglish] = usePref("showEnglish", false);
  const hasEnglish = Boolean(story.script?.pages.some((p) => p.translation));
  const wordsBox = useRef<HTMLDivElement>(null);
  // The picture as big as the screen: when it's asked for (and kept, for next time), or with a phone turned
  // sideways (back to the words with a tap, until it's turned again).
  const [bigPref, setBigPref] = usePref("bigPicture", false);
  const sideways = useSideways();
  const [uprightWhileSideways, setUprightWhileSideways] = useState(false);
  useEffect(() => {
    if (!sideways) setUprightWhileSideways(false);
  }, [sideways]);
  const big = bigPref || (sideways && !uprightWhileSideways);
  // In the big picture, the controls show at a tap, and step aside again while the story plays.
  const [chrome, setChrome] = useState(true);
  useEffect(() => {
    if (!big || !playing || !chrome) return;
    const hide = setTimeout(() => setChrome(false), 3500);
    return () => clearTimeout(hide);
  }, [big, playing, chrome]);
  const bigger = () => {
    setBigPref(true);
    setUprightWhileSideways(false);
    setChrome(true);
  };
  const smaller = () => {
    setBigPref(false);
    if (sideways) setUprightWhileSideways(true);
  };

  const idx = pageAt(pages, t);
  const page = pages[idx];
  const inCue = page.chimeAt !== null && t >= page.chimeAt && t < Math.min(page.next, page.chimeAt + CUE_SECONDS);

  // Lights-out hides the floating motes too.
  useEffect(() => {
    document.body.classList.toggle("lights-out-active", lightsOut);
    return () => document.body.classList.remove("lights-out-active");
  }, [lightsOut]);
  // The page underneath stays put while the picture fills the screen.
  useEffect(() => {
    document.body.classList.toggle("big-picture-active", big);
    return () => document.body.classList.remove("big-picture-active");
  }, [big]);

  // Smooth time updates for word highlighting, and the "wait for me" pause.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audio.current;
      if (el) {
        const now = el.currentTime;
        setT(now);
        const i = pageAt(pages, now);
        const p = pages[i];
        if (
          waitMode &&
          p.page > 0 &&
          p.chimeAt !== null &&
          i < pages.length - 1 &&
          now >= p.chimeAt + 1.3 &&
          !released.current.has(i)
        ) {
          el.pause();
          setWaiting(true);
        }
        if (!counted.current && now > 10) {
          counted.current = true;
          void api.post(`/api/stories/${story.id}/played`).catch(() => undefined);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, pages, waitMode, api, story.id]);

  // Keep the screen awake while a story plays.
  useEffect(() => {
    if (!playing || !("wakeLock" in navigator)) return;
    let cancelled = false;
    navigator.wakeLock
      .request("screen")
      .then((lock) => {
        if (cancelled) void lock.release();
        else wakeLock.current = lock;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void wakeLock.current?.release().catch(() => undefined);
      wakeLock.current = null;
    };
  }, [playing]);

  const seekTo = useCallback((time: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = Math.max(0, time);
    setT(el.currentTime);
    setWaiting(false);
    setEnded(false);
  }, []);

  const goPage = useCallback(
    (i: number) => {
      const target = Math.max(0, Math.min(pages.length - 1, i));
      // Pages before the target count as turned; later ones will wait again.
      released.current = new Set(Array.from({ length: target }, (_, k) => k));
      seekTo(pages[target].start);
    },
    [pages, seekTo],
  );

  /** Back or ahead some seconds (a word missed, a bit to skip), the page turns kept in step as a page jump keeps them. */
  const skip = useCallback(
    (seconds: number) => {
      const at = Math.max(0, Math.min(timeline.duration, (audio.current?.currentTime ?? t) + seconds));
      released.current = new Set(Array.from({ length: pageAt(pages, at) }, (_, k) => k));
      seekTo(at);
    },
    [pages, seekTo, t, timeline.duration],
  );

  const play = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (ended) seekTo(0);
    setStarted(true);
    if (el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setLoading(true);
    void el.play().catch(() => {
      setPlaying(false);
      setLoading(false);
    });
  }, [ended, seekTo]);

  const pause = useCallback(() => audio.current?.pause(), []);

  // Carry straight on from the story before (the tap that got here lets it play).
  useEffect(() => {
    if (autoplay) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The classic's next chapter, when it isn't made yet: its name and length, and one tap to have it read.
  const [nextChapter, setNextChapter] = useState<{ title: string; words: number } | null>(null);
  const [making, setMaking] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);
  useEffect(() => {
    if (next?.kind !== "chapter") return;
    api
      .get<{ chapters: { index: number; title: string; words: number }[] }>(`/api/classics/${next.gutenbergId}`)
      .then((res) => setNextChapter(res.chapters[next.chapter] ?? null))
      .catch(() => setNextChapter(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const readNextChapter = async () => {
    if (next?.kind !== "chapter") return;
    setMaking(true);
    setNextError(null);
    try {
      const { classic: _done, ...settings } = story.settings;
      const { id } = await api.post<{ id: string }>("/api/classics/read", {
        gutenbergId: next.gutenbergId,
        chapter: next.chapter,
        emoji: book.notes,
        settings,
      });
      router.push(`/stories/${id}`);
    } catch (err) {
      setNextError(err instanceof Error ? err.message : "The next chapter couldn't be opened.");
      setMaking(false);
    }
  };

  const turned = () => {
    released.current.add(idx);
    setWaiting(false);
    const next = pages[idx + 1];
    if (next) seekTo(next.start - 0.15);
    void audio.current?.play();
  };

  // Lock screen and headphone controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const artwork = book.coverUrl ? [{ src: book.coverUrl, sizes: "512x512", type: "image/jpeg" }] : [{ src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" }];
    navigator.mediaSession.metadata = new MediaMetadata({ title: story.title, artist: "Storyhollow", album: book.title, artwork });
    navigator.mediaSession.setActionHandler("play", play);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", () => goPage(pageAt(pages, audio.current?.currentTime ?? 0) - 1));
    navigator.mediaSession.setActionHandler("nexttrack", () => goPage(pageAt(pages, audio.current?.currentTime ?? 0) + 1));
    return () => {
      for (const a of ["play", "pause", "previoustrack", "nexttrack"] as const) navigator.mediaSession.setActionHandler(a, null);
    };
  }, [story.title, book.title, book.coverUrl, play, pause, goPage, pages]);

  // Space to play/pause, arrows to flip pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (waiting) turned();
        else if (playing) pause();
        else play();
      } else if (e.code === "ArrowRight") goPage(idx + 1);
      else if (e.code === "ArrowLeft") goPage(idx - 1);
      else if (e.code === "Escape" && big) smaller();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleFavorite = async () => {
    setFavorite(!favorite);
    await api.patch(`/api/stories/${story.id}`, { favorite: !favorite }).catch(() => setFavorite(favorite));
  };

  const castById = useMemo(() => new Map((story.script?.cast ?? []).map((c) => [c.id, c])), [story.script]);
  const wordIdx = useMemo(() => {
    const words = page.words;
    let lo = 0;
    let hi = words.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }, [page, t]);
  const speaking = wordIdx >= 0 && t <= page.speechEnd ? castById.get(page.words[wordIdx].speaker) : undefined;
  // If a page has no word timings, still show its words, just without the highlight.
  const pageText = useMemo(
    () =>
      (story.script?.pages.find((p) => p.page === page.page)?.lines ?? [])
        .map((l) => l.text.replace(/\[[^\]]{1,40}\]\s*/g, "").trim())
        .filter(Boolean)
        .join(" "),
    [story.script, page.page],
  );

  const english = story.script?.pages.find((p) => p.page === page.page)?.translation ?? "";

  // Keep the word being read in view, and start each page at the top.
  useEffect(() => {
    if (wordsBox.current) wordsBox.current.scrollTop = 0;
  }, [idx]);
  useEffect(() => {
    const box = wordsBox.current;
    const now = box?.querySelector<HTMLElement>(`[data-i="${wordIdx}"]`);
    if (!box || !now) return;
    const y = now.offsetTop - box.scrollTop;
    if (y < 0 || y > box.clientHeight * 0.65) box.scrollTo({ top: now.offsetTop - box.clientHeight * 0.3, behavior: "smooth" });
  }, [wordIdx]);

  // A picture book shows its own pictures (and its cover while the welcome plays); other stories, the book's photos.
  const img =
    page.page > 0 ? (artForPage(story.art, page.page) ?? imageForPage(page.page, photos, story.settings.source, storyPages)) : (story.art?.cover ?? null);
  // Living pictures: how far into this page the story was when it came up, so the drift keeps time with the voice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pageOffset = useMemo(() => Math.max(0, t - page.start), [idx]);
  const effect = story.script?.pages.find((p) => p.page === page.page)?.effect ?? "none";
  const label =
    page.page === 0
      ? "Welcome"
      : physical || story.art
        ? `Page ${page.page} of ${storyPages}`
        : story.settings.source === "classic" || story.settings.source === "text"
          ? `Part ${page.page} of ${storyPages}`
          : `Chapter ${page.page} of ${storyPages}`;

  return (
    <main className={`player ${lightsOut ? "lights-out" : ""} ${big ? "big" : ""}`}>
      <audio
        ref={audio}
        src={story.audioUrl!}
        preload="auto"
        playsInline
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
          // The first time it plays, it's saved on the phone for listening without signal.
          if (!saved.current) {
            saved.current = true;
            const images = pages.map((p) => artForPage(story.art, p.page) ?? imageForPage(p.page, photos, story.settings.source, storyPages));
            void keepForOffline({
              id: story.id,
              title: story.title,
              book: book.title,
              audioUrl: story.audioUrl!,
              images: [...new Set([book.coverUrl, story.art?.cover ?? null, ...images].filter((src): src is string => Boolean(src)))],
            });
          }
        }}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onPause={() => {
          setPlaying(false);
          setLoading(false);
          setT(audio.current?.currentTime ?? 0);
        }}
        onEnded={() => {
          setPlaying(false);
          setLoading(false);
          setEnded(true);
          released.current.clear();
        }}
        onTimeUpdate={() => !playing && setT(audio.current?.currentTime ?? 0)}
      />

      <div className="player-top">
        <Link href={`/books/${book.id}`} className="icon-btn" aria-label="Close the story" title="Close">
          <Icon name="close" size={20} />
        </Link>
        <div className="player-title">
          <div className="eyebrow">
            {book.title}
            {narrator ? ` · read by ${narrator.name}` : ""}
          </div>
          <h1>{story.title}</h1>
        </div>
        <button className="icon-btn" onClick={toggleFavorite} aria-pressed={favorite} aria-label={favorite ? "Unfavorite" : "Make a favorite"}>
          {favorite ? "⭐" : "☆"}
        </button>
      </div>

      <div className="player-stage">
        <div
          className={`page-frame ${img ? "photo" : ""}`}
          // A tap on the picture makes it big; in the big picture, it shows (or hides) the controls.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a, button")) return;
            if (big) setChrome(!chrome);
            else bigger();
          }}
        >
          {img ? (
            <DriftingImage key={img} src={img} alt={label} page={page.page} seconds={page.next - page.start} offset={pageOffset} playing={playing} />
          ) : (
            <Cover id={book.id} title={story.title} kind={book.kind} coverUrl={page.page === 0 ? book.coverUrl : null} notes={book.notes} />
          )}
          <SceneEffects effect={effect} playing={playing} />
          {inCue && !ended && (
            <div className="turn-cue" aria-live="polite">
              <div>
                <span className="page-turn-icon" aria-hidden="true">
                  {page.page === 0 ? "🔔" : "📖"}
                </span>
                <strong>{page.page === 0 ? "That's the page-turn sound!" : "Turn the page!"}</strong>
              </div>
            </div>
          )}
          {ended && (
            <div className="turn-cue">
              <div>
                <strong>✨ The End ✨</strong>
                {next?.kind === "story" ? (
                  <div className="up-next">
                    <span className="up-next-label">Up next</span>
                    <Link className="btn" href={next.ready ? `/play/${next.id}?autoplay=1` : `/stories/${next.id}`}>
                      ▶ {next.title}
                    </Link>
                  </div>
                ) : next?.kind === "chapter" && nextChapter ? (
                  <div className="up-next">
                    <span className="up-next-label">
                      Up next · {nextChapter.title} · about {Math.max(1, Math.round(nextChapter.words / 150))} min
                    </span>
                    <button className="btn" onClick={readNextChapter} disabled={making}>
                      {making ? "Opening the book…" : "🎧 Read the next chapter"}
                    </button>
                    {nextError && <span className="up-next-label">{nextError}</span>}
                  </div>
                ) : (
                  <p className="muted" style={{ marginTop: 8 }}>
                    Sweet dreams.
                  </p>
                )}
              </div>
            </div>
          )}
          {!big && (
            <button type="button" className="icon-btn picture-bigger" onClick={bigger} aria-label="Make the picture as big as the screen" title="Big picture">
              <Icon name="bigger" size={20} />
            </button>
          )}
        </div>
        <span className="page-badge">{label}</span>
      </div>

      {big && (
        <div className={`big-chrome ${chrome || !playing || loading ? "" : "resting"}`}>
          <span className="big-label">{label}</span>
          <button type="button" className="icon-btn big-smaller" onClick={smaller} aria-label="Smaller picture, with the words" title="Smaller picture">
            <Icon name="smaller" size={20} />
          </button>
          <div className="big-controls">
            <button className="icon-btn" onClick={() => goPage(idx - 1)} disabled={idx === 0} aria-label="Previous page">
              <Icon name="prev" />
            </button>
            <button className="icon-btn" onClick={() => skip(-10)} aria-label="Back 10 seconds" title="Back 10 seconds">
              <Icon name="back10" size={26} />
            </button>
            {playing ? (
              <button className={`big-play ${loading ? "loading" : ""}`} onClick={pause} aria-label={loading ? "Loading the story (tap to pause)" : "Pause"}>
                <Icon name="pause" size={32} />
              </button>
            ) : (
              <button className="big-play" onClick={play} aria-label={ended ? "Play again" : started ? "Keep listening" : "Play the story"}>
                <Icon name={ended ? "again" : "play"} size={34} />
              </button>
            )}
            <button className="icon-btn" onClick={() => skip(10)} aria-label="Ahead 10 seconds" title="Ahead 10 seconds">
              <Icon name="ahead10" size={26} />
            </button>
            <button className="icon-btn" onClick={() => goPage(idx + 1)} disabled={idx >= pages.length - 1} aria-label="Next page">
              <Icon name="next" />
            </button>
          </div>
        </div>
      )}

      {showWords && (page.words.length > 0 || pageText) && (
        <div className="read-along" ref={wordsBox} aria-hidden="true" lang={story.script?.language}>
          {speaking && castById.size > 1 && <span className="who-speaks">{speaking.name}</span>}
          {page.words.length > 0
            ? page.words.map((w, i) => (
                <span key={i} data-i={i} className={`w ${i < wordIdx ? "said" : ""} ${i === wordIdx && t <= w.e + 0.25 ? "now" : ""}`}>
                  {spaced(w.w)}{" "}
                </span>
              ))
            : pageText}
        </div>
      )}
      {showEnglish && english && (
        <p className="read-english" lang="en">
          {english}
        </p>
      )}

      <div className="controls">
        <button className="icon-btn" onClick={() => goPage(idx - 1)} disabled={idx === 0} aria-label="Previous page">
          <Icon name="prev" />
        </button>
        <button className="icon-btn" onClick={() => skip(-10)} aria-label="Back 10 seconds" title="Back 10 seconds">
          <Icon name="back10" size={26} />
        </button>
        {playing ? (
          <button className={`big-play ${loading ? "loading" : ""}`} onClick={pause} aria-label={loading ? "Loading the story (tap to pause)" : "Pause"}>
            <Icon name="pause" size={38} />
          </button>
        ) : (
          <button className="big-play" onClick={play} aria-label={ended ? "Play again" : started ? "Keep listening" : "Play the story"}>
            <Icon name={ended ? "again" : "play"} size={40} />
          </button>
        )}
        <button className="icon-btn" onClick={() => skip(10)} aria-label="Ahead 10 seconds" title="Ahead 10 seconds">
          <Icon name="ahead10" size={26} />
        </button>
        <button className="icon-btn" onClick={() => goPage(idx + 1)} disabled={idx >= pages.length - 1} aria-label="Next page">
          <Icon name="next" />
        </button>
      </div>

      <div className="page-dots" aria-label="Pages">
        {pages.map((p, i) => (
          <button
            key={i}
            className={i === idx ? "now" : i < idx ? "past" : ""}
            onClick={() => goPage(i)}
            aria-label={p.page === 0 ? "Welcome" : `Go to page ${p.page}`}
          />
        ))}
      </div>

      <div className="scrubber">
        <span>{formatClock(t)}</span>
        <input
          type="range"
          min={0}
          max={timeline.duration}
          step={0.5}
          value={Math.min(t, timeline.duration)}
          onChange={(e) => seekTo(Number(e.target.value))}
          aria-label="Position in the story"
        />
        <span>{formatClock(timeline.duration)}</span>
      </div>

      <div className="player-options">
        {physical && story.settings.chime.enabled && (
          <Toggle on={waitMode} onClick={() => setWaitMode(!waitMode)} icon="✋" label="Wait for me to turn" title="Pause after each chime until you tap" />
        )}
        <Toggle on={showWords} onClick={() => setShowWords(!showWords)} icon="Aa" label="Words" />
        {hasEnglish && (
          <Toggle on={showEnglish} onClick={() => setShowEnglish(!showEnglish)} icon="EN" label="English" title="Each page in English, under the words" />
        )}
        <Toggle on={big} onClick={() => (big ? smaller() : bigger())} icon="🖼️" label="Big picture" title="The picture as big as the screen" />
        <Toggle on={lightsOut} onClick={() => setLightsOut(!lightsOut)} icon="🌙" label="Lights out" title="A nearly-black screen for shadow books on the wall" />
      </div>

      {waiting && (
        <button className="wait-overlay" onClick={turned} autoFocus>
          <span>
            <span style={{ fontSize: "4rem", display: "block" }} aria-hidden="true">
              📖
            </span>
            <strong>Turn the page…</strong>
            <span className="muted" style={{ display: "block", marginTop: 10, fontSize: "1.2rem" }}>
              then tap anywhere to keep going
            </span>
          </span>
        </button>
      )}
    </main>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi } from "@/components/Grownup";
import { Cover, hueFor } from "@/components/Books";
import { Steps, toTop } from "@/components/Steps";
import { CreditButton, CreditNote, CreditsLeft, useCredits } from "@/components/Credits";
import { VoicePicker, useVoices } from "@/components/Pickers";
import { pickPhotos } from "@/lib/client/images";
import { sendTrouble, sentWords, upload } from "@/lib/client/upload";
import { WaitLine } from "@/components/Waiting";
import { DEFAULT_NARRATOR_ID } from "@/lib/shared/personas";
import { defaultSettings, readingWordsSeconds } from "@/lib/shared/options";
import { gutenbergCover } from "@/lib/shared/gutenberg";
import type { AppStatus, Book } from "@/lib/shared/types";
import type { CataloguePage, Classic, Refinement, TOPICS } from "@/lib/server/classics";
import type { FavoriteClassic } from "@/lib/server/db";
import { Plaque } from "@/components/Plaque";
import { formatMoney, storytellerCost } from "@/lib/shared/art";
import { BookPicker } from "@/components/BookPicker";

type Tab = "classics" | "own" | "words";
type Topic = (typeof TOPICS)[number];

/** The whole library opens a couple of rows deep, and grows a few rows at a time. */
const FIRST_ROWS = 2;
const MORE_ROWS = 3;

/** A book to choose: its real Gutenberg cover (or a leather one), its title, and a star to keep it handy. */
function BookTile({
  book,
  sub,
  hue,
  starred,
  onOpen,
  onStar,
  className = "",
}: {
  book: FavoriteClassic;
  sub: string | null;
  hue: string;
  starred: boolean;
  onOpen: () => void;
  onStar: () => void;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`book ${className}`}>
      <button type="button" className="book-open" onClick={onOpen} title={book.title}>
        <div className="book-cover">
          {book.cover && !broken ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={book.cover} alt="" loading="lazy" onError={() => setBroken(true)} />
          ) : (
            <div className="leather" style={{ ["--hue" as string]: hue }}>
              <span className="leather-emoji">{book.emoji ?? "📖"}</span>
              <span className="leather-title">{book.title}</span>
            </div>
          )}
        </div>
        <div className="book-title">{book.title}</div>
        {sub && <div className="faint small center">{sub}</div>}
      </button>
      <button
        type="button"
        className="fav-star"
        aria-pressed={starred}
        aria-label={starred ? `Take ${book.title} out of favorites` : `Make ${book.title} a favorite`}
        onClick={onStar}
      >
        {starred ? "★" : "☆"}
      </button>
    </div>
  );
}

interface ChapterInfo {
  index: number;
  title: string;
  words: number;
  characters: number;
  opening: string;
}

export function ReadToMe({
  classics,
  topics,
  ownBooks,
  readAloudCount,
  status,
  preselectBook,
  preselectClassic,
  preselectReader,
  favoriteClassics,
  librarySize,
  lastReaders,
}: {
  classics: Classic[];
  topics: readonly Topic[];
  ownBooks: Book[];
  /** How many read-alouds the family has made (they're kept in the Library). */
  readAloudCount: number;
  /** The storyteller who last read each book ("classic:<id>" or "book:<id>"). */
  lastReaders: Record<string, string>;
  status: AppStatus;
  preselectBook: string | null;
  preselectClassic: number | null;
  /** Arrived to be read to by someone in particular (a loved one, from Home): they read whatever's chosen. */
  preselectReader: string | null;
  favoriteClassics: FavoriteClassic[];
  /** How many books the whole library holds (0 until it's first fetched). */
  librarySize: number;
}) {
  const api = useApi();
  const router = useRouter();
  const voices = useVoices();
  const credits = useCredits();
  const [reader, setReader] = useState<string>(preselectReader ?? DEFAULT_NARRATOR_ID);
  const [fullCast, setFullCast] = useState(false);
  const [tab, setTab] = useState<Tab>(preselectBook ? "own" : "classics");
  // First the book, then who reads it. Arriving from one of the family's books, it's already chosen.
  const startsChosen = Boolean(preselectBook && ownBooks.some((b) => b.id === preselectBook));
  const [step, setStep] = useState(startsChosen ? 1 : 0);
  const goTo = (next: number) => {
    setStep(next);
    toTop();
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // classics
  const [open, setOpen] = useState<{ gid: number; title: string; author: string | null; emoji: string; chapters: ChapterInfo[] } | null>(null);
  const [chapter, setChapter] = useState<ChapterInfo | null>(null);
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<string>(topics[0]?.id ?? "loved");
  const [searched, setSearched] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<(CataloguePage & { page: number }) | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // Narrowing a long list down by a subject its books share ("Dogs · 84").
  const [refine, setRefine] = useState<Refinement | null>(null);
  const [refinements, setRefinements] = useState<Refinement[]>([]);
  const browseSeq = useRef(0);
  const [rows, setRows] = useState(FIRST_ROWS);
  const [cols, setCols] = useState(3);
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  const shelfScroll = useRef(0);
  const openRef = useRef<HTMLDivElement>(null);

  // own book
  const [bookId, setBookId] = useState<string>(preselectBook ?? "");
  const [checkFirst, setCheckFirst] = useState(false);

  // own words
  const [wordsTitle, setWordsTitle] = useState("");
  const [words, setWords] = useState("");
  // Words from a photo: developing it, sending it, then the storyteller reading it (about how long that takes, when it's known).
  const [reading, setReading] = useState<{ what: string; startedAt: number; seconds: number } | null>(null);
  const [readNote, setReadNote] = useState<{ ok: boolean; text: string } | null>(null);
  const picturesInput = useRef<HTMLInputElement>(null);

  const storytellerReady = status.storyteller || status.demoMode;

  const savedReader = () => {
    try {
      return localStorage.getItem("storyhollow:reader") || DEFAULT_NARRATOR_ID;
    } catch {
      return DEFAULT_NARRATOR_ID;
    }
  };
  // The book chosen so far, and who read it last time.
  const bookKey = tab === "classics" ? (open ? `classic:${open.gid}` : null) : tab === "own" && bookId ? `book:${bookId}` : null;
  const usual = bookKey ? lastReaders[bookKey] : undefined;
  // Once per book: whoever read it last (so a story keeps its voice from chapter to chapter), or the family's usual choice.
  const pickedFor = useRef<string | null>(null);
  const pickReader = () => {
    const key = bookKey ?? tab;
    if (pickedFor.current === key) return;
    pickedFor.current = key;
    setReader(preselectReader ?? usual ?? savedReader());
  };
  useEffect(() => {
    if (startsChosen) pickReader();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toStoryteller = () => {
    pickReader();
    setError(null);
    goTo(1);
  };
  const readerVoice = voices?.find((v) => v.voiceId === reader);
  const familyNames = (voices ?? []).filter((v) => v.source === "family").map((v) => v.name);
  // Arrived to be read to by a loved one: they read whatever's chosen.
  const askedFor = preselectReader ? voices?.find((v) => v.voiceId === preselectReader && v.source === "family") : undefined;
  const readerName = readerVoice
    ? `${readerVoice.persona?.emoji ?? (readerVoice.source === "family" ? "💛" : readerVoice.source === "designed" ? "🪄" : "🗣️")} ${readerVoice.persona?.name ?? readerVoice.name}`
    : "your storyteller";
  const chooseReader = (id: string | null) => {
    const v = id ?? DEFAULT_NARRATOR_ID;
    setReader(v);
    try {
      localStorage.setItem("storyhollow:reader", v);
    } catch {
      // ignore
    }
  };

  const openClassic = async (gid: number, fallbackTitle: string, emoji: string) => {
    setBusy(`Fetching ${fallbackTitle} from the archives…`);
    setError(null);
    // The book opens at the top of the page; "All books" brings the family back to where they were.
    shelfScroll.current = window.scrollY;
    toTop();
    try {
      const res = await api.get<{ title: string; author: string | null; chapters: ChapterInfo[] }>(`/api/classics/${gid}`);
      setOpen({ gid, title: res.title, author: res.author, emoji, chapters: res.chapters });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That book couldn't be fetched.");
    } finally {
      setBusy(null);
    }
  };

  // An opened book lands at the top of the screen, its chapters in view.
  useEffect(() => {
    if (open) openRef.current?.scrollIntoView({ block: "start" });
  }, [open]);

  const closeClassic = () => {
    setOpen(null);
    requestAnimationFrame(() => window.scrollTo({ top: shelfScroll.current }));
  };

  useEffect(() => {
    if (preselectClassic) void openClassic(preselectClassic, "the book", "📜");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectClassic]);

  /** A page of the whole library, by topic or by search. A later request always wins over an earlier one. */
  const browse = async (by: { topic?: string; q?: string; refine?: string }, page = 1) => {
    const seq = ++browseSeq.current;
    setBrowsing(true);
    setBrowseError(null);
    if (page === 1) {
      setCatalogue(null);
      setRows(FIRST_ROWS);
    }
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (by.q) params.set("q", by.q);
      else if (by.topic) params.set("topic", by.topic);
      if (by.refine) params.set("refine", by.refine);
      const res = await api.get<CataloguePage>(`/api/classics?${params}`);
      if (seq !== browseSeq.current) return;
      if (res.refinements) setRefinements(res.refinements);
      setCatalogue((cur) => ({ results: page > 1 && cur ? [...cur.results, ...res.results] : res.results, more: res.more, total: res.total, page }));
    } catch (err) {
      if (seq === browseSeq.current) setBrowseError(err instanceof Error ? err.message : "The library couldn't be reached.");
    } finally {
      if (seq === browseSeq.current) setBrowsing(false);
    }
  };

  // Open the card catalogue at the first topic the first time the treasury is shown.
  useEffect(() => {
    if (tab === "classics" && !catalogue && !browsing && !browseError) void browse({ topic });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // How many books fit across, so "two rows" is two rows on a phone and on a big screen alike.
  useEffect(() => {
    if (!gridEl) return;
    const measure = () => setCols(Math.max(1, getComputedStyle(gridEl).gridTemplateColumns.split(" ").filter(Boolean).length));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [gridEl]);
  // What's being looked at: a search or a kind, and what it's narrowed to.
  const lookingAt = (narrowed = refine) => ({ ...(searched ? { q: searched } : { topic }), refine: narrowed?.id });
  const startOver = () => {
    setRefine(null);
    setRefinements([]);
  };

  const chooseTopic = (id: string) => {
    setTopic(id);
    setRows(FIRST_ROWS);
    setSearched(null);
    setQuery("");
    startOver();
    if (id !== "favorites") void browse({ topic: id });
  };

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearched(q);
    startOver();
    void browse({ q });
  };

  const clearSearch = () => {
    setSearched(null);
    setQuery("");
    startOver();
    if (topic !== "favorites") void browse({ topic });
  };

  const narrow = (r: Refinement | null) => {
    setRefine(r);
    void browse(lookingAt(r));
  };

  // Starred books, for the whole family. Each keeps its title and cover so it shows without the library.
  const [starredBooks, setStarredBooks] = useState<FavoriteClassic[]>(favoriteClassics);
  const isStarred = (gid: number) => starredBooks.some((b) => b.gutenbergId === gid);
  const toggleStar = (book: FavoriteClassic) => {
    const favorite = !isStarred(book.gutenbergId);
    const apply = (on: boolean) =>
      setStarredBooks((cur) => (on ? [book, ...cur.filter((b) => b.gutenbergId !== book.gutenbergId)] : cur.filter((b) => b.gutenbergId !== book.gutenbergId)));
    apply(favorite);
    api.post("/api/favorites", { book, favorite }).catch(() => apply(!favorite));
  };
  const pick = (c: Classic): FavoriteClassic => ({
    gutenbergId: c.gutenbergId,
    title: c.title,
    author: c.author,
    cover: gutenbergCover(c.gutenbergId),
    emoji: c.emoji,
  });

  // One search, one set of results: Storyhollow's own picks for this kind (or search) first, then the rest of the library.
  const kinds = [{ id: "favorites", label: "Favorites", emoji: "⭐" }, ...topics];
  const showingStarred = topic === "favorites" && !searched;
  const sought = searched?.toLowerCase();
  // Narrowed by a subject, it's the library's own list (Storyhollow's picks have no subjects of their own).
  const picks = refine
    ? []
    : classics.filter((c) =>
        sought ? `${c.title} ${c.author}`.toLowerCase().includes(sought) : topic === "loved" || (c.kinds as string[]).includes(topic),
      );
  const picked = new Set(picks.map((c) => c.gutenbergId));
  const results: FavoriteClassic[] = showingStarred
    ? starredBooks
    : [
        ...picks.map(pick),
        ...(catalogue?.results ?? [])
          .filter((hit) => !picked.has(hit.gutenbergId))
          .map((hit) => ({ gutenbergId: hit.gutenbergId, title: hit.title, author: hit.author, cover: hit.cover, emoji: null })),
      ];
  const total = showingStarred ? starredBooks.length : Math.max(catalogue?.total ?? 0, results.length);
  const shown = results.slice(0, rows * cols);
  const canShowMore = shown.length < results.length || (!showingStarred && Boolean(catalogue?.more));
  const showMore = () => {
    const next = rows + MORE_ROWS;
    setRows(next);
    // Fetch the next page from the library before running out of books to show.
    if (!showingStarred && catalogue?.more && next * cols > results.length) void browse(lookingAt(), catalogue.page + 1);
  };
  const topicLabel = kinds.find((t) => t.id === topic)?.label ?? "browsing";
  const tileFor = (book: FavoriteClassic, className?: string) => {
    const curated = classics.find((c) => c.gutenbergId === book.gutenbergId);
    return (
      <BookTile
        key={book.gutenbergId}
        book={curated ? pick(curated) : book}
        sub={curated ? `Ages ${curated.ages}` : book.author}
        hue={curated?.color ?? hueFor(String(book.gutenbergId))}
        starred={isStarred(book.gutenbergId)}
        onOpen={() => openClassic(book.gutenbergId, book.title, curated?.emoji ?? book.emoji ?? "📖")}
        onStar={() => toggleStar(curated ? pick(curated) : book)}
        className={className}
      />
    );
  };

  const baseSettings = (source: "classic" | "book_read" | "text") =>
    defaultSettings({
      source,
      narratorVoiceId: reader,
      fullCast,
      chime: { enabled: source === "book_read", style: "bell", gapSeconds: 3 },
      intro: true,
      review: source === "book_read" ? checkFirst : false,
    });

  const readChapter = async () => {
    if (!open || !chapter) return;
    setBusy("Opening the book…");
    setError(null);
    try {
      const { id } = await api.post<{ id: string }>("/api/classics/read", {
        gutenbergId: open.gid,
        chapter: chapter.index,
        emoji: open.emoji,
        settings: baseSettings("classic"),
      });
      router.push(`/stories/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      setBusy(null);
    }
  };

  const readOwnBook = async () => {
    setBusy("Opening your book…");
    setError(null);
    try {
      const res = await api.post<{ id: string }>("/api/stories", { bookId, mode: "read", settings: baseSettings("book_read") });
      router.push(`/stories/${res.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      setBusy(null);
    }
  };

  const readWords = async () => {
    setBusy("Opening the envelope…");
    setError(null);
    try {
      const form = new FormData();
      form.set("title", wordsTitle.trim() || "Our Words");
      form.set("kind", "own_text");
      const { id: bookIdNew } = await api.form<{ id: string }>("/api/books", form);
      const res = await api.post<{ id: string }>("/api/stories", {
        bookId: bookIdNew,
        mode: "read",
        settings: { ...baseSettings("text"), text: words },
      });
      router.push(`/stories/${res.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      setBusy(null);
    }
  };

  /** The words in a photo or screenshot, copied into the box (after anything already there) to check. */
  const readPictures = async (files: FileList | null) => {
    if (!files?.length) return;
    const step = (what: string, seconds = 0) => setReading({ what, startedAt: Date.now(), seconds });
    step("Developing the photo");
    setReadNote(null);
    try {
      const { photos, extra } = await pickPhotos(files, 6, (done, total) => step(total > 1 ? `Developing photo ${done + 1} of ${total}` : "Developing the photo"));
      const form = new FormData();
      photos.forEach((p) => {
        form.append("pictures", p.file, p.file.name);
        URL.revokeObjectURL(p.url);
      });
      const sending = photos.length > 1 ? "Sending the photos" : "Sending the photo";
      step(sending);
      let sent = false;
      const res = await upload<{ title: string | null; text: string }>(api, "/api/words", form, (n, of) => {
        if (n < of) step(sentWords(sending, n, of));
        else if (!sent) {
          sent = true;
          step("Reading the words", status.storyteller ? readingWordsSeconds(photos.length) : 0);
        }
      });
      if (!res.text) {
        setReadNote({ ok: false, text: "No words could be found in that picture. A closer, brighter photo usually helps." });
        return;
      }
      setWords((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${res.text}` : res.text));
      if (res.title) setWordsTitle((cur) => cur.trim() || res.title!);
      setReadNote({
        ok: true,
        text: `Here are the words${extra ? ` from the first ${photos.length} pictures` : ""}. Give them a quick read, and fix anything the picture made hard to make out.`,
      });
    } catch (err) {
      setReadNote({ ok: false, text: sendTrouble(err, "That picture couldn't be read.") });
    } finally {
      setReading(null);
    }
  };

  const minutes = (w: number) => Math.max(1, Math.round(w / 150));
  const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

  // What's been chosen to read, shown above the storytellers.
  const ownBook = ownBooks.find((b) => b.id === bookId);
  const chosen =
    tab === "classics"
      ? open && chapter
        ? {
            thumb: <Cover id={String(open.gid)} title={open.title} kind="classic" coverUrl={gutenbergCover(open.gid)} notes={open.emoji} showTitle={false} />,
            title: open.title,
            sub: open.chapters.length > 1 ? chapter.title : open.author,
            about: `About ${minutes(chapter.words)} min`,
            credits: chapter.characters,
          }
        : null
      : tab === "own"
        ? ownBook
          ? {
              thumb: <Cover id={ownBook.id} title={ownBook.title} kind={ownBook.kind} coverUrl={ownBook.coverUrl} showTitle={false} />,
              title: ownBook.title,
              sub: `${ownBook.pageCount} ${ownBook.pageCount === 1 ? "page" : "pages"}, with page-turn chimes`,
              about: null,
              credits: null,
            }
          : null
        : words.trim().length >= 10
          ? {
              thumb: <span className="chosen-emoji">✉️</span>,
              title: wordsTitle.trim() || "Our Words",
              sub: null,
              about: `About ${minutes(wordCount(words))} min`,
              credits: words.trim().length,
            }
          : null;
  const readIt = () => (tab === "classics" ? readChapter() : tab === "own" ? readOwnBook() : readWords());
  // The storyteller's time, when it's needed: reading the words off your own pages, or sorting out who says what for
  // character voices. One reader, word for word, needs none.
  const chosenWords = tab === "classics" ? (chapter?.words ?? 0) : wordCount(words);
  const preparing =
    !storytellerReady || !chosen
      ? 0
      : tab === "own" && ownBook
        ? storytellerCost(status.storytellerRates, 6_000 + ownBook.pageCount * 1_600, 2_500 + ownBook.pageCount * 350)
        : fullCast
          ? storytellerCost(status.storytellerRates, 7_000 + chosenWords * 1.4, 3_000 + chosenWords * 1.6)
          : 0;

  return (
    <div className="stack" style={{ ["--gap" as string]: "26px" }}>
      {step === 1 && (
        <button type="button" className="back-link" onClick={() => goTo(0)} style={{ marginBottom: -12 }}>
          ‹ Back to the book
        </button>
      )}
      <div className="center">
        <div className="eyebrow">Read to Me</div>
        <h1>{step === 0 ? "What shall we read?" : "Who shall read it to you?"}</h1>
        {step === 0 && askedFor && <p className="muted" style={{ margin: 0 }}>💛 {askedFor.name} will read it to you. Choose a book, a poem or a letter.</p>}
      </div>
      <Steps labels={["The book", "The storyteller"]} step={step} onGo={goTo} />

      {step === 1 && (
        <div className="parchment stack">
          {chosen ? (
            <div className="cast-card chosen-book">
              <div className="story-thumb">{chosen.thumb}</div>
              <div className="story-meta">
                <div className="cast-name">{chosen.title}</div>
                {chosen.sub && <div className="small muted">{chosen.sub}</div>}
                {chosen.about && <div className="small faint">{chosen.about}</div>}
              </div>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => goTo(0)}>
                Change
              </button>
            </div>
          ) : (
            <p className="notice center" style={{ margin: 0 }}>
              First, choose something to read.{" "}
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => goTo(0)}>
                Choose a book
              </button>
            </p>
          )}
          {usual && reader === usual && (
            <p className="small muted" style={{ margin: 0 }}>
              Picked because <b>{readerName}</b> read this book last time. Choose anyone you like.
            </p>
          )}
          <VoicePicker voices={voices} value={reader} onChange={chooseReader} allowAuto={false} />
          <label className="toggle">
            <input type="checkbox" checked={fullCast} onChange={(e) => setFullCast(e.target.checked)} disabled={!storytellerReady} />
            <span>
              <b>Character voices</b>
              <span className="muted small">
                {storytellerReady
                  ? "Your storyteller reads the narration, and every character who speaks gets a voice of their own."
                  : "Needs the storyteller (an Anthropic key) to work out who's talking."}
              </span>
            </span>
          </label>
          {error && <p className="notice notice-error center">{error}</p>}
          {busy && <p className="notice center">✨ {busy}</p>}
          {preparing > 0 && (
            <p className="small muted center" style={{ margin: 0 }}>
              Preparing it: about {formatMoney(preparing)} of storyteller time.
            </p>
          )}
          {chosen?.credits ? <CreditNote needed={chosen.credits} className="small muted center" /> : <CreditsLeft className="small muted center" />}
          <div className="center">
            <CreditButton
              needed={chosen?.credits ?? 0}
              className="btn btn-lg"
              onClick={readIt}
              disabled={!chosen || Boolean(busy) || (tab === "own" && !storytellerReady)}
            >
              🎧 Read it to me
            </CreditButton>
          </div>
        </div>
      )}

      {step === 0 && (
        <>
          <div className="choices on-dark read-tabs" role="tablist">
            {(
              [
                ["classics", "📜", "The Classic Treasury", "Free classic books"],
                ["own", "📕", "A book we own", "Photograph its pages"],
                ["words", "✉️", "Our own words", "Write, paste or photograph"],
              ] as const
            ).map(([t, emoji, label, sub]) => (
              <button key={t} role="tab" aria-selected={tab === t} className="choice" aria-pressed={tab === t} onClick={() => setTab(t)}>
                <span className="choice-emoji" aria-hidden="true">
                  {emoji}
                </span>
                <span className="choice-title">{label}</span>
                <span className="choice-sub">{sub}</span>
              </button>
            ))}
          </div>

          {error && <p className="notice notice-error center">{error}</p>}
          {busy && <p className="notice center">✨ {busy}</p>}

          {tab === "classics" && !open && (
            <>
              <section className="find-panel stack" style={{ ["--gap" as string]: "14px" }} aria-label="Find a book">
                <div>
                  <p className="find-intro">
                    📚 <b>{librarySize ? librarySize.toLocaleString() : "Tens of thousands of"} free books</b> from Project Gutenberg, the great
                    free library of classics.
                  </p>
                  <form className="find-search" onSubmit={search} role="search">
                    <input
                      className="input"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search by title, author or subject"
                      aria-label="Search by title, author or subject"
                      enterKeyHint="search"
                    />
                    <button className="btn btn-sm" aria-label="Search">
                      🔍
                    </button>
                  </form>
                  <p className="find-hint">Try a title (“Peter Pan”), an author (“Beatrix Potter”) or a subject (“pirates”, “Halloween”, “dragons”).</p>
                </div>
                <div>
                  <span className="find-label">Or browse a kind of story</span>
                  <div className="topic-chips">
                    {kinds.map((t) => (
                      <button key={t.id} type="button" className="dark-chip" aria-pressed={!searched && topic === t.id} onClick={() => chooseTopic(t.id)}>
                        {t.emoji} {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="stack" style={{ ["--gap" as string]: "14px" }} aria-label="Books">
                <div className="center">
                  <Plaque label={showingStarred ? "Your favorites" : searched ? "Search results" : topicLabel} wide />
                  <p className="muted small" style={{ margin: "-6px 0 0" }}>
                    {showingStarred
                      ? "The books anyone in the family has starred."
                      : [
                          searched ? `Books matching “${searched}”` : null,
                          refine?.label ?? null,
                          catalogue ? `${total.toLocaleString()} ${total === 1 ? "book" : "books"}` : null,
                          refine || searched ? null : "Storyhollow's picks first (with ages), then the rest of the library.",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                    {searched && (
                      <>
                        {" "}
                        <button type="button" className="btn btn-quiet btn-sm" onClick={clearSearch}>
                          ✕ Clear search
                        </button>
                      </>
                    )}
                  </p>
                </div>
                {!showingStarred && refinements.length > 0 && (
                  <div>
                    <span className="find-label">Narrow it down</span>
                    <div className="topic-chips">
                      <button type="button" className="dark-chip" aria-pressed={!refine} onClick={() => narrow(null)}>
                        All
                      </button>
                      {refinements.map((r) => (
                        <button key={r.id} type="button" className="dark-chip" aria-pressed={refine?.id === r.id} onClick={() => narrow(r)}>
                          {r.label} <span className="chip-count">{r.count.toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {browseError && (
                  <div className="notice notice-error center">
                    <p style={{ margin: 0 }}>{browseError}</p>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ marginTop: 10 }}
                      onClick={() => browse(lookingAt(), (catalogue?.page ?? 0) + 1)}
                    >
                      Try again
                    </button>
                  </div>
                )}
                {results.length > 0 && (
                  <div className="catalogue-grid" ref={setGridEl}>
                    {shown.map((b) => tileFor(b, "catalogue-book"))}
                  </div>
                )}
                {showingStarred && results.length === 0 && (
                  <p className="muted center">Tap the ☆ on any book to keep it here, for everyone in the family.</p>
                )}
                {!showingStarred && catalogue && results.length === 0 && !browsing && (
                  <p className="muted center">Nothing found. Try another title, an author, or another kind of story.</p>
                )}
                {browsing && (
                  <p className="notice center">
                    {catalogue ? "✨ Fetching more books…" : "✨ Opening the card catalogue… the first look can take a few seconds."}
                  </p>
                )}
                {canShowMore && !browsing && (
                  <div className="center">
                    <button type="button" className="btn btn-ghost" onClick={showMore}>
                      Show more books
                    </button>
                  </div>
                )}
              </section>

              <p className="faint small center">
                Newer picture books aren't in any free library, so photograph your own copy instead (“A book we own”).
              </p>
            </>
          )}

          {tab === "classics" && open && (
            <div className="parchment stack opened-book" ref={openRef}>
              <div className="spread">
                <div>
                  <div className="eyebrow">{open.author}</div>
                  <h2 style={{ margin: 0 }}>
                    {open.emoji} {open.title}
                  </h2>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={closeClassic}>
                  ← All books
                </button>
              </div>
              <CreditsLeft className="small muted" />
              <div className="stack" style={{ ["--gap" as string]: "10px" }}>
                {open.chapters.map((c) => (
                  <div key={c.index} className="cast-card spread" style={{ alignItems: "center" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="cast-name">{c.title}</div>
                      <div className="small muted">
                        About {minutes(c.words)} min · about {c.characters.toLocaleString()} voice credits
                        {credits && c.characters > credits.left && <b className="over-budget"> · more than you have left</b>}
                      </div>
                      <div className="small faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.opening}…
                      </div>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setChapter(c);
                        toStoryteller();
                      }}
                      disabled={Boolean(busy)}
                    >
                      Choose ›
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "own" && (
            <div className="parchment stack">
              <p className="muted" style={{ margin: 0 }}>
                Choose a book you&apos;ve photographed, and your storyteller will read its real words aloud, with a chime to turn
                each page. (For your family&apos;s own listening.)
              </p>
              <BookPicker books={ownBooks} value={bookId} onChange={setBookId} addHref="/books/new?then=read" />
              <label className="toggle">
                <input type="checkbox" checked={checkFirst} onChange={(e) => setCheckFirst(e.target.checked)} />
                <span>
                  <b>Let me check the words before recording</b>
                  <span className="muted small">Handy for tricky fonts or handwriting.</span>
                </span>
              </label>
              {!storytellerReady && <p className="notice small">Reading your own pages needs the storyteller (an Anthropic key).</p>}
              <div className="spread">
                <span />
                <button className="btn" type="button" onClick={toStoryteller} disabled={!storytellerReady || !bookId}>
                  Next: the storyteller →
                </button>
              </div>
            </div>
          )}

          {tab === "words" && (
            <div className="parchment stack">
              <p className="muted" style={{ margin: 0 }}>
                A poem, a letter from Grandma, a birthday card, a story your child dictated… write it here, paste it in, or add a photo or
                screenshot of it, and it will be read aloud.
              </p>
              <p className="hint" style={{ margin: 0 }}>
                {familyNames.length ? (
                  <>💛 Choose {familyNames.join(" or ")} as the storyteller next, and it&apos;s read in their own voice.</>
                ) : (
                  <>
                    💛 It can even be read in a loved one&apos;s own voice: the storytellers can learn it from a voicemail or a video, in the{" "}
                    <Link href="/grownups#family-voices">Grown-ups&apos; corner</Link>.
                  </>
                )}
              </p>
              <div className="words-picture">
                <input
                  ref={picturesInput}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    void readPictures(e.target.files);
                    e.target.value = "";
                  }}
                />
                {reading ? (
                  <WaitLine what={reading.what} done={0} total={1} startedAt={reading.startedAt} seconds={reading.seconds} />
                ) : (
                  <>
                    <button type="button" className="btn btn-ghost" onClick={() => picturesInput.current?.click()}>
                      📷 Add a photo or screenshot
                    </button>
                    <span className="hint">
                      The words in it are copied out below for you to check
                      {storytellerReady ? ` (about ${formatMoney(storytellerCost(status.storytellerRates, 2_500, 1_500))} of storyteller time a picture)` : ""}.
                    </span>
                  </>
                )}
              </div>
              {readNote && <p className={`notice small ${readNote.ok ? "" : "notice-error"}`} style={{ margin: 0 }}>{readNote.text}</p>}
              <label className="field">
                <span>Title</span>
                <input className="input" value={wordsTitle} onChange={(e) => setWordsTitle(e.target.value)} placeholder="A Letter from Granny" />
              </label>
              <label className="field">
                <span>The words</span>
                <textarea
                  className="textarea"
                  style={{ minHeight: 220 }}
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  placeholder="Write or paste the words here."
                />
              </label>
              <div className="spread">
                <span />
                <button className="btn" type="button" onClick={toStoryteller} disabled={words.trim().length < 10}>
                  Next: the storyteller →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {step === 0 && readAloudCount > 0 && (
        <p className="faint small center">
          🎧 {readAloudCount === 1 ? "The read-aloud you've made is" : `The ${readAloudCount} read-alouds you've made are`} in the Library.{" "}
          <Link href="/library?show=read-alouds">See them ›</Link>
        </p>
      )}
    </div>
  );
}

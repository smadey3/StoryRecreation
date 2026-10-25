"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/components/Grownup";
import { Cover, StoryCardView } from "@/components/Books";
import { BOOK_KINDS, DEFAULT_SHELVES, defaultSettings } from "@/lib/shared/options";
import { LANGUAGES, languageOf } from "@/lib/shared/languages";
import type { Book, BookPage, Profile, StoryCard, StorySettings } from "@/lib/shared/types";
import { Plaque } from "@/components/Plaque";
import { PdfShare } from "@/components/PdfShare";

const folderHref = (name: string) => `/library?folder=${encodeURIComponent(name)}`;

export function BookView({
  book,
  pages,
  stories,
  profiles,
  shelves,
  folders,
  lastCreate,
  currentProfile,
  canMake,
}: {
  book: Book;
  pages: BookPage[];
  stories: StoryCard[];
  profiles: Profile[];
  shelves: string[];
  /** The family's folders of books, to keep this one in. */
  folders: string[];
  lastCreate: StorySettings | null;
  currentProfile: Profile | null;
  canMake: boolean;
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(book.title);
  const [shelf, setShelf] = useState(book.shelf);
  const [folder, setFolder] = useState(book.folder ?? "");
  const [favorite, setFavorite] = useState(book.favorite);
  const toggleFavorite = () => {
    const next = !favorite;
    setFavorite(next);
    api.patch(`/api/books/${book.id}`, { favorite: next }).then(
      () => router.refresh(),
      () => setFavorite(!next),
    );
  };

  const physical = book.kind === "shadow_book" || book.kind === "picture_book";
  const canCreate = book.kind !== "classic" && book.kind !== "own_text";
  const emojiOf = new Map(profiles.map((p) => [p.id, p.avatar]));
  // A book in the library is usually opened to hear it again, so its stories come first and making a new one second.
  const hasStories = stories.length > 0;
  const canAdd = canCreate || (physical && pages.length > 0) || book.kind === "classic";

  const quickStory = async () => {
    setBusy(true);
    setError(null);
    try {
      const base =
        lastCreate ??
        defaultSettings({
          source: book.kind === "wild" ? "wild" : book.kind === "idea" ? "idea" : "book",
          chime: { enabled: physical, style: "bell", gapSeconds: 3 },
          heroes: currentProfile ? [currentProfile.name] : [],
        });
      // One tap makes one story: no pictures planned along the way (a story can become a picture book from its page).
      const settings: StorySettings = { ...base, surprise: true, review: false, pictures: false };
      const { id } = await api.post<{ id: string }>("/api/stories", { bookId: book.id, mode: "create", settings });
      router.push(`/stories/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The storyteller couldn't start.");
      setBusy(false);
    }
  };

  const save = async () => {
    try {
      await api.patch(`/api/books/${book.id}`, { title, shelf, folder });
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save.");
    }
  };

  const remove = async () => {
    if (!confirm(`Take "${book.title}" off the shelves? Its ${stories.length} stories will be deleted too.`)) return;
    try {
      await api.del(`/api/books/${book.id}`);
      router.push("/library");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    }
  };

  return (
    <>
      {book.folder ? (
        <Link href={folderHref(book.folder)} className="back-link">
          ‹ Back to {book.folder}
        </Link>
      ) : (
        <Link href="/library" className="back-link">
          ‹ Back to the library
        </Link>
      )}
      <div className="book-header">
        <div className="book">
          <div className="book-cover">
            <Cover id={book.id} title={book.title} kind={book.kind} coverUrl={book.coverUrl} notes={book.notes} />
          </div>
          <button
            type="button"
            className="fav-star"
            aria-pressed={favorite}
            aria-label={favorite ? `Take ${book.title} out of favorites` : `Make ${book.title} a favorite`}
            onClick={toggleFavorite}
          >
            {favorite ? "★" : "☆"}
          </button>
        </div>
        <div className="stack">
          <div>
            <div className="eyebrow">
              {/* The shelf says what kind of book it is, unless the family has put it on a shelf of their own. */}
              {BOOK_KINDS[book.kind].emoji} {book.shelf === DEFAULT_SHELVES[book.kind] ? book.shelf : `${BOOK_KINDS[book.kind].label} · ${book.shelf}`}
              {book.folder && (
                <>
                  {" · "}
                  <Link href={folderHref(book.folder)}>📁 {book.folder}</Link>
                </>
              )}
            </div>
            {editing ? (
              <div className="stack" style={{ maxWidth: 460 }}>
                <label className="field">
                  <span>Its name</span>
                  <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="field">
                  <span>Its shelf</span>
                  <input className="input" list="shelves" value={shelf} onChange={(e) => setShelf(e.target.value)} />
                </label>
                <datalist id="shelves">
                  {[...new Set([...shelves, ...Object.values(DEFAULT_SHELVES)])].map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <label className="field">
                  <span>Keep it in a folder</span>
                  <input className="input" list="folders" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Not in a folder" maxLength={40} />
                </label>
                <datalist id="folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
                <div className="row">
                  <button className="btn btn-sm" onClick={save}>
                    Save
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button className="btn btn-quiet btn-sm" onClick={remove} style={{ color: "var(--danger)" }}>
                    Remove book
                  </button>
                </div>
              </div>
            ) : (
              <h1 style={{ marginBottom: 4 }}>{book.title}</h1>
            )}
            {book.author && <p className="muted">by {book.author}</p>}
            {pages.length > 0 && <p className="faint small">{pages.length} page photos</p>}
          </div>

          {error && <p className="notice notice-error">{error}</p>}

          {hasStories && (
            <div className="book-stories">
              <Plaque label={stories.length === 1 ? "Your story" : `Your ${stories.length} stories`} wide />
              <div className="story-list">
                {stories.map((s) => (
                  <div key={s.id} className="book-story">
                    <StoryCardView story={s} inBook profileEmoji={s.profileId ? emojiOf.get(s.profileId) : undefined} />
                    <StoryKeep story={s} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {canAdd && (
            <div className="book-make">
              <Plaque label={hasStories ? "Add another story" : "Make a story for this book"} wide />
              <div className="make-cards">
                {canCreate && (
                  <button type="button" className="make-card" onClick={quickStory} disabled={busy || !canMake}>
                    <span className="make-card-emoji">✨</span>
                    <span>
                      <b>{busy ? "Summoning the storyteller…" : "Quick create"}</b>
                      <span className="small">
                        One tap: a brand-new story {book.kind === "idea" ? "on the same idea" : "for these pictures"}
                        {lastCreate ? ", with the same voices and length as last time" : ""}
                        {lastCreate?.language ? ` (in ${LANGUAGES[languageOf(lastCreate.language)].name})` : ""}.
                      </span>
                    </span>
                  </button>
                )}
                {canCreate && (
                  <Link className="make-card" href={`/create?book=${book.id}`}>
                    <span className="make-card-emoji">🎨</span>
                    <span>
                      <b>Choose the details</b>
                      <span className="small">Pick how long it is, what kind of story, who&apos;s in it, and who reads it.</span>
                    </span>
                  </Link>
                )}
                {physical && pages.length > 0 && (
                  <Link className="make-card" href={`/read?book=${book.id}`}>
                    <span className="make-card-emoji">🎧</span>
                    <span>
                      <b>Read the book&apos;s own words</b>
                      <span className="small">The words printed on your pages, read aloud just as they are.</span>
                    </span>
                  </Link>
                )}
                {book.kind === "classic" && (
                  <Link className="make-card" href={`/read?classic=${book.sourceRef}`}>
                    <span className="make-card-emoji">📜</span>
                    <span>
                      <b>Read another chapter</b>
                      <span className="small">Choose the next chapter of this book to hear.</span>
                    </span>
                  </Link>
                )}
              </div>
            </div>
          )}
          {!editing && (
            <button
              className="btn btn-quiet btn-sm"
              onClick={() => {
                // as the book is now (a folder's name may have been matched to one the family already has)
                setTitle(book.title);
                setShelf(book.shelf);
                setFolder(book.folder ?? "");
                setEditing(true);
              }}
              style={{ alignSelf: "flex-start" }}
            >
              ✎ Rename, move or remove
            </button>
          )}
        </div>
      </div>

      {pages.length > 0 && (
        <section className="section">
          <Plaque label="The pages" wide />
          <div className="page-strip">
            {pages.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p.id} src={p.imageUrl} alt={`Page ${p.pageNumber}`} loading="lazy" />
            ))}
          </div>
        </section>
      )}

    </>
  );
}

/** A finished story to keep or share: as a PDF book (with its pictures, when it has them), and its recording as an MP3. */
function StoryKeep({ story }: { story: StoryCard }) {
  if (story.status !== "ready" || (!story.pdf && !story.audioUrl)) return null;
  return (
    <div className="story-keep">
      {story.pdf && <PdfShare storyId={story.id} title={story.title} seconds={story.pdf.seconds} label="📄 Share as a PDF" />}
      {story.audioUrl && (
        <a className="btn btn-ghost btn-sm" href={`${story.audioUrl.split("?")[0]}?download=${encodeURIComponent(`${story.title}.mp3`)}`}>
          ⬇️ Save the MP3
        </a>
      )}
    </div>
  );
}

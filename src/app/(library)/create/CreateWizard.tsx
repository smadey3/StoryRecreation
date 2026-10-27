"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/components/Grownup";
import { ChimePicker, PhotoPicker, SoundsPicker, VoicePicker, soundsOf, useVoices } from "@/components/Pickers";
import { BookPicker } from "@/components/BookPicker";
import { Steps, toTop } from "@/components/Steps";
import { CreditButton, CreditNote } from "@/components/Credits";
import { StylePicker, bookEstimate } from "@/components/PictureBook";
import { DEFAULT_ART_STYLE, formatMoney, storytellerCost } from "@/lib/shared/art";
import type { PickedPhoto } from "@/lib/client/images";
import { newShelving, shelfTrouble, shelfWords, shelveBook, type Shelving } from "@/lib/client/shelve";
import { AGES, LENGTHS, MOODS, defaultSettings, estimateMinutes, madeUpBookTitle } from "@/lib/shared/options";
import { LANGUAGES, languageOf } from "@/lib/shared/languages";
import type { AgeBand, AppStatus, Book, LengthPreset, Mood, Profile, StoryLanguage, StorySettings, VoiceLabel, WriteCosts } from "@/lib/shared/types";

type Source = "book" | "wild" | "idea";

/** A story the family made, to make another like it. */
interface PastStory {
  id: string;
  title: string;
  bookId: string;
  bookTitle: string;
  settings: StorySettings;
  createdAt: number;
  narrator: VoiceLabel | null;
}

/** How a story was made (storyteller, length, mood, sounds, who's in it), without what it was about. */
/** What a story was made from: a book, something seen, or an idea. */
const sourceOf = (story: PastStory): Source => (story.settings.source === "wild" || story.settings.source === "idea" ? story.settings.source : "book");

function madeLike(story: PastStory): { source: Source; settings: StorySettings } {
  const { description: _description, classic: _classic, text: _text, ...how } = story.settings;
  const source = sourceOf(story);
  return { source, settings: defaultSettings({ ...how, source, description: "", chime: { ...how.chime, enabled: source === "book" } }) };
}

const LESSONS = ["Kindness", "Being brave", "Sharing", "Trying new things", "Patience", "Being yourself", "Friendship", "Saying sorry"];

function ageBandFor(age: number | null | undefined): AgeBand {
  if (age == null) return "4-5";
  if (age <= 3) return "2-3";
  if (age <= 5) return "4-5";
  if (age <= 8) return "6-8";
  return "9-12";
}

export function CreateWizard({
  books,
  profiles,
  currentProfile,
  preselect,
  preselectSettings,
  preselectNarrator,
  past,
  like,
  status,
  writeCosts,
}: {
  books: Book[];
  profiles: Profile[];
  currentProfile: Profile | null;
  preselect: Book | null;
  preselectSettings: StorySettings | null;
  /** Arrived to make a story read by someone in particular (a loved one, from Home). */
  preselectNarrator: string | null;
  /** Stories the family has made, newest first, for "make one like…". */
  past: PastStory[];
  /** Arrived from "Make another like this" on a story's page. */
  like: string | null;
  status: AppStatus;
  /** About what writing a story costs, by length. */
  writeCosts: WriteCosts;
}) {
  const api = useApi();
  const router = useRouter();
  const voices = useVoices();

  const liked0 = like ? (past.find((s) => s.id === like) ?? null) : null;
  const initialSource: Source = preselect
    ? preselect.kind === "wild"
      ? "wild"
      : preselect.kind === "idea"
        ? "idea"
        : "book"
    : liked0
      ? madeLike(liked0).source
      : "book";
  // A book already chosen goes straight to the details, unless it came with a story to make one like.
  const [step, setStep] = useState(preselect && !like ? 1 : 0);
  const goTo = (next: number) => {
    setStep(next);
    toTop();
  };
  const [source, setSource] = useState<Source>(initialSource);
  const [bookId, setBookId] = useState<string>(preselect?.id ?? "");
  const [title, setTitle] = useState("");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  // A fresh start: Storyhollow's own choices (or, for a book already chosen, how its last story was made).
  const fresh = (src: Source) =>
    defaultSettings({
      ...(preselectSettings ?? {}),
      source: src,
      age: preselectSettings?.age ?? ageBandFor(currentProfile?.age),
      heroes: preselectSettings?.heroes ?? (currentProfile ? [currentProfile.name] : []),
      narratorVoiceId: preselectNarrator ?? preselectSettings?.narratorVoiceId ?? null,
      chime: preselectSettings?.chime ?? { enabled: src === "book", style: "bell", gapSeconds: 3 },
      review: true,
    });
  const physicalBooks = books.filter((b) => (b.kind === "shadow_book" || b.kind === "picture_book") && b.pageCount > 0);
  const chosenBook = bookId ? books.find((b) => b.id === bookId) : undefined;
  const [settings, setSettings] = useState<StorySettings>(() => (liked0 ? madeLike(liked0).settings : fresh(initialSource)));
  // "Make one like…": which story it's like (if any), and whether the list to choose from is open.
  const [likedId, setLikedId] = useState<string | null>(liked0?.id ?? null);
  const [choosing, setChoosing] = useState(false);
  const [likeQuery, setLikeQuery] = useState("");
  const liked = likedId ? past.find((s) => s.id === likedId) : undefined;
  const makeLike = (story: PastStory) => {
    const l = madeLike(story);
    setSource(l.source);
    setSettings(l.settings);
    setLikedId(story.id);
    setChoosing(false);
    setLikeQuery("");
    // A book story with no book chosen yet is made for that story's book; a book already chosen stays chosen.
    if (l.source === "book" && !physicalBooks.some((b) => b.id === bookId) && physicalBooks.some((b) => b.id === story.bookId)) setBookId(story.bookId);
  };
  const startFresh = () => {
    setLikedId(null);
    setChoosing(false);
    setSettings(fresh(source));
  };
  // The story to suggest: the last one made for the chosen book; with no book chosen yet, the last book story (or the last of any
  // kind); for something seen or an idea, the last of the same kind.
  const forChosen = source === "book" && chosenBook ? past.find((s) => s.bookId === chosenBook.id) : undefined;
  const sameKind = past.find((s) => sourceOf(s) === source);
  const suggestion = forChosen ?? (source !== "book" ? sameKind : chosenBook ? undefined : (sameKind ?? past[0]));
  // Quick create is for the start. Once the family is into their own story's details it only distracts, so it steps aside,
  // unless they've already chosen a story to make it like.
  const begun =
    source === "book"
      ? Boolean(chosenBook && !forChosen)
      : Boolean(title.trim() || settings.description.trim() || (source === "wild" ? photos.length > 0 : settings.pictures));
  const quick = Boolean(liked) || (!begun && Boolean(suggestion));
  const lq = likeQuery.trim().toLowerCase();
  const likeOptions = lq ? past.filter((s) => s.title.toLowerCase().includes(lq) || s.bookTitle.toLowerCase().includes(lq)) : past;
  const howItWasMade = (s: PastStory) =>
    [
      s.narrator ? `${s.narrator.emoji} ${s.narrator.name}` : null,
      LENGTHS[s.settings.length].label,
      s.settings.language ? `in ${LANGUAGES[languageOf(s.settings.language)].name}` : null,
      s.settings.heroes.join(" & ") || null,
    ]
      .filter(Boolean)
      .join(" · ");
  const [customHero, setCustomHero] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A new book's photos already sent, so trying again carries on.
  const shelving = useRef<Shelving | null>(null);

  const set = <K extends keyof StorySettings>(k: K, v: StorySettings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const language = languageOf(settings.language);
  // Another language is for someone learning it, to begin with (most families who ask are).
  const chooseLanguage = (l: StoryLanguage) =>
    setSettings(({ language: _, learner, ...s }) => (l === "en" ? s : { ...s, language: l, learner: learner ?? true }));

  const pageCount =
    source === "book"
      ? chosenBook?.pageCount ?? 0
      : source === "wild"
        ? Math.max(photos.length, settings.length === "short" ? 4 : settings.length === "long" ? 9 : 6)
        : settings.length === "short" ? 4 : settings.length === "long" ? 9 : 6;

  const pickSource = (s: Source) => {
    setSource(s);
    setSettings((cur) => ({ ...cur, source: s, chime: { ...cur.chime, enabled: s === "book" } }));
  };

  const sourceReady =
    source === "book"
      ? Boolean(chosenBook && chosenBook.pageCount > 0)
      : source === "wild"
        ? (chosenBook && chosenBook.kind === "wild") || photos.length > 0
        : settings.description.trim().length >= 8;

  const words = useMemo(() => {
    const minutes = source === "book" ? estimateMinutes(settings.length, Math.max(1, pageCount)) : LENGTHS[settings.length].minutes;
    return { minutes, chars: Math.round(minutes * 140 * 6) };
  }, [settings.length, pageCount, source]);

  // The book the story is for: one already on the shelf, or (with none) a new one, which joins the folder of the
  // story it's made like, so a series stays together.
  const forBook = chosenBook && (source === "book" || chosenBook.kind === source) ? chosenBook.id : "";
  const likedFolder = !forBook && liked && sourceOf(liked) === source ? (books.find((b) => b.id === liked.bookId)?.folder ?? null) : null;

  const toggleHero = (name: string) =>
    set("heroes", settings.heroes.includes(name) ? settings.heroes.filter((h) => h !== name) : [...settings.heroes, name]);

  const conjure = async () => {
    setError(null);
    let id = forBook;
    if (!id) {
      // The photos go up one at a time; trying again carries on, and never shelves the book twice.
      // A book nobody names takes its first story's title once the storyteller has written it.
      const kind = source === "book" ? "picture_book" : source;
      const s = (shelving.current ??= newShelving());
      setBusy("Putting the book on the shelf…");
      try {
        const book = {
          title: title.trim() || madeUpBookTitle(kind, settings.description),
          kind: source,
          notes: settings.description || undefined,
          folder: likedFolder ?? undefined,
        };
        id = await shelveBook(api, s, book, photos, (step) => setBusy(shelfWords(step, "Putting the book on the shelf…")));
      } catch (err) {
        setError(shelfTrouble(err, s, photos.length, "the same button"));
        setBusy(null);
        return;
      }
    }
    try {
      setBusy("Summoning the storyteller…");
      const story = await api.post<{ id: string }>("/api/stories", {
        bookId: id,
        mode: "create",
        settings: { ...settings, source },
        profileId: currentProfile?.id ?? null,
      });
      router.push(`/stories/${story.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The storyteller couldn't start.");
      setBusy(null);
    }
  };

  const STEPS = ["The pictures", "The story", "Voices & sounds", "Conjure"];

  // What it costs, before anything is spent: the storyteller's time, and the pictures (bought later, with the PIN).
  const pictureBook = source === "idea" && Boolean(settings.pictures);
  const planning = pictureBook
    ? storytellerCost(status.storytellerRates, 3_000 + LENGTHS[settings.length].minutes * 140 * 1.5, 2_500 + pageCount * 150)
    : 0;
  const costs = (
    <p className="faint small center" style={{ margin: 0 }}>
      Writing it{language !== "en" ? " (and every page in English too)" : ""}
      {pictureBook ? " and planning the pictures" : ""}: about {formatMoney(writeCosts[settings.length] * (language !== "en" ? 1.4 : 1) + planning)} of
      storyteller time.
      {pictureBook &&
        ` Pictures: about ${formatMoney(bookEstimate(pageCount, status.picturePrice))}${status.illustrator ? "" : " once the illustrator is set up (free stand-ins until then)"}, approved before any are drawn.`}
    </p>
  );

  return (
    <>
      <div className="center" style={{ marginBottom: 16 }}>
        <div className="eyebrow">Create a New Story</div>
        <h1>{["What story shall we create?", "Shape the story", "Voices & sounds", "Ready to conjure"][step]}</h1>
      </div>
      <Steps labels={STEPS} step={step} onGo={goTo} />

      <div className="parchment stack" style={{ ["--gap" as string]: "26px" }}>
        {step === 0 && (
          <>
            <div className="choices" style={{ ["--min" as string]: "180px" }} role="radiogroup" aria-label="Story source">
              {(
                [
                  ["book", "📖", "A book we own", "Snap each page, and get a brand-new story for the same pictures."],
                  ["wild", "🌿", "Something we saw", "A puddle, a snail, a castle made of sofa cushions…"],
                  ["idea", "💭", "Just an idea", "Describe it, and the storyteller dreams it up."],
                ] as const
              ).map(([value, emoji, label, sub]) => (
                <button key={value} type="button" className="choice" role="radio" aria-checked={source === value} onClick={() => pickSource(value)}>
                  <span className="choice-emoji">{emoji}</span>
                  <span className="choice-title">{label}</span>
                  <span className="choice-sub">{sub}</span>
                </button>
              ))}
            </div>

            {source === "book" && (
              <div className="stack">
                <div>
                  <span className="label">Which book?</span>
                  <BookPicker
                    books={physicalBooks}
                    value={bookId}
                    onChange={setBookId}
                    addHref="/books/new?then=create"
                    detail={(b) =>
                      `${b.pageCount} ${b.pageCount === 1 ? "page" : "pages"} · ${b.storyCount} ${b.storyCount === 1 ? "story" : "stories"}`
                    }
                  />
                </div>
              </div>
            )}

            {source === "wild" && (
              <div className="stack">
                <label className="field">
                  <span>Name this adventure</span>
                  <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The Great Puddle Expedition" />
                </label>
                <div>
                  <span className="label">Photos from the adventure</span>
                  <PhotoPicker photos={photos} onChange={setPhotos} label="Photo" max={12} />
                </div>
                <label className="field">
                  <span>Tell the storyteller about it (optional)</span>
                  <textarea
                    className="textarea"
                    value={settings.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="We found a snail on the garden wall and Leo named him Professor Slime. He was very slow and very shiny."
                  />
                </label>
              </div>
            )}

            {source === "idea" && (
              <div className="stack">
                <label className="field">
                  <span>What should the story be about?</span>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 130 }}
                    value={settings.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="A dragon who is afraid of the dark, and a firefly who helps him."
                  />
                </label>
                <label className="field">
                  <span>A title (optional)</span>
                  <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The storyteller will choose one" />
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(settings.pictures)}
                    onChange={(e) => setSettings((cur) => ({ ...cur, pictures: e.target.checked, artStyle: cur.artStyle ?? DEFAULT_ART_STYLE }))}
                  />
                  <span>
                    <b>📖 Make it a picture book</b>
                    <span className="muted small">
                      The illustrator draws a cover and a picture for every page. You&apos;ll meet the characters first. The pictures cost a
                      little extra.
                    </span>
                  </span>
                </label>
                {settings.pictures && <StylePicker value={settings.artStyle ?? DEFAULT_ART_STYLE} onChange={(s) => set("artStyle", s)} />}
              </div>
            )}
            {quick && (
              <div>
                <span className="label">Quick create</span>
                <div className="like-panel">
                  {liked ? (
                    <>
                      <div>
                        {source === "book" && chosenBook && chosenBook.id !== liked.bookId ? (
                          <>
                            <b>A new &ldquo;{chosenBook.title}&rdquo; story</b>, like &ldquo;{liked.title}&rdquo;
                          </>
                        ) : (
                          <>
                            <b>Like &ldquo;{liked.title}&rdquo;</b>
                          </>
                        )}
                        <div className="small muted">{howItWasMade(liked)}</div>
                        {likedFolder && <div className="small muted">📁 The new book goes in the folder &ldquo;{likedFolder}&rdquo;, with it.</div>}
                      </div>
                      <div className="row">
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setChoosing(!choosing)}>
                          Choose another
                        </button>
                        <button type="button" className="btn btn-quiet btn-sm" onClick={startFresh}>
                          Start fresh
                        </button>
                      </div>
                    </>
                  ) : suggestion ? (
                    <>
                      <div>
                        {forChosen && chosenBook ? (
                          <>
                            Make it like the last &ldquo;{chosenBook.title}&rdquo; story, <b>&ldquo;{suggestion.title}&rdquo;</b>?
                          </>
                        ) : (
                          <>
                            Make one like <b>&ldquo;{suggestion.title}&rdquo;</b>?
                          </>
                        )}
                        <div className="small muted">{howItWasMade(suggestion)}</div>
                      </div>
                      <div className="row">
                        <button type="button" className="btn btn-sm" onClick={() => makeLike(suggestion)}>
                          Yes, like that one
                        </button>
                        {past.length > 1 && (
                          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setChoosing(!choosing)}>
                            Choose another
                          </button>
                        )}
                      </div>
                    </>
                  ) : null}
                  {choosing && past.length > 8 && (
                    <input
                      className="input like-search"
                      type="search"
                      value={likeQuery}
                      onChange={(e) => setLikeQuery(e.target.value)}
                      placeholder={`🔍 Find one of your ${past.length} stories`}
                      aria-label="Find a story"
                    />
                  )}
                  {choosing && (
                    <div className="like-list" role="radiogroup" aria-label="Make one like">
                      {lq && likeOptions.length === 0 && <p className="small muted" style={{ margin: 0 }}>No story or book by that name.</p>}
                      {likeOptions.map((s) => (
                        <button key={s.id} type="button" role="radio" aria-checked={s.id === likedId} className="like-option" onClick={() => makeLike(s)}>
                          <b>{s.title}</b>
                          <span className="small muted">
                            {[s.bookTitle !== s.title ? s.bookTitle : null, howItWasMade(s)].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <div>
              <span className="label">How long?</span>
              <div className="choices" style={{ ["--min" as string]: "150px" }} role="radiogroup" aria-label="Length">
                {(Object.keys(LENGTHS) as LengthPreset[]).map((l) => (
                  <button key={l} type="button" className="choice" role="radio" aria-checked={settings.length === l} onClick={() => set("length", l)}>
                    <span className="choice-emoji">{l === "short" ? "🌱" : l === "medium" ? "🌳" : "🌲"}</span>
                    <span className="choice-title">{LENGTHS[l].label}</span>
                    <span className="choice-sub">
                      {source === "book" && pageCount ? `About ${estimateMinutes(l, pageCount)} min` : LENGTHS[l].blurb}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="label">What kind of story?</span>
              <div className="choices" style={{ ["--min" as string]: "130px" }} role="radiogroup" aria-label="Mood">
                {(Object.keys(MOODS) as Mood[]).map((m) => (
                  <button key={m} type="button" className="choice" role="radio" aria-checked={settings.mood === m} onClick={() => set("mood", m)}>
                    <span className="choice-emoji">{MOODS[m].emoji}</span>
                    <span className="choice-title">{MOODS[m].label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="label">Who's listening?</span>
              <div className="chips" role="radiogroup" aria-label="Age">
                {(Object.keys(AGES) as AgeBand[]).map((a) => (
                  <button key={a} type="button" className="chip" aria-pressed={settings.age === a} onClick={() => set("age", a)}>
                    {AGES[a].label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="label">In which language?</span>
              <div className="chips" role="radiogroup" aria-label="Language">
                {(Object.keys(LANGUAGES) as StoryLanguage[]).map((l) => (
                  <button key={l} type="button" className="chip" aria-pressed={language === l} onClick={() => chooseLanguage(l)}>
                    {l === "en" ? "English" : `${LANGUAGES[l].native} · ${LANGUAGES[l].name}`}
                  </button>
                ))}
              </div>
              {language !== "en" && (
                <>
                  <p className="hint">
                    Told all in {LANGUAGES[language].name}, voices too. The English of every page is on the screen when you want it.
                  </p>
                  <label className="toggle" style={{ marginTop: 10 }}>
                    <input type="checkbox" checked={Boolean(settings.learner)} onChange={(e) => set("learner", e.target.checked)} />
                    <span>
                      <b>For someone learning {LANGUAGES[language].name}</b>
                      <span className="muted small">
                        Simple words and short sentences, at a gentle pace. Turn off for a story told just as a {LANGUAGES[language].name}-speaking
                        child would hear it.
                      </span>
                    </span>
                  </label>
                </>
              )}
            </div>
            <div>
              <span className="label">Star of the story</span>
              <p className="hint" style={{ marginTop: 0 }}>
                Put a listener right inside the tale. Or leave it to the book's own characters.
              </p>
              <div className="chips">
                {[...new Set([...profiles.map((p) => p.name), ...settings.heroes])].map((name) => {
                  const p = profiles.find((x) => x.name === name);
                  return (
                    <button key={name} type="button" className="chip" aria-pressed={settings.heroes.includes(name)} onClick={() => toggleHero(name)}>
                      {p?.avatar ?? "⭐"} {name}
                    </button>
                  );
                })}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (customHero.trim()) set("heroes", [...new Set([...settings.heroes, customHero.trim()])]);
                    setCustomHero("");
                  }}
                  className="row"
                  style={{ gap: 6 }}
                >
                  <input
                    className="input"
                    value={customHero}
                    onChange={(e) => setCustomHero(e.target.value)}
                    placeholder="Add a name (a pet? Grandpa?)"
                    style={{ width: 230, padding: "6px 12px" }}
                  />
                  <button className="chip" type="submit">
                    ＋
                  </button>
                </form>
              </div>
            </div>
            <div>
              <span className="label">A little something to learn (optional)</span>
              <div className="chips">
                {LESSONS.map((l) => (
                  <button key={l} type="button" className="chip" aria-pressed={settings.lesson === l} onClick={() => set("lesson", settings.lesson === l ? "" : l)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>Any special wishes?</span>
              <textarea
                className="textarea"
                value={settings.extra}
                onChange={(e) => set("extra", e.target.value)}
                placeholder="Make the moon a character. Include our dog, Biscuit. A joke about socks, please!"
              />
            </label>
            {source === "book" && (
              <label className="toggle">
                <input type="checkbox" checked={settings.keepNames} onChange={(e) => set("keepNames", e.target.checked)} />
                <span>
                  <b>Keep the characters' names from the book</b>
                  <span className="muted small">
                    The friends your children know, off on a brand-new adventure. Turn off for all-new names.
                  </span>
                </span>
              </label>
            )}
            <label className="toggle">
              <input type="checkbox" checked={settings.surprise} onChange={(e) => set("surprise", e.target.checked)} />
              <span>
                <b>Surprise us 🎲</b>
                <span className="muted small">An unexpected twist: a new hero, a new point of view, a different kind of tale.</span>
              </span>
            </label>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <span className="label">Who should tell the story?</span>
              <VoicePicker voices={voices} value={settings.narratorVoiceId} onChange={(v) => set("narratorVoiceId", v)} language={settings.language} />
            </div>
            <label className="toggle">
              <input type="checkbox" checked={settings.fullCast} onChange={(e) => set("fullCast", e.target.checked)} />
              <span>
                <b>A full cast of voices</b>
                <span className="muted small">
                  Every character gets their own voice: a creaky old owl, a squeaky mouse, a booming giant.
                </span>
              </span>
            </label>
            <ChimePicker value={settings.chime} onChange={(c) => set("chime", c)} />
            <label className="toggle">
              <input type="checkbox" checked={settings.intro} onChange={(e) => set("intro", e.target.checked)} />
              <span>
                <b>A welcome at the start</b>
                <span className="muted small">
                  “Welcome to Storyhollow… you'll know it's time to turn the page when you hear this sound.”
                </span>
              </span>
            </label>
            <SoundsPicker
              value={soundsOf(settings)}
              onChange={(v) => {
                set("effects", v === "effects");
                set("ambience", v === "soundscape");
              }}
            />
          </>
        )}

        {step === 3 && (
          <>
            <div className="center stack">
              <p style={{ fontSize: "1.15rem" }}>
                A <b>{MOODS[settings.mood].label.toLowerCase()}</b> story,{" "}
                <b>{LENGTHS[settings.length].label.toLowerCase()}</b> (about {words.minutes} minutes)
                {source === "book" ? ` for ${pageCount} pages` : ""}, for <b>{AGES[settings.age].label.toLowerCase()}</b>
                {settings.heroes.length ? (
                  <>
                    , starring <b>{settings.heroes.join(" & ")}</b>
                  </>
                ) : null}
                {pictureBook ? ", as a picture book" : ""}
                {language !== "en" ? (
                  <>
                    , in <b>{LANGUAGES[language].name}</b>
                    {settings.learner ? " for a learner" : ""}
                  </>
                ) : null}
                .
              </p>
              <p className="muted">
                {settings.fullCast ? "A full cast of voices" : "One storyteller"}
                {settings.chime.enabled ? `, a ${settings.chime.style === "bell" ? "bell" : settings.chime.style === "sparkle" ? "sparkle" : "wind chime"} to turn each page` : ""}
                {settings.effects ? ", and a few sound effects" : settings.ambience ? ", and a soft soundscape" : ""}.
              </p>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={settings.review} onChange={(e) => set("review", e.target.checked)} />
              <span>
                <b>Let me read it before the voices record it</b>
                <span className="muted small">
                  Tweak any words, swap voices, then record. Turn off to go straight to listening.
                </span>
              </span>
            </label>
            {costs}
            <CreditNote needed={words.chars} />
            {error && <p className="notice notice-error">{error}</p>}
            <div className="center">
              <CreditButton needed={words.chars} className="btn btn-lg" onClick={conjure} disabled={Boolean(busy)}>
                {busy ?? "✨ Conjure the story"}
              </CreditButton>
            </div>
          </>
        )}

        <div className="spread">
          {step > 0 ? (
            <button className="btn btn-ghost" type="button" onClick={() => goTo(step - 1)} disabled={Boolean(busy)}>
              ← Back
            </button>
          ) : (
            <span />
          )}
          {step === 0 && liked ? (
            <div className="row">
              <button className="btn btn-ghost" type="button" onClick={() => goTo(1)} disabled={!sourceReady || Boolean(busy)}>
                Change the details
              </button>
              <CreditButton needed={words.chars} className="btn" onClick={conjure} disabled={!sourceReady || Boolean(busy)}>
                {busy ?? "✨ Make my story"}
              </CreditButton>
            </div>
          ) : (
            step < 3 && (
              <button className="btn" type="button" onClick={() => goTo(step + 1)} disabled={step === 0 && !sourceReady}>
                Next →
              </button>
            )
          )}
        </div>
        {step === 0 && liked && sourceReady && (
          <>
            {costs}
            <CreditNote needed={words.chars} />
          </>
        )}
        {step === 0 && error && <p className="notice notice-error">{error}</p>}
      </div>
    </>
  );
}

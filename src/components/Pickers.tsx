"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pickPhotos, type PickedPhoto } from "@/lib/client/images";
import { previewChime, previewVoice, useVoicePreview } from "@/lib/client/sound";
import { CHIMES } from "@/lib/shared/options";
import type { ChimeSettings, ChimeStyle, StoryLanguage, VoiceOption } from "@/lib/shared/types";
import { FamilyVoiceWindow } from "./FamilyVoices";
import { useApi } from "./Grownup";
import { SideArrows, useSideScroll } from "./Shelf";
import { VoiceDesigner } from "./VoiceDesigner";

// ------------------------------------------------------------------ photos

export function PhotoPicker({
  photos,
  onChange,
  label = "Page",
  max = 60,
}: {
  photos: PickedPhoto[];
  onChange: (p: PickedPhoto[]) => void;
  label?: string;
  max?: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState("");

  // Many photos at once: from the photo library, or dragged onto the page.
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setNote("");
    setBusy("Developing…");
    const { photos: picked, extra } = await pickPhotos(files, max - photos.length, (done, total) =>
      setBusy(total > 1 ? `Developing ${done + 1} of ${total}…` : "Developing…"),
    );
    onChange([...photos, ...picked]);
    if (extra > 0) setNote(`${max} ${label.toLowerCase()}s is the most for one story, so ${extra} ${extra === 1 ? "photo wasn't" : "photos weren't"} added.`);
    setBusy(null);
  };
  const move = (i: number, d: number) => {
    const next = [...photos];
    const [p] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, p);
    onChange(next);
  };
  const remove = (i: number) => onChange(photos.filter((_, j) => j !== i));

  return (
    <div
      className={`photo-picker${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files") || photos.length >= max) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void add(e.dataTransfer.files);
      }}
    >
      {photos.length > 1 && (
        <div className="row" style={{ justifyContent: "flex-end", marginBottom: 10 }}>
          <span className="hint" style={{ margin: 0, marginRight: "auto" }}>
            Out of order? The storyteller also reads printed page numbers and sorts them out.
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...photos].reverse())}>
            ⇅ Reverse order
          </button>
        </div>
      )}
      <div className="photo-grid">
        {photos.map((p, i) => (
          <div className="photo" key={p.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.url} alt={`${label} ${i + 1}`} />
            <span className="photo-num">{i + 1}</span>
            <div className="photo-tools">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${label} ${i + 1} earlier`}>
                ←
              </button>
              <button type="button" onClick={() => remove(i)} aria-label={`Remove ${label} ${i + 1}`}>
                ✕
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === photos.length - 1}
                aria-label={`Move ${label} ${i + 1} later`}
              >
                →
              </button>
            </div>
          </div>
        ))}
        {photos.length < max && (
          <>
            <button type="button" className="dropzone" onClick={() => camRef.current?.click()} disabled={!!busy}>
              <b>📷</b>
              {busy ?? `Snap ${label.toLowerCase()} ${photos.length + 1}`}
            </button>
            <button type="button" className="dropzone" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              <b>🖼️</b>
              Choose photos
              <small>
                Pick several at once<span className="drop-hint">, or drop them here</span>
              </small>
            </button>
          </>
        )}
      </div>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      <input
        ref={camRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void add(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void add(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ voices

const VOICE_MADE = "storyhollow:voice-made";
const TIP_PUT_AWAY = "storyhollow:did-you-know-family-voices";

/**
 * A little "did you know?", like a small ad: someone you love can read too, and their voice can be made right here.
 * ✕ puts it away on this phone.
 */
function FamilyVoiceTip({ onMake }: { onMake: () => void }) {
  // Shown once the phone has said it wasn't put away (so it doesn't flash up and vanish).
  const [shown, setShown] = useState(false);
  useEffect(() => {
    try {
      setShown(localStorage.getItem(TIP_PUT_AWAY) !== "1");
    } catch {
      setShown(true);
    }
  }, []);
  if (!shown) return null;
  const putAway = () => {
    setShown(false);
    try {
      localStorage.setItem(TIP_PUT_AWAY, "1");
    } catch {
      // ignore
    }
  };
  return (
    <aside className="did-you-know" aria-label="Did you know?">
      <span className="did-you-know-face" aria-hidden="true">
        💛
      </span>
      <span>
        <span className="did-you-know-label">Did you know?</span>
        Someone you love can read to you, from an old voicemail or video.{" "}
        <button type="button" className="link-button did-you-know-go" onClick={onMake}>
          Make their voice →
        </button>
      </span>
      <button type="button" className="did-you-know-close" onClick={putAway} aria-label="Not now">
        ✕
      </button>
    </aside>
  );
}

/** A voice just made in the voice workshop: every list of voices on the page takes it in. */
export function announceVoice(voice: VoiceOption) {
  window.dispatchEvent(new CustomEvent<VoiceOption>(VOICE_MADE, { detail: voice }));
}

export function useVoices() {
  const api = useApi();
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  useEffect(() => {
    api
      .get<{ voices: VoiceOption[] }>("/api/voices")
      .then((r) => setVoices(r.voices))
      .catch(() => setVoices([]));
    const add = (e: Event) => {
      const v = (e as CustomEvent<VoiceOption>).detail;
      setVoices((cur) => (cur && !cur.some((x) => x.voiceId === v.voiceId) ? [v, ...cur] : cur));
    };
    window.addEventListener(VOICE_MADE, add);
    return () => window.removeEventListener(VOICE_MADE, add);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return voices;
}

/** Speak a short sample with the browser's voice when no recorded sample exists. */
function speakSample(text: string) {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

type VoiceFilter = "all" | "favorites" | "family" | "made" | "included";

const VOICE_FILTERS: { id: VoiceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "favorites", label: "⭐ Favorites" },
  { id: "family", label: "💛 Family" },
  { id: "made", label: "🪄 Made by you" },
  { id: "included", label: "🏰 Included" },
];

/** Family recordings, voices the family designed or cloned, or the storytellers that come with Storyhollow. */
const groupOf = (v: VoiceOption): VoiceFilter => (v.source === "family" ? "family" : v.persona || v.source === "default" ? "included" : "made");

export function VoicePicker({
  voices,
  value,
  onChange,
  allowAuto = true,
  narratorsOnly = true,
  language,
}: {
  voices: VoiceOption[] | null;
  value: string | null;
  onChange: (id: string | null) => void;
  allowAuto?: boolean;
  narratorsOnly?: boolean;
  /** The story's language: a voice made here is made speaking it. */
  language?: StoryLanguage;
}) {
  const api = useApi();
  const [filter, setFilter] = useState<VoiceFilter>("all");
  // A new voice, made right here: first how (someone the family loves, or one dreamed up in the voice workshop), then
  // making it. The voice that's made becomes the storyteller.
  const [making, setMaking] = useState<"choosing" | "family" | "dream" | null>(null);
  // A family voice just made: a word that they can read now.
  const [made, setMade] = useState<VoiceOption | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const preview = useVoicePreview();
  useEffect(() => {
    if (voices) setFavorites(new Set(voices.filter((v) => v.favorite).map((v) => v.voiceId)));
  }, [voices]);

  // The storytellers sit on one shelf you swipe along, so the cards stay big
  // however many voices the family collects.
  const loaded = voices !== null;
  const { ref: shelf, ends, measure, slide, overflows } = useSideScroll<HTMLDivElement>(`${loaded}-${filter}`);
  // Keep the chosen storyteller in view (a saved choice may be far along the shelf), without scrolling the page.
  useEffect(() => {
    const el = shelf.current;
    const chosen = el?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (el) el.scrollTo({ left: chosen ? chosen.offsetLeft - (el.clientWidth - chosen.clientWidth) / 2 : 0, behavior: "smooth" });
  }, [loaded, value, filter, shelf]);

  if (!voices) return <p className="muted">Gathering the storytellers…</p>;
  // family voices first: Grandma reading is the most special storyteller of all
  const family = voices.filter((v) => v.source === "family");
  const personas = voices.filter((v) => v.persona);
  const rest = voices.filter((v) => !v.persona && v.source !== "default" && v.source !== "family");
  const all = narratorsOnly ? [...family, ...personas, ...rest] : voices;
  const shown = all.filter((v) => filter === "all" || (filter === "favorites" ? favorites.has(v.voiceId) : groupOf(v) === filter));
  const withAuto = allowAuto && filter === "all";
  const count = shown.length + (withAuto ? 1 : 0);
  // Offer only the groups the family has, but always "Favorites", so the star has somewhere to lead.
  const filters = VOICE_FILTERS.filter((f) => f.id === "all" || f.id === "favorites" || all.some((v) => groupOf(v) === f.id));

  const hear = (v: VoiceOption) => {
    if (!preview.hear(v.voiceId, v.previewUrl)) speakSample(`Hello! I'm ${v.persona?.name ?? v.name}.`);
  };
  const toggleFavorite = (voiceId: string) => {
    const favorite = !favorites.has(voiceId);
    const flip = (on: boolean) =>
      setFavorites((cur) => {
        const next = new Set(cur);
        if (on) next.add(voiceId);
        else next.delete(voiceId);
        return next;
      });
    flip(favorite);
    api.post("/api/favorites", { voiceId, favorite }).catch(() => flip(!favorite));
  };

  return (
    <div>
      <div className="voice-filters" role="group" aria-label="Show storytellers">
        {filters.map((f) => (
          <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="voice-shelf-head">
        <span className="small" style={{ color: "var(--ink-soft)" }}>
          {count} {count === 1 ? "storyteller" : "storytellers"}
          {overflows ? " · swipe for more" : ""}
        </span>
        {overflows && <SideArrows ends={ends} slide={slide} what="storytellers" />}
      </div>
      {count === 0 ? (
        <p className="voice-empty">
          {filter === "favorites"
            ? "Tap the ☆ on a storyteller to keep them here."
            : filter === "made"
              ? "No voices made yet: make one below."
              : "No storytellers here yet."}
        </p>
      ) : (
        <div className="voice-grid" ref={shelf} onScroll={measure} role="radiogroup" aria-label="Storyteller">
          {withAuto && (
            <div
              className="voice-card"
              role="radio"
              tabIndex={0}
              aria-checked={value === null}
              onClick={() => onChange(null)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onChange(null)}
            >
              <span className="voice-face">🎭</span>
              <span className="voice-name">Casting director’s choice</span>
              <span className="voice-tag">The perfect voice for this story</span>
            </div>
          )}
          {shown.map((v) => {
            const name = v.persona?.name ?? v.name;
            const starred = favorites.has(v.voiceId);
            return (
              <div
                key={v.voiceId}
                className="voice-card"
                role="radio"
                tabIndex={0}
                aria-checked={value === v.voiceId}
                onClick={() => onChange(v.voiceId)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onChange(v.voiceId)}
              >
                <button
                  type="button"
                  className="fav-star"
                  aria-pressed={starred}
                  aria-label={starred ? `Take ${name} out of favorites` : `Make ${name} a favorite`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(v.voiceId);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {starred ? "★" : "☆"}
                </button>
                <span className="voice-face">{v.persona?.emoji ?? (v.source === "family" ? "💛" : v.source === "designed" ? "🪄" : "🗣️")}</span>
                <span className="voice-name">{name}</span>
                <span className="voice-tag">{v.persona?.tagline ?? v.description}</span>
                <button
                  type="button"
                  className="hear"
                  onClick={(e) => {
                    e.stopPropagation();
                    hear(v);
                  }}
                >
                  {preview.label(v.voiceId)}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {/* A family voice is only ever the storyteller, so it's offered where the storyteller is chosen. */}
      <div className="voice-make">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMaking(narratorsOnly ? "choosing" : "dream")}>
          🪄 Make a new voice
        </button>
        <span className="small" style={{ color: "var(--ink-soft)" }}>
          {narratorsOnly ? "Someone you love, from a voicemail or a video, or one you dream up." : "Describe one, hear three, and keep your favorite."}
        </span>
      </div>
      {made && value === made.voiceId && (
        <p className="notice small" role="status" style={{ margin: "10px 0 0" }}>
          💛 {made.name} can read stories now.
        </p>
      )}
      {/* No loved one's voice yet: a word that it's possible, and a way to make it right here. */}
      {narratorsOnly && family.length === 0 && <FamilyVoiceTip onMake={() => setMaking("family")} />}
      {making &&
        createPortal(
          making === "choosing" ? (
            <NewVoiceChooser onChoose={setMaking} onClose={() => setMaking(null)} />
          ) : making === "family" ? (
            <FamilyVoiceWindow
              onClose={() => setMaking(null)}
              onChosen={(v) => {
                // A voice just made joins every list of voices on the page; one the family had is simply chosen.
                if (!family.some((f) => f.voiceId === v.voiceId)) {
                  announceVoice(v);
                  setMade(v);
                }
                setMaking(null);
                setFilter("all");
                onChange(v.voiceId);
              }}
            />
          ) : (
            <VoiceDesigner
              initialLanguage={language}
              onClose={() => setMaking(null)}
              onSaved={(v) => {
                announceVoice({ ...v, gender: null, age: null, accent: null, previewUrl: null, persona: null, source: "designed" });
                setMaking(null);
                setFilter("all");
                onChange(v.voiceId);
              }}
            />
          ),
          document.body,
        )}
    </div>
  );
}

/** How to make a new storyteller: someone the family loves, from their recordings, or one dreamed up in the voice workshop. */
function NewVoiceChooser({ onChoose, onClose }: { onChoose: (way: "family" | "dream") => void; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="nv-title">
      <div className="modal parchment stack" style={{ width: "min(560px, 100%)" }}>
        <div className="spread">
          <div>
            <div className="eyebrow">A new storyteller</div>
            <h2 id="nv-title" style={{ margin: 0 }}>
              🪄 Make a new voice
            </h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" style={{ color: "#3a2616", background: "rgba(255,255,255,.4)" }}>
            ✕
          </button>
        </div>
        <button type="button" className="new-voice-way loved" onClick={() => onChoose("family")}>
          <span className="new-voice-face" aria-hidden="true">
            💛
          </span>
          <span>
            <span className="new-voice-name">Someone you love</span>
            <span className="new-voice-about">
              Grandma, Grandpa, a parent who&apos;s far away: from a voicemail, a video, or a minute of them reading aloud, they can
              read any story, in their own voice. Recordings stay private to your family.
            </span>
          </span>
        </button>
        <button type="button" className="new-voice-way" onClick={() => onChoose("dream")}>
          <span className="new-voice-face" aria-hidden="true">
            🪄
          </span>
          <span>
            <span className="new-voice-name">Dream one up</span>
            <span className="new-voice-about">Describe any voice (a sleepy old owl, a jolly pirate), hear three, and keep your favorite.</span>
          </span>
        </button>
      </div>
    </div>
  );
}

export function VoiceSelect({
  voices,
  value,
  onChange,
  id,
}: {
  voices: VoiceOption[];
  value: string;
  onChange: (id: string) => void;
  id?: string;
}) {
  const known = voices.some((v) => v.voiceId === value);
  return (
    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>Current voice</option>}
        {voices.map((v) => (
          <option key={v.voiceId} value={v.voiceId}>
            {v.persona ? `${v.persona.emoji} ${v.persona.name} (${v.name})` : `${v.source === "family" ? "💛 " : v.source === "designed" ? "🪄 " : ""}${v.name}`}
            {v.persona ? "" : v.description ? `: ${v.description.slice(0, 40)}` : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="hear"
        onClick={() => {
          const v = voices.find((x) => x.voiceId === value);
          if (!previewVoice(v?.previewUrl)) speakSample(`Hello, I'm ${v?.persona?.name ?? v?.name ?? "a storyteller"}.`);
        }}
        aria-label="Hear this voice"
      >
        ▶
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ chime

export type SoundsChoice = "none" | "effects" | "soundscape";

export const soundsOf = (s: { effects: boolean; ambience: boolean }): SoundsChoice => (s.effects ? "effects" : s.ambience ? "soundscape" : "none");

const SOUNDS: Record<SoundsChoice, { emoji: string; label: string; sub: string }> = {
  none: { emoji: "🎙️", label: "Just the voices", sub: "Nothing underneath" },
  effects: { emoji: "🦉", label: "Sound effects", sub: "A few short sounds at just the right moments: a door's creak, an owl's hoot" },
  soundscape: { emoji: "🌧️", label: "Soft soundscape", sub: "A quiet background the whole way through" },
};

/** What plays besides the voices. The continuous soundscape is only offered where a story already has it. */
export function SoundsPicker({ value, onChange }: { value: SoundsChoice; onChange: (v: SoundsChoice) => void }) {
  const options = (Object.keys(SOUNDS) as SoundsChoice[]).filter((k) => k !== "soundscape" || value === "soundscape");
  return (
    <div>
      <span className="label">Sounds</span>
      <div className="choices" style={{ ["--min" as string]: "150px" }} role="radiogroup" aria-label="Sounds">
        {options.map((k) => (
          <button key={k} type="button" className="choice" role="radio" aria-checked={value === k} onClick={() => onChange(k)}>
            <span className="choice-emoji">{SOUNDS[k].emoji}</span>
            <span className="choice-title">{SOUNDS[k].label}</span>
            <span className="choice-sub">{SOUNDS[k].sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChimePicker({ value, onChange }: { value: ChimeSettings; onChange: (c: ChimeSettings) => void }) {
  return (
    <div className="stack" style={{ ["--gap" as string]: "14px" }}>
      <label className="toggle">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        <span>
          <b>Ring a chime when it's time to turn the page</b>
          <span className="muted small">A soft little sound between pages, just like the read-along records.</span>
        </span>
      </label>
      {value.enabled && (
        <>
          <div className="choices" style={{ ["--min" as string]: "140px" }} role="radiogroup" aria-label="Chime">
            {(Object.keys(CHIMES) as ChimeStyle[]).map((style) => (
              <button
                key={style}
                type="button"
                className="choice"
                role="radio"
                aria-checked={value.style === style}
                onClick={() => {
                  previewChime(style);
                  onChange({ ...value, style });
                }}
              >
                <span className="choice-emoji">{CHIMES[style].emoji}</span>
                <span className="choice-title">{CHIMES[style].label}</span>
                <span className="choice-sub">tap to hear</span>
              </button>
            ))}
          </div>
          <label className="field">
            <span>Time to turn the page: {value.gapSeconds} seconds</span>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={value.gapSeconds}
              onChange={(e) => onChange({ ...value, gapSeconds: Number(e.target.value) })}
              style={{ width: "100%", accentColor: "#a8792b" }}
            />
            <div className="hint">Little hands may need longer. In the player you can also choose “wait for me”.</div>
          </label>
        </>
      )}
    </div>
  );
}

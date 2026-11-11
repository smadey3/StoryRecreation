import { AGES, CHIMES, LENGTHS, MOODS, defaultSettings } from "@/lib/shared/options";
import { ART_STYLES, DEFAULT_ART_STYLE } from "@/lib/shared/art";
import { languageOf } from "@/lib/shared/languages";
import type { AgeBand, ArtStyle, ChimeStyle, LengthPreset, Mood, StorySettings, StorySource } from "@/lib/shared/types";

const SOURCES: StorySource[] = ["book", "wild", "idea", "classic", "book_read", "text"];

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** Accept settings from the browser, keeping only sensible values. */
export function sanitizeSettings(input: unknown): StorySettings {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const d = defaultSettings();
  const chime = (i.chime && typeof i.chime === "object" ? i.chime : {}) as Record<string, unknown>;
  const classic = i.classic as { gutenbergId?: unknown; chapter?: unknown } | undefined;
  const source = pick(i.source, SOURCES, d.source);
  return {
    source,
    length: pick(i.length, Object.keys(LENGTHS) as LengthPreset[], d.length),
    mood: pick(i.mood, Object.keys(MOODS) as Mood[], d.mood),
    age: pick(i.age, Object.keys(AGES) as AgeBand[], d.age),
    heroes: Array.isArray(i.heroes) ? i.heroes.map((h) => str(h, 40).trim()).filter(Boolean).slice(0, 4) : [],
    lesson: str(i.lesson, 200),
    extra: str(i.extra, 600),
    // A story in another language, and whether it's for someone learning it.
    ...(languageOf(i.language) !== "en" ? { language: languageOf(i.language), learner: Boolean(i.learner) } : {}),
    surprise: Boolean(i.surprise),
    keepNames: i.keepNames === undefined ? d.keepNames : Boolean(i.keepNames),
    description: str(i.description, 1500),
    narratorVoiceId: typeof i.narratorVoiceId === "string" && i.narratorVoiceId ? i.narratorVoiceId.slice(0, 64) : null,
    fullCast: i.fullCast === undefined ? d.fullCast : Boolean(i.fullCast),
    chime: {
      enabled: chime.enabled === undefined ? d.chime.enabled : Boolean(chime.enabled),
      style: pick(chime.style, Object.keys(CHIMES) as ChimeStyle[], d.chime.style),
      gapSeconds: Math.min(10, Math.max(1, Number(chime.gapSeconds) || d.chime.gapSeconds)),
    },
    intro: i.intro === undefined ? d.intro : Boolean(i.intro),
    ambience: Boolean(i.ambience),
    effects: Boolean(i.effects),
    review: i.review === undefined ? d.review : Boolean(i.review),
    // Pictures are drawn for stories dreamed up from an idea, and for a day out told from the family's photos (a book
    // they own has its own pictures).
    ...(i.pictures && (source === "idea" || source === "wild")
      ? { pictures: true, artStyle: pick(i.artStyle, Object.keys(ART_STYLES) as ArtStyle[], DEFAULT_ART_STYLE) }
      : {}),
    ...(classic && Number.isInteger(classic.gutenbergId) && Number.isInteger(classic.chapter)
      ? { classic: { gutenbergId: Number(classic.gutenbergId), chapter: Number(classic.chapter) } }
      : {}),
    ...(typeof i.text === "string" ? { text: i.text.slice(0, 60000) } : {}),
  };
}

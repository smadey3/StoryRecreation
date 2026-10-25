import type { Story, StorySettings } from "./types";

/**
 * What a story's PDF holds, to keep, share or print: everything ("all": its pictures and words), or its words alone
 * ("words": a new story for a real book, whose own pictures belong to its publisher, so they stay in the family's
 * library). Null when there's no PDF to make: a reading of a real book would be that book's own words, and a story
 * still being written has none yet.
 */
export function pdfOffer(story: Pick<Story, "settings" | "script">): "all" | "words" | null {
  return pdfOfferFor(story.settings.source, story.script?.pages.length ?? 0);
}

/** The same, from where a story came from and how many pages it has (all a story's card knows of it). */
export function pdfOfferFor(source: StorySettings["source"] | undefined, pages: number): "all" | "words" | null {
  if (!pages || source === "book_read") return null;
  return source === "book" ? "words" : "all";
}

/** About how long a story's PDF takes to make: a moment for words alone, longer with a picture on every page. */
export const pdfSeconds = (pictured: boolean, pages: number) => (pictured ? Math.round(3 + pages * 0.4) : 2);

/** A story's PDF file name: its title, without the marks phones and computers don't allow in names. */
export const pdfFileName = (title: string) =>
  `${
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Story"
  }.pdf`;

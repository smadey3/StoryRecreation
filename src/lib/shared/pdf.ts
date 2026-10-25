import type { Story } from "./types";

/**
 * What a story's PDF holds, to keep, share or print: everything ("all": its pictures and words), or its words alone
 * ("words": a new story for a real book, whose own pictures belong to its publisher, so they stay in the family's
 * library). Null when there's no PDF to make: a reading of a real book would be that book's own words, and a story
 * still being written has none yet.
 */
export function pdfOffer(story: Pick<Story, "settings" | "script">): "all" | "words" | null {
  if (!story.script?.pages.length || story.settings.source === "book_read") return null;
  return story.settings.source === "book" ? "words" : "all";
}

/** A story's PDF file name: its title, without the marks phones and computers don't allow in names. */
export const pdfFileName = (title: string) =>
  `${
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Story"
  }.pdf`;

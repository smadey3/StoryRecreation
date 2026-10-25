import { apiCtx, HttpError, oneStoryAtATime, readJson, requireGrownup, route } from "@/lib/server/auth";
import { canWriteStories } from "@/lib/server/config";
import { createBook, createStory, findBookBySource } from "@/lib/server/db";
import { loadClassic } from "@/lib/server/classics";
import { sanitizeSettings } from "@/lib/server/settings";
import { startWriting } from "@/lib/server/jobs";
import { keepClassicCover } from "@/lib/server/covers";

/** Put a classic on the family's shelf and prepare a chapter to be read aloud. */
export const POST = route(async (req: Request) => {
  const ctx = await apiCtx();
  requireGrownup(ctx);
  const body = await readJson<{ gutenbergId?: number; chapter?: number; settings?: unknown; emoji?: string }>(req);
  const gid = Number(body.gutenbergId);
  const chapterIndex = Number(body.chapter ?? 0);
  if (!Number.isInteger(gid) || gid <= 0) throw new HttpError(400, "Pick a book first.");
  oneStoryAtATime(ctx);
  const settings = sanitizeSettings({ ...(body.settings as object), source: "classic", classic: { gutenbergId: gid, chapter: chapterIndex } });
  if (settings.fullCast && !canWriteStories()) {
    throw new HttpError(503, "A full cast needs the storyteller (an Anthropic API key). Try a single reader instead.", "no_storyteller");
  }
  const classic = await loadClassic(gid).catch(() => {
    throw new HttpError(502, "The Gutenberg library couldn't be reached.");
  });
  const chapter = classic.chapters[chapterIndex];
  if (!chapter) throw new HttpError(404, "That chapter wasn't found.");

  let bookId = findBookBySource(ctx.household.id, "classic", String(gid))?.id;
  if (!bookId) {
    bookId = createBook(ctx.household.id, {
      title: classic.title,
      author: classic.author,
      kind: "classic",
      sourceRef: String(gid),
      notes: body.emoji?.slice(0, 8) ?? null,
    });
    // Its cover is kept with it, in the background.
    void keepClassicCover(ctx.household.id, bookId, gid);
  }
  const title = classic.chapters.length > 1 ? `${chapter.title}` : classic.title;
  const id = createStory(ctx.household.id, {
    bookId,
    profileId: ctx.profile?.id ?? null,
    mode: "read",
    title,
    settings,
    status: "writing",
  });
  startWriting(id);
  return Response.json({ id, bookId });
});

import { apiCtx, HttpError, oneStoryAtATime, readJson, requireGrownup, route } from "@/lib/server/auth";
import { createStory, getBook, getProfile } from "@/lib/server/db";
import { storyCards } from "@/lib/server/voices";
import { canWriteStories } from "@/lib/server/config";
import { sanitizeSettings } from "@/lib/server/settings";
import { startWriting } from "@/lib/server/jobs";

export const GET = route(async () => {
  const ctx = await apiCtx();
  return Response.json({ stories: await storyCards(ctx.household.id) });
});

/** Start a new story (or a read-aloud) for a book on the shelf. */
export const POST = route(async (req: Request) => {
  const ctx = await apiCtx();
  requireGrownup(ctx);
  const body = await readJson<{ bookId?: string; mode?: string; settings?: unknown; profileId?: string | null }>(req);
  const book = body.bookId ? getBook(ctx.household.id, body.bookId) : undefined;
  if (!book) throw new HttpError(404, "That book isn't on the shelf.");
  if (!canWriteStories()) {
    throw new HttpError(503, "The storyteller needs an Anthropic API key. A grown-up can add one in the settings.", "no_storyteller");
  }
  oneStoryAtATime(ctx);
  const mode = body.mode === "read" ? "read" : "create";
  const settings = sanitizeSettings(body.settings);
  const profileId =
    body.profileId && getProfile(ctx.household.id, body.profileId) ? body.profileId : ctx.profile?.id ?? null;
  const id = createStory(ctx.household.id, {
    bookId: book.id,
    profileId,
    mode,
    title: mode === "read" ? book.title : "A new story is brewing…",
    settings,
    status: "writing",
  });
  startWriting(id);
  return Response.json({ id });
});

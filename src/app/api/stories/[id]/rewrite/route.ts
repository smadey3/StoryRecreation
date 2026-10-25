import { apiCtx, HttpError, oneStoryAtATime, requireGrownup, route } from "@/lib/server/auth";
import { getStory, updateStory } from "@/lib/server/db";
import { canWriteStories } from "@/lib/server/config";
import { isRunning, startWriting } from "@/lib/server/jobs";
import { artBusy } from "@/lib/server/art";

/** Ask the storyteller for a fresh draft (or retry after a hiccup). */
export const POST = route(async (_req: Request, ctx: RouteContext<"/api/stories/[id]/rewrite">) => {
  const c = await apiCtx();
  requireGrownup(c);
  const { id } = await ctx.params;
  const story = getStory(c.household.id, id);
  if (!story) throw new HttpError(404, "That story wasn't found.");
  if (isRunning(id)) return Response.json({ ok: true });
  if (artBusy(id)) throw new HttpError(409, "Please wait until the illustrator has finished.");
  // A failed recording keeps its script: just try the recording again.
  if (story.status === "error" && story.script) {
    updateStory(id, { status: "draft", error: null });
    return Response.json({ ok: true, resumed: "draft" });
  }
  if (!canWriteStories()) throw new HttpError(503, "The storyteller needs an Anthropic API key.", "no_storyteller");
  oneStoryAtATime(c, id);
  startWriting(id);
  return Response.json({ ok: true });
});

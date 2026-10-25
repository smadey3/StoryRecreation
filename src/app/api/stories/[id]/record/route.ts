import { apiCtx, HttpError, oneStoryAtATime, requireGrownup, route } from "@/lib/server/auth";
import { getStory } from "@/lib/server/db";
import { canRecordStories } from "@/lib/server/config";
import { isRunning, startRecording } from "@/lib/server/jobs";

export const POST = route(async (_req: Request, ctx: RouteContext<"/api/stories/[id]/record">) => {
  const c = await apiCtx();
  requireGrownup(c);
  const { id } = await ctx.params;
  const story = getStory(c.household.id, id);
  if (!story) throw new HttpError(404, "That story wasn't found.");
  if (!story.script) throw new HttpError(409, "This story hasn't been written yet.");
  if (isRunning(id)) return Response.json({ ok: true });
  if (!canRecordStories()) {
    throw new HttpError(503, "The voices need an ElevenLabs API key. A grown-up can add one in the settings.", "no_voices");
  }
  oneStoryAtATime(c, id);
  startRecording(id);
  return Response.json({ ok: true });
});

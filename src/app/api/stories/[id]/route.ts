import { apiCtx, HttpError, readJson, requireGrownup, route } from "@/lib/server/auth";
import { deleteStory, getStory, updateStory } from "@/lib/server/db";
import { removeDir, storyDir } from "@/lib/server/files";
import { isRunning, resumeLostStory, withPlaceInLine } from "@/lib/server/jobs";
import { artBusy, drawnBeforeUrls, resumeLostArt } from "@/lib/server/art";
import { pictureSpendForStory } from "@/lib/server/spending";
import { keepForChildren } from "@/lib/server/guard";
import type { StoryScript } from "@/lib/shared/types";

export const GET = route(async (_req: Request, ctx: RouteContext<"/api/stories/[id]">) => {
  const c = await apiCtx();
  const { id } = await ctx.params;
  let story = getStory(c.household.id, id);
  if (!story) throw new HttpError(404, "That story wasn't found.");
  if ((story.status === "writing" || story.status === "recording") && !isRunning(id)) {
    // The work was stopped midway (by a restart, say): it carries on.
    resumeLostStory(id);
    story = getStory(c.household.id, id)!;
  }
  if (story.art && story.art.status !== "idle" && !artBusy(id)) {
    resumeLostArt(id);
    story = getStory(c.household.id, id)!;
  }
  return Response.json({ story: withPlaceInLine(story), running: isRunning(id), pictureSpend: pictureSpendForStory(id), drawnBefore: drawnBeforeUrls(c.household.id, id) });
});

/** Edit the draft (title, lines, cast voices) or mark a favorite. */
export const PATCH = route(async (req: Request, ctx: RouteContext<"/api/stories/[id]">) => {
  const c = await apiCtx();
  const { id } = await ctx.params;
  const story = getStory(c.household.id, id);
  if (!story) throw new HttpError(404, "That story wasn't found.");
  const body = await readJson<{ favorite?: boolean; title?: string; script?: StoryScript }>(req);

  if (body.favorite !== undefined && body.title === undefined && body.script === undefined) {
    updateStory(id, { favorite: Boolean(body.favorite) }); // kids can star their favorites
    return Response.json({ story: getStory(c.household.id, id) });
  }

  requireGrownup(c);
  if (story.status === "writing" || story.status === "recording") {
    throw new HttpError(409, "Please wait until the storyteller has finished.");
  }
  let script = story.script;
  if (body.script && script) {
    const castIds = new Set(body.script.cast.map((m) => m.id));
    script = {
      ...script,
      title: String(body.script.title ?? script.title).slice(0, 120),
      synopsis: String(body.script.synopsis ?? script.synopsis).slice(0, 600),
      cast: body.script.cast.map((m) => ({
        id: String(m.id),
        name: String(m.name).slice(0, 60),
        description: String(m.description ?? "").slice(0, 300),
        voiceBrief: String(m.voiceBrief ?? "").slice(0, 300),
        voiceId: String(m.voiceId).slice(0, 64),
      })),
      pages: script.pages.map((p, i) => {
        const edited = body.script!.pages[i];
        if (!edited) return p;
        return {
          ...p,
          lines: edited.lines
            .map((l) => ({ speaker: castIds.has(l.speaker) ? l.speaker : "narrator", text: String(l.text).slice(0, 4000).trim() }))
            .filter((l) => l.text),
        };
      }),
    };
  }
  const title = (body.title ?? script?.title ?? story.title).trim().slice(0, 120) || story.title;
  if (script) script.title = title;
  // Words the family changed are checked before they're kept (and so before they could be recorded).
  const before = new Set([story.title, story.synopsis ?? "", ...(story.script?.cast.flatMap((m) => [m.name, m.description]) ?? []), ...(story.script?.pages.flatMap((p) => p.lines.map((l) => l.text)) ?? [])]);
  const changed = [title, script?.synopsis ?? "", ...(script?.cast.flatMap((m) => [m.name, m.description]) ?? []), ...(script?.pages.flatMap((p) => p.lines.map((l) => l.text)) ?? [])].filter(
    (t) => t.trim() && !before.has(t),
  );
  await keepForChildren(c, "edit", [{ label: "Words changed in the story", text: changed.join("\n") }], story.settings.age);
  updateStory(id, { title, script, synopsis: script?.synopsis ?? story.synopsis });
  return Response.json({ story: getStory(c.household.id, id) });
});

export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/stories/[id]">) => {
  const c = await apiCtx();
  requireGrownup(c);
  const { id } = await ctx.params;
  if (isRunning(id)) throw new HttpError(409, "Please wait until the storyteller has finished.");
  if (artBusy(id)) throw new HttpError(409, "Please wait until the illustrator has finished.");
  deleteStory(c.household.id, id);
  await removeDir(storyDir(c.household.id, id));
  return Response.json({ ok: true });
});

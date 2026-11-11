import { apiCtx, HttpError, readJson, route } from "@/lib/server/auth";
import { getStory } from "@/lib/server/db";
import { artBusy, startDrawing, undrawn } from "@/lib/server/art";
import { illustratorReady } from "@/lib/server/illustrator";
import { keepForChildren } from "@/lib/server/guard";
import { picturePrice } from "@/lib/server/prices";
import { approvePurchase, recordSpend, type Approval } from "@/lib/server/spending";

/**
 * Draw the book: the cover and every page not drawn yet, or the pictures
 * asked for (a redraw, with an optional note). A purchase: approved with the PIN.
 */
export const POST = route(async (req: Request, ctx: RouteContext<"/api/stories/[id]/art/draw">) => {
  const c = await apiCtx();
  const { id } = await ctx.params;
  const story = getStory(c.household.id, id);
  const art = story?.art;
  if (!story || !art) throw new HttpError(404, "This story isn't a picture book yet.");
  if (!art.scenes.length) throw new HttpError(409, "The pictures haven't been planned yet.");
  if (artBusy(id)) throw new HttpError(409, "The illustrator is busy with this book. Try again in a moment.");
  const body = await readJson<{ pages?: unknown; note?: unknown; approval?: Approval }>(req);
  const asked = Array.isArray(body.pages)
    ? [...new Set(body.pages.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= art.pages.length).sort((a, b) => a - b)
    : undrawn(art);
  if (asked.length === 0) throw new HttpError(400, "Every picture is already drawn.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
  // What should change goes to the illustrator: it's for children, like everything written for the storyteller.
  await keepForChildren(c, "pictures", [{ label: "What should change in a picture", text: note || null }], story.settings.age);

  const real = illustratorReady();
  const price = (real ? picturePrice() : 0) * asked.length;
  approvePurchase(c, body.approval, price);
  const name = (t: number) => (t === 0 ? "the cover" : `page ${t}`);
  const pages = asked.filter((t) => t > 0).length;
  const redraw = asked.length === 1 && (asked[0] === 0 ? art.cover : art.pages[asked[0] - 1]);
  const what =
    asked.length === 1
      ? `${redraw ? "Redrew" : "Drew"} ${name(asked[0])} of “${story.title}”`
      : `Drew ${asked.includes(0) ? `the cover and ${pages} ${pages === 1 ? "page" : "pages"}` : `${pages} pages`} of “${story.title}”`;
  const purchaseId = recordSpend(c.household.id, { storyId: id, service: "pictures", kind: redraw ? "redraw" : "draw", what, approved: price, standIn: !real });
  startDrawing(id, asked, purchaseId, note || undefined);
  return Response.json({ story: getStory(c.household.id, id) });
});

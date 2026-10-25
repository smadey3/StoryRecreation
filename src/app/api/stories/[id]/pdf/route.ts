import { apiCtx, HttpError, route } from "@/lib/server/auth";
import { getBook, getStory, listPages } from "@/lib/server/db";
import { storyPdf } from "@/lib/server/pdf";
import { pdfFileName, pdfOffer } from "@/lib/shared/pdf";

// A story as a PDF book, to keep, share with friends and family, or print.
export const GET = route(async (_req: Request, ctx: RouteContext<"/api/stories/[id]/pdf">) => {
  const c = await apiCtx();
  const { id } = await ctx.params;
  const story = getStory(c.household.id, id);
  if (!story) throw new HttpError(404, "That story wasn't found.");
  if (!story.script) throw new HttpError(409, "This story hasn't been written yet.");
  if (!pdfOffer(story)) throw new HttpError(403, "This is a reading of your own copy of a book, so its words belong to the book's publisher and stay in your library.");
  const book = getBook(c.household.id, story.bookId);
  if (!book) throw new HttpError(404, "That story's book wasn't found.");
  const bytes = await storyPdf({ householdId: c.household.id, familyName: c.household.name, story, book, photos: listPages(book.id) });
  const filename = pdfFileName(story.script.title || story.title);
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
});

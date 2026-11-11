import fs from "node:fs";
import { apiCtx, HttpError, route } from "@/lib/server/auth";
import { isArtStyle, sampleFile } from "@/lib/server/styleSamples";

// A picture style's example. Its address carries which drawing it is, so a phone keeps it.
export const GET = route(async (_req: Request, ctx: RouteContext<"/api/art-styles/[style]/sample">) => {
  await apiCtx();
  const { style } = await ctx.params;
  const file = isArtStyle(style) ? sampleFile(style) : null;
  if (!file) throw new HttpError(404, "That example isn't drawn yet.");
  return new Response(new Uint8Array(await fs.promises.readFile(file)), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" },
  });
});

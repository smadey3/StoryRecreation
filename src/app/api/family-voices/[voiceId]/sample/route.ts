import { apiCtx, HttpError, route } from "@/lib/server/auth";
import { fileUrl, listFamilyVoices } from "@/lib/server/db";
import { elevenLabsReason } from "@/lib/server/performer";
import { voiceSample } from "@/lib/server/voiceSample";

// A family voice reading a few lines of a story: made the first time it's asked for, then handed to the file it's
// kept in (which a phone's player can read a piece at a time).
export const GET = route(async (_req: Request, ctx: RouteContext<"/api/family-voices/[voiceId]/sample">) => {
  const c = await apiCtx();
  const { voiceId } = await ctx.params;
  if (!listFamilyVoices(c.household.id).some((v) => v.voiceId === voiceId)) throw new HttpError(404, "That voice isn't here any more.");
  let rel: string;
  try {
    rel = await voiceSample(c.household.id, voiceId);
  } catch (err) {
    console.error("Could not make a voice sample", err);
    throw new HttpError(502, elevenLabsReason(err) ?? "That voice couldn't be heard just now. Try again in a moment.");
  }
  return new Response(null, { status: 302, headers: { Location: fileUrl(rel)!, "Cache-Control": "no-store" } });
});

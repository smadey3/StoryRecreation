import { apiCtx, HttpError, requireGrownup, route } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { deleteFamilyVoice } from "@/lib/server/db";
import { deleteAccountVoice } from "@/lib/server/performer";
import { forgetVoiceCache } from "@/lib/server/voices";
import { forgetVoiceSample } from "@/lib/server/voiceSample";

// Stop using a family voice. The recordings it came from stay as keepsakes.
export const DELETE = route(async (_req: Request, ctx: RouteContext<"/api/family-voices/[voiceId]">) => {
  const c = await apiCtx();
  requireGrownup(c);
  const { voiceId } = await ctx.params;
  if (!deleteFamilyVoice(c.household.id, voiceId)) throw new HttpError(404, "That voice is already gone.");
  forgetVoiceSample(c.household.id, voiceId);
  if (config.elevenLabsKey && !voiceId.startsWith("family-demo-")) {
    await deleteAccountVoice(voiceId).catch((err) => console.error("Could not remove the voice from ElevenLabs", err));
  }
  forgetVoiceCache();
  return Response.json({ ok: true });
});

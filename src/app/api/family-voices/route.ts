import fs from "node:fs";
import { apiCtx, HttpError, readJson, requireGrownup, route } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { keepsakeFiles, newId, saveFamilyVoice } from "@/lib/server/db";
import { resolveHouseholdPath } from "@/lib/server/files";
import { sliceMp3 } from "@/lib/server/mp3";
import { cloneFamilyVoice, elevenLabsReason } from "@/lib/server/performer";
import { forgetVoiceCache } from "@/lib/server/voices";
import { voiceSample } from "@/lib/server/voiceSample";

const MIN_MS = 10_000;
/** ElevenLabs learns nothing from a shorter recording (it asks for at least 5 seconds of each). */
const MIN_EACH_MS = 5_000;

type Part = { fromMs?: unknown; toMs?: unknown };

// Teach the storytellers a grown-up's voice from their keepsake recordings: all of each, or just part of it
// (the stretch where they're speaking on their own). The recordings themselves are kept whole.
export const POST = route(async (req: Request) => {
  const ctx = await apiCtx();
  requireGrownup(ctx);
  const body = await readJson<{ name?: string; keepsakeIds?: string[]; parts?: Record<string, Part>; adult?: boolean; consent?: boolean; cleanNoise?: boolean }>(
    req,
  );
  const ids = [...new Set((body.keepsakeIds ?? []).filter((x) => typeof x === "string"))].slice(0, 25);
  const parts = body.parts && typeof body.parts === "object" ? body.parts : {};
  const files = keepsakeFiles(ctx.household.id, ids)
    .map((f) => {
      const part = Object.hasOwn(parts, f.id) ? parts[f.id] : null;
      const fromMs = part ? Math.min(f.durationMs, Math.max(0, Math.round(Number(part.fromMs) || 0))) : 0;
      const toMs = part ? Math.min(f.durationMs, Math.max(fromMs, Math.round(Number(part.toMs) || f.durationMs))) : f.durationMs;
      return { ...f, part: part ? { fromMs, toMs } : null, ms: toMs - fromMs };
    })
    .filter((f) => f.ms >= MIN_EACH_MS);
  if (!files.length) throw new HttpError(400, "Choose at least one recording of 5 seconds or more.");
  if (body.adult !== true) throw new HttpError(400, "Storytelling voices can only be made from a grown-up's voice.");
  if (body.consent !== true) throw new HttpError(400, "Please confirm you have the right to use this voice.");
  const totalMs = files.reduce((n, f) => n + f.ms, 0);
  if (totalMs < MIN_MS) throw new HttpError(400, "We need at least 10 seconds of their voice. A minute to three minutes sounds best.");
  const person = files[0].person;
  const name = body.name?.trim().slice(0, 40) || person;

  let voiceId: string;
  if (config.elevenLabsKey) {
    try {
      const audio = await Promise.all(
        files.map(async (f, i) => {
          const whole = await fs.promises.readFile(resolveHouseholdPath(ctx.household.id, f.audioPath));
          return { data: f.part ? sliceMp3(whole, f.part.fromMs, f.part.toMs) : whole, filename: `recording-${i + 1}.mp3` };
        }),
      );
      voiceId = await cloneFamilyVoice(name, person, audio, body.cleanNoise !== false);
    } catch (err) {
      console.error(err);
      throw new HttpError(502, elevenLabsReason(err) ?? "ElevenLabs couldn't learn this voice. Your plan may not include voice cloning, or may be out of voice slots.");
    }
  } else if (config.demoMode) {
    voiceId = `family-demo-${newId()}`; // a pretend voice: demo mode hums every part
  } else {
    throw new HttpError(503, "Making a family voice needs an ElevenLabs API key.", "no_voices");
  }
  saveFamilyVoice(ctx.household.id, { voiceId, name, person, keepsakeIds: files.map((f) => f.id) });
  forgetVoiceCache();
  // Their voice reading a few lines, made now, so it's ready by the time anyone taps "Hear me".
  void voiceSample(ctx.household.id, voiceId).catch((err) => console.error("Could not make a voice sample", err));
  return Response.json({ voiceId, name });
});

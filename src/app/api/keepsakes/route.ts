import { apiCtx, HttpError, requireGrownup, route } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { addKeepsake, listFamilyVoices, listKeepsakes } from "@/lib/server/db";
import { saveAudio } from "@/lib/server/files";

const MAX_MS = 20 * 60 * 1000;

// The family's recordings and the voices learned from them, with what a family voice made away from the
// Grown-ups' corner needs to know too: whether voices can be made, and the key for videos from Drive links.
export const GET = route(async () => {
  const ctx = await apiCtx();
  return Response.json({
    keepsakes: listKeepsakes(ctx.household.id),
    familyVoices: listFamilyVoices(ctx.household.id),
    canMakeVoices: Boolean(config.elevenLabsKey) || config.demoMode,
    driveKey: config.googleDriveKey ?? null,
  });
});

// A recording to keep: a voicemail, a voice memo, a child reading aloud.
export const POST = route(async (req: Request) => {
  const ctx = await apiCtx();
  requireGrownup(ctx);
  const form = await req.formData();
  const audio = form.get("audio");
  const person = String(form.get("person") ?? "").trim().slice(0, 40);
  const title = String(form.get("title") ?? "").trim().slice(0, 80);
  const recordedOn = String(form.get("recordedOn") ?? "").trim().slice(0, 40) || null;
  const durationMs = Math.round(Number(form.get("durationMs")));
  if (!(audio instanceof File) || !audio.size) throw new HttpError(400, "Add a recording first.");
  if (!person) throw new HttpError(400, "Whose voice is this?");
  if (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > MAX_MS) {
    throw new HttpError(400, "Recordings can be from half a second up to 20 minutes long.");
  }
  const audioPath = await saveAudio(ctx.household.id, "keepsakes", audio);
  const keepsake = addKeepsake(ctx.household.id, { person, title: title || "A recording", recordedOn, audioPath, durationMs });
  return Response.json({ keepsake });
});

import fs from "node:fs";
import path from "node:path";
import { encodeMp3 } from "./audio";
import { resolveHouseholdPath } from "./files";
import { performLines } from "./performer";

// What a family voice sounds like telling a story: a few lines of a bedtime story read in the voice the storytellers
// learned, so "Hear me" is that voice, not the recording it was learned from. Made once (a few seconds of voice credit)
// the first time it's asked for, or as soon as the voice is made, and kept with the family's files.

/** About fifteen seconds of a bedtime story, with a whisper and a smile in it. */
export const SAMPLE_TEXT =
  "Once upon a time, at the edge of a sleepy wood, a little fox curled up beneath the stars. “Will you tell me a story?” she whispered. “Of course,” said the moon, with a smile. “Close your eyes, and listen.”";

const making = new Map<string, Promise<string>>();

const sampleFile = (voiceId: string) => `voices/${voiceId.replace(/[^\w-]+/g, "_")}-sample.mp3`;

/** The family voice reading its sample: its file, among the family's files, made the first time it's asked for. */
export function voiceSample(householdId: string, voiceId: string): Promise<string> {
  const rel = sampleFile(voiceId);
  const full = resolveHouseholdPath(householdId, rel);
  if (fs.existsSync(full)) return Promise.resolve(rel);
  // Asked for twice at once (a second tap of "Hear me"), it's made once.
  const key = `${householdId}/${voiceId}`;
  let job = making.get(key);
  if (!job) {
    job = (async () => {
      const clip = await performLines([{ speaker: "narrator", text: SAMPLE_TEXT }], [{ id: "narrator", name: "Storyteller", description: "", voiceBrief: "", voiceId }]);
      if (!clip.samples.length) throw new Error("The voice came back silent.");
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(`${full}.part`, await encodeMp3(clip.samples, 96));
      await fs.promises.rename(`${full}.part`, full);
      return rel;
    })().finally(() => making.delete(key));
    making.set(key, job);
  }
  return job;
}

/** A voice that's gone takes its sample with it. */
export function forgetVoiceSample(householdId: string, voiceId: string) {
  fs.rmSync(resolveHouseholdPath(householdId, sampleFile(voiceId)), { force: true });
}

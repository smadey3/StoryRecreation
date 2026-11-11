import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config";
import { sceneRequest } from "./art";
import { drawPicture, illustratorReady, type PictureRequest } from "./illustrator";
import { ART_STYLES, formatMoney } from "@/lib/shared/art";
import type { ArtStyle } from "@/lib/shared/types";

// What each picture style looks like: the same little scene drawn once in every style, shown on the style choices so a
// family picks a style by seeing it. Each is drawn the first time anyone looks at the choices (a few cents each, once
// for the whole library, not charged to a family), drawn just as a book's page is, and kept. Changing how a style is
// described draws its example again.

const SCENE =
  "Pip, a little red fox in a yellow raincoat, and her best friend Bramble, a small hedgehog, walk home side by side along a winding path through a meadow at dusk. Pip carries a glowing lantern; fireflies drift around them, and a little cottage with a warm, lit window waits on the hill ahead.";

/** The example, asked for the way a book's page is (smaller: it's only seen small). */
export function sampleRequest(style: ArtStyle): PictureRequest {
  const req = sceneRequest({
    title: "Pip and the Lantern",
    page: 1,
    scene: SCENE,
    characters: [],
    sketches: new Map(),
    cover: null,
    style,
    mood: "heartwarming",
    seed: `sample-${style}`,
  });
  return { ...req, size: "1K" };
}

const STYLES = Object.keys(ART_STYLES) as ArtStyle[];
const dir = () => path.join(config.dataDir, "style-samples");
/** Which drawing of the example this is: a new one when the style (or the scene) is described differently. */
const versionOf = (style: ArtStyle) => createHash("sha1").update(sampleRequest(style).prompt).digest("hex").slice(0, 10);
const fileFor = (style: ArtStyle) => path.join(dir(), `${style}-${versionOf(style)}.jpg`);

export const isArtStyle = (value: string): value is ArtStyle => Object.prototype.hasOwnProperty.call(ART_STYLES, value);

/** The example of a style, once it's drawn. */
export function sampleFile(style: ArtStyle): string | null {
  const file = fileFor(style);
  return fs.existsSync(file) ? file : null;
}

const globalForSamples = globalThis as unknown as { __storyhollowSamples?: { drawing: Promise<void> | null; failed: Map<ArtStyle, { at: number; times: number }> } };
const state = (globalForSamples.__storyhollowSamples ??= { drawing: null, failed: new Map() });
/** A style whose example wouldn't draw waits this long before it's tried again, and stops after a few tries. */
const RETRY_MS = 15 * 60 * 1000;
const MOST_TRIES = 3;

const waiting = (style: ArtStyle) => {
  const failed = state.failed.get(style);
  return !failed || (failed.times < MOST_TRIES && Date.now() - failed.at > RETRY_MS);
};

/**
 * Every style's example, by its address (null while it isn't drawn), and whether the ones missing are being drawn. Asking
 * starts drawing those missing, a few at a time, when there's an illustrator to draw them.
 */
export function styleSamples(): { samples: Record<ArtStyle, string | null>; drawing: boolean } {
  const samples = Object.fromEntries(
    STYLES.map((s) => [s, sampleFile(s) ? `/api/art-styles/${s}/sample?v=${versionOf(s)}` : null]),
  ) as Record<ArtStyle, string | null>;
  const missing = STYLES.filter((s) => !samples[s] && waiting(s));
  if (missing.length && illustratorReady() && !state.drawing) {
    state.drawing = drawSamples(missing).finally(() => (state.drawing = null));
  }
  return { samples, drawing: Boolean(state.drawing) };
}

/** The examples being drawn (for tests). */
export const samplesDrawn = () => state.drawing ?? Promise.resolve();

async function drawSamples(styles: ArtStyle[]): Promise<void> {
  await fs.promises.mkdir(dir(), { recursive: true });
  const queue = [...styles];
  const worker = async () => {
    for (let style = queue.shift(); style; style = queue.shift()) await drawSample(style);
  };
  await Promise.all([worker(), worker(), worker()]);
}

async function drawSample(style: ArtStyle): Promise<void> {
  try {
    const picture = await drawPicture(sampleRequest(style));
    if (picture.standIn) return;
    const { default: sharp } = await import("sharp");
    const small = await sharp(picture.bytes).resize(720, 720, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#fffaf0" }).jpeg({ quality: 84 }).toBuffer();
    const file = fileFor(style);
    await fs.promises.writeFile(`${file}.part`, small);
    await fs.promises.rename(`${file}.part`, file);
    state.failed.delete(style);
    // An older drawing of it (from before the style was described differently) goes.
    for (const old of await fs.promises.readdir(dir())) {
      if (old.startsWith(`${style}-`) && old !== path.basename(file)) await fs.promises.rm(path.join(dir(), old), { force: true });
    }
    console.log(`Drew the example of the ${ART_STYLES[style].label} style (${formatMoney(picture.cost)}).`);
  } catch (err) {
    const failed = state.failed.get(style);
    state.failed.set(style, { at: Date.now(), times: (failed?.times ?? 0) + 1 });
    console.warn(`The example of the ${ART_STYLES[style].label} style couldn't be drawn:`, err instanceof Error ? err.message : err);
  }
}

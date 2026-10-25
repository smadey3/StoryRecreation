import type { ArtStyle, SceneEffect, StoryArt } from "./types";

// Picture books: the styles the illustrator can paint in, the little moving
// touches of "living pictures", and how money is shown to the grown-ups.

/**
 * The styles the illustrator paints in. Each says what the medium looks like up close, and what it isn't, so the
 * pictures don't all drift toward the same smooth look; `alone` is where a character stands for its sketch.
 */
export const ART_STYLES: Record<ArtStyle, { label: string; emoji: string; blurb: string; prompt: string; alone: string }> = {
  watercolor: {
    label: "Watercolor",
    emoji: "🎨",
    blurb: "Soft washes and ink, like a classic bedtime book",
    prompt:
      "a traditional watercolor painting with pen and ink: transparent washes that bloom and bleed into each other, white paper showing through, visible paper grain, loose and lively ink lines, soft muted storybook colors. Painted by hand on paper: not digital, no smooth gradients, no 3D shading",
    alone: "on plain white watercolor paper",
  },
  gouache: {
    label: "Painted",
    emoji: "🖌️",
    blurb: "Rich, bright gouache",
    prompt:
      "an opaque gouache painting: flat, matte shapes of bold, saturated color, visible brushstrokes and dry-brush texture, simple chunky forms, a bright mid-century picture-book look. Painted by hand: no ink outlines, nothing glossy, no 3D",
    alone: "on a plain, flat painted background",
  },
  pencil: {
    label: "Colored pencil",
    emoji: "✏️",
    blurb: "Hand-drawn and cozy",
    prompt:
      "a colored pencil and wax crayon drawing on toothy paper: every area filled with visible hatching and pencil strokes, slightly wobbly hand-drawn outlines, the paper's texture showing through the color, soft layered tones. Clearly drawn by hand with pencils: not painted, not digital",
    alone: "on plain drawing paper",
  },
  papercut: {
    label: "Cut paper",
    emoji: "✂️",
    blurb: "Layered paper collage",
    prompt:
      "a cut-paper collage: every shape cut from flat colored and patterned papers (card, tissue, kraft and hand-painted papers), crisp scissor-cut edges, the pieces layered on top of each other with small drop shadows between the layers. No outlines and no painted shading: it looks like a photograph of real paper pieces glued down",
    alone: "on a plain sheet of colored card",
  },
  shadow: {
    label: "Shadow puppets",
    emoji: "🌙",
    blurb: "Silhouettes on glowing light",
    prompt:
      "a shadow-puppet theater picture: the characters and scenery are solid black silhouettes with fine cut-out details (little holes for eyes, windows and leaves), seen against a glowing gradient of warm light, like a shadow play on a lit screen. No faces, colors or shading on the figures themselves",
    alone: "against a plain glow of warm light",
  },
};

export const DEFAULT_ART_STYLE: ArtStyle = "watercolor";

export const SCENE_EFFECTS: Record<SceneEffect, string> = {
  none: "",
  sparkles: "Fairy dust",
  snow: "Falling snow",
  rain: "Gentle rain",
  fireflies: "Fireflies",
  leaves: "Drifting leaves",
  stars: "Twinkling stars",
  bubbles: "Bubbles",
  petals: "Petals on the breeze",
};

export const sceneEffect = (value: unknown): SceneEffect =>
  typeof value === "string" && value in SCENE_EFFECTS ? (value as SceneEffect) : "none";

/** How many pictures a book of pages takes: a cover, then one a page. */
export const bookPictures = (pages: number) => pages + 1;

/** How many sketches are made of a character at a time, to choose between (more can always be asked for). */
export const SKETCHES = 2;

/** About how long one picture takes the illustrator. */
const PICTURE_SECONDS = 25;

/**
 * About how long the illustrator takes for some pictures, two at a time (the cover first, on its own so the pages can
 * match it), at `pace` times the rule of thumb: how it has really gone lately.
 */
export function drawingSeconds(pictures: number, coverFirst: boolean, real: boolean, pace = 1): number {
  if (!real) return 3;
  return Math.round(((coverFirst ? PICTURE_SECONDS : 0) + Math.ceil(Math.max(0, pictures - (coverFirst ? 1 : 0)) / 2) * PICTURE_SECONDS) * pace);
}

/** About how long the storyteller takes to plan a picture book's pictures (a moment, for the demo storyteller), at `pace`. */
export const planningSeconds = (storyteller: boolean, pace = 1) => (storyteller ? Math.round(30 * pace) : 3);

/** Stand-in pictures (made while the illustrator isn't set up) are drawings the app makes itself. */
export const isStandIn = (url: string | null | undefined) => Boolean(url && /\.svg(\?|$)/.test(url));

/** The picture for a page of a picture book, if it has been drawn. */
export const artForPage = (art: StoryArt | null | undefined, page: number): string | null =>
  art && page >= 1 ? (art.pages[page - 1] ?? null) : null;

/** About what a storyteller job costs, from the tokens it reads and writes, in millionths of a dollar. */
export const storytellerCost = (rates: { input: number; output: number }, inputTokens: number, outputTokens: number) =>
  Math.round(inputTokens * rates.input + outputTokens * rates.output);

/**
 * Money for grown-ups, from millionths of a dollar: "5¢", "$1.20". Rounded up,
 * so what's shown is never less than what it can cost.
 */
export function formatMoney(micros: number, zero = "free"): string {
  if (micros <= 0) return zero;
  const cents = Math.ceil(micros / 10_000);
  if (cents < 100) return `${cents}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

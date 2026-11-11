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
  pastel: {
    label: "Chalk pastel",
    emoji: "🖍️",
    blurb: "Dreamy chalk on dark paper",
    prompt:
      "a soft chalk pastel drawing on dark navy-blue paper: glowing colors rubbed and smudged with fingers, visible chalky strokes and grainy texture, the dark paper showing through between the strokes, so light seems to glow out of the dark. Drawn by hand with pastels: not painted, no hard outlines, not digital",
    alone: "on plain dark blue pastel paper",
  },
  papercut: {
    label: "Cut paper",
    emoji: "✂️",
    blurb: "Layered paper collage",
    prompt:
      "a cut-paper collage: every shape cut from flat colored and patterned papers (card, tissue, kraft and hand-painted papers), crisp scissor-cut edges, the pieces layered on top of each other with small drop shadows between the layers. No outlines and no painted shading: it looks like a photograph of real paper pieces glued down",
    alone: "on a plain sheet of colored card",
  },
  felt: {
    label: "Felt & stitches",
    emoji: "🧶",
    blurb: "Soft felt, yarn and buttons",
    prompt:
      "a handmade felt and fabric collage: every shape cut from soft, fuzzy wool felt and fabric, visible running stitches and blanket stitches around the edges, details embroidered in thread, button eyes, yarn for hair and grass, tufts of needle-felted wool, photographed close up so the fibres show. Real fabric and thread: not painted, not drawn, not digital",
    alone: "on a plain piece of cream felt",
  },
  clay: {
    label: "Clay",
    emoji: "🧸",
    blurb: "Squishy modeling-clay figures",
    prompt:
      "a handmade modeling-clay (plasticine) scene photographed like a stop-motion film set: every character and object sculpted from soft, matte clay with visible fingerprints, tool marks and slightly lumpy edges, simple rounded shapes, small bead eyes, soft studio lighting with gentle real shadows and a shallow depth of field. Real clay: not smooth computer 3D, nothing glossy, not plastic toys",
    alone: "on a plain clay-colored tabletop against a soft plain backdrop",
  },
  comic: {
    label: "Comic",
    emoji: "💥",
    blurb: "Bold ink and bright dots",
    prompt:
      "a classic comic-book picture: bold black ink outlines with lively brush strokes and pen hatching, flat bright printed colors with halftone dot shading, a dynamic angle and motion lines, like one big panel from a children's comic book, printed on slightly yellowed paper. No panel borders, speech bubbles, sound-effect words or captions. Printed comic look: not painted, not 3D",
    alone: "on a plain, flat pale background",
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

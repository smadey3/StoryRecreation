import { createHash } from "node:crypto";
import { config } from "./config";
import { pictureCost } from "./prices";
import { ART_STYLES } from "@/lib/shared/art";
import type { ArtStyle } from "@/lib/shared/types";

// The illustrator: Google's picture model ("Nano Banana", through the Gemini
// API) paints picture books. Until its key is set, the app draws simple
// stand-in pictures itself, for free, so the whole flow can be tried first.

export class IllustratorError extends Error {
  constructor(
    message: string,
    /** What the attempt still cost (Google charges for a reply that came back without a picture). */
    public cost = 0,
    /** Whether trying again might work: Google busy, a dropped connection, an empty reply (not a refused key or request). */
    public retry = false,
  ) {
    super(message);
  }
}

export interface Reference {
  data: Buffer;
  mime: string;
  /** What the picture is, for the illustrator: "Mia (the girl in the yellow raincoat)". */
  label: string;
}

export interface PictureRequest {
  prompt: string;
  references: Reference[];
  aspect: "4:3" | "1:1";
  /** How big Google draws it: 2K for a book's pages (the default), 1K for a little example. */
  size?: "1K" | "2K";
  /** What a stand-in picture shows instead. */
  standIn: { heading: string; caption: string; style: ArtStyle; seed: string };
}

export interface Picture {
  bytes: Buffer;
  mime: string;
  /** What it cost, in millionths of a dollar. */
  cost: number;
  standIn: boolean;
}

export const illustratorReady = () => Boolean(config.illustratorKey);

/** The picture types Google accepts as references (a stand-in sketch is an SVG, so it's described in words instead). */
export const REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string; status?: string };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function drawPicture(req: PictureRequest): Promise<Picture> {
  if (!config.illustratorKey) return { bytes: Buffer.from(standInPicture(req)), mime: "image/svg+xml", cost: 0, standIn: true };

  const parts: GeminiPart[] = [];
  req.references.forEach((r, i) => {
    parts.push({ text: `Reference picture ${i + 1}: ${r.label}` });
    parts.push({ inlineData: { mimeType: r.mime, data: r.data.toString("base64") } });
  });
  parts.push({ text: req.prompt });
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: req.aspect, imageSize: req.size ?? "2K" } },
  });

  // A busy moment (or a dropped connection) is tried once more; Google doesn't charge for a refused request.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${config.illustratorBaseUrl}/v1beta/models/${encodeURIComponent(config.pictureModel)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.illustratorKey },
        body,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      res = null;
    }
    if (res && res.status !== 429 && res.status < 500) break;
    if (attempt === 0) await wait(4000);
  }
  if (!res) throw new IllustratorError("The illustrator couldn't be reached. Please try again in a minute.", 0, true);

  const data = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (!res.ok) throw new IllustratorError(errorMessage(res.status, data.error?.message), 0, res.status === 429 || res.status >= 500);

  const cost = pictureCost(config.pictureModel, data.usageMetadata ?? {});
  const picture = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!picture?.inlineData?.data) {
    const finish = data.candidates?.[0]?.finishReason ?? "";
    const blocked = data.promptFeedback?.blockReason || /SAFETY|PROHIBITED|BLOCK/.test(finish);
    throw new IllustratorError(
      blocked
        ? "The illustrator wouldn't draw this one. Try again with a note about what to draw."
        : "The illustrator came back without a picture. Please try again.",
      cost,
      // A refused request is refused again; a picture that came out wrong may come out right next time.
      !data.promptFeedback?.blockReason,
    );
  }
  return { bytes: Buffer.from(picture.inlineData.data, "base64"), mime: picture.inlineData.mimeType ?? "image/png", cost, standIn: false };
}

/**
 * A reference picture, made small (at most 1024 pixels across, as a JPEG). It's plenty for the illustrator to keep a
 * character the same, it goes quicker, and full-size pictures could add up past what Google takes in one request.
 */
export async function smallReference(ref: Reference): Promise<Reference> {
  try {
    const { default: sharp } = await import("sharp");
    const data = await sharp(ref.data)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#fffaf0" })
      .jpeg({ quality: 86 })
      .toBuffer();
    return { ...ref, data, mime: "image/jpeg" };
  } catch {
    return ref;
  }
}

function errorMessage(status: number, detail: string | undefined): string {
  const said = detail ? ` (Google said: ${detail.slice(0, 160)})` : "";
  if (status === 400) return `The illustrator couldn't take that request${said}.`;
  if (status === 401 || status === 403) return `The Google key wasn't accepted. Check GEMINI_API_KEY, and that billing is turned on for it${said}.`;
  if (status === 404) return `The picture model "${config.pictureModel}" wasn't found. Check PICTURE_MODEL${said}.`;
  if (status === 429) return "The illustrator is busy, or the Google account has reached its limit for now. Please try again in a few minutes.";
  return `The illustrator hit a snag (${status}). Please try again.`;
}

// ------------------------------------------------------------- stand-ins

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Words wrapped to lines of about `width` letters, at most `max` lines (the last ends "…" if there was more). */
export function wrapWords(text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let placed = 0;
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = "";
      if (lines.length === max) break;
    }
    line = line ? `${line} ${word}` : word;
    placed++;
  }
  if (line && lines.length < max) lines.push(line);
  if (placed < words.length && lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/[.,;:!?]?$/, "…");
  return lines;
}

const PALETTES: Record<ArtStyle, { sky: [string, string]; hills: [string, string]; ink: string; glow: string }> = {
  watercolor: { sky: ["#f7efd9", "#cfe3ea"], hills: ["#b9d3a8", "#8fb388"], ink: "#3b2a1e", glow: "#f6d98b" },
  gouache: { sky: ["#ffe7a8", "#f7a679"], hills: ["#e2794f", "#b8433a"], ink: "#3a1d10", glow: "#fff2c4" },
  pencil: { sky: ["#f4ead6", "#e8dcc2"], hills: ["#c9b28a", "#a68b5b"], ink: "#4a3a28", glow: "#f2c46a" },
  block: { sky: ["#f3ead2", "#e6d6b0"], hills: ["#2f6f73", "#1d4447"], ink: "#1b1b1b", glow: "#e0533d" },
  papercut: { sky: ["#d9efe9", "#9fcfc4"], hills: ["#4f9a8a", "#2f6b5f"], ink: "#123a33", glow: "#f6e3a1" },
  felt: { sky: ["#f3e6d6", "#e2c9b0"], hills: ["#9cb27a", "#6f8a52"], ink: "#4a2f24", glow: "#f2b85c" },
  clay: { sky: ["#f6dcc4", "#e9b796"], hills: ["#8fbf7f", "#5f9a5a"], ink: "#4b2b1f", glow: "#ffd27a" },
  glass: { sky: ["#2b5fa8", "#6aa5d8"], hills: ["#2f8f4e", "#1d5e33"], ink: "#1a1a1a", glow: "#ffcf3f" },
  cartoon: { sky: ["#bfe8ff", "#ffe9a8"], hills: ["#7ccf6b", "#4aa25a"], ink: "#24323f", glow: "#ffd23f" },
  shadow: { sky: ["#f6b25e", "#c4502f"], hills: ["#1b1210", "#000000"], ink: "#1b1210", glow: "#ffe2a6" },
};

/** A simple, clearly-pretend picture: a little landscape with what the real one would show written on it. */
export function standInPicture(req: Pick<PictureRequest, "aspect" | "standIn">): string {
  const { heading, caption, style, seed } = req.standIn;
  const w = req.aspect === "1:1" ? 900 : 1200;
  const h = 900;
  const p = PALETTES[style];
  const n = createHash("sha1").update(seed).digest();
  const sunX = Math.round(w * (0.18 + (n[0] / 255) * 0.64));
  const sunY = Math.round(150 + (n[1] / 255) * 120);
  const hillA = Math.round(h * (0.62 + (n[2] / 255) * 0.08));
  const hillB = Math.round(h * (0.72 + (n[3] / 255) * 0.06));
  const lines = wrapWords(caption, req.aspect === "1:1" ? 34 : 46, 5);
  const textOnDark = style === "shadow";
  const boxW = w - 160;
  const boxH = 110 + lines.length * 44;
  const boxY = Math.round(h * 0.5 - boxH / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#sky)"/>
<circle cx="${sunX}" cy="${sunY}" r="70" fill="${p.glow}" opacity="0.9"/>
<path d="M0 ${hillA} C ${w * 0.25} ${hillA - 90}, ${w * 0.5} ${hillA + 40}, ${w} ${hillA - 50} L ${w} ${h} L 0 ${h} Z" fill="${p.hills[0]}"/>
<path d="M0 ${hillB} C ${w * 0.3} ${hillB + 30}, ${w * 0.7} ${hillB - 80}, ${w} ${hillB} L ${w} ${h} L 0 ${h} Z" fill="${p.hills[1]}"/>
<rect x="80" y="${boxY}" width="${boxW}" height="${boxH}" rx="22" fill="${textOnDark ? "#1b1210" : "#fffaf0"}" opacity="0.82"/>
<text x="${w / 2}" y="${boxY + 62}" text-anchor="middle" font-family="Georgia, serif" font-size="44" font-weight="700" fill="${textOnDark ? p.glow : p.ink}">${esc(heading)}</text>
${lines.map((l, i) => `<text x="${w / 2}" y="${boxY + 112 + i * 44}" text-anchor="middle" font-family="Georgia, serif" font-size="32" fill="${textOnDark ? "#f6e7c8" : p.ink}">${esc(l)}</text>`).join("\n")}
<text x="${w / 2}" y="${h - 34}" text-anchor="middle" font-family="Georgia, serif" font-size="24" font-style="italic" fill="${textOnDark ? p.glow : "#fffaf0"}" opacity="0.9">Stand-in picture · ${esc(ART_STYLES[style].label.toLowerCase())}</text>
</svg>`;
}

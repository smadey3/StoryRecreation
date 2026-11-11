"use client";

import { useEffect, useState } from "react";
import { ART_STYLES, SKETCHES, bookPictures } from "@/lib/shared/art";
import type { ArtStyle } from "@/lib/shared/types";

type Samples = Partial<Record<ArtStyle, string | null>>;

/**
 * Each style's example picture (the same little scene in every style), as each is ready. The first time anyone looks,
 * they're being drawn, so this looks again every few seconds until they're all here (or for a few minutes at most).
 */
function useStyleSamples(): Samples {
  const [samples, setSamples] = useState<Samples>({});
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const look = async () => {
      try {
        const res = await fetch("/api/art-styles/samples", { cache: "no-store" });
        if (!res.ok || stop) return;
        const data = (await res.json()) as { samples: Samples; drawing: boolean };
        setSamples(data.samples);
        if (data.drawing && Date.now() - started < 5 * 60_000) timer = setTimeout(() => void look(), 6000);
      } catch {
        // Without the examples, the styles are still there to choose.
      }
    };
    void look();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);
  return samples;
}

/** The illustrator's styles, as choice cards, each with its example picture once it's drawn. */
export function StylePicker({ value, onChange }: { value: ArtStyle; onChange: (s: ArtStyle) => void }) {
  const samples = useStyleSamples();
  const chosen = samples[value];
  return (
    <div className="stack" style={{ ["--gap" as string]: "14px" }}>
      <div className="choices style-choices" style={{ ["--min" as string]: "140px" }} role="radiogroup" aria-label="Picture style">
        {(Object.keys(ART_STYLES) as ArtStyle[]).map((s) => {
          const sample = samples[s];
          return (
            <button key={s} type="button" className="choice" role="radio" aria-checked={value === s} onClick={() => onChange(s)}>
              {sample ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="style-sample" src={sample} alt="" loading="lazy" />
              ) : (
                <span className="choice-emoji">{ART_STYLES[s].emoji}</span>
              )}
              <span className="choice-title">{ART_STYLES[s].label}</span>
              <span className="choice-sub">{ART_STYLES[s].blurb}</span>
            </button>
          );
        })}
      </div>
      {chosen && (
        <figure className="style-example">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={chosen} alt={`The same little scene drawn in the ${ART_STYLES[value].label} style`} />
          <figcaption className="small muted">An example of {ART_STYLES[value].label}: every picture in your book is made this way.</figcaption>
        </figure>
      )}
    </div>
  );
}

/** About what a whole picture book costs: a few sketches of the main characters, the cover and every page. */
export const bookEstimate = (pages: number, each: number, mainCharacters = 2) => (bookPictures(pages) + mainCharacters * SKETCHES) * each;

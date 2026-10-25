"use client";

import { useEffect, useState } from "react";
import { WaitLine } from "./Waiting";
import { pdfFileName } from "@/lib/shared/pdf";

/** Whether this phone (or computer) can hand a file to its share sheet: Messages, email, AirDrop… */
function canShare(file: File): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * A story as a PDF book, to send to friends and family or print: made when it's asked for, then shared straight from
 * the phone where the phone can (a second tap, since a share has to come from a tap), or saved like any download.
 */
export function PdfShare({
  storyId,
  title,
  note,
  seconds,
  label = "📄 Make a PDF book to share",
}: {
  storyId: string;
  title: string;
  /** What's in it, beneath the button (left out where there's no room). */
  note?: string;
  seconds: number;
  label?: string;
}) {
  const [making, setMaking] = useState<number | null>(null);
  const [ready, setReady] = useState<{ file: File; url: string; shareable: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (ready) URL.revokeObjectURL(ready.url);
    },
    [ready],
  );

  const save = (book = ready) => {
    if (!book) return;
    const a = document.createElement("a");
    a.href = book.url;
    a.download = book.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setSaved(true);
  };

  const make = async () => {
    setError(null);
    setSaved(false);
    setMaking(Date.now());
    try {
      const res = await fetch(`/api/stories/${storyId}/pdf`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (data.code === "signed_out") window.location.href = "/welcome";
        throw new Error(data.error ?? "The book couldn't be made. Please try again.");
      }
      const file = new File([await res.blob()], pdfFileName(title), { type: "application/pdf" });
      const book = { file, url: URL.createObjectURL(file), shareable: canShare(file) };
      setReady(book);
      if (!book.shareable) save(book); // a computer, say: it's saved straight away
    } catch (err) {
      setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "The book couldn't be made. Check the connection and try again.");
    } finally {
      setMaking(null);
    }
  };

  const share = async () => {
    if (!ready) return;
    try {
      await navigator.share({ files: [ready.file], title });
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) save(); // sharing didn't work here: it's saved instead
    }
  };

  return (
    <div className="pdf-share">
      {making ? (
        <WaitLine what="Making the book" done={0} total={1} startedAt={making} seconds={seconds} />
      ) : ready ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            📖 <b>{ready.file.name}</b> is ready{saved ? ", and saved with your downloads" : ""}.
          </p>
          <div className="row" style={{ justifyContent: "center", gap: 8 }}>
            {ready.shareable && (
              <button type="button" className="btn btn-sm" onClick={share}>
                📤 Share it
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => save()}>
              {saved ? "Save it again" : "⬇️ Save it"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={make}>
              {label}
            </button>
          </div>
          {note && (
            <p className="small faint" style={{ margin: 0 }}>
              {note}
            </p>
          )}
        </>
      )}
      {error && <p className="notice notice-error small">{error}</p>}
    </div>
  );
}

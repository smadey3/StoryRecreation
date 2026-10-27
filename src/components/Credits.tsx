"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useApi } from "@/components/Grownup";
import type { VoiceCredits } from "@/lib/shared/types";

// The family's ElevenLabs voice credit, shown wherever something is about to spend it.

let asked: { at: number; credits: Promise<VoiceCredits | null> } | null = null;

/** This month's voice credit: undefined while asking, null when it can't be told. */
export function useCredits(): VoiceCredits | null | undefined {
  const api = useApi();
  const [credits, setCredits] = useState<VoiceCredits | null | undefined>(undefined);
  useEffect(() => {
    if (!asked || Date.now() - asked.at > 60 * 1000) {
      asked = {
        at: Date.now(),
        credits: api.get<{ credits: VoiceCredits | null }>("/api/credits").then(
          (r) => r.credits,
          () => null,
        ),
      };
    }
    let live = true;
    void asked.credits.then((c) => live && setCredits(c));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return credits;
}

const n = (x: number) => Math.round(x).toLocaleString();
const day = (at: number) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
const until = (c: VoiceCredits) => (c.resetsAt ? ` until ${day(c.resetsAt)}` : " this month");

/** "Uses about 2,400 voice credits. You have 18,240 left until Nov 3." With a warning when it's more than is left. */
export function CreditNote({ needed, className = "faint small center" }: { needed: number; className?: string }) {
  const credits = useCredits();
  const cost = `Uses about ${n(needed)} voice credits`;
  if (!credits) return <p className={className}>{cost}.</p>;
  if (needed > credits.left) {
    return (
      <p className="notice notice-error small center" style={{ margin: 0 }}>
        {cost}, more than the {n(credits.left)} left{until(credits)}, so the recording would stop partway. Choose something shorter, or top
        up at elevenlabs.io.
      </p>
    );
  }
  return (
    <p className={className}>
      {cost}. You have {n(credits.left)} left{until(credits)}
      {credits.demo ? " (pretend, in demo mode)" : ""}.
    </p>
  );
}

/** "You have 18,240 voice credits left until Nov 3." */
export function CreditsLeft({ className = "faint small center" }: { className?: string }) {
  const credits = useCredits();
  if (!credits) return null;
  return (
    <p className={className}>
      You have {n(credits.left)} voice credits left{until(credits)}
      {credits.demo ? " (pretend, in demo mode)" : ""}.
    </p>
  );
}

/**
 * A button that starts something spending voice credits. When it needs more than are left, the first tap asks first:
 * a story that runs out stops partway (what's recorded is kept, and "Try again" records the rest once there's credit).
 */
export function CreditButton({
  needed,
  onClick,
  className,
  disabled,
  children,
}: {
  needed: number;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const credits = useCredits();
  const [asking, setAsking] = useState(false);
  const short = Boolean(credits && needed > credits.left);
  if (asking && short && credits) {
    return (
      <div className="notice notice-error credit-ask stack" role="alertdialog" aria-label="Not enough voice credits" style={{ ["--gap" as string]: "10px" }}>
        {/* The note beside the button already says how many it needs and how many are left. */}
        <p className="small" style={{ margin: 0 }}>
          <b>Start it anyway?</b> It will stop partway. What&apos;s recorded is kept, and <i>Try again</i> records the rest once you top up at
          elevenlabs.io{credits.resetsAt ? ` or the credits refill${until(credits).replace(" until", " on")}` : ""}.
        </p>
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setAsking(false);
              onClick();
            }}
          >
            Start anyway
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(false)}>
            Not now
          </button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className={className} disabled={disabled} onClick={() => (short ? setAsking(true) : onClick())}>
      {children}
    </button>
  );
}

/** Whether something costing this much fits in what's left (true when the balance can't be told). */
export function useAffordable(needed: number): boolean {
  const credits = useCredits();
  return !credits || needed <= credits.left;
}

/** The month's credit as a bar, for the Grown-ups' corner. */
export function CreditMeter() {
  const credits = useCredits();
  if (credits === undefined) return <div className="small muted">Checking your voice credits…</div>;
  if (credits === null)
    return (
      <div className="small muted">
        Voice credits: couldn&apos;t be read. In ElevenLabs, give the API key permission to read your account (User → Read) to see them here.
      </div>
    );
  const share = credits.limit ? credits.left / credits.limit : 0;
  return (
    <div className="stack" style={{ ["--gap" as string]: "6px" }}>
      <div className="credit-meter" role="meter" aria-valuemin={0} aria-valuemax={credits.limit} aria-valuenow={credits.left} aria-label="Voice credits left">
        <span style={{ width: `${Math.round(share * 100)}%` }} className={share < 0.1 ? "low" : undefined} />
      </div>
      <div className="small">
        <b>{n(credits.left)}</b> of {n(credits.limit)} voice credits left{until(credits)}
        {credits.plan ? ` · ${credits.demo ? "pretend, in demo mode" : `${credits.plan.charAt(0).toUpperCase()}${credits.plan.slice(1)} plan`}` : ""}.
        {share < 0.1 && !credits.demo ? " Running low: shorter stories, or a top-up at elevenlabs.io, will see you through." : ""}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { ApiError, RememberDevice, useApi } from "@/components/Grownup";
import { PIN_DIGITS, PinEntry } from "@/components/PinEntry";
import { Spinner } from "@/components/Waiting";
import { formatMoney } from "@/lib/shared/art";
import { aboutTime } from "@/lib/shared/options";

// Anything that costs money is a purchase: the price is shown first, and a
// grown-up says yes. With the family PIN, unless it was entered on this device
// lately (or the device is remembered for 30 days): then a tap is enough. A
// family without a PIN chooses one here.

export interface PurchaseOffer {
  /** What's being bought: "Sketch the tooth fairy (3 tries)". */
  what: string;
  pictures: number;
  /** What one picture is priced at, in millionths of a dollar. */
  each: number;
  /** False while pictures are stand-ins: free, and the price shown is what it would be. */
  real: boolean;
  /** About how long it takes, in seconds, so nobody wonders afterwards. */
  seconds?: number;
  /** Make the purchase, with the price the grown-up said yes to (and the PIN, when this device needs it). */
  buy: (approval: { pin?: string; micros: number; remember?: boolean }) => Promise<void>;
}

export function PurchaseDialog({ offer, onDone }: { offer: PurchaseOffer; onDone: (bought: boolean) => void }) {
  const api = useApi();
  const [pinSet, setPinSet] = useState<boolean | null>(null);
  // A grown-up entered the PIN on this device lately (or asked it not to ask): a tap says yes.
  const [unlocked, setUnlocked] = useState(false);
  const [remember, setRemember] = useState(true);
  // How many digits the PIN has, so it's checked as soon as it's all in (see PinEntry).
  const [digits, setDigits] = useState<number | null | undefined>(undefined);
  // Choosing a new PIN: the first entry, waiting to be confirmed.
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The price as the server last said it is, once it's said it changed: shown, and what the next yes approves.
  const [priced, setPriced] = useState<number | null>(null);
  const total = priced ?? offer.each * offer.pictures;
  const each = total / Math.max(1, offer.pictures);

  useEffect(() => {
    api.get<{ pinSet: boolean; digits?: number | null; unlocked?: boolean }>("/api/pin").then(
      (r) => {
        setPinSet(r.pinSet);
        setUnlocked(r.pinSet && Boolean(r.unlocked));
        setDigits(r.pinSet ? (r.digits ?? null) : PIN_DIGITS);
      },
      () => {
        setPinSet(true);
        setDigits(null);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approve = async (pin?: string) => {
    setBusy(true);
    setError(null);
    try {
      await offer.buy({ pin, micros: offer.real ? total : 0, remember: pin ? remember : undefined });
      onDone(true);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "pin_needed") {
        setPinSet(false);
        setUnlocked(false);
        setDigits(PIN_DIGITS);
      } else {
        if (err instanceof ApiError && err.code === "price_changed" && typeof err.details?.price === "number") setPriced(err.details.price);
        setError(err instanceof Error ? err.message : "That didn't work.");
      }
      setBusy(false);
      return false;
    }
  };

  /** The whole PIN is in: approve with it, or (choosing one) take it, then make sure. */
  const entered = async (pin: string) => {
    if (pinSet) return approve(pin);
    if (first === null) {
      setFirst(pin);
      return true;
    }
    if (first !== pin) {
      setError("Those didn't match. Choose a PIN again.");
      setFirst(null);
      return false;
    }
    setBusy(true);
    try {
      await api.put("/api/pin", { pin, remember });
      setPinSet(true);
      setDigits(pin.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That PIN couldn't be saved.");
      setFirst(null);
      setBusy(false);
      return false;
    }
    return approve(pin);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onDone(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const choosing = pinSet === false;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="buy-title">
      <div className="modal parchment center purchase">
        <div className="eyebrow">For grown-ups</div>
        {/* Until it's known whether the family has a PIN, it isn't said which to enter. */}
        <h2 id="buy-title" style={pinSet === null ? { visibility: "hidden" } : undefined}>
          {choosing ? (first === null ? "Choose a family PIN" : "Once more, to be sure") : unlocked ? "Buy these pictures?" : "Approve this purchase"}
        </h2>
        <div className="purchase-summary">
          <div className="purchase-what">{offer.what}</div>
          <div className="purchase-price">{offer.real ? formatMoney(total) : "Free"}</div>
          <div className="small purchase-terms">
            {offer.real
              ? `${offer.pictures} ${offer.pictures === 1 ? "picture" : "pictures"}, about ${formatMoney(each)} each, charged to your Google account. Storyhollow never spends more than ${formatMoney(total)}.`
              : `Stand-in pictures, while the illustrator isn't set up. With it, this would be about ${formatMoney(total)}.`}
          </div>
          {offer.seconds ? <div className="small purchase-time">⏱️ Ready in {aboutTime(offer.seconds)}. You can carry on while it works.</div> : null}
        </div>
        {choosing && (
          <p className="small purchase-terms" style={{ margin: 0 }}>
            Four digits you&apos;ll remember, so little fingers can&apos;t buy pictures. It also keeps making stories and the Grown-ups&apos; corner for
            grown-ups.
          </p>
        )}
        {unlocked ? (
          <>
            {error && <p className="small pin-error">{error}</p>}
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-lg" type="button" onClick={() => void approve()} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner /> Starting…
                  </>
                ) : offer.real ? (
                  `Yes, buy them · ${formatMoney(total)}`
                ) : (
                  "Yes, draw them"
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <PinEntry digits={digits} onComplete={entered} error={error} onType={() => setError(null)} />
            <RememberDevice checked={remember} onChange={setRemember} />
          </>
        )}
        <p style={{ marginTop: 14 }}>
          <button className="btn-quiet btn" type="button" onClick={() => onDone(false)} disabled={busy}>
            Never mind
          </button>
        </p>
      </div>
    </div>
  );
}

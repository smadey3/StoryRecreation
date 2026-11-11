"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { PinEntry } from "@/components/PinEntry";

// Every API call goes through `useApi()`. If the server says a grown-up is
// needed (a PIN is set and the device isn't unlocked), a PIN pad appears and
// the request is retried automatically once it's entered.

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** Everything else the server said about it. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Requester = <T = unknown>(url: string, init?: RequestInit & { json?: unknown }) => Promise<T>;

const GrownupContext = createContext<{ request: Requester; askPin: () => Promise<boolean> } | null>(null);

export function useApi() {
  const ctx = useContext(GrownupContext);
  if (!ctx) throw new Error("useApi must be used inside <GrownupProvider>");
  const { request } = ctx;
  return {
    get: <T,>(url: string) => request<T>(url),
    post: <T,>(url: string, json?: unknown) => request<T>(url, { method: "POST", json: json ?? {} }),
    patch: <T,>(url: string, json: unknown) => request<T>(url, { method: "PATCH", json }),
    put: <T,>(url: string, json: unknown) => request<T>(url, { method: "PUT", json }),
    del: <T,>(url: string) => request<T>(url, { method: "DELETE" }),
    form: <T,>(url: string, body: FormData, method = "POST") => request<T>(url, { method, body }),
    askPin: ctx.askPin,
  };
}

async function rawRequest<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string } & Record<string, unknown>;
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code, data);
  return data as T;
}

export function GrownupProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const waiters = useRef<((ok: boolean) => void)[]>([]);

  const askPin = useCallback(() => {
    setOpen(true);
    return new Promise<boolean>((resolve) => waiters.current.push(resolve));
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    const w = waiters.current;
    waiters.current = [];
    w.forEach((fn) => fn(ok));
  };

  const request: Requester = useCallback(
    async <T,>(url: string, init?: RequestInit & { json?: unknown }) => {
      try {
        return await rawRequest<T>(url, init);
      } catch (err) {
        if (err instanceof ApiError && err.code === "pin_required") {
          if (await askPin()) return rawRequest<T>(url, init);
        }
        if (err instanceof ApiError && err.code === "signed_out") window.location.href = "/welcome";
        throw err;
      }
    },
    [askPin],
  ) as Requester;

  return (
    <GrownupContext.Provider value={{ request, askPin }}>
      {children}
      {open && <PinPad onDone={finish} />}
    </GrownupContext.Provider>
  );
}

function PinPad({ onDone }: { onDone: (ok: boolean) => void }) {
  const [digits, setDigits] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Grown-ups mostly use the family's own phone: once is enough for a good while.
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    rawRequest<{ digits?: number | null }>("/api/pin").then(
      (r) => setDigits(r.digits ?? null),
      () => setDigits(null),
    );
  }, []);

  const check = async (pin: string) => {
    try {
      await rawRequest("/api/pin", { method: "POST", json: { pin, remember } });
      onDone(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      return false;
    }
  };

  return (
    <div className="modal-backdrop pin-backdrop" role="dialog" aria-modal="true" aria-labelledby="pin-title">
      <div className="modal parchment center">
        <div className="eyebrow">For grown-ups</div>
        <h2 id="pin-title">Enter the family PIN</h2>
        <p className="muted small">Making new stories uses storytelling credits, so a grown-up needs to say yes.</p>
        <PinEntry digits={digits} onComplete={check} error={error} onType={() => setError(null)} />
        <RememberDevice checked={remember} onChange={setRemember} />
        <p style={{ marginTop: 12 }}>
          <button className="btn-quiet btn" type="button" onClick={() => onDone(false)}>
            Never mind
          </button>
        </p>
      </div>
    </div>
  );
}

/** "Don't ask again on this device for 30 days": under every PIN pad. */
export function RememberDevice({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="remember-device small">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Don&apos;t ask again on this device for 30 days
    </label>
  );
}

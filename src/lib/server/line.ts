import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config";

// Turns at something only a few can have at once (ElevenLabs' recordings, or putting a finished story together),
// shared out fairly: the story started first goes first, whoever asks on its behalf, and a story waiting its turn can
// say where it stands and about how long it will be.

/** A story's place in the line: which story, and when its turn in line began (earlier goes first). */
export interface Place {
  story: string;
  since: number;
}

const placeNow = new AsyncLocalStorage<Place>();

/** Work for a story: whatever a line is asked for meanwhile, wherever it's asked from, waits in the story's place. */
export const forStory = <T>(place: Place, work: () => T): T => placeNow.run(place, work);

interface Waiting {
  story: string | null;
  since: number;
  turn: number;
  go: () => void;
}

/** One story's turns: how many are waiting and being had, and how long it has waited with nothing being made for it. */
interface StoryTurns {
  waiting: number;
  having: number;
  stalledAt: number | null;
  stalledMs: number;
}

export class Line {
  private had = 0;
  private queue: Waiting[] = [];
  private turns = 0;
  private stories = new Map<string, StoryTurns>();

  /** `size()` turns at once; a turn takes about `turnSeconds`, to begin with (then as long as turns have lately). */
  constructor(
    private size: () => number,
    private turnSeconds: number,
  ) {}

  /** `work`, when its turn comes. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    const place = placeNow.getStore();
    const mine = place ? this.turnsOf(place.story) : null;
    if (this.had < this.size() && !this.queue.length) this.had++;
    else {
      if (mine) this.count(mine, () => mine.waiting++);
      await new Promise<void>((go) => this.join({ story: place?.story ?? null, since: place?.since ?? Date.now(), turn: this.turns++, go }));
      if (mine) mine.waiting--;
    }
    if (mine) this.count(mine, () => mine.having++);
    const began = Date.now();
    try {
      return await work();
    } finally {
      this.turnSeconds = this.turnSeconds * 0.8 + ((Date.now() - began) / 1000) * 0.2;
      if (mine) this.count(mine, () => mine.having--);
      // The turn passes straight to whoever's next.
      const next = this.queue.shift();
      if (next) next.go();
      else this.had--;
    }
  }

  /**
   * Where a story stands while it waits with nothing being made for it: how many other stories are ahead of it, and
   * about how long until its turn, in seconds. Null when it isn't waiting.
   */
  placeOf(story: string): { ahead: number; seconds: number } | null {
    const t = this.stories.get(story);
    if (!t || t.having > 0 || t.waiting === 0) return null;
    const first = this.queue.findIndex((w) => w.story === story);
    if (first < 0) return null;
    const ahead = new Set(this.queue.slice(0, first).map((w) => w.story ?? `turn ${w.turn}`)).size;
    return { ahead, seconds: Math.round(((first + 1) / Math.max(1, this.size())) * this.turnSeconds) };
  }

  /** How long a story has waited with nothing being made for it, in seconds (still counting while it waits). */
  waitedSeconds(story: string): number {
    const t = this.stories.get(story);
    return t ? (t.stalledMs + (t.stalledAt === null ? 0 : Date.now() - t.stalledAt)) / 1000 : 0;
  }

  /** A story's work is done: its turns are let go of. */
  forget(story: string) {
    this.stories.delete(story);
  }

  private join(w: Waiting) {
    // In the order each story's turn in line began, and a story's own turns in the order it asked for them.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].since > w.since) i--;
    this.queue.splice(i, 0, w);
  }

  private turnsOf(story: string): StoryTurns {
    let t = this.stories.get(story);
    if (!t) this.stories.set(story, (t = { waiting: 0, having: 0, stalledAt: null, stalledMs: 0 }));
    return t;
  }

  /** A change to a story's turns, keeping count of the time it spends waiting with nothing being made for it. */
  private count(t: StoryTurns, change: () => void) {
    change();
    const stalled = t.waiting > 0 && t.having === 0;
    if (stalled && t.stalledAt === null) t.stalledAt = Date.now();
    else if (!stalled && t.stalledAt !== null) {
      t.stalledMs += Date.now() - t.stalledAt;
      t.stalledAt = null;
    }
  }
}

/**
 * The lines every story shares, kept on globalThis so every part of the app keeps the one count. ElevenLabs makes only
 * so many recordings at once for an account (5 on Creator, 10 on Pro): the stories keep to VOICES_AT_ONCE between them,
 * which leaves room for a voice being designed or learned. Finished stories are put together one at a time.
 */
const globalForLines = globalThis as unknown as { __storyhollowLines?: { voices: Line; binding: Line } };
export const turns = (globalForLines.__storyhollowLines ??= {
  voices: new Line(() => config.voicesAtOnce, 20),
  binding: new Line(() => 1, 5),
});

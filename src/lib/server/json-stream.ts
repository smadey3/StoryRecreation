// A JSON object as it streams in, a few characters at a time: each top-level field the moment its value is complete,
// and, inside a top-level list, each item the moment it's complete (and the moment the next one begins). The storyteller
// writes a story's script this way, so its pages can be voiced while the rest is still being written.

export interface JsonStreamEvents {
  /** A top-level field is complete: its key, and its value as JSON. */
  field?: (key: string, json: string) => void;
  /** An object in a top-level list has begun: the list's key, and the item's place in it (from 0). */
  begin?: (key: string, index: number) => void;
  /** An object in a top-level list is complete: the list's key, its place, and the object as JSON. */
  item?: (key: string, index: number, json: string) => void;
}

export class JsonStream {
  private text = "";
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  // The top-level field being read: its key, where its value starts, and (for a list) where the current item starts.
  private key: string | null = null;
  private keyStart = -1;
  private valueStart = -1;
  private list = false;
  private itemStart = -1;
  private items = 0;
  // Once the object is closed, anything after it is no part of it.
  private closed = false;

  constructor(private on: JsonStreamEvents) {}

  /** The next few characters. */
  push(more: string) {
    if (this.closed) return;
    this.text += more;
    for (; this.pos < this.text.length && !this.closed; this.pos++) this.read(this.text[this.pos], this.pos);
  }

  private read(ch: string, at: number) {
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (ch === "\\") this.escaped = true;
      else if (ch === '"') {
        this.inString = false;
        if (this.depth === 1 && this.keyStart >= 0) {
          this.key = this.text.slice(this.keyStart, at);
          this.keyStart = -1;
        } else if (this.depth === 1 && this.valueStart >= 0) this.complete(at + 1);
      }
      return;
    }
    if (ch === '"') {
      this.inString = true;
      if (this.depth === 1) {
        if (this.key === null) this.keyStart = at + 1;
        else this.valueStart = at;
      }
    } else if (ch === "{" || ch === "[") {
      if (this.depth === 1 && this.key !== null) {
        this.valueStart = at;
        this.list = ch === "[";
      } else if (this.depth === 2 && this.list && ch === "{") {
        this.itemStart = at;
        this.on.begin?.(this.key!, this.items);
      }
      this.depth++;
    } else if (ch === "}" || ch === "]") {
      this.depth--;
      if (this.depth === 2 && this.itemStart >= 0) {
        this.on.item?.(this.key!, this.items++, this.text.slice(this.itemStart, at + 1));
        this.itemStart = -1;
      } else if (this.depth === 1 && this.valueStart >= 0) this.complete(at + 1);
      else if (this.depth === 0 && this.valueStart >= 0) this.complete(at); // a number or a word, last in the object
      if (this.depth === 0) this.closed = true;
    } else if (ch === ",") {
      if (this.depth === 1 && this.valueStart >= 0) this.complete(at); // a number or a word
    } else if (this.depth === 1 && this.key !== null && this.valueStart < 0 && ch !== ":" && !/\s/.test(ch)) {
      this.valueStart = at; // a number, true, false or null
    }
  }

  private complete(end: number) {
    const key = this.key!;
    const json = this.text.slice(this.valueStart, end).trim();
    this.key = null;
    this.valueStart = -1;
    this.list = false;
    this.items = 0;
    this.on.field?.(key, json);
  }
}

// Which trails you've ridden, kept in this browser's localStorage.
//
// Trails are keyed by park + name (plus the location hint for repeated names), not by id, so the
// log survives a data refresh that renumbers trails. Export/import moves it between browsers.

import { Trail } from './data';

const STORAGE_KEY = 'northbay-trails:ridden:v1';

/** trail key → date first marked ridden (YYYY-MM-DD) */
type Log = Record<string, string>;

export const trailKey = (t: Trail) => `${t.park ?? ''}/${t.name}${t.area ? ` (${t.area})` : ''}`;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class Rides {
  private log: Log = {};
  private listeners: (() => void)[] = [];

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.log = JSON.parse(raw);
    } catch {
      this.log = {};
    }
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  has(t: Trail) {
    return trailKey(t) in this.log;
  }

  date(t: Trail): string | null {
    return this.log[trailKey(t)] ?? null;
  }

  set(t: Trail, ridden: boolean) {
    const k = trailKey(t);
    if (ridden) this.log[k] ??= today();
    else delete this.log[k];
    this.save();
  }

  toggle(t: Trail) {
    this.set(t, !this.has(t));
  }

  /** Download the log as a JSON file */
  export() {
    const blob = new Blob([JSON.stringify({ ridden: this.log }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ridden-trails-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Merge a previously exported log; returns how many trails it added */
  import(text: string): number {
    const data = JSON.parse(text);
    const incoming: Log = data.ridden ?? data;
    if (typeof incoming !== 'object' || incoming === null) throw new Error('Not a ridden-trails file');
    let added = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v !== 'string') continue;
      if (!(k in this.log)) added++;
      if (!this.log[k] || v < this.log[k]) this.log[k] = v;
    }
    this.save();
    return added;
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.log));
    } catch {
      // private mode or storage blocked: progress lasts for this visit only
    }
    for (const fn of this.listeners) fn();
  }
}

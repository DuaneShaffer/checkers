import type { DriverSnapshot } from './driver.ts';

export class SnapshotHub {
  #listeners = new Set<(s: DriverSnapshot) => void>();

  subscribe(fn: (s: DriverSnapshot) => void, current: DriverSnapshot): () => void {
    this.#listeners.add(fn);
    fn(current);
    return () => this.#listeners.delete(fn);
  }

  emit(s: DriverSnapshot): void {
    for (const fn of [...this.#listeners]) fn(s);
  }

  clear(): void {
    this.#listeners.clear();
  }
}

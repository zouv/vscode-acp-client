/**
 * Released / retired agent terminals stay visible for a while so the user can read their
 * output, but only the newest `cap` of them: every `terminal/create` makes a VS Code
 * terminal, and a long session would otherwise pile up hundreds until shutdown.
 */
export class RetainedPool<T> {
  private readonly items = new Set<T>();

  constructor(private readonly cap: number, private readonly disposeItem: (item: T) => void) {}

  get size(): number { return this.items.size; }

  add(item: T): void {
    this.items.delete(item);
    this.items.add(item);
    while (this.items.size > this.cap) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
      this.disposeItem(oldest);
    }
  }

  /** Forget without disposing (the user closed it themselves). */
  delete(item: T): void { this.items.delete(item); }

  clear(): void {
    const items = Array.from(this.items);
    this.items.clear();
    for (const item of items) { this.disposeItem(item); }
  }
}

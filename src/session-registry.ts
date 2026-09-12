export interface ClosableSession {
  close(): void | Promise<void>;
}

interface SessionEntry<T> {
  value: T;
  lastUsed: number;
}

export class SessionRegistry<T extends ClosableSession> {
  private readonly entries = new Map<string, SessionEntry<T>>();

  constructor(
    private readonly maxSessions: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error(`maxSessions must be a positive integer, got ${maxSessions}`);
    }
  }

  get(sessionId: string): T | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    entry.lastUsed = this.now();
    return entry.value;
  }

  set(sessionId: string, value: T): string[] {
    const existing = this.entries.get(sessionId);
    if (existing && existing.value !== value) {
      this.closeQuietly(existing.value);
    }

    this.entries.set(sessionId, { value, lastUsed: this.now() });
    return this.evictOverflow();
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOverflow(): string[] {
    const evicted: string[] = [];

    while (this.entries.size > this.maxSessions) {
      let oldestId: string | undefined;
      let oldestLastUsed = Number.POSITIVE_INFINITY;

      for (const [sessionId, entry] of this.entries) {
        if (entry.lastUsed < oldestLastUsed) {
          oldestId = sessionId;
          oldestLastUsed = entry.lastUsed;
        }
      }

      if (!oldestId) break;
      const entry = this.entries.get(oldestId);
      this.entries.delete(oldestId);
      if (entry) this.closeQuietly(entry.value);
      evicted.push(oldestId);
    }

    return evicted;
  }

  private closeQuietly(value: T): void {
    try {
      const result = value.close();
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Best effort: the registry bound is already enforced by removing the entry.
    }
  }
}

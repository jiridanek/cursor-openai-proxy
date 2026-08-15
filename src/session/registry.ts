import type { AgentHandle, RunHandle, TokenUsage } from "../cursor/backend.ts";

export class Mutex {
  #locked = false;
  #queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#locked = false;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export type SessionStatus =
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export type SessionRecord = {
  id: string;
  callerKeyHash: string;
  agent: AgentHandle;
  mutex: Mutex;
  activeRun?: RunHandle;
  outputText: string;
  status: SessionStatus;
  model: string;
  createdAt: number;
  previousResponseId: string | null;
  stored: boolean;
  kind: "chat" | "response";
  usage?: TokenUsage;
};

function sessionKey(callerKeyHash: string, id: string): string {
  return `${callerKeyHash}:${id}`;
}

export class SessionRegistry {
  readonly #byKey = new Map<string, SessionRecord>();
  readonly #ids = new Map<string, Set<string>>();

  get(callerKeyHash: string, id: string): SessionRecord | undefined {
    return this.#byKey.get(sessionKey(callerKeyHash, id));
  }

  existsUnderAnyCaller(id: string): boolean {
    const hashes = this.#ids.get(id);
    return Boolean(hashes && hashes.size > 0);
  }

  set(record: SessionRecord): void {
    this.#byKey.set(sessionKey(record.callerKeyHash, record.id), record);
    let hashes = this.#ids.get(record.id);
    if (!hashes) {
      hashes = new Set();
      this.#ids.set(record.id, hashes);
    }
    hashes.add(record.callerKeyHash);
  }

  alias(callerKeyHash: string, id: string, record: SessionRecord): void {
    this.#byKey.set(sessionKey(callerKeyHash, id), record);
    let hashes = this.#ids.get(id);
    if (!hashes) {
      hashes = new Set();
      this.#ids.set(id, hashes);
    }
    hashes.add(callerKeyHash);
  }

  all(): SessionRecord[] {
    return [...new Set(this.#byKey.values())];
  }

  delete(callerKeyHash: string, id: string): void {
    this.#byKey.delete(sessionKey(callerKeyHash, id));
    const hashes = this.#ids.get(id);
    if (!hashes) return;
    hashes.delete(callerKeyHash);
    if (hashes.size === 0) this.#ids.delete(id);
  }

  async dispose(record: SessionRecord): Promise<void> {
    try {
      await record.agent.close();
    } catch {
      // ignore dispose errors
    }
  }
}

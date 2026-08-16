import type { AgentHandle, RunHandle, TokenUsage } from "../cursor/backend.ts";
import type { PendingToolCall } from "../mapping.ts";
import type { RunSupervisor } from "./supervisor.ts";

export class Mutex {
  #locked = false;
  #queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.#locked) {
      await new Promise<void>((resolve) => {
        this.#queue.push(resolve);
      });
    } else {
      this.#locked = true;
    }
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
  | "requires_action"
  | "completed"
  | "cancelled"
  | "failed";

export type SessionRecord = {
  id: string;
  callerKeyHash: string;
  agent: AgentHandle;
  mutex: Mutex;
  activeRun?: RunHandle;
  supervisor?: RunSupervisor;
  pendingToolCalls?: PendingToolCall[];
  outputText: string;
  reasoningText: string;
  status: SessionStatus;
  model: string;
  createdAt: number;
  previousResponseId: string | null;
  stored: boolean;
  usage?: TokenUsage;
  error?: { message: string; code?: string };
};

function sessionKey(callerKeyHash: string, id: string): string {
  return `${callerKeyHash}:${id}`;
}

export class SessionRegistry {
  readonly #byKey = new Map<string, SessionRecord>();
  readonly #ids = new Map<string, Set<string>>();
  readonly #creating = new Map<string, Promise<SessionRecord>>();
  readonly #inFlight = new Map<string, Promise<SessionRecord>>();

  get(callerKeyHash: string, id: string): SessionRecord | undefined {
    return this.#byKey.get(sessionKey(callerKeyHash, id));
  }

  /**
   * Atomically look up `aliasId`, or create it via `factory` if absent.
   * Concurrent callers for the same (callerKeyHash, aliasId) that arrive
   * before `factory` resolves share the same in-flight promise instead of
   * each racing their own factory call.
   */
  async getOrCreate(
    callerKeyHash: string,
    aliasId: string,
    factory: () => Promise<SessionRecord>,
  ): Promise<SessionRecord> {
    const key = sessionKey(callerKeyHash, aliasId);
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const pending = this.#creating.get(key);
    if (pending) return pending;
    const promise = factory()
      .then((record) => {
        this.set(record);
        this.alias(callerKeyHash, aliasId, record);
        return record;
      })
      .finally(() => {
        this.#creating.delete(key);
      });
    this.#creating.set(key, promise);
    return promise;
  }

  /**
   * Share a single in-flight `factory` call among concurrent callers keyed by
   * `key`, without registering the result under that key for later lookup --
   * unlike getOrCreate(), which permanently aliases its result for a durable
   * session handle (a client-supplied sticky id, meant to be reused forever).
   * This is for collapsing a race window on a key that's only a coincidental
   * match (e.g. the same set of stale/unknown call_ids from two concurrent
   * retries), not a handle worth keeping around: once the in-flight promise
   * settles, a later caller with the same key runs its own fresh factory
   * rather than reusing a since-completed result.
   */
  async dedupeInFlight(
    key: string,
    factory: () => Promise<SessionRecord>,
  ): Promise<SessionRecord> {
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const promise = factory().finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, promise);
    return promise;
  }

  /**
   * Find a caller's own session that's currently parked waiting on one of
   * `callIds`. Lets a tool-call follow-up be resumed by the `tool_call_id`
   * alone -- something every OpenAI-compliant client already echoes back as
   * part of the base protocol -- with no proxy-specific session id needed.
   * A linear scan: callers have few concurrent open sessions in practice, so
   * no dedicated reverse index (with its own cleanup burden) is warranted.
   */
  findByPendingCall(
    callerKeyHash: string,
    callIds: ReadonlySet<string>,
  ): SessionRecord | undefined {
    for (const record of this.all()) {
      if (record.callerKeyHash !== callerKeyHash) continue;
      if (record.status !== "requires_action") continue;
      if ((record.pendingToolCalls ?? []).some((call) => callIds.has(call.callId))) {
        return record;
      }
    }
    return undefined;
  }

  existsUnderAnyCaller(id: string): boolean {
    const hashes = this.#ids.get(id);
    return Boolean(hashes && hashes.size > 0);
  }

  set(record: SessionRecord): void {
    this.alias(record.callerKeyHash, record.id, record);
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
}

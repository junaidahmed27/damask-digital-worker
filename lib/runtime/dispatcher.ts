import { newId } from "@/lib/ids";
import type { LedgerEvent, LedgerEventName, LedgerEvents } from "./events";
import { parseDuration, type LedgerFunction, type Runtime, type Step } from "./step";

/**
 * The in process dispatcher. It routes events to the same durable function
 * bodies Inngest Cloud runs, implements the Step interface with memoized
 * checkpoints and an event bus, and lets `make demo`, the gate and the tests run
 * the whole runtime with no cloud account. See D-2 in docs/DECISIONS.md.
 */

type Waiter = {
  id: string;
  event: LedgerEventName;
  match?: string;
  matchValue?: unknown;
  resolve(event: LedgerEvent | null): void;
  timer: ReturnType<typeof setTimeout>;
};

export type DispatchedRun = {
  functionId: string;
  event: LedgerEvent;
  status: "running" | "done" | "failed";
  error?: Error;
};

export class LocalDispatcher {
  private readonly functions: LedgerFunction[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly inflight = new Set<Promise<unknown>>();
  readonly runs: DispatchedRun[] = [];
  readonly trace: { at: string; line: string; detail?: Record<string, unknown> }[] = [];

  constructor(readonly runtime: Runtime) {}

  register(...functions: LedgerFunction<never>[]): this;
  register(...functions: LedgerFunction[]): this;
  register(...functions: LedgerFunction[]): this {
    this.functions.push(...functions);
    return this;
  }

  /** Sends an event: wakes any waiter that matches, then starts every function triggered by it. */
  async send(event: LedgerEvent | LedgerEvent[]): Promise<void> {
    const list = Array.isArray(event) ? event : [event];
    for (const item of list) {
      this.log(`event ${item.name}`, item.data as Record<string, unknown>);

      for (const waiter of [...this.waiters]) {
        if (waiter.event !== item.name) continue;
        if (waiter.match) {
          const incoming = readPath(item.data as Record<string, unknown>, waiter.match.replace(/^data\./, ""));
          if (incoming !== waiter.matchValue) continue;
        }
        this.removeWaiter(waiter.id);
        clearTimeout(waiter.timer);
        waiter.resolve(item);
      }

      for (const fn of this.functions) {
        if (fn.trigger.event !== item.name) continue;
        this.start(fn, item);
      }
    }
  }

  private start(fn: LedgerFunction, event: LedgerEvent): void {
    const record: DispatchedRun = { functionId: fn.id, event, status: "running" };
    this.runs.push(record);
    const step = new LocalStep(this, `${fn.id}:${newId("i")}`, event);
    const promise = Promise.resolve()
      .then(() =>
        (fn as LedgerFunction<LedgerEventName>).handler({
          event: event as LedgerEvent<LedgerEventName>,
          step,
          runtime: this.runtime,
        }),
      )
      .then(() => {
        record.status = "done";
      })
      .catch((error: unknown) => {
        record.status = "failed";
        record.error = error instanceof Error ? error : new Error(String(error));
        this.log(`function ${fn.id} failed`, { error: record.error.message });
      })
      .finally(() => {
        this.inflight.delete(promise);
      });
    this.inflight.add(promise);
  }

  /**
   * Waits until the runtime is quiet: nothing executing, and anything still
   * open is parked on waitForEvent. A row waiting two days for an approver is
   * quiet, not busy, which is the whole point of a durable wait.
   */
  async settle(options: { timeoutMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (this.busy() === 0) {
        // Give any just resolved promise a turn to register its follow up work.
        await new Promise((r) => setImmediate(r));
        if (this.busy() === 0) return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`the dispatcher did not settle: ${this.busy()} function(s) still running`);
  }

  /** Invocations that are executing rather than parked on a wait. */
  private busy(): number {
    return Math.max(0, this.inflight.size - this.parked);
  }

  parked = 0;

  /** The functions that are parked on waitForEvent right now. */
  pendingWaits(): { event: LedgerEventName; matchValue: unknown }[] {
    return this.waiters.map((w) => ({ event: w.event, matchValue: w.matchValue }));
  }

  addWaiter(waiter: Waiter): void {
    this.waiters.push(waiter);
  }

  removeWaiter(id: string): void {
    const index = this.waiters.findIndex((w) => w.id === id);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  log(line: string, detail?: Record<string, unknown>): void {
    this.trace.push({ at: new Date().toISOString(), line, detail });
    this.runtime.log(line, detail);
  }

  failures(): DispatchedRun[] {
    return this.runs.filter((r) => r.status === "failed");
  }
}

class LocalStep implements Step {
  private readonly memo = new Map<string, unknown>();

  constructor(
    private readonly dispatcher: LocalDispatcher,
    private readonly invocationId: string,
    private readonly trigger: LedgerEvent,
  ) {}

  async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.memo.has(id)) return this.memo.get(id) as T;
    const value = await fn();
    this.memo.set(id, value);
    return value;
  }

  async sendEvent(_id: string, events: LedgerEvent | LedgerEvent[]): Promise<void> {
    await this.dispatcher.send(events);
  }

  async waitForEvent<N extends LedgerEventName>(
    id: string,
    opts: { event: N; timeout: string; match?: string },
  ): Promise<{ name: N; data: LedgerEvents[N]["data"] } | null> {
    const waiterId = `${this.invocationId}:${id}`;
    // Inngest's `match` compares a path on the incoming event to the same path
    // on the event that started this function. The local step does the same.
    const matchValue = opts.match
      ? readPath(this.trigger.data as Record<string, unknown>, opts.match.replace(/^data\./, ""))
      : undefined;
    this.dispatcher.parked += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.dispatcher.parked -= 1;
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.dispatcher.removeWaiter(waiterId);
        release();
        resolve(null);
      }, parseDuration(opts.timeout));
      if (typeof timer.unref === "function") timer.unref();
      this.dispatcher.addWaiter({
        id: waiterId,
        event: opts.event,
        match: opts.match,
        matchValue,
        resolve: (event) => {
          release();
          resolve(event as { name: N; data: LedgerEvents[N]["data"] } | null);
        },
        timer,
      });
    });
  }

  async sleep(_id: string, duration: string): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.min(parseDuration(duration), 50)));
  }
}

export function readPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const part of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export { LocalStep };

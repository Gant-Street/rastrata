import type { BrowserApplicationClient } from "../application-client.ts";
import type { SearchHit, SearchSource } from "../routes/registry-types.ts";

/** The most results one source shows. A source returns a handful; this is the stop that keeps a careless
 * one from filling the dialog. */
export const MOST_HITS_PER_SOURCE = 8;

/** One source's answer to the question asked, as the palette draws it. */
export interface SourceResult {
  readonly id: string;
  readonly label: string;
  readonly order: number;
  readonly hits: readonly SearchHit[];
  readonly state: "loading" | "ready" | "error";
}

/** The timers a session uses (so a test can drive them). */
export interface Clock {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: Clock = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The questions asked while the Search dialog is open. Each new question abandons the last: its timer
 * is cleared, its reads are aborted and its late answers are ignored. A source that answers from memory
 * (`instant`, the pages and actions) is asked at once on every keystroke; the others wait for a pause in
 * typing (`debounceMs`), so a word typed quickly is one read and not six. Sources are asked together and
 * answer on their own: one that is slow or fails shows as loading or failed in its own group and never
 * holds the others. The empty question asks everything at once (it is the list that opens the dialog).
 */
export class SearchSession {
  private results = new Map<string, SourceResult>();
  private controller: AbortController | null = null;
  private timer: unknown;
  private readonly clock: Clock;
  private readonly debounceMs: number;

  constructor(
    private readonly options: {
      readonly sources: readonly SearchSource[];
      readonly client: BrowserApplicationClient;
      /** Told every time any group changes, with all the groups in `order`. */
      readonly onChange: (results: readonly SourceResult[]) => void;
      readonly debounceMs?: number;
      readonly clock?: Clock;
    },
  ) {
    this.clock = options.clock ?? realClock;
    this.debounceMs = options.debounceMs ?? 150;
  }

  /** Ask a question, abandoning the one before it. */
  ask(query: string): void {
    this.abandon();
    const controller = new AbortController();
    this.controller = controller;
    const text = query.trim();
    this.results = new Map(
      this.options.sources.map((source) => [
        source.id,
        {
          id: source.id,
          label: source.label,
          order: source.order,
          hits: [],
          state: "loading" as const,
        },
      ]),
    );
    this.publish();
    const now = this.options.sources.filter((source) => source.instant || text === "");
    const later = this.options.sources.filter((source) => !now.includes(source));
    for (const source of now) this.run(source, text, controller);
    if (later.length > 0)
      this.timer = this.clock.setTimer(() => {
        for (const source of later) this.run(source, text, controller);
      }, this.debounceMs);
  }

  /** Stop everything and forget the results (the dialog closed). */
  close(): void {
    this.abandon();
    this.results = new Map();
    this.publish();
  }

  private abandon(): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = null;
  }

  private run(source: SearchSource, query: string, controller: AbortController): void {
    const done = (state: SourceResult["state"], hits: readonly SearchHit[]) => {
      if (controller.signal.aborted) return;
      const known = this.results.get(source.id);
      if (!known) return;
      // A source that reads shows a handful; the pages and actions are a short fixed list, all of it.
      const most = source.instant ? hits.length : MOST_HITS_PER_SOURCE;
      this.results.set(source.id, { ...known, state, hits: hits.slice(0, most) });
      this.publish();
    };
    let asked: Promise<readonly SearchHit[]>;
    try {
      asked = source.search(query, this.options.client, controller.signal);
    } catch {
      done("error", []);
      return;
    }
    asked.then(
      (hits) => done("ready", hits),
      () => done("error", []),
    );
  }

  private publish(): void {
    this.options.onChange([...this.results.values()].sort((a, b) => a.order - b.order));
  }
}

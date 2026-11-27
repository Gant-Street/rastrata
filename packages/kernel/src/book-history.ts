import type {
  BookedJournal,
  BookProtocolState,
  BookState,
  RetainedCommandResult,
  RevisionRecord,
} from "./book.ts";

/**
 * The three lists of a book that grow by one element per command (journals, revisions, and the
 * protocol's retained results) are stored here, once, for a whole chain of states.
 *
 * Why not one frozen array per state: `Object.freeze` on an array costs 50 to 130 ns an element in
 * JavaScriptCore (about 2.3 ms for 20,000 elements; a plain copy costs 2 ns an element), so a frozen
 * copy per command made every command O(history) and replay quadratic. A state built by the kernel
 * therefore holds a `Log`: a length-limited view of an append-only store shared with the states
 * before and after it. The public property (`state.journals`) is an accessor that hands out a frozen
 * array on first read and the same array afterwards. Callers can never obtain anything writable:
 * the store and the unfrozen copies never leave this module.
 *
 * Reading `state.journals`, `state.revisions` or `protocol.retainedResults` of a built state forces
 * that one-time copy and freeze (O(n)). Spreading or cloning a state, JSON, the durable encoder and
 * `toEqual` all read every property and so force it too. Code on a per-command path must use the
 * `HistoryView` helpers (`journalsOf`, `revisionsOf`, `retainedResultsOf`) or the two exported tail
 * readers, which cost O(1).
 */

/** Read access to a growing list without materializing it as an array. A plain array is one. */
export interface HistoryView<T> {
  readonly length: number;
  /** As `Array.prototype.at`: a negative position counts from the end. */
  at(position: number): T | undefined;
  /** As `Array.prototype.map`, without the array argument. */
  map<U>(transform: (item: T, position: number) => U): U[];
}

type AddKey = (key: string) => void;

interface Shape<T> {
  /** Named lookups: the keys each item carries. A lookup answers with the FIRST item carrying a key. */
  readonly keys: Readonly<Record<string, (item: T, add: AddKey) => void>>;
  /** Frozen arrays known to hold exactly the items of one view, so a copy of a state finds its chain. */
  readonly views: WeakMap<object, Log<T>>;
}

interface Keyed {
  readonly positions: Map<string, number | number[]>;
  through: number;
}

interface First {
  found: number | undefined;
  scanned: number;
}

interface Store<T> {
  readonly items: T[];
  /** False when `items` is a frozen array lent by a caller: it is read, never written. */
  readonly owned: boolean;
  readonly keyed: Map<string, Keyed>;
  readonly firsts: Map<string, First>;
}

/** Process-wide counters, readable in tests and benches. They carry no accounting meaning. */
export const historyStats = { materialized: 0, indexed: 0, copied: 0 };

/**
 * The first `length` items of an append-only store. A view never changes: appending returns a new
 * view and, when this view is the head of its store, extends the store in place (O(1)); when
 * another view has already extended it, the new view gets its own copy (O(n), a plain-array copy),
 * so two states derived from one state never see each other's items.
 */
export class Log<T> implements HistoryView<T> {
  readonly length: number;
  readonly #shape: Shape<T>;
  readonly #store: Store<T>;
  #array: readonly T[] | undefined;

  constructor(shape: Shape<T>, store: Store<T>, length: number, array?: readonly T[]) {
    this.#shape = shape;
    this.#store = store;
    this.length = length;
    this.#array = array;
  }

  at(position: number): T | undefined {
    // As Array.prototype.at: the position is truncated, and NaN counts as 0.
    const relative = Math.trunc(Number(position)) || 0;
    const index = relative < 0 ? this.length + relative : relative;
    return index >= 0 && index < this.length ? this.#store.items[index] : undefined;
  }

  append(added: readonly T[]): Log<T> {
    if (added.length === 0) return this;
    let store = this.#store;
    if (!store.owned || store.items.length !== this.length) {
      store = this.#branch();
      historyStats.copied += 1;
    }
    for (const item of added) store.items.push(item);
    return new Log(this.#shape, store, store.items.length);
  }

  /** A store of its own holding exactly this view's items, and the lookups already built for them:
   * what a second next state derived from the same state needs. Copying the lookups, without the
   * entries for items beyond this view, costs a fraction of building them again. */
  #branch(): Store<T> {
    const old = this.#store;
    const keyed = new Map<string, Keyed>();
    for (const [name, index] of old.keyed) {
      const through = Math.min(index.through, this.length);
      const positions = new Map<string, number | number[]>();
      for (const [key, found] of index.positions) {
        if (typeof found === "number") {
          if (found < through) positions.set(key, found);
        } else {
          positions.set(key, found.filter((position) => position < through));
        }
      }
      keyed.set(name, { positions, through });
    }
    const firsts = new Map<string, First>();
    for (const [name, scan] of old.firsts) {
      firsts.set(
        name,
        scan.found !== undefined && scan.found < this.length
          ? { found: scan.found, scanned: scan.scanned }
          : { found: undefined, scanned: Math.min(scan.scanned, this.length) },
      );
    }
    return { items: old.items.slice(0, this.length), owned: true, keyed, firsts };
  }

  /** `Array.prototype.map` over these items, without copying them into a frozen array first. */
  map<U>(transform: (item: T, position: number) => U): U[] {
    const mapped: U[] = [];
    for (let position = 0; position < this.length; position += 1) {
      mapped.push(transform(this.#store.items[position] as T, position));
    }
    return mapped;
  }

  /** `Array.prototype.filter` over these items: a new, unfrozen array. */
  filter(test: (item: T) => boolean): T[] {
    const kept: T[] = [];
    for (let position = 0; position < this.length; position += 1) {
      const item = this.#store.items[position] as T;
      if (test(item)) kept.push(item);
    }
    return kept;
  }

  /** The first item carrying `key` in the named lookup, or undefined. Built on first use, then kept. */
  first(name: string, key: string): T | undefined {
    const position = this.#firstPosition(name, key);
    return position === undefined ? undefined : this.#store.items[position];
  }

  has(name: string, key: string): boolean {
    return this.#firstPosition(name, key) !== undefined;
  }

  /** Every item carrying `key`, in order. */
  all(name: string, key: string): T[] {
    const found = this.#keyed(name).positions.get(key);
    const positions = found === undefined ? [] : typeof found === "number" ? [found] : found;
    return positions
      .filter((position) => position < this.length)
      .map((position) => this.#store.items[position] as T);
  }

  /** The first item satisfying `test`, scanning only as far as the first match and remembering it. */
  firstWhere(name: string, test: (item: T) => boolean): T | undefined {
    const store = this.#store;
    let scan = store.firsts.get(name);
    if (scan === undefined) {
      scan = { found: undefined, scanned: 0 };
      store.firsts.set(name, scan);
    }
    while (scan.found === undefined && scan.scanned < store.items.length) {
      const position = scan.scanned;
      if (test(store.items[position] as T)) scan.found = position;
      scan.scanned = position + 1;
    }
    return scan.found !== undefined && scan.found < this.length ? store.items[scan.found] : undefined;
  }

  /** The frozen array of these items: copied and frozen once, then the same array. */
  array(): readonly T[] {
    if (this.#array === undefined) {
      const array = Object.freeze(this.#store.items.slice(0, this.length));
      this.#shape.views.set(array, this);
      this.#array = array;
      historyStats.materialized += 1;
    }
    return this.#array;
  }

  #firstPosition(name: string, key: string): number | undefined {
    const found = this.#keyed(name).positions.get(key);
    const position = typeof found === "number" ? found : found?.[0];
    return position !== undefined && position < this.length ? position : undefined;
  }

  #keyed(name: string): Keyed {
    const keysOf = this.#shape.keys[name];
    if (keysOf === undefined) throw new RangeError(`Unknown history lookup ${name}`);
    const store = this.#store;
    let keyed = store.keyed.get(name);
    if (keyed === undefined) {
      keyed = { positions: new Map(), through: 0 };
      store.keyed.set(name, keyed);
    }
    while (keyed.through < store.items.length) {
      const position = keyed.through;
      carried.length = 0;
      keysOf(store.items[position] as T, carry);
      for (const key of carried) {
        const found = keyed.positions.get(key);
        if (found === undefined) keyed.positions.set(key, position);
        else if (typeof found === "number") {
          if (found !== position) keyed.positions.set(key, [found, position]);
        } else if (found[found.length - 1] !== position) found.push(position);
      }
      keyed.through = position + 1;
      historyStats.indexed += 1;
    }
    return keyed;
  }
}

/** The keys of the item being indexed. Indexing is synchronous and a key function only calls
 * `carry`, so one array serves every index; an item that throws leaves nothing behind. */
const carried: string[] = [];
const carry: AddKey = (key) => {
  carried.push(key);
};

function shapeOf<T>(keys: Shape<T>["keys"]): Shape<T> {
  return { keys, views: new WeakMap() };
}

const JOURNALS = shapeOf<BookedJournal>({
  journal: (booked, add) => add(booked.journal.id),
  posting: (booked, add) => {
    for (const posting of booked.journal.postings) add(posting.id);
  },
});

const REVISIONS = shapeOf<RevisionRecord>({
  // The configuration revision a command replaced, which only a configuration command names.
  configuration: (revision, add) => {
    if ("expectedConfigurationRevision" in revision.command)
      add(String(revision.command.expectedConfigurationRevision));
  },
});

const RETAINED = shapeOf<RetainedCommandResult>({
  command: (retained, add) => add(retained.commandId),
});

/** The view of a plain array: the chain it already belongs to, or a new one. A caller's array is
 * trusted to stay as it is only when it is frozen; any other array is copied and not remembered. */
function logOf<T>(shape: Shape<T>, items: readonly T[]): Log<T> {
  const known = shape.views.get(items);
  if (known !== undefined) return known;
  const frozen = Object.isFrozen(items);
  const store: Store<T> = {
    items: frozen ? (items as T[]) : items.slice(),
    owned: !frozen,
    keyed: new Map(),
    firsts: new Map(),
  };
  const log = new Log(shape, store, items.length, frozen ? items : undefined);
  if (frozen) shape.views.set(items, log);
  return log;
}

const JOURNAL_LISTS = new WeakMap<object, Log<BookedJournal>>();
const REVISION_LISTS = new WeakMap<object, Log<RevisionRecord>>();
const PROTOCOLS = new WeakMap<object, Log<RetainedCommandResult>>();

/** The journals of a state, to read its length, its end or to map over them. O(1) for any state:
 * a state the kernel built answers from its shared store without copying anything, and a plain
 * state answers with its own array, which is not examined. Code that needs more (an identifier
 * lookup, a growth) asks `journalLogOf`. */
export function journalsOf(state: Pick<BookState, "journals">): HistoryView<BookedJournal> {
  return JOURNAL_LISTS.get(state) ?? state.journals;
}

/** The revisions of a state, as `journalsOf` gives its journals. */
export function revisionsOf(state: Pick<BookState, "revisions">): HistoryView<RevisionRecord> {
  return REVISION_LISTS.get(state) ?? state.revisions;
}

/** The retained command results of a protocol, as `journalsOf` gives a state's journals. */
export function retainedResultsOf(protocol: BookProtocolState): HistoryView<RetainedCommandResult> {
  return PROTOCOLS.get(protocol) ?? protocol.retainedResults;
}

/** The journals of a state with their lookups by journal or posting identifier, and with the
 * ability to grow. Free for a state the kernel built; for a plain state it is built on first use
 * (one pass, remembered for a frozen array) and so is not for code that only needs the end. */
export function journalLogOf(state: Pick<BookState, "journals">): Log<BookedJournal> {
  return JOURNAL_LISTS.get(state) ?? logOf(JOURNALS, state.journals);
}

/** The revisions of a state with their lookups (the first activation, the configuration a command
 * replaced), under the same cost as `journalLogOf`. */
export function revisionLogOf(state: Pick<BookState, "revisions">): Log<RevisionRecord> {
  return REVISION_LISTS.get(state) ?? logOf(REVISIONS, state.revisions);
}

/** The retained command results of a protocol with their lookup by command identifier, under the
 * same cost as `journalLogOf`. */
export function retainedLogOf(protocol: BookProtocolState): Log<RetainedCommandResult> {
  return PROTOCOLS.get(protocol) ?? logOf(RETAINED, protocol.retainedResults);
}

function lazyList(target: object, key: string, log: { array(): readonly unknown[] }): void {
  Object.defineProperty(target, key, { enumerable: true, configurable: false, get: () => log.array() });
}

/** Give a state under construction its journals as a lazily frozen accessor over `journals`, and
 * remember them so `journalLogOf` finds them. The caller freezes the state. */
export function adoptJournals(next: object, journals: Log<BookedJournal>): void {
  lazyList(next, "journals", journals);
  JOURNAL_LISTS.set(next, journals);
}

/** The same for the journals and the revisions together. */
export function adoptLists(
  next: object,
  journals: Log<BookedJournal>,
  revisions: Log<RevisionRecord>,
): void {
  adoptJournals(next, journals);
  lazyList(next, "revisions", revisions);
  REVISION_LISTS.set(next, revisions);
}

/** A protocol state whose retained results are a lazily frozen accessor over `retained`. */
export function lazyProtocol(retained: Log<RetainedCommandResult>): BookProtocolState {
  const protocol = {};
  lazyList(protocol, "retainedResults", retained);
  PROTOCOLS.set(protocol, retained);
  return Object.freeze(protocol) as BookProtocolState;
}

/** The protocol after one more retained result; the original is unchanged. */
export function withRetainedResult(
  protocol: BookProtocolState,
  retained: RetainedCommandResult,
): BookProtocolState {
  return lazyProtocol(retainedLogOf(protocol).append([retained]));
}

const FROZEN = new WeakSet<object>();

/** An immutable list with the same items: the list itself when it is frozen (the check runs once
 * per list), otherwise a frozen copy. For lists that rarely change, so reuse beats a copy. */
export function frozenList<T>(list: readonly T[]): readonly T[] {
  if (FROZEN.has(list)) return list;
  const frozen = Object.isFrozen(list) ? list : Object.freeze([...list]);
  FROZEN.add(frozen);
  return frozen;
}

/** The list followed by `added`, frozen. An unchanged list is reused, not copied. */
export function appendFrozen<T>(list: readonly T[], added: readonly T[]): readonly T[] {
  if (added.length === 0) return frozenList(list);
  const frozen = Object.freeze([...list, ...added]);
  FROZEN.add(frozen);
  return frozen;
}

/** The most recent revision of a book without copying its history into an array: O(1) for a state
 * the kernel built, `revisions.at(-1)` for any other. Reading `state.revisions` instead would copy
 * and freeze every revision, once per state. */
export function latestRevisionRecord(state: Pick<BookState, "revisions">): RevisionRecord | undefined {
  return revisionsOf(state).at(-1);
}

/** The most recent retained command result, with the same cost as `latestRevisionRecord`. */
export function latestRetainedCommandResult(
  protocol: BookProtocolState,
): RetainedCommandResult | undefined {
  return retainedResultsOf(protocol).at(-1);
}

/** How many lists this process has copied and frozen on demand since it started. A built state does
 * so on the first read of `journals`, `revisions` or `retainedResults`. A per-command path should
 * leave it unchanged; tests and benches read it to prove that. It carries no accounting meaning. */
export function bookHistoryMaterializations(): number {
  return historyStats.materialized;
}

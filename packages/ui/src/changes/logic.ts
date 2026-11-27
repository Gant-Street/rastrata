/** What the Changes screen decides, as pure functions: who a change was made by in words, the choices the
 * screen offers and how many each has, how the changes group into days, and whether the list in front of
 * a person is one they can truthfully say they have looked at. Nothing here touches a screen or a clock
 * (the time is passed in). */
import { formatDate, formatTime, formatWeekdayDate } from "../format";
import type { ChangeListView, ChangeView, MakerCountView, MakerView } from "./types";
import {
  addDays,
  filtersActive,
  isStartDate,
  SINCE_CHOICES,
  WHAT_GROUPS,
  type ChangesScreenState,
} from "./url-state";
import { makerKindWords, roleWords, sinceWords, whatWords, words } from "./words";

/** The same maker: the same kind and the same identifier, or, where neither has one, the same name. */
export function sameMaker(left: MakerView, right: MakerView): boolean {
  if (left.kind !== right.kind) return false;
  if (left.id !== undefined || right.id !== undefined) return left.id === right.id;
  return left.label === right.label;
}

/** Whether the maker is the person looking. */
export const isCaller = (maker: MakerView, caller: MakerView | undefined): boolean =>
  caller !== undefined && sameMaker(maker, caller);

/** "By the agent weekly-run": who made a change, as a line on its row. A name from outside is the last
 * thing in the line, and the screen shows it as plain text. */
export function byWords(maker: MakerView, caller?: MakerView): { text: string; name?: string } {
  if (isCaller(maker, caller)) return { text: words.by.you };
  switch (maker.kind) {
    case "owner":
      return { text: words.by.owner };
    case "person":
      return { text: `By ${roleWords(maker.label)}` };
    case "service":
      return { text: words.by.service };
    case "agent":
      return { text: words.by.agent, name: maker.label };
    case "unknown":
      return { text: words.by.unknown };
  }
}

/** The sentence form of `byWords`, for a choice or a count. */
export function makerName(maker: MakerView, caller?: MakerView): string {
  const base = (() => {
    switch (maker.kind) {
      case "owner":
        return makerKindWords.owner;
      case "person":
        return roleWords(maker.label);
      case "service":
        return makerKindWords.service;
      case "agent":
        return `the agent ${maker.label}`;
      case "unknown":
        return "not recorded";
    }
  })();
  return isCaller(maker, caller) ? `${words.you}, ${base}` : base;
}

/** The `who` value that names a maker: by identifier where it has one, else by name. */
export function whoValue(maker: MakerView): string {
  if (maker.kind === "owner" || maker.kind === "unknown") return maker.kind;
  if (maker.id !== undefined && maker.id !== "") return `${maker.kind}@${maker.id}`;
  return `${maker.kind}:${maker.label}`;
}

export interface Choice {
  readonly value: string;
  readonly label: string;
}

const total = (actors: readonly MakerCountView[]): number =>
  actors.reduce((sum, actor) => sum + actor.count, 0);

/** The makers to choose from: anyone, a whole kind (people, agents) when there is more than one of it, and
 * each maker there is in the window, with how many changes each made. A maker already chosen stays in the
 * list even when the window has none of theirs, so the choice always shows what is on. */
export function whoChoices(
  actors: readonly MakerCountView[],
  caller: MakerView | undefined,
  selected: string,
): readonly Choice[] {
  const choices: Choice[] = [{ value: "", label: `${words.anyone} (${total(actors)})` }];
  for (const [kind, label] of [
    ["person", words.people],
    ["agent", words.agents],
  ] as const) {
    const of = actors.filter((actor) => actor.by.kind === kind);
    if (of.length > 1) choices.push({ value: kind, label: `${label} (${total(of)})` });
  }
  for (const actor of actors)
    choices.push({
      value: whoValue(actor.by),
      label: `${makerName(actor.by, caller)} (${actor.count})`,
    });
  if (selected !== "" && !choices.some((choice) => choice.value === selected))
    choices.push({ value: selected, label: `${nameOfValue(selected)} (0)` });
  return choices;
}

/** What a `who` value that no maker in the window has stands for, in words. */
function nameOfValue(value: string): string {
  const match = /^(owner|person|agent|service|unknown)(?:@(.+)|:(.+))?$/.exec(value);
  if (!match) return value;
  const kind = match[1] as MakerView["kind"];
  if (match[3] !== undefined) return makerName({ kind, label: match[3] });
  if (match[2] !== undefined) return `${makerKindWords[kind]} ${match[2].slice(0, 8)}`;
  return kind === "person" ? words.people.toLowerCase() : makerKindWords[kind];
}

/** Where the list starts: the named choices, and a date when the address carries one. */
export function sinceChoices(selected: string): readonly Choice[] {
  const choices: Choice[] = SINCE_CHOICES.map((value) => ({ value, label: sinceWords[value] }));
  if (isStartDate(selected)) choices.push({ value: selected, label: formatDate(selected) });
  return choices;
}

export function whatChoices(): readonly Choice[] {
  return [
    { value: "", label: whatWords[""] },
    ...WHAT_GROUPS.map((value) => ({ value, label: whatWords[value] })),
  ];
}

/** The changes of one day, with the heading the screen shows. */
export interface DayGroup {
  /** `YYYY-MM-DD`, on the viewer's clock. */
  readonly day: string;
  readonly heading: string;
  /** The date beside "Today" and "Yesterday"; nothing for an older day, whose heading is its date. */
  readonly when: string;
  readonly changes: readonly ChangeView[];
}

/** The day an instant falls on, on the viewer's clock (or a zone, for a test). */
export const dayOf = (instant: string, timeZone?: string): string =>
  formatDate(instant, { format: "iso", timeZone });

/** The changes in the order they came, cut into days: "Today", "Yesterday", and then the date with its
 * weekday. `today` is the viewer's day, `YYYY-MM-DD`. */
export function groupByDay(
  changes: readonly ChangeView[],
  today: string,
  timeZone?: string,
): readonly DayGroup[] {
  const yesterday = addDays(today, -1);
  const groups: { day: string; changes: ChangeView[] }[] = [];
  for (const change of changes) {
    const day = dayOf(change.at, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.changes.push(change);
    else groups.push({ day, changes: [change] });
  }
  return groups.map((group) => ({
    day: group.day,
    heading:
      group.day === today
        ? words.dayToday
        : group.day === yesterday
          ? words.dayYesterday
          : formatWeekdayDate(group.day),
    when: group.day === today || group.day === yesterday ? formatDate(group.day) : "",
    changes: group.changes,
  }));
}

/** The time of day a change was recorded, on the viewer's clock: "10:42 AM". */
export const timeOf = (instant: string, timeZone?: string): string => {
  const moment = new Date(instant);
  return Number.isNaN(moment.getTime()) ? instant : formatTime(moment, { timeZone });
};

/** How many changes there are in the window before any choice narrowed them: what the sources gave. */
export const changesInWindow = (list: ChangeListView): number =>
  list.sources
    .filter((source) => source.name !== "review")
    .reduce((sum, source) => sum + source.changes, 0);

/** The sources that could not be read. The "review" source only says how entries were decided: when it
 * cannot be read the changes are all there and only that explanation is missing. */
export const unreadSources = (list: ChangeListView) =>
  list.sources.filter((source) => !source.read);

const atOrBefore = (left: string, right: string): boolean => {
  try {
    return BigInt(left) <= BigInt(right);
  } catch {
    return false;
  }
};

/** Whether the list starts at or before the last look, so that it holds everything that has not been
 * looked at. */
export function reachesLastLook(list: ChangeListView): boolean {
  const review = list.lastReview;
  if (review === null) return list.window.sinceRevision === "0" && list.window.sinceAt === null;
  return (
    atOrBefore(list.window.sinceRevision, review.upToRevision) &&
    (list.window.sinceAt === null || list.window.sinceAt <= review.upToAt)
  );
}

export type MarkVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "filtered" | "window" | "partial" | "withheld" | "nothing";
    };

/** Whether a person can truthfully say "I have looked at these" about the list in front of them: it is
 * all there is (every source was read, no choice hides a change, it starts at or before the last look)
 * and there is something in it. */
export function markVerdict(list: ChangeListView, state: ChangesScreenState): MarkVerdict {
  if (unreadSources(list).some((source) => source.name !== "review"))
    return { ok: false, reason: "partial" };
  if (list.sources.some((source) => (source.withheld ?? null) !== null))
    return { ok: false, reason: "withheld" };
  if (filtersActive(state) || list.window.until !== null) return { ok: false, reason: "filtered" };
  if (!reachesLastLook(list)) return { ok: false, reason: "window" };
  if (list.count === 0) return { ok: false, reason: "nothing" };
  return { ok: true };
}

/** What to say when the list has nothing in it. */
export type EmptyKind = "after-look" | "filtered" | "window" | "book";

export function emptyKind(list: ChangeListView, state: ChangesScreenState): EmptyKind {
  if (filtersActive(state)) return "filtered";
  if (state.since === "look" && list.lastReview !== null) return "after-look";
  if (state.since === "all") return "book";
  return "window";
}

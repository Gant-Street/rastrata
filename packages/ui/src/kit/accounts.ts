import { defaultMessages } from "../messages";

/** One account as the picker offers it. `AccountChoice`, the shape the register and the Inbox already pass,
 * is one of these (it has no `code` and no `isGroup`), so an existing screen keeps working until its lane
 * moves it to the code and the group flag. */
export interface AccountOption {
  /** The account's id: what `onChange` returns. */
  readonly value: string;
  /** What a person calls it: "Business checking". Names before codes: this is the name. */
  readonly label: string;
  /** The account number, shown muted after the name and matched by search ("1000"). */
  readonly code?: string | undefined;
  /** A quieter line under the name: where it sits ("Expenses > Software") or what it is. */
  readonly path?: string | undefined;
  /** The heading it is listed under ("Bank accounts", "Expenses"). */
  readonly group?: string | undefined;
  /** A group account only holds other accounts, and nothing is posted to it. A picker never offers one
   * unless it is asked to (`allowGroups`). */
  readonly isGroup?: boolean | undefined;
  /** Shown but not choosable (a closed account), with `reason` saying why. */
  readonly disabled?: boolean | undefined;
  readonly reason?: string | undefined;
}

/** What `accounts.list` says about one account; the fields a picker needs and nothing it does not. */
export interface AccountRowLike {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: string;
  readonly parentId?: string | null | undefined;
  readonly closedOn?: string | null | undefined;
}

/** The words `accountOptions` puts on what it builds. They live in `messages.account`, so an application
 * can reword them; a test or a story can pass its own. */
export interface AccountWords {
  /** The heading for each kind of account: `asset` is "Assets". */
  readonly headings: Readonly<Record<string, string>>;
  /** Why a closed account cannot be chosen. */
  readonly closed: string;
}

/** The accounts a picker offers, from the rows `accounts.list` returns: the name, the code, where it sits
 * (its parents, "Expenses > Software"), the heading its kind is listed under, and the two things a picker
 * must know and a row does not say outright: whether it is a group (some other account is under it) and
 * whether it is closed. The order is the order of the rows. */
export function accountOptions(
  rows: readonly AccountRowLike[],
  words: AccountWords = defaultMessages.account,
): AccountOption[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parents = new Set(
    rows.flatMap((row) => (row.parentId && byId.has(row.parentId) ? [row.parentId] : [])),
  );
  const pathOf = (row: AccountRowLike): string | undefined => {
    const names: string[] = [];
    const seen = new Set<string>([row.id]);
    let parent = row.parentId ? byId.get(row.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      names.unshift(parent.name);
      seen.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return names.length > 0 ? names.join(" > ") : undefined;
  };
  return rows.map((row) => {
    const path = pathOf(row);
    return {
      value: row.id,
      label: row.name,
      code: row.code,
      ...(path ? { path } : {}),
      group: words.headings[row.role] ?? row.role,
      isGroup: parents.has(row.id),
      ...(row.closedOn ? { disabled: true, reason: words.closed } : {}),
    };
  });
}

/** The accounts a picker lists: a group account only when it is asked to, because nothing is posted to one. */
export function offeredAccounts(
  accounts: readonly AccountOption[],
  allowGroups: boolean,
): AccountOption[] {
  return allowGroups ? [...accounts] : accounts.filter((account) => account.isGroup !== true);
}

/** Lower case, no accents, single spaces: how a name is compared with what was typed. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const wordsOf = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** How well one typed word matches one account; lower is better, `undefined` is no match. An exact code is
 * best, then the start of the name, the start of the code, the start of a word in the name, and then
 * anywhere in the name, the code or the path. */
function wordScore(
  word: string,
  name: string,
  nameWords: readonly string[],
  code: string,
  path: string,
): number | undefined {
  if (code !== "" && code === word) return 0;
  if (name.startsWith(word)) return 1;
  if (code.startsWith(word)) return 2;
  if (nameWords.some((candidate) => candidate.startsWith(word))) return 3;
  if (name.includes(word)) return 4;
  if (code.includes(word)) return 5;
  if (path.includes(word)) return 6;
  return undefined;
}

/** The accounts that match what was typed, best first. Every word typed has to be found in the name, the
 * code or the path, in any order, so "bus chec" finds "Business checking" and "1000 chec" finds it too.
 * With nothing typed every account is listed, in the order given. Ties keep that order, so the chart's own
 * order is what a person sees when nothing matches better. */
export function matchAccounts(accounts: readonly AccountOption[], query: string): AccountOption[] {
  const typed = wordsOf(foldText(query));
  if (typed.length === 0) return [...accounts];
  const scored: { account: AccountOption; score: number; index: number }[] = [];
  accounts.forEach((account, index) => {
    const name = foldText(account.label);
    const nameWords = wordsOf(name);
    const code = foldText(account.code ?? "");
    const path = foldText(account.path ?? "");
    let score = 0;
    for (const word of typed) {
      const found = wordScore(word, name, nameWords, code, path);
      if (found === undefined) return;
      score += found;
    }
    scored.push({ account, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((item) => item.account);
}

/** The options in the order a list shows them: grouped under their headings, the headings in the order their
 * first option appears (so the heading of the best match comes first), and each heading's options in the order
 * they were given. A list that shows headings has to be navigated in this order too, or an arrow key would
 * jump over what is next on the screen: a ranked list of matches mixes the groups. */
export function groupedInOrder(options: readonly AccountOption[]): AccountOption[] {
  const headings = [...new Set(options.map((option) => option.group ?? ""))];
  return headings.flatMap((heading) =>
    options.filter((option) => (option.group ?? "") === heading),
  );
}

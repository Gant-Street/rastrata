import { formatDate, formatMoney } from "@rastrata/ui/format";
import type { BrowserApplicationClient } from "../application-client.ts";
import type { SearchHit, SearchSource } from "../routes/registry-types.ts";
import { matchScore } from "./builtin.ts";

/** The sources that read the book: what is waiting for review, the transactions in the books and the
 * chart of accounts. Each composes a read that already exists, so Search needs no operation of its own.
 * The lane that owns a screen may replace its source (keep the id); the shell asks whatever is registered.
 *
 * What a person types is data here as everywhere: it goes to the service as a filter, never into markup
 * or a path unescaped. */

const MOST = 5;

/** Bank lines still being worked: new, with a suggestion, or drafted. (Posted lines are transactions.) */
export const reviewSource: SearchSource = {
  id: "review",
  label: "For review",
  order: 30,
  async search(query, client, signal) {
    const text = query.trim();
    if (text === "") return [];
    const page = await client.read(
      "inbox.list",
      { filter: { text, status: ["new", "proposed", "drafted"] }, page: 1, pageSize: MOST },
      { signal },
    );
    return page.items.map(
      (item): SearchHit => ({
        id: item.id,
        label: item.line.description,
        detail: `${formatDate(item.line.date)} · ${formatMoney(item.line.amount)}`,
        href: `/inbox?item=${encodeURIComponent(item.id)}`,
        kind: "review",
      }),
    );
  },
};

/** Entries in the books (and drafts), found by what the service matches (reference, description, number,
 * amount, account). A draft opens in the editor; an entry opens on its page. */
export const transactionsSource: SearchSource = {
  id: "transactions",
  label: "Transactions",
  order: 40,
  async search(query, client, signal) {
    const text = query.trim();
    if (text === "") return [];
    const page = await client.read("journal.list", { page: 1, text }, { signal });
    return page.entries.slice(0, MOST).map((entry): SearchHit => {
      const draft = entry.status === "Draft";
      const facts = [
        formatDate(entry.isoDate),
        draft ? "Draft" : formatMoney(entry.amount),
        ...(entry.postingSequence ? [`No. ${entry.postingSequence}`] : []),
      ];
      return {
        id: entry.id,
        label: entry.description?.trim() || entry.reference.trim() || formatDate(entry.isoDate),
        detail: facts.join(" · "),
        href: draft
          ? `/journal/new?draft=${encodeURIComponent(entry.id)}`
          : `/journal/${encodeURIComponent(entry.id)}`,
        kind: "transaction",
      };
    });
  },
};

/** Accounts by name (every word of what was typed starts a word of the name) or by the start of the code. */
export const accountsSource: SearchSource = {
  id: "accounts",
  label: "Chart of accounts",
  order: 50,
  async search(query, client, signal) {
    const text = query.trim();
    if (text === "") return [];
    const { accounts } = await client.read("accounts.list", {}, { signal, fresh: true });
    return accounts
      .map((account) => ({
        account,
        score: Math.max(matchScore(text, account.name), account.code.startsWith(text) ? 5 : 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.account.code.localeCompare(right.account.code),
      )
      .slice(0, MOST)
      .map(
        ({ account }): SearchHit => ({
          id: account.id,
          label: account.name,
          detail: account.code,
          href: `/accounts?account=${encodeURIComponent(account.id)}`,
          kind: "account",
        }),
      );
  },
};

/** What is waiting for review, for the tab's count. */
export async function reviewCount(
  client: BrowserApplicationClient,
  signal: AbortSignal,
): Promise<number | undefined> {
  const summary = await client.read("inbox.summary", {}, { signal, fresh: true });
  return summary.counts.toReview;
}

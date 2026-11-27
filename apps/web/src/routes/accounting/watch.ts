import { WATCH_KEYS, watchKind, watchOffer } from "@rastrata/ui/catchall/logic";
import { catchallWords } from "@rastrata/ui/catchall/words";
import type { AccountView, TagChange } from "@rastrata/ui/chart/types";
import { createSignal } from "solid-js";

/** What can be done about watching an account, as the chart's menu offers it: nothing, watch, or stop. */
export const watchOffered = (account: AccountView): "watch" | "stop" | null =>
  watchOffer({
    role: account.role,
    closedOn: account.closedOn,
    roleKey: account.tags.roleKey,
  });

/** The account the book watches for this kind of account, if it has one (an open one). */
export const watchedFor = (
  accounts: readonly AccountView[],
  kind: "expense" | "income",
): AccountView | undefined =>
  accounts.find((account) => account.tags.roleKey === WATCH_KEYS[kind] && !account.closedOn);

/** Watching an account at month end from the Chart of accounts, and stopping. The mark is a tag, so it goes
 * through the same retained write as every other tag. Watching an account while another is watched for the
 * same kind takes the mark off the other first: the book keeps the mark on one account at a time. */
export function createWatchController(options: {
  accounts: () => readonly AccountView[];
  /** Save one tag change on one account (the page's retained tag writer). True when it was saved. */
  save: (accountId: string, change: TagChange) => Promise<boolean>;
  /** The tag writer's last error, in the service's words, and its code. */
  saveError: () => string;
  saveCode: () => string;
  /** The tag writer's request was sent and never answered. */
  uncertain: () => boolean;
  resume: () => Promise<void>;
  today: () => string;
  onSaved: (message: string) => void;
}) {
  const w = catchallWords.watch;
  const [target, setTarget] = createSignal<{
    readonly account: AccountView;
    readonly mode: "watch" | "stop";
  } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  /** The account that is watched now, when watching this one takes its place. */
  const replaced = (): AccountView | undefined => {
    const open = target();
    if (!open || open.mode === "stop") return undefined;
    const kind = watchKind(open.account.role);
    const current = kind ? watchedFor(options.accounts(), kind) : undefined;
    return current && current.id !== open.account.id ? current : undefined;
  };

  const failure = (): string => {
    if (options.saveCode() === "role_key_in_use") return w.inUse;
    return options.saveError() || w.failed;
  };

  return {
    target,
    busy,
    error,
    uncertain: options.uncertain,
    replaces: () => replaced()?.name,
    begin(account: AccountView) {
      const mode = watchOffered(account);
      if (mode === null) return;
      setError("");
      setTarget({ account, mode });
    },
    cancel() {
      if (busy()) return;
      setTarget(null);
      setError("");
    },
    async confirm() {
      const open = target();
      if (!open || busy()) return;
      const kind = watchKind(open.account.role);
      if (kind === null && open.mode === "watch") return;
      setBusy(true);
      setError("");
      try {
        const effectiveOn = options.today();
        const other = replaced();
        if (open.mode === "watch" && other) {
          const cleared = await options.save(other.id, { effectiveOn, tags: { roleKey: null } });
          if (!cleared) {
            setError(failure());
            return;
          }
        }
        const roleKey = open.mode === "stop" || kind === null ? null : WATCH_KEYS[kind];
        const saved = await options.save(open.account.id, { effectiveOn, tags: { roleKey } });
        if (!saved) {
          setError(failure());
          return;
        }
        setTarget(null);
        options.onSaved(
          open.mode === "stop" ? w.stopped(open.account.name) : w.watching(open.account.name),
        );
      } finally {
        setBusy(false);
      }
    },
    resume: options.resume,
  };
}

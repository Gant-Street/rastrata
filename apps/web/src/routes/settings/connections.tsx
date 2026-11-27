import { type ButtonLinkProps, ConnectionCard, PageHeader, settingsWords } from "@rastrata/ui";
import { formatInstant } from "@rastrata/ui/format";
import type { JSX } from "solid-js";
import { AppLink } from "../../app-link";
import { BrowserApplicationClient } from "../../application-client";
import { createLoader } from "../../loader";

const words = settingsWords.connections;

interface Standing {
  readonly status: string;
  readonly tone: "calm" | "attention" | "problem";
  readonly detail: string | undefined;
}

const link = (props: ButtonLinkProps): JSX.Element => <AppLink {...props} />;

/** The bank connection, as one line of state: not connected, connected (with what is linked and when it
 * was last read), or needing attention. A read that has not answered says it is checking; one that failed
 * says so and claims nothing else. */
export function bankStanding(
  status:
    | {
        connected: boolean;
        linked: number;
        attention: readonly unknown[];
        problems: readonly unknown[];
        lastSync: { finishedAt: string | null } | null;
      }
    | undefined,
  failed: boolean,
): Standing {
  if (failed) return { status: words.failed, tone: "problem", detail: undefined };
  if (!status) return { status: words.checking, tone: "calm", detail: undefined };
  if (!status.connected) return { status: words.notConnected, tone: "calm", detail: undefined };
  const read = status.lastSync?.finishedAt;
  const detail = [
    words.accountsLinked(status.linked),
    read ? words.lastRead(formatInstant(read)) : words.neverRead,
  ].join(" · ");
  const needsLook = status.attention.length > 0 || status.problems.length > 0;
  return needsLook
    ? { status: words.needsAttention, tone: "attention", detail }
    : { status: words.connected, tone: "calm", detail };
}

/** Stripe, the same way: no key, a key (test or live), or a key that cannot be used. */
export function stripeStanding(
  status:
    | {
        key: { present: boolean; mode: string | null; problem: string | null };
        lastSync: { finishedAt: string | null } | null;
      }
    | undefined,
  failed: boolean,
): Standing {
  if (failed) return { status: words.failed, tone: "problem", detail: undefined };
  if (!status) return { status: words.checking, tone: "calm", detail: undefined };
  if (!status.key.present) return { status: words.notConnected, tone: "calm", detail: undefined };
  const read = status.lastSync?.finishedAt;
  const detail = [
    ...(status.key.mode ? [words.keyMode(status.key.mode)] : []),
    read ? words.lastRead(formatInstant(read)) : words.neverRead,
  ].join(" · ");
  return status.key.problem
    ? { status: words.needsAttention, tone: "attention", detail }
    : { status: words.connected, tone: "calm", detail };
}

/** Settings, Connections: the bank connection and Stripe with their state, each linking to its own page.
 * The state is read here (two cheap reads) so a person sees which is set up without opening either. */
export function ConnectionsPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const bank = createLoader(() => client.read("bankfeed.status", {}));
  const stripe = createLoader(() => client.read("stripe.status", {}));
  const bankState = () => bankStanding(bank.value(), bank.error() !== undefined);
  const stripeState = () => stripeStanding(stripe.value(), stripe.error() !== undefined);
  return (
    <section aria-labelledby="connections-title">
      <PageHeader titleId="connections-title" title={words.title} description={words.description} />
      <ul class="rt-connections">
        <ConnectionCard
          title={words.bank}
          status={bankState().status}
          tone={bankState().tone}
          detail={bankState().detail}
          body={words.bankBody}
          action={bank.value()?.connected ? words.open : words.set}
          href="/settings/bankfeed"
          busy={bank.loading()}
          link={link}
        />
        <ConnectionCard
          title={words.stripe}
          status={stripeState().status}
          tone={stripeState().tone}
          detail={stripeState().detail}
          body={words.stripeBody}
          action={stripe.value()?.key.present ? words.open : words.set}
          href="/settings/stripe"
          busy={stripe.loading()}
          link={link}
        />
      </ul>
    </section>
  );
}

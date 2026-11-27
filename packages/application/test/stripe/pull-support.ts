import { type Answer, BUNDLE_UPLOAD, bundleOf } from "./bundle.ts";
import type { FakeStripe } from "./fake-stripe.ts";
import { type World, uuid } from "./slice-support.ts";

/** The command line's side of `stripe.receive`, as a test double: it holds the key, fetches what the
 * service asks for from the fake Stripe, packs the answers into a bundle, uploads it, calls again,
 * until the service asks for nothing more. It knows nothing of Stripe's data: a request it is told to
 * make is a request it makes. `follow` is the one convenience the real command has, reading on to
 * the next page of a list (the service would ask for it in the next round anyway). */

// biome-ignore lint/suspicious/noExplicitAny: tests inspect JSON responses loosely.
type Loose = any;

export type Delivery = Answer;

export interface PullOptions {
  readonly stripe?: FakeStripe;
  readonly key: string;
  /** The instant the pull reads up to; the world's clock by default. */
  readonly asOf?: string;
  /** Read on to the next page of a list without being asked. */
  readonly follow?: boolean;
  readonly maxRounds?: number;
  /** Most answers in one bundle; a round with more uploads several. */
  readonly perBundle?: number;
  /** Called before each round, with its number, to let a test change the world between rounds. */
  readonly beforeRound?: (round: number) => void | Promise<void>;
  /** The answers the sender already has, as a command that ran before would (kept by request). */
  readonly have?: Map<string, Delivery>;
  /** Whether the sender says its answers are Stripe's live mode (true) or test mode (false); it says nothing when absent, as an older sender. */
  readonly livemode?: boolean;
}

export interface PullResult {
  readonly rounds: number;
  readonly replies: { status: number; body: Loose }[];
  /** The last reply. */
  readonly last: { status: number; body: Loose };
  readonly requested: string[];
  readonly delivered: Map<string, Delivery>;
  readonly bundles: string[];
  readonly asOf: string;
}

/** What an answer said, parsed once, for reading on to the next page. */
const parsed = new WeakMap<Delivery, Loose>();

export async function pull(w: World, options: PullOptions): Promise<PullResult> {
  const stripe = options.stripe ?? w.stripe;
  const asOf = options.asOf ?? new Date(w.clock.ms).toISOString();
  const have = options.have ?? new Map<string, Delivery>();
  const requested: string[] = [];
  const bundles: string[] = [];
  const replies: PullResult["replies"] = [];

  const fetchOne = async (request: string): Promise<Delivery> => {
    requested.push(request);
    const response = await stripe.fetch(new URL(request, "https://api.stripe.com"), {
      method: "GET",
      headers: { authorization: `Bearer ${options.key}`, accept: "application/json" },
    });
    const body = new Uint8Array(await response.arrayBuffer());
    let json: Loose = null;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      json = null;
    }
    const delivery: Delivery = { request, status: response.status, body };
    parsed.set(delivery, json);
    return delivery;
  };

  const answerFor = async (need: string): Promise<Delivery[]> => {
    const out: Delivery[] = [];
    let request = need;
    for (let page = 0; page < 500; page++) {
      let answer = have.get(request);
      if (!answer) {
        answer = await fetchOne(request);
        have.set(request, answer);
      }
      out.push(answer);
      if (!options.follow || answer.status !== 200) break;
      // Read on when the answer says there is more: the next request is the same one after the last item.
      const json = parsed.get(answer);
      const items = Array.isArray(json?.data) ? json.data : [];
      if (json?.has_more !== true || items.length === 0) break;
      const next = new URL(request, "https://api.stripe.com");
      next.searchParams.set("starting_after", String(items.at(-1).id));
      request = `${next.pathname}${next.search}`;
    }
    return out;
  };

  const upload = async (answers: readonly Delivery[]): Promise<string> => {
    const stored = await w.upload(bundleOf(answers), BUNDLE_UPLOAD);
    if (stored.status !== 200) throw new Error(`upload failed: ${JSON.stringify(stored.body)}`);
    bundles.push(stored.body.data.sha256 as string);
    return stored.body.data.sha256 as string;
  };

  let send: Delivery[] = [];
  for (let round = 1; round <= (options.maxRounds ?? 400); round++) {
    await options.beforeRound?.(round);
    const shas: string[] = [];
    const per = options.perBundle ?? 1000;
    for (let at = 0; at < send.length; at += per) shas.push(await upload(send.slice(at, at + per)));
    const reply = await w.call(
      "stripe.receive",
      {
        asOf,
        bundles: shas,
        ...(options.livemode === undefined ? {} : { livemode: options.livemode }),
      },
      uuid(),
    );
    replies.push(reply);
    if (!reply.body.ok)
      return { rounds: round, replies, last: reply, requested, delivered: have, bundles, asOf };
    const { needs, more } = reply.body.data as { needs: string[]; more: boolean };
    if (needs.length === 0 && !more)
      return { rounds: round, replies, last: reply, requested, delivered: have, bundles, asOf };
    send = [];
    for (const need of needs) send.push(...(await answerFor(need)));
  }
  throw new Error("The pull did not finish");
}

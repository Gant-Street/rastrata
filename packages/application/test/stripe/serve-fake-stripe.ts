import { fakeStripe } from "./fake-stripe.ts";
import { buildScenario } from "./fixtures.ts";

/** The fake Stripe of the tests, listening on this machine, for the browser flow test: the Rastrata
 * service is started with RASTRATA_STRIPE_API_URL pointing here and a key (made up, never real)
 * that this server accepts. It only ever answers on the loopback address and holds nothing but the
 * fictional month in fixtures.ts.
 *
 *   RASTRATA_FAKE_STRIPE_PORT  the port to listen on
 *   RASTRATA_FAKE_STRIPE_KEY   the key it accepts, as a Bearer credential */

const port = Number(process.env.RASTRATA_FAKE_STRIPE_PORT ?? "");
const key = process.env.RASTRATA_FAKE_STRIPE_KEY ?? "";
if (!Number.isInteger(port) || port < 1 || port > 65_535 || key === "")
  throw new Error("Set RASTRATA_FAKE_STRIPE_PORT and RASTRATA_FAKE_STRIPE_KEY");

const stripe = fakeStripe(buildScenario(), {
  key,
  // The balance is read at the real time, as the service reads it.
  now: () => Math.floor(Date.now() / 1000),
});

/** The objects of the fictional month say they are real sales; a test key reads practice data, and Stripe labels what it serves with the mode of the key: so for a test key the labels are practice's. */
const practice = /^(rk|sk)_test_/.test(key);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const answer = await stripe.fetch(request.url, {
      method: request.method,
      headers: request.headers,
    });
    if (!practice) return answer;
    return new Response((await answer.text()).replaceAll('"livemode":true', '"livemode":false'), {
      status: answer.status,
      headers: answer.headers,
    });
  },
});
console.info(`fake Stripe on http://127.0.0.1:${port}`);

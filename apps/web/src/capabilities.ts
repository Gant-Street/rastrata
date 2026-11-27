/** What the service that serves this page can do, as far as the screens care. The page learns it once, when it starts (boot.ts reads GET /health), and the screens ask
 * synchronously: the navigation leaves out a page the service cannot back, and a screen does not offer a button that could only fail.
 *
 *  - `accounts`: people sign in with accounts, so a workspace has members (Settings, Members).
 *  - `connections`: the service can keep a bank or Stripe credential for the book (Settings, Connections). One with many books in a process cannot.
 *  - `banks`: an owner can connect a bank in Stripe's window, and its transactions arrive in the Inbox (Settings, Bank accounts). Only a hosted service with accounts whose control plane
 *    has Stripe's keys; the page learns it from the control plane (`GET /auth/config`), not from the service.
 *  - `billing`: the service charges for workspaces: each has a trial and a subscription (Settings, Billing). Only a hosted service with accounts whose control plane has Stripe's keys; the page
 *    learns it from the control plane (`GET /auth/config`), not from the service.
 *  - `stripeApp`: an owner can connect Stripe with the button (Settings, Stripe): the control plane has the company's Stripe app. Only a hosted service with accounts; the page learns it from the
 *    control plane (`GET /auth/config`), not from the service. The Stripe page is offered where the service keeps a Stripe credential itself (`connections`) or where this is so (`stripe`, below).
 *  - `agents`: the service takes an agent's token (Settings, Agents). A hosted service that is not set to takes only the owner's key and people's tokens.
 *  - `backups`: the service makes backups for the person to see and verify (Settings, Backups and export, and the steps and checks that ask about them). A hosted service keeps
 *    the backups itself and offers the open export instead. */
export interface Capabilities {
  readonly accounts: boolean;
  readonly connections: boolean;
  readonly banks: boolean;
  readonly billing: boolean;
  readonly stripeApp: boolean;
  readonly agents: boolean;
  readonly backups: boolean;
}

/** What a route needs of the service: one of the capabilities, or `stripe`, which is either of the two ways to have Stripe (a credential kept by the service, or the button). */
export type Need = keyof Capabilities | "stripe";

/** Whether the service can give what a route needs. */
export const has = (capabilities: Capabilities, need: Need): boolean =>
  need === "stripe" ? capabilities.connections || capabilities.stripeApp : capabilities[need];

/** The installed application and the development servers: no accounts, and a credential can be kept. */
const unlearned: Capabilities = {
  accounts: false,
  connections: true,
  banks: false,
  billing: false,
  stripeApp: false,
  agents: true,
  backups: true,
};

let known: Capabilities = unlearned;

export const capabilities = (): Capabilities => known;

export function learnCapabilities(learned: Capabilities | null): void {
  known = learned ?? unlearned;
}

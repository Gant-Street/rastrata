/** What the page's first lines asked for before its code had arrived (the second script in index.html): whether the service has accounts (`GET /health`) and, for a person who has a
 * workspace open, the token for it (`POST /auth/workspace-token`, which the service also takes as the word to open the workspace's book). The code that would have asked takes the answer
 * instead, once, and asks for itself when there is none: a page that is started some other way (a test, a browser that blocked the first lines) is the page it always was.
 *
 * The first lines put the two requests on `window.__rastrataEarly`; each is taken once, by `readService` (service-state.ts) and by the account layer's first token (account.ts). What is
 * asked for is why this is worth having: the page's code takes 65 ms to start on a repeat visit and a few hundred after a release (it is two megabytes), and the sign-in waited for all of
 * that and then for the health of the service before it began (docs/reference/program/performance.md, step 3). */
export interface Early {
  service?: Promise<Response>;
  token?: { readonly workspace: string; readonly response: Promise<Response> };
}

const early = (): Early | undefined => (globalThis as { __rastrataEarly?: Early }).__rastrataEarly;

/** The request for `/health` the first lines made, once, or null. */
export function takeEarlyService(): Promise<Response> | null {
  const held = early();
  const taken = held?.service ?? null;
  if (held) delete held.service;
  return taken;
}

/** The request for the token of `workspace` the first lines made, once, or null (a request for another workspace is not this one's: the person has changed workspace since). */
export function takeEarlyToken(workspace: string): Promise<Response> | null {
  const held = early();
  const taken = held?.token ?? null;
  if (held) delete held.token;
  return taken !== null && taken.workspace === workspace ? taken.response : null;
}

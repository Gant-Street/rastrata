/** What the application's requests carry on a service with accounts, without every screen passing it down. The client (application-client.ts) is made in
 * about twenty places, each with the page's storage and the browser's `fetch`; with accounts on, each needs the signed token of the workspace the person
 * has open on its requests, and a retained write (kept in the browser until the service has answered) must belong to that workspace and no other.
 *
 * The account layer (account.ts) installs the hook once, when the page starts, if the service says it has accounts. Without it every function here
 * does nothing, and the client is exactly what it was: the owner's session is the cookie, the book has no scope. */
export interface Authorizer {
  /** The `Authorization` value for a request ("Bearer ..."), or null when there is none to give. `force` asks for a new token, as after a refusal. */
  authorization(force?: boolean): Promise<string | null>;
  /** The workspace the page has open: part of the key of every retained write. */
  scope(): string | null;
  /** The service refused the token again after a new one: the session has ended or the person is no longer in the workspace. */
  ended(): void;
}

let installed: Authorizer | null = null;

export function installAuthorizer(authorizer: Authorizer | null): void {
  installed = authorizer;
}

/** The workspace's identifier for keys kept in the browser, or "" when there is no scope (nothing is installed). */
export const authorizationScope = (): string => installed?.scope() ?? "";

/** The service's refusal of a person who is no longer in the workspace (taken out while the page was open) or of a workspace that is being deleted or was: the token still checked
 * out, the book would not let it in. Asking for a new token tells the page, through the control plane, that the person is gone or the workspace is, and the page leaves. */
async function notAMember(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 410) return false;
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return response.status === 403
      ? code === "not_a_member"
      : code === "book_retired" || code === "book_deleted";
  } catch {
    return false;
  }
}

/** Whether the service refused the credentials: the token is not accepted (it ran out, or the clocks differ), or the person is not in the workspace any more. */
const refused = async (response: Response): Promise<boolean> =>
  response.status === 401 || (await notAMember(response));

const resendable = (body: BodyInit | null | undefined): boolean =>
  body === undefined ||
  body === null ||
  typeof body === "string" ||
  body instanceof Blob ||
  body instanceof FormData ||
  body instanceof URLSearchParams ||
  body instanceof ArrayBuffer;

function withToken(init: RequestInit | undefined, token: string | null): RequestInit {
  if (token === null) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set("authorization", token);
  return { ...init, headers };
}

/** `fetch` for a request to the application's API. With accounts installed it carries the workspace's token; if the service refuses the token (it may have
 * run out a moment before it was sent, or the clocks differ), a new one is asked for and the request is sent once more, and a second refusal means the
 * session is over. Without accounts it is `fetch`. */
export async function ambientFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const authorizer = installed;
  if (authorizer === null) return fetch(input, init);
  const first = await fetch(input, withToken(init, await authorizer.authorization()));
  if (!(await refused(first)) || !resendable(init?.body)) return first;
  // A new token is asked for. If the control plane says the session is over or the person is out of the workspace, the authorizer has told the page by now; if it could not
  // be reached, nothing has ended and the refusal is the answer.
  const renewed = await authorizer.authorization(true);
  if (renewed === null) return first;
  const second = await fetch(input, withToken(init, renewed));
  // A new token that is not accepted is the session's end. A book that still says the person is not in it, or is closed, with a token the control plane has just made is in the
  // middle of a change (a restore the book has not heard of yet): the answer is the person's to see, and the next request asks again.
  if (second.status === 401) authorizer.ended();
  return second;
}

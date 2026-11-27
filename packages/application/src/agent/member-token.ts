/** Checking the signed token the control plane gives a signed-in person for one workspace (src/agent/member.ts says what is in it).
 * For the process that serves a book: it checks signature, issuer, audience, algorithm and expiry against the control plane's
 * published public keys, and does nothing else. It needs no secret and calls the control plane only to read the keys, which it
 * keeps for ten minutes, so the control plane being down stops new tokens and not the work of people who have one.
 *
 * Server-side only (it uses `jose`): the browser never checks a token. */
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from "jose";
import {
  MEMBER_TOKEN,
  type MemberTokenClaims,
  memberClaims,
  memberTokenIssuer,
  memberTokenKeysUrl,
} from "./member.ts";

export type MemberTokenVerdict =
  | { readonly kind: "valid"; readonly claims: MemberTokenClaims }
  /** Not a token of ours, or not a good one: another audience or issuer, another algorithm, made by other keys, expired,
   * changed, or missing a claim. */
  | { readonly kind: "refused" }
  /** The keys could not be read, so nothing is known about the token: not the token's fault, and worth another try. */
  | { readonly kind: "unavailable" };

export interface MemberTokenVerifier {
  verify(token: string): Promise<MemberTokenVerdict>;
}

/** Whether a bearer is shaped like a signed token: three parts of base64url. It is a test of shape and says nothing of whether
 * the token is good; it only keeps the work of checking for what could be one. */
export const looksLikeMemberToken = (value: string): boolean =>
  /^[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,500}$/.test(value);

export interface MemberTokenOptions {
  /** The app's own address, such as `https://app.rastrata.com`: the issuer is `<origin>/auth`, the keys are at `<origin>/auth/jwks`. */
  readonly origin: string;
  /** Where the keys come from. The default reads them from the control plane and keeps them; a test gives its own. */
  readonly keys?: JWTVerifyGetKey;
  /** The clock for expiry. Tests only. */
  readonly clock?: () => Date;
  /** How often the keys are fetched again in the background, before they are due, so that the first request after they were is not the one that waits for the control plane (the default is eight minutes;
   * a test gives a few milliseconds). Only for keys that are read from the control plane. */
  readonly refreshEveryMs?: number;
  /** Ends the background refresh (the process's own life by default; a test ends it). */
  readonly stop?: AbortSignal;
}

export function memberTokenVerifier(options: MemberTokenOptions): MemberTokenVerifier {
  const remote = options.keys
    ? null
    : createRemoteJWKSet(new URL(memberTokenKeysUrl(options.origin)), {
        // A token signed by a key that is not in the list asks for the list again, at most this often, so a flood of
        // made-up tokens cannot make the pod ask the control plane a thousand times a second.
        cooldownDuration: 30_000,
        // An hour, with the list fetched again every eight minutes in the background: the keys never expire under a request, and a control plane that cannot be reached for a while
        // leaves the pod checking tokens with the keys it has.
        cacheMaxAge: 60 * 60_000,
        timeoutDuration: 5000,
      });
  if (remote !== null) {
    const refresh = () => void remote.reload().catch(() => {});
    refresh();
    const timer = setInterval(refresh, options.refreshEveryMs ?? 8 * 60_000);
    (timer as unknown as { unref?: () => void }).unref?.();
    options.stop?.addEventListener("abort", () => clearInterval(timer), { once: true });
  }
  const keys = options.keys ?? (remote as JWTVerifyGetKey);
  const issuer = memberTokenIssuer(options.origin);
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer,
          audience: MEMBER_TOKEN.audience,
          algorithms: [MEMBER_TOKEN.algorithm],
          requiredClaims: ["exp", "sub"],
          clockTolerance: 5,
          ...(options.clock ? { currentDate: options.clock() } : {}),
        });
        const claims = memberClaims(payload as Record<string, unknown>);
        return claims ? { kind: "valid", claims } : { kind: "refused" };
      } catch (error) {
        // jose's own errors say the token is not good; a timeout or a failed read says the keys were not there.
        if (error instanceof errors.JWKSTimeout) return { kind: "unavailable" };
        if (error instanceof errors.JOSEError) return { kind: "refused" };
        return { kind: "unavailable" };
      }
    },
  };
}

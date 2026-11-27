import { verifySmoke, type Transport } from "./verify-smoke.ts";
import { verifyNativeSmoke, verifyNativeSave } from "./verify-native-smoke.ts";

export function remoteTransport(url: string, token: string): Transport {
  const origin = new URL(url);
  if (
    origin.protocol !== "https:" ||
    !/^rastrata-ledger-dev\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    origin.port
  ) {
    throw new Error("Expected the isolated rastrata-ledger-dev workers.dev origin");
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Development token missing or malformed");
  return (path, method = "GET", authorized = true) => {
    const target = new URL(path, origin);
    if (target.origin !== origin.origin) throw new Error("Cross-origin requests forbidden");
    return fetch(target, {
      method,
      headers: authorized ? { authorization: `Bearer ${token}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  };
}

if (import.meta.main) {
  try {
    const result = await verifySmoke(
      remoteTransport(process.env.LEDGER_DEV_URL ?? "", process.env.DEV_ACCESS_TOKEN ?? ""),
    );
    const native = await verifyNativeSmoke(
      remoteTransport(process.env.LEDGER_DEV_URL ?? "", process.env.DEV_ACCESS_TOKEN ?? ""),
    );
    const saved = await verifyNativeSave(
      remoteTransport(process.env.LEDGER_DEV_URL ?? "", process.env.DEV_ACCESS_TOKEN ?? ""),
    );
    console.log(
      JSON.stringify(
        {
          verified: true,
          ...result,
          nativeHead: saved.snapshot.head,
          priorNativeHead: native.head,
          singleSave: { httpRoundTripMs: saved.httpRoundTripMs, disposition: saved.disposition },
        },
        null,
        2,
      ),
    );
  } catch {
    console.error("Remote smoke verification failed. Details suppressed to protect credentials.");
    process.exitCode = 1;
  }
}

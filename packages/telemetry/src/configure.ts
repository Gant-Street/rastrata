/** Turning telemetry on from the environment. This is the only place that loads the exporting
 * backend (and with it the OpenTelemetry SDK), and it does so only when an endpoint is configured,
 * so a process without one, which is every local product, loads none of it.
 *
 * It cannot fail the caller: a bad configuration, or a backend that will not start, leaves
 * telemetry off and says so in one line (never with a credential in it). */
import { type Backend, installBackend, telemetryEnabled } from "./api.ts";
import {
  describeConfig,
  readTelemetryConfig,
  type Environment,
  type TelemetryConfig,
} from "./config.ts";
import { startRuntimeTelemetry } from "./runtime.ts";

/** The packaging script of the installed local service defines this as false, which removes the
 * dynamic import below from the executable altogether: the service people install carries no
 * OpenTelemetry. In development and in the hosted image it is not defined, and telemetry is as
 * configured. */
declare const RASTRATA_TELEMETRY_SDK: boolean | undefined;

export interface ConfigureOptions {
  /** The environment to read; the process's own by default. */
  readonly env?: Environment;
  /** What this process is called when OTEL_SERVICE_NAME is not set. */
  readonly serviceName?: string;
  /** Replaces `fetch`, for tests. */
  readonly fetch?: typeof fetch;
  /** Read the process's memory, CPU and event-loop lag (default true). */
  readonly runtime?: boolean;
  /** Where the one line it prints goes (console by default). */
  readonly log?: (message: string) => void;
}

let starting: Promise<boolean> | undefined;

/** Load the exporting backend (and with it the SDK) and install it. The only place that does. */
async function turnOn(config: TelemetryConfig, options: ConfigureOptions): Promise<void> {
  const { createSdkBackend } = await import("./sdk.ts");
  const sdk = createSdkBackend({ config, ...(options.fetch ? { fetch: options.fetch } : {}) });
  let stopRuntime = () => {};
  const backend: Backend = {
    ...sdk,
    shutdown: async (timeoutMs) => {
      stopRuntime();
      await sdk.shutdown(timeoutMs);
    },
  };
  installBackend(backend);
  if (options.runtime !== false)
    stopRuntime = startRuntimeTelemetry({
      sampleMs: config.runtimeSampleMs,
      onTick: sdk.sampleSelf,
    });
}

/** Turn telemetry on if the environment names an endpoint. Resolves true when it is on (already, or
 * now) and false when it stays off. Safe to call more than once. */
export function configureTelemetry(options: ConfigureOptions = {}): Promise<boolean> {
  if (telemetryEnabled()) return Promise.resolve(true);
  starting ??= start(options).finally(() => {
    starting = undefined;
  });
  return starting;
}

async function start(options: ConfigureOptions): Promise<boolean> {
  const say = options.log ?? ((message: string) => console.info(message));
  const warn = options.log ?? ((message: string) => console.warn(message));
  try {
    const result = readTelemetryConfig(options.env ?? process.env, {
      ...(options.serviceName ? { serviceName: options.serviceName } : {}),
    });
    if (!result.on) {
      if (result.reason === "invalid")
        warn(
          "telemetry stays off: the OTLP endpoint is not an http or https URL without credentials in it",
        );
      return false;
    }
    // Written as a positive condition around everything that uses the SDK, because that is the form
    // the bundler can remove when the flag is defined false: the installed service carries none of it.
    if (typeof RASTRATA_TELEMETRY_SDK === "undefined" || RASTRATA_TELEMETRY_SDK) {
      await turnOn(result.config, options);
      say(describeConfig(result.config));
      return true;
    }
    return false;
  } catch (error) {
    warn(
      `telemetry stays off: it could not start (${error instanceof Error ? error.name : "error"})`,
    );
    return false;
  }
}

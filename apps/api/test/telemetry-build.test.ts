import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildService } from "../tooling/build-service.ts";

// The service people install never sends telemetry, so it must not carry the code that could: the
// build defines RASTRATA_TELEMETRY_SDK as false, which removes the one branch that imports the
// OpenTelemetry SDK. This builds the service both ways, around a one-page web app so that it does not
// wait for the real one, and looks inside.
test("the installed service is built without the OpenTelemetry SDK; a build that asks for it has it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-telemetry-build-"));
  try {
    const web = join(directory, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<!doctype html>");
    const without = join(directory, "installed");
    const withSdk = join(directory, "with-telemetry");
    await buildService({ outfile: without, webDirectory: web, version: "0.0.0" });
    await buildService({ outfile: withSdk, webDirectory: web, version: "0.0.0", telemetry: true });

    const installed = readFileSync(without);
    const measured = readFileSync(withSdk);
    // What only the SDK and its OTLP serializers contain.
    for (const marker of ["opentelemetry", "JsonTraceSerializer", "AlwaysOnSampler"]) {
      expect(installed.includes(marker), `the installed service holds ${marker}`).toBe(false);
      expect(measured.includes(marker), `the build with telemetry lacks ${marker}`).toBe(true);
    }
    // The saving is real, not a rounding: several hundred kilobytes of an executable of 67 MB.
    expect(statSync(withSdk).size - statSync(without).size).toBeGreaterThan(300_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

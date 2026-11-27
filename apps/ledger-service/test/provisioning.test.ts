import { expect, test } from "bun:test";
import { provisioningStage } from "../src/provisioning.ts";

test("provisioning reports the durable boundary without reflecting opaque error data or retrying", async () => {
  for (const stage of [
    "reserve",
    "initialize",
    "activate",
    "refresh",
    "book_catalog",
    "book_open",
    "book_binding",
    "book_activation",
    "book_archive",
  ] as const) {
    let calls = 0;
    await expect(
      provisioningStage(stage, async () => {
        calls++;
        throw new Error("private request data and Bearer credentials");
      }),
    ).rejects.toThrow(`ledger_provisioning_${stage}_platform_failure`);
    expect(calls).toBe(1);
    await expect(
      provisioningStage(stage, async () => {
        throw new Error("Durable Object reset because its code was updated.");
      }),
    ).rejects.toThrow(`ledger_provisioning_${stage}_deployment_reset`);
  }
});

test("provisioning preserves successful values and known accounting or authorization diagnostics", async () => {
  const receipt = Object.freeze({ outcomeSequence: "1" });
  expect(await provisioningStage("initialize", async () => receipt)).toBe(receipt);
  for (const message of ["ledger_unauthorized", "native_catalog_conflict", "archive_unavailable"]) {
    const error = new Error(message);
    const observed = await provisioningStage("activate", async () => {
      throw error;
    }).catch((value: unknown) => value);
    expect(observed).toBe(error);
  }
  for (const error of [null, undefined, { message: "secret" }, "secret"]) {
    await expect(
      provisioningStage("refresh", async () => {
        throw error;
      }),
    ).rejects.toThrow("ledger_provisioning_refresh_platform_failure");
  }
});

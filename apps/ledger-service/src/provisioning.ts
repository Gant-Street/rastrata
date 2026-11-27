/** Private provisioning crosses independently durable services. Preserve known
 * ledger diagnostics, but identify opaque platform failures without reflecting
 * their messages (which can contain request data). A stage never retries work. */
export type ProvisioningStage =
  | "reserve"
  | "initialize"
  | "activate"
  | "refresh"
  | "book_catalog"
  | "book_open"
  | "book_binding"
  | "book_activation"
  | "book_archive";

export async function provisioningStage<T>(
  stage: ProvisioningStage,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(?:ledger|native|archive)_[a-z_]+$/.test(message)) throw error;
    const reason =
      message.toLowerCase() === "durable object reset because its code was updated."
        ? "deployment_reset"
        : "platform_failure";
    throw new Error(`ledger_provisioning_${stage}_${reason}`);
  }
}

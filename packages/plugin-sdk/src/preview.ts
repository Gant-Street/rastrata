import { fromCents, toCents } from "./money.ts";
import type { PluginManifest, PullBatch } from "./types.ts";

/** Render an aligned debit/credit ledger preview table for human review or CLI `--dry-run`. */
export function formatPreviewTable(
  batches: readonly PullBatch[],
  manifest: PluginManifest,
): string {
  const roleLabels = new Map((manifest.roles ?? []).map((r) => [r.key, r.label]));
  const lines: string[] = [];
  lines.push(`${manifest.name} (${manifest.id} v${manifest.version})`);
  lines.push("─".repeat(72));

  let totalLines = 0;
  for (let b = 0; b < batches.length; b += 1) {
    const batch = batches[b];
    if (!batch) continue;
    lines.push(
      `Batch ${b + 1} · source=${batch.sourceKey} · raw=${batch.raw.bytes.byteLength} B${batch.cursor ? ` · cursor=${batch.cursor}` : ""}`,
    );

    for (const item of batch.lines) {
      totalLines += 1;
      if (item.kind === "bankLine") {
        const amt = item.amount.padStart(11);
        const id = item.providerId ? ` [${item.providerId}]` : "";
        lines.push(`  ${item.postedOn}  ${amt} ${item.currency}  ${item.description}${id}`);
      } else {
        const covered = item.coveredBy ? ` (evidence for ${item.coveredBy})` : "";
        lines.push(`  ${item.eventOn}  ${item.summary} [${item.providerId}]${covered}`);
        for (const leg of item.legs) {
          const cents = toCents(leg.amount);
          const roleName = (roleLabels.get(leg.role) ?? leg.role).padEnd(26);
          const debit = cents > 0n ? fromCents(cents).padStart(11) : "".padStart(11);
          const credit = cents < 0n ? fromCents(-cents).padStart(11) : "".padStart(11);
          lines.push(`      ${roleName}  DR ${debit}   CR ${credit}`);
        }
      }
    }

    for (const check of batch.balances ?? []) {
      lines.push(`  Balance check · ${check.accountKey} as of ${check.asOf}: ${check.balance}`);
    }
  }

  if (totalLines === 0) lines.push("  (no lines emitted)");
  lines.push("─".repeat(72));
  return lines.join("\n");
}

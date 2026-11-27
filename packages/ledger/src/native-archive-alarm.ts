import { requireLedger } from "./records.ts";
import type { NativeOutcomeOutbox } from "./native-outcome-outbox.ts";

export interface NativeAlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

/** Owns the book's single archive alarm. arm() must run inside command
 * serialization before publication, so the relay cannot read between those steps.
 * Successful warm arms are cached only until delivery/restart/deadline; neither
 * backup progress nor payloads live in this cache. Only the platform calls run(). */
export class NativeArchiveAlarm {
  private armedUntil: number | null = null;
  private generation = 0;
  private arming: Promise<number> | null = null;
  constructor(
    private readonly storage: NativeAlarmStorage,
    private readonly outbox: Pick<NativeOutcomeOutbox, "drain">,
    private readonly delayMs = 60000,
    private readonly clock = Date.now,
  ) {
    requireLedger(
      Number.isSafeInteger(delayMs) && delayMs > 0 && delayMs <= 60000,
      "native_archive_alarm_invalid",
    );
  }
  async arm(): Promise<void> {
    await this.schedule(this.delayMs);
  }
  private async schedule(delayMs: number): Promise<void> {
    const now = this.clock();
    requireLedger(Number.isSafeInteger(now) && now > 0, "native_archive_alarm_invalid");
    const deadline = now + delayMs;
    requireLedger(Number.isSafeInteger(deadline), "native_archive_alarm_invalid");
    if (this.armedUntil !== null && this.armedUntil > now && this.armedUntil <= deadline) return;
    if (this.arming === null) {
      const generation = this.generation;
      this.arming = (async () => {
        const existing = await this.storage.getAlarm();
        requireLedger(
          existing === null || (Number.isSafeInteger(existing) && existing > 0),
          "native_archive_alarm_invalid",
        );
        const selected = existing === null ? deadline : Math.min(existing, deadline);
        if (existing !== selected) await this.storage.setAlarm(selected);
        if (generation === this.generation) this.armedUntil = selected;
        return generation;
      })().finally(() => {
        this.arming = null;
      });
    }
    const generation = await this.arming;
    // Delivery may have begun while an earlier arm was awaiting storage. That
    // old observation cannot establish a future retry for the running handler.
    if (generation !== this.generation || (this.armedUntil !== null && this.armedUntil > deadline))
      await this.schedule(delayMs);
  }
  async run(): Promise<void> {
    this.generation++;
    this.armedUntil = null;
    try {
      // Bound each wake to eight batches (at most 128 outcomes / 8 MiB), but do
      // not throttle an existing backlog to one batch per initial-arm interval.
      for (let batch = 0; batch < 8; batch++) {
        const progress = await this.outbox.drain();
        if (progress.disposition === "conflict") break;
        if (BigInt(progress.through.sequence) === BigInt(progress.observedTip.sequence)) return;
      }
      await this.schedule(Math.min(this.delayMs, 1000));
    } catch (error) {
      // Native retries are finite. Persist another opportunity after a downstream
      // failure; do not delete an alarm concurrently armed by a new command.
      await this.arm();
      throw error;
    }
  }
}

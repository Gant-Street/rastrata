import type {
  ApplicationInputs,
  MutationReceipt,
  PreparedOperation,
} from "@rastrata/application/client-contracts";
import { createSignal, onMount } from "solid-js";
import { BrowserApplicationClient, type PendingRequest } from "./application-client";

type Preparation =
  | "accounts.prepareCreate"
  | "accounts.prepareChange"
  | "journal.prepareReverse"
  | "periods.prepare"
  | "periods.extend";
type ReviewRequest = {
  [K in Preparation]: { name: K; input: ApplicationInputs[K] };
}[Preparation];

/** One retained write and one inspected plan for each browser workflow.
 *
 * Preparing and committing are two writes, each retained before it is sent. A screen whose form is
 * already the review (reversing an entry, adding an account) passes `chain`: a plan that is valid and
 * carries no warning is committed at once, from the same click, and the person only sees a review when
 * there is something to read. The commit is still the exact plan that was prepared, under its own hash. */
export function createPostingWorkflow(
  key: string,
  onReceipt: (receipt: MutationReceipt) => Promise<void>,
  restore?: (request: ReviewRequest) => void,
  options: { chain?: boolean } = {},
) {
  const client = new BrowserApplicationClient(window.localStorage);
  const [plan, setPlan] = createSignal<PreparedOperation | null>(null);
  const [reviewedInput, setReviewedInput] = createSignal("");
  const [pending, setPending] = createSignal<PendingRequest | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [invalidJournal, setInvalidJournal] = createSignal(false);
  const sync = () => {
    try {
      setPending(client.pending(key));
      setInvalidJournal(false);
    } catch (cause) {
      setInvalidJournal(true);
      setError(cause instanceof Error ? cause.message : "Retained request unavailable");
    }
  };
  onMount(sync);
  const blocked = () => busy() || !!pending() || invalidJournal();
  const run = async (work: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request unavailable");
    } finally {
      sync();
      setBusy(false);
    }
  };
  function reviewed(prepared: PreparedOperation, input: unknown) {
    setPlan(prepared);
    setReviewedInput(JSON.stringify(input));
    if (!prepared.valid) setError(prepared.diagnostics.join("; ") || "Change is invalid");
  }
  async function completed(receipt: MutationReceipt) {
    setPlan(null);
    await onReceipt(receipt);
    if (receipt.disposition === "rejected")
      setError(receipt.diagnostics.join("; ") || "Change rejected. Review a new plan.");
  }
  /** A prepared plan is reviewed; when the screen chains the commit and there is nothing to read in the
   * plan (it is valid and has no warning), it is committed at once. */
  async function afterPrepare(prepared: PreparedOperation, input: unknown, chain = options.chain) {
    reviewed(prepared, input);
    if (chain && prepared.valid && (prepared.warnings ?? []).length === 0)
      await completed(
        await client.write(
          "operations.commit",
          { planId: prepared.planId, planHash: prepared.planHash },
          key,
        ),
      );
  }
  return {
    plan,
    pending,
    busy,
    error,
    blocked,
    current: (input: unknown) => reviewedInput() === JSON.stringify(input),
    /** Leave a review without sending anything: the plan and the message go, a retained request
     * (if there is one) stays. */
    discard: () => {
      setPlan(null);
      setReviewedInput("");
      setError("");
    },
    /** `chain` decides, for this one preparation, whether a clean plan is committed at once; left out, the
     * workflow's own choice stands. */
    prepare: <K extends Preparation>(name: K, input: ApplicationInputs[K], chain?: boolean) =>
      blocked()
        ? Promise.resolve()
        : run(async () => {
            await afterPrepare(await client.write(name, input, key), input, chain);
          }),
    commit: () =>
      run(async () => {
        const selected = plan();
        if (!selected?.valid) return;
        await completed(
          await client.write(
            "operations.commit",
            { planId: selected.planId, planHash: selected.planHash },
            key,
          ),
        );
      }),
    resume: () =>
      run(async () => {
        const original = client.pending(key);
        if (!original) return;
        const result = await client.resume(key);
        if (result.name === "operations.commit") await completed(result.data);
        else if (
          result.name === "accounts.prepareCreate" ||
          result.name === "accounts.prepareChange" ||
          result.name === "journal.prepareReverse" ||
          result.name === "periods.prepare" ||
          result.name === "periods.extend"
        ) {
          restore?.({ name: result.name, input: JSON.parse(original.body).input } as ReviewRequest);
          await afterPrepare(result.data, JSON.parse(original.body).input);
        } else throw new Error("Unexpected retained request");
      }),
  };
}

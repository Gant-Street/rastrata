import {
  Button,
  ClassifierCard,
  type ClassifierConfigView,
  Notice,
  rulesWords as words,
} from "@rastrata/ui";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import type { BrowserApplicationClient } from "../../application-client";
import type { ChartView } from "./chart.ts";
import { classifierOf } from "./draft.ts";
import { createLoader } from "../../loader.ts";
import { isUncertain, messageOf, retained } from "./retained.ts";

const TRAIN = "classifier:train";
const CONFIGURE = "classifier:configure";

/** The classifier card with its data: what it has learned and how well it does, read from the
 * service. It learns by itself; the one training a person can start (a history too long to learn
 * from on the side) and the threshold changes are retained writes, so a lost reply is resumed,
 * never sent twice. The card shows nothing on a book it has nothing to say about. The classifier
 * only suggests; nothing here posts. */
export function ClassifierPanel(props: { client: BrowserApplicationClient; chart: ChartView }) {
  const status = createLoader(() => props.client.read("classifier.status", {}));
  const [training, setTraining] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal<{ tone: "ok" | "error"; text: string } | undefined>();
  const train = retained(props.client, TRAIN);
  const configure = retained(props.client, CONFIGURE);
  onMount(() => {
    train.sync();
    configure.sync();
  });
  const view = createMemo(() => {
    const current = status.value();
    return current ? classifierOf(current, props.chart) : null;
  });

  async function learn() {
    setTraining(true);
    setMessage(undefined);
    try {
      status.set(await props.client.write("classifier.train", {}, TRAIN));
      setMessage({ tone: "ok", text: words.classifierTrainedDone });
    } catch (cause) {
      if (!isUncertain(cause))
        setMessage({ tone: "error", text: messageOf(cause, words.classifierTrainFailed) });
    } finally {
      train.sync();
      setTraining(false);
    }
  }

  async function save(config: ClassifierConfigView) {
    setSaving(true);
    setMessage(undefined);
    try {
      status.set(await props.client.write("classifier.configure", config, CONFIGURE));
      setMessage({ tone: "ok", text: words.classifierSaved });
    } catch (cause) {
      if (!isUncertain(cause))
        setMessage({ tone: "error", text: messageOf(cause, words.classifierSaveFailed) });
    } finally {
      configure.sync();
      setSaving(false);
    }
  }

  async function resume(workflow: string) {
    setMessage(undefined);
    try {
      const done = await props.client.resume(workflow);
      if (done.name === "classifier.train" || done.name === "classifier.configure")
        status.set(done.data);
      else await status.reload();
    } catch (cause) {
      if (!isUncertain(cause)) setMessage({ tone: "error", text: messageOf(cause, words.failed) });
    } finally {
      train.sync();
      configure.sync();
    }
  }

  return (
    <>
      <Show when={train.pending() || configure.pending()}>
        <Notice title={words.uncertainTitle} tone="review" role="status">
          <p>{words.uncertainBody}</p>
          <Button
            label={words.resume}
            onClick={() => void resume(train.pending() ? TRAIN : CONFIGURE)}
          />
        </Notice>
      </Show>
      <ClassifierCard
        state={status.error() ? "error" : !status.value() ? "loading" : "ready"}
        view={view()}
        training={training()}
        saving={saving()}
        message={message()}
        onTrain={() => void learn()}
        onSave={(config) => void save(config)}
        onRetry={() => void status.reload()}
      />
    </>
  );
}

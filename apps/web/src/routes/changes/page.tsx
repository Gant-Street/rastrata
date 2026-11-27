import { ChangesWorkspace } from "@rastrata/ui";
import { localToday } from "@rastrata/ui/format";
import { onMount } from "solid-js";
import { BrowserApplicationClient } from "../../application-client";
import { createChangesController, hrefFor } from "./controller";

/** Changes. The route only creates the controller and hands its data and actions to the workspace; every
 * decision about what the screen says is in the components and the controller. */
export function ChangesPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const page = createChangesController(client, localToday());
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());
  return (
    <section aria-labelledby="changes-title">
      <ChangesWorkspace
        load={page.load()}
        busy={page.busy()}
        list={page.list()}
        failure={page.failure()}
        state={page.state()}
        today={page.today}
        look={page.look()}
        titleRef={(element) => {
          heading = element;
        }}
        onChange={page.change}
        onClear={page.clear}
        onRetry={page.readAgain}
        onReload={page.readAgain}
        onLook={() => void page.markLooked()}
        hrefFor={hrefFor}
      />
    </section>
  );
}

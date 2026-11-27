import { GapsScreen } from "@rastrata/ui";
import { BrowserApplicationClient } from "../../application-client";
import { createGapsController } from "./gaps-controller";

/** The gap log: what the move found that is not yet right. */
export function GapsPage() {
  const controller = createGapsController(new BrowserApplicationClient(window.localStorage));
  return <GapsScreen {...controller.props()} />;
}

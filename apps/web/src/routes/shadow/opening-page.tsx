import { OpeningScreen } from "@rastrata/ui";
import { BrowserApplicationClient } from "../../application-client";
import { createOpeningController } from "./opening-controller";

/** Opening balances: the cutover date, the balances and the entry they make. The route is thin: the
 * controller holds the state and the writes, and the screen renders what it is given. */
export function OpeningPage() {
  const controller = createOpeningController(new BrowserApplicationClient(window.localStorage));
  return <OpeningScreen {...controller.props()} />;
}

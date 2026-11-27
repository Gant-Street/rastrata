import { registerFonts } from "@rastrata/ui/fonts";
import { UiProvider } from "@rastrata/ui/locale";
import { render } from "solid-js/web";
import { Account } from "./account";
import { wipeDevice } from "./copy";
import { GateScreen } from "./gate";
import { GateController } from "./gate-controller";
import { takeReturnPath } from "./return-after-sign-in";
import { readService } from "./service-state";
import { rememberSignIn, SESSION_NOT_KEPT_MESSAGE, signInJustTaken } from "./session";
import { SignInScreen } from "./signin";

/** The page a hosted service sends to a browser that has no session (the service decides: see `WebApp.serve`
 * in apps/api/src/web.ts). It is the sign-in and nothing else: the application's code is not sent to someone
 * who is not in, and none of its screens is drawn for them before the first refusal arrives.
 *
 * On a service with accounts it is the whole of getting in: an address, a code, a workspace (or an invitation to
 * accept), and then the application (gate.tsx). The same page answers `/start`, where the application sends
 * someone who has to choose a workspace, and `/invite/<token>`, the link in an invitation. On a service that
 * takes only the owner's key it is the key dialog, as it always was: when the key is accepted the page is read
 * again from the same address, and the service, which now sees the session, answers with the application. If the
 * page that comes back is this one again, the service took the key and the browser did not keep the session
 * (a cookie that must be secure on a page that is not on https), and the screen says so, as the application's own
 * does. */
const root = document.getElementById("root");
if (!root) throw new Error("Sign-in root is missing");
registerFonts();
const service = await readService();
if (service.accounts) {
  const controller = new GateController({
    // This page keeps nothing of a book, and signing out or deleting the account from it deletes what the application kept on the device.
    account: new Account({ copy: { unlock: () => {}, giveUp: () => {}, forget: wipeDevice } }),
    // A page that sent the person here to sign in again (Settings, Agents) is where they go back to; anyone else goes where the gate says.
    go: (path) => window.location.assign(path === "/" ? (takeReturnPath() ?? path) : path),
    path: window.location.pathname,
    choose: new URLSearchParams(window.location.search).has("choose"),
  });
  render(
    () => (
      <UiProvider locale="en-US">
        <GateScreen controller={controller} />
      </UiProvider>
    ),
    root,
  );
} else {
  const notKept = signInJustTaken();
  render(
    () => (
      <UiProvider locale="en-US">
        <SignInScreen
          notice={notKept ? SESSION_NOT_KEPT_MESSAGE : undefined}
          onSignedIn={() => {
            rememberSignIn();
            window.location.reload();
          }}
        />
      </UiProvider>
    ),
    root,
  );
}

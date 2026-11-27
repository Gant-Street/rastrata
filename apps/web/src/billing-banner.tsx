import { buttonAttrs, Notice } from "@rastrata/ui";
import { Show } from "solid-js";
import { AppLink } from "./app-link";
import type { Banner } from "./billing-controller";

/** What everyone in a workspace is told about its trial or subscription, under the header: the last days of a trial, a payment that failed, a workspace that is read-only. Not a live region: it is
 * there on every page, and a screen reader is not interrupted by it each time. */
export function BillingBanner(props: { readonly banner: Banner | null }) {
  return (
    <Show when={props.banner}>
      {(banner) => (
        <div class="billing-banner">
          <Notice title={banner().title} tone={banner().tone}>
            <p class="billing-banner-text">{banner().text}</p>
            <p>
              <AppLink
                {...buttonAttrs({ variant: "secondary", size: "sm" })}
                href="/settings/billing"
              >
                {banner().link}
              </AppLink>
            </p>
          </Notice>
        </div>
      )}
    </Show>
  );
}

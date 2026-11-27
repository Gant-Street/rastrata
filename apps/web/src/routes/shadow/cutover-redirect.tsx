import { useRouter } from "@tanstack/solid-router";
import { onMount } from "solid-js";

/** `/cutover` was the month checklist, a page of its own under Close the books. What is left for a month is
 * on Close the books now, so the old address (a bookmark, a link in a message) opens that page. */
export function CutoverRedirect() {
  const router = useRouter();
  onMount(() => router.history.replace("/periods"));
  return null;
}

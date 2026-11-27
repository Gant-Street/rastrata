import { ApplicationRequestError } from "../../application-client";

/** Whether the service said there is no book yet. A screen opened before the books are set up shows
 * that, in plain words, rather than a failed read. */
export const isNoBook = (...causes: readonly unknown[]): boolean =>
  causes.some(
    (cause) => cause instanceof ApplicationRequestError && cause.code === "book_not_configured",
  );

/** The release this build of the service is. The packaging script (apps/api/tooling/build-service.ts) writes
 * it into the executable from the repository's package.json; run from source there is no such
 * definition and the service says so. */
declare const RASTRATA_VERSION: string | undefined;

export const VERSION: string =
  typeof RASTRATA_VERSION === "string" ? RASTRATA_VERSION : "0.1.0-development";

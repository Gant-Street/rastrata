import { capabilities } from "../../capabilities.ts";
import type { HelpAudience } from "./topics.ts";

/** Who is reading Help: a service where people sign in with accounts is the hosted one; any other is a
 * person's own copy, on their own computer. */
export const helpAudience = (): HelpAudience => (capabilities().accounts ? "hosted" : "installed");

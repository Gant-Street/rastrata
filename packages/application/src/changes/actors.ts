/** Who made a change, in the words a list shows. Pure and portable.
 *
 * The book keeps a maker as the string `describePrincipal` makes ("owner", "agent:<token>",
 * "member:<user>", "service:<name>") and, where it knew one, the name the maker goes by. A name is
 * text somebody chose (an agent's token name), so it is plain and short here, like every other text
 * that comes from outside. */
import { sanitizeText } from "../ingest/text.ts";
import { type ActorRef, UNKNOWN_ACTOR } from "./kinds.ts";

const LABEL_MAX = 100;
const ID_MAX = 128;

const cleanLabel = (value: string | undefined, fallback: string): string => {
  const text = sanitizeText(value ?? "", LABEL_MAX);
  return text === "" ? fallback : text;
};

/** The maker a recorded principal stands for. `label` is the name recorded with it. A string that is
 * none of the known forms is a maker the lane cannot name, which is shown as such and never guessed. */
export function actorOf(principal: string, label?: string): ActorRef {
  if (principal === "owner") return { kind: "owner", label: "owner" };
  const at = principal.indexOf(":");
  if (at < 0) return UNKNOWN_ACTOR;
  const kind = principal.slice(0, at);
  const id = sanitizeText(principal.slice(at + 1), ID_MAX);
  if (id === "") return UNKNOWN_ACTOR;
  switch (kind) {
    case "agent":
      return { kind: "agent", label: cleanLabel(label, `agent ${id.slice(0, 8)}`), id };
    case "member":
      return { kind: "person", label: cleanLabel(label, "member"), id };
    case "service":
      return { kind: "service", label: cleanLabel(label, id), id };
    default:
      return UNKNOWN_ACTOR;
  }
}

/** The maker of a rule, as the rules lane records it: a person or an agent, with a name. */
export function authorOf(author: {
  readonly kind: string;
  readonly name?: string | undefined;
}): ActorRef {
  const label = cleanLabel(author.name, author.kind === "agent" ? "agent" : "person");
  if (author.kind === "agent") return { kind: "agent", label };
  if (author.kind === "person") return { kind: "person", label };
  return UNKNOWN_ACTOR;
}

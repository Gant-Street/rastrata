import { formatFiguresInText } from "@rastrata/ui/format";

/** The books explain a refusal in words meant for every caller at once: a person on a screen, a script, an
 * agent. A closed month says how a script reopens it, in a parenthesis that names the operation: on a screen the
 * person has the button, so the formatter leaves the parenthesis out (`formatFiguresInText`, for every screen),
 * and the dates and amounts in the sentence read the way every other one does. Running it again over a sentence
 * that has been through it changes nothing. */
export function forPeople(message: string): string {
  return formatFiguresInText(message).trim();
}

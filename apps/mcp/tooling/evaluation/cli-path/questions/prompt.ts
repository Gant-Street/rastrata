/** What the owner says to the agent at the start of a session: who they are, what is allowed, how to
 * answer (and to say so when the books cannot), the format of the answer lines, and the ten questions.
 * It is the same wording for every session, so a difference between sessions is a difference in the
 * questions. */
import { hintOf, questionsOfSession } from "./bank.ts";

export function promptFor(session: number): string {
  const questions = questionsOfSession(session);
  const lines = questions.map(
    (question) => `${question.id} (${hintOf(question)}): ${question.text}`,
  );
  return [
    "I own Willow Lane Studio. March 2026 is the month I have just finished, and I have ten questions about my books. Please answer them from the books themselves, using rastrata. Your access only lets you read, so change nothing.",
    "",
    "How to answer:",
    "- Find each answer in the books. Do not guess, estimate or work from memory.",
    "- If the books cannot tell you (they do not hold it, or no command reports it), do not make an answer up: write UNSUPPORTED and a short reason.",
    "- Money is dollars and cents with a minus sign for a loss or a decrease, like 1204.50 or -87.00. Something I owe is a positive number.",
    "- A percentage is a number with one decimal, like 12.3. A date is YYYY-MM-DD. A count is a whole number. A name is as the books spell it. A list is names separated by semicolons.",
    "- Finish your reply with exactly one line per question, in the order I asked, each beginning with the question's number, a colon and a space, and nothing else on the line, like this:",
    "A0: 1204.50",
    "A0: UNSUPPORTED the books do not track this",
    "Do not put those lines in a table or a code block.",
    "",
    "My questions:",
    ...lines,
  ].join("\n");
}

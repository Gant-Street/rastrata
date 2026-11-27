/** A process that sends one `inbox.recategorize` request to a book in a file and, when told to, kills
 * itself with SIGKILL between two steps of it. The first-step test of the catch-all lane starts it twice:
 * once to die, once to carry on. Test support; nothing in the product runs it.
 *
 * Arguments: the book's path, the request as JSON, the operation identity and, optionally, where to die
 * as `before|after:reverse|return|categorize|post:N` (the Nth time that step is reached). It prints the
 * response body as one line of JSON. */
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { type MoveStep, onMoveStep } from "../../src/slices/entries/recategorize.ts";
import { ingestRuntime } from "../../src/slices/ingest/store.ts";

const [path, request, operationId, dieAt] = process.argv.slice(2);
if (!path || !request || !operationId)
  throw new Error("usage: move-child PATH REQUEST_JSON ID [WHEN:STEP:N]");

const service = await LocalBookService.open(path);
ingestRuntime(service).postBudgetMs = 600_000;
if (dieAt) {
  const [when, step, nth] = dieAt.split(":") as ["before" | "after", MoveStep, string];
  let reached = 0;
  onMoveStep(service, (at, what) => {
    if (at !== when || what !== step) return;
    reached += 1;
    // A real death: no finally block runs, no buffer is flushed, nothing is closed.
    if (reached === Number(nth)) process.kill(process.pid, "SIGKILL");
  });
}
const http = new ApplicationHttp(service, {
  bookId: service.bookId,
  permissions: BUSINESS_PERMISSIONS,
});
const response = await http.fetch(
  new Request("http://127.0.0.1:4010/v1/inbox.recategorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: service.bookId,
      input: JSON.parse(request),
      operationId,
    }),
  }),
);
console.log(JSON.stringify(await response.json()));
service.close();

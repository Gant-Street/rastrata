# Production ledger design review

Initial review: 2026-09-05, covering SysML and executable design specifications.
Subsequent dated sections record scoped implementation and measurement evidence.
This is an agent-authored reference review and adversarial self-audit, not an
independent human review, runtime certification, or production release approval.

Current owner decisions are in the
[acceptance contract](../../../docs/reference/ledger-production-acceptance.md#current-closeout--2026-09-19).
On 2026-09-19 the owner removed the sub-50-ms latency release requirement after
profiling; the dated failures below remain historical evidence, not active
numeric gates or retroactively passing measurements. Correctness, durability,
measurement integrity and deployment/authorization obligations remain unchanged.

## Signed recovery and persistence-boundary audit — 2026-09-17

The [acceptance contract](../../../docs/reference/ledger-production-acceptance.md#current-closeout--2026-09-19)
supersedes historical statements below that the production incident verifier or
deployed unexpected-loss drill is missing. Recovery grants now bind the exact
scope, original catalog, actual quarantine, reconciled source and approving actor;
incident grants cannot authorize restoration. Authorization is checked again after
archive I/O and before catalog publication. Signing keys and independent evidence
reconciliation remain application/operator responsibilities.

Two isolated deployed drills recovered an active book after unplanned loss,
using actual PITR plus the production signed-authority verifier. Both preserved
130 original outcomes, revocations and the complete projection, rejected old
credentials and accepted the next fresh command. Both failed the unchanged
under-50-ms latency gates. This closes a scoped recovery implementation/evidence
gap, not production activation, a fleet SLO or an independent human audit.

The native accounting evaluator and its helpers no longer import the concrete
SQLite repository. A mechanically enforced boundary and contract tests cover
original receipts, retained rejections, uncertain commits and admission following
asynchronous preparation. The extracted view is still synchronous: asynchronous
database input preparation/maintenance scans remain unfinished. No PostgreSQL
backend, accounting change, alternate recovery engine or new save-path query was
introduced to pretend that limitation is solved.

Local root checks pass with 1,049 ledger tests (one intentional skip), 490 kernel
tests and ten service tests. Ledger SysIDE reports zero diagnostics and all 11
native workflow scopes pass. Kernel certification inputs remain byte-unchanged
from `be4c515`; its mutation score is carried forward, not newly measured. The
[evidence record](../../../docs/reference/reviews/ledger-readiness-2026-09-09.json)
retains cloud report/source hashes, the failed provisioning attempt, measurement
limitations and current local verification.

## Unexpected-loss recovery handoff — 2026-09-17

Implemented the missing ledger-side handoff from an independently authorized,
reconciled incident to the existing bounded native restore and activation protocol.
No kernel or ordinary-save implementation changes. `RecoverUnavailableNativeSource`
and `NativeRecoveryEvidence` model the private authority boundary under existing
PL-011/014/015/016; approval provenance distinguishes control-plane retirement from
an actual source retirement observation. No new general-purpose recovery engine.

Real local workerd tests lose an active primary before maintenance, retirement,
sealing or approval. A separate test-only authority receives a witness captured
from the actual source, authenticates with a different issuer key, and pins the
exact head/projection/access revision. Caught-up R2 replays the original commit and
retained rejection, preserves revocation, rejects stale credentials and admits a
fresh next command. Both a still-warm quarantined owner and cold restart are tested.
An initial audit found activation could depend on eviction of the quarantined
owner; activation now replaces its caches without releasing old queued admissions.

The original fixture was **not a production evidence reconciler**. The subsequent
integration replaces its service binding with `RECOVERY_AUTHORIZATION`, a real
pinned-signature verifier, separate incident/recovery grants and bounded native
source inspection. The application/operator still owns signing keys and must
reconcile all acknowledgements. Neither signatures nor archive progress prove
snapshot completeness. With missing authorization or incomplete R2, recovery stays
unavailable. The original handoff work below was local-only; isolated cloud testing
was subsequently authorized for the production integration. See the current
[acceptance contract](../../../docs/reference/ledger-production-acceptance.md#unexpected-loss-recovery-implementation--2026-09-17)
for the integration contract and remaining activation gates.

At `bea35e6`, `bun run check` passes: 1,045 ledger tests (one intentional skip),
490 kernel tests, nine service tests, type/lint/format/boundary/spec checks, 100%
kernel function/line coverage and 105 requirements with no pending dispositions.
Thirty focused recovery/routing tests pass with 538 assertions. The ledger release
gate passes (zero SysIDE diagnostics and 11 native workflow scopes). No new kernel
mutation run is claimed because its certified inputs are unchanged.

## Operational closeout follow-up — 2026-09-16

The owner confirmed individual-book loss as the initial disaster scope, a future
application-owned issuer with production activation blocked until integration,
and local testing only. The [acceptance contract](../../../docs/reference/ledger-production-acceptance.md)
records those decisions, proposed numerical operating targets and open gates.
No Cloudflare resource was contacted or changed by this follow-up.

Private `archiveStatus(token)` now reports a verified source/archive sequence
difference with bounded reads and no archival or accounting mutations. It requires
maintenance permission, checks persisted revocation before access and after remote
work, and rejects changed control/fence or malformed/missing evidence. It neither
adds work to saves nor claims elapsed-time backup lag, historical payload audit,
restore authority or installed alert delivery. The ledger SysML models this under
PL-012/014; licensed SysIDE validation passes with zero diagnostics.

Focused operational tests pass, including actual local workerd routing and
unexpected active-book loss with both incomplete and caught-up R2. Retained
rejections and revocation state are present before loss; there is no preparatory
retirement/seal/approval. After loss the application correctly refuses blank
provisioning, reads, writes and unapproved restore/activation. This exposes the
remaining recovery authority requirement, not a successful disaster restoration.

The existing local resource profiler now includes a bounded paced multi-book
case with distinct tenant/object identities. At 100 books, 500 accounts each and
100 offered fresh saves/second for 30 seconds, all 3,000 results matched the kernel.
Aggregate CPU was 0.470 cores; native service p95 was 6.313 ms and response p95
including producer lateness was 7.920 ms, at seven SQL statements/save. The sample
includes all observations and excludes oracle verification from timed CPU. It is
one outstanding native call at a time, not a concurrent-client, HTTP/R2, long-term
capacity or deployed-latency certification. The harness retains results, so RSS
is not a per-book memory measurement. Raw report/source hashes and exact figures
are retained in the [measurement record](../../../docs/reference/reviews/ledger-readiness-2026-09-09.json).

At `5a73cee`, the final root check passes 1,026 ledger tests (one intentional crash
child entry-point skip), 490 kernel tests and unchanged 100% kernel function/line
coverage. The ledger release check passes both its SysIDE gate and 11 native
workflow scopes. A repeated 3,000-save paced campaign measured 0.468 cores and
7.913 ms scheduled-response p95. The new profiler smoke case verifies all 200 quick
observations and summary arithmetic; the earlier 18-scenario count was updated to
19 after the gate caught that missing test update. Kernel certification is carried
forward for byte-unchanged source/tests/spec/tooling, not claimed as a new run.

These changes do not modify the accounting kernel. Unplanned-loss return to
service, the unresolved incomplete-backup recovery policy, real issuer/alert
integration and deployed performance/capacity acceptance remain open. Do not
describe this local follow-up as complete production readiness.

## Correctness assurance — 2026-09-16

The full root `check:release` passes at
`be4c515e4271ac2fc70027afcd30d81a81fcb487`, using pinned Bun 1.4.0 and
`MUTATION_WORKERS=8 MUTATION_ALL=1 MUTATION_NO_CACHE=1`. This closes the outstanding
kernel mutation findings and software release recertification for this candidate;
it does not grant production deployment approval. The dated observations below
remain historical evidence, not the current mutation verdict.

The fresh whole-kernel baseline at `5d88ea7` independently reproduced 144
unreviewed survivors: 2,893 kills and 49 existing equivalents across 3,086 sites.
New boundary and lineage tests resolve 119 of those sites as kills; the remaining
25 have individual equivalence arguments tied to the actual surrounding guards.
The review also withdrew ten unsound old exemptions. Regression cases now kill
all ten: exact FX rejection diagnostics, a second prospective allocation revision,
same-revision close-package corruption, hostile array encoding, ASCII/UTF-8 payload
limits, and forged projection predecessor/checkpoint fields. Supplied hash fields
must be checked even when recomputation from the expected predecessor succeeds.

One production repair was required: `resolveJournal` now rejects duplicate posting
ordinals before pairing postings with quantized values. This enforces ACC-018/019;
valid zero-based and noncontiguous ordinals remain supported. Final journal
admission already rejected duplicates, but the public resolver previously could
return an ambiguous resolved transaction. Other changes are tests and reviewed
mutation rationales, not a new accounting feature or a relaxation of release gates.

The final campaign ran from 2026-09-17 03:45:05.708 to 04:05:44.905 UTC
(2026-09-16 locally). All 3,087 mutations were executed live across all 17 discovered
kernel sources: **3,023 killed, 64 individually justified equivalents, zero
unreviewed survivors**. Every site has exactly one verdict; all eight pristine
baselines passed, with no invalid mutants, worker failures or cached verdicts.
The 64 equivalents comprise 39 retained and re-reviewed old entries plus 25 new
entries; they are not counted as test kills. An earlier candidate run was
deliberately stopped after the waiver review found counterexamples; that campaign
failed closed and its score was voided, not reused for certification.

The same root release run also passed:

- 490 kernel tests and 1,016 ledger tests, with no failures. The ledger's single
  skip is a child-process entry point invoked separately by the passing SIGKILL
  parent test, not an unexecuted crash-recovery obligation.
- 100% kernel function and line coverage across 17 sources. This is not a ledger
  coverage percentage or a branch-coverage claim.
- Strict trace: 105 exact requirement IDs, 97 executable bindings, eight boundary
  dispositions and zero design-pending requirements.
- Both licensed SysIDE models with zero diagnostics and working negative controls;
  all 11 native workflow scopes; the 120-cycle ten-year golden replay test.
- Mutation-runner failure-injection self-tests, source restoration, worktree
  cleanup, typechecking, formatting, linting and repository boundary checks.

The new artifact-cardinality test validates coherent 10,000-entry creation and
reduction effects at the source-free integrity boundary. It does not assert that
such an effect fits the separately stricter command-work or transport-byte limits.
Other new cases assert exact ownership amounts, before-image lineage, inclusive
caps, half-open policy windows and rejection diagnostics rather than permissive
"draft or rejected" outcomes.

The [measurement record](../../../docs/reference/reviews/ledger-readiness-2026-09-09.json)
retains the tested revisions, complete report hashes, per-module results and the
ten withdrawn exemptions. Individual remaining rationales are in
`packages/kernel/scripts/mutation-equivalents.json`. Full mutation execution takes
about 21 minutes on this machine and belongs in release certification, not every
interactive save or developer edit.

This is agent-executed engineering assurance for the existing specification and
mutation operator population, not proof of defect absence, independent human
accounting-policy sign-off, or mutation coverage of the ledger implementation.
Unplanned-primary-loss recovery without prior source evidence, production issuer
configuration/deployment, deployed client latency and fleet capacity/cost
acceptance remain separate open production gates. No new deployment was performed.

## Closeout audit — 2026-09-15

### Implementation follow-up: native snapshot handoff and compact outcomes

The existing restore coordinator now accepts native snapshots under the same
independent exact-head seal and projection approval as archive replay. Bounded
steps verify every outcome/hash link and all facts; preparation preserves the
approved authorization revision and revocation events while advancing the writer
fence. No canonical table deletion or command replay is involved. Tests cover
corruption, gaps, shorter heads, stale revocations/fences, interrupted verification,
rollback/lost replies at handoff, and a second recovery of an already restored book.
The ledger SysIDE model still has zero diagnostics. The final pinned Bun 1.4.0
repository check passes: 999 ledger tests (one intentional child-process skip),
460 kernel tests, eight service tests, unchanged 100% kernel function/line coverage
and 105 traced requirements with zero design-pending. This is `check`, not a new
passing `check:release` or mutation certification.

The isolated deployed drill (source fingerprint
`6b8d06c4dea2e9d434e54d64d142d03cdc7cd927a32ee601f18449d31d33c723`)
verified native PITR in 1.274 seconds and direct verification/reactivation in
13.608 seconds for 130 outcomes, versus the previous 77.418-second R2 replay path.
The prerequisite R2 drain-to-seal still took 91.683 seconds; these phases are not
a single 13.608-second recovery guarantee. Original commit/rejection receipt hashes,
revocations, old-writer rejection and a fresh post all passed. Save p95 was 40 ms
book-side and 94.368 ms client-observed: the client gate correctly failed. Four
earlier runs stopped during provisioning at platform code-update resets, before
timed saves. Only that specific setup error is now retried with identical IDs;
the completed run needed one provisioning attempt. Timed saves are not retried.

Lossless versioned SQLite outcome compression keeps canonical hashes and R2 bytes
unchanged and reads old plain-JSON rows without migration. Expanded records and
pages remain bounded at one MiB. The matching 100,000-outcome local workload used
857,022,464 database bytes instead of 1,306,284,032 (34.4% less). Outcome body bytes
fell from 780,762,460 to 249,311,276 (68.1% less). Fresh-commit p95 was 1.824 ms,
maximum seven SQL statements, with all outcome chains, journal arithmetic, SQLite
integrity and sampled retries checked. This is not deployed million-outcome or
multi-tenant capacity evidence; older/newer local timings are not a controlled A/B
experiment. The retained measurement record includes source and raw-report hashes.

This closes the controlled native handoff and storage implementation work, not
production sign-off. Unplanned-loss recovery without prior source evidence, client
latency, larger deployed capacity/cost evidence, production issuer configuration
and the previously unclosed kernel mutation findings remain open. Historical
observations below retain their original scope and are superseded where noted here.

### Prior audit evidence

The audit replaced D02g–i input-ignoring inventory executors. D02g now starts from
a canonically committed acquisition and resolves an independently rehashed hostile
anchor against its real historical position. D02h submits a positive, zero-money
quantity command with an invented posting link. D02i submits an unsupported owned
command version. Actual diagnostics and command deltas are observed; successful
and rejected commands are durably decoded and retried. D01 now also commits the
positive quantity-only case. Controls change quantity, restore the real anchor
budget, remove the fake link and select a supported version. The unchanged strict
trace check passes, but its declaration count alone is not semantic completeness.

The prior mutation generator's default list omitted `current-journal.ts`,
`inventory-ownership.ts`, `inventory-posted-values.ts` and
`owned-inventory-command.ts`. Default discovery and source-restoration self-tests
now cover all production modules, with a regression for those four omissions.
The historical 13-file mutation score must not be described as whole-kernel
certification. The expanded pinned campaign completed at commit `aca8c48` with
3,081 scheduled mutations, eight passing pristine baselines, no invalid/missing
verdicts, 2,876 kills, 49 previously catalogued equivalent survivors and **156
unreviewed survivors**. The release gate correctly failed. Those findings comprise
114 in `inventory-ownership.ts`, 41 in `owned-inventory-command.ts` and one in
`current-journal.ts`; they are not automatically 156 production defects or
equivalents. Exact sites and the complete report's SHA-256 are retained in the
measurement record. Dirty-tree refusal remains enabled.

An isolated deployed Cloudflare run (UTC 2026-09-16, local 2026-09-15) committed
128 genuine saves and retained one rejection in addition to activation. It then
entered maintenance, captured a native PITR bookmark, corrupted a stored outcome,
restored the bookmark and restarted. The digest of the full book, outcomes, facts,
access record and revocation events matched exactly after restoration. Both old
and current credentials received 503 during maintenance. The experiment took
1,137.303 ms including its RPCs and checks. These fault operations exist only in
the expiring, operator-gated acceptance Worker and reject an active book.

This is **native PITR restoration/quarantine evidence, not direct PITR activation
certification**. The drill subsequently used the existing retired-source R2
restore and higher-fence activation, verified original committed/rejected receipt
hashes, rejected the old fence and made a fresh post. Native return-to-service
needs its own verified procedure; no public production rollback route was added.
R2 drain-to-seal took 87.449 seconds and restore/activation/checks took 77.418
seconds for 130 outcomes. This remains small-book evidence.

Warm fresh saves measured 31 ms book-side p95, 49 ms Worker-side p95 and
89.614 ms client-observed p95 (120 samples after the predefined eight warmups).
Per-sample client time outside the Worker had p95 45.765 ms; these percentiles are
not additive and do not establish a unique network/CPU cause. The new client gate
correctly fails the requested sub-50-ms target. No slow samples were discarded.
The complete report is retained in
[the measurement record](../../../docs/reference/reviews/ledger-readiness-2026-09-09.json),
bound to source fingerprint `e43a4f22ed59d82be1cdda874757187eb7354c5f13ddf9d92d2c75bb8200c9d6`.

At `aca8c48`, the repository check passes on pinned Bun 1.4.0: 456 kernel tests,
974 ledger tests (one intentional subprocess-only skip), seven service tests, and
100% function/line coverage across 17 kernel sources. Both licensed SysIDE models
have zero diagnostics, all 11 native workflow scopes pass, and the decade replay
passes. The earlier Bun 1.4.2 checks are superseded by this pinned run.
Production authentication configuration, native reactivation, larger deployed
capacity/cost evidence, the client latency target and mutation finding closure
remain release obligations.

The pinned Bun 1.4.0 recheck passes all 456 kernel tests and both text and LCOV
coverage at the unchanged 100% threshold when run serially. Parallel coverage
passed the tests but exited 1 and reported missing coverage; only the coverage
script is now serial, with a repository regression guard. Ordinary test execution
is unchanged. The expanded mutation self-test also passes on 1.4.0. The complete
release pipeline first stopped at that coverage-runner discrepancy. The repaired
candidate completed every preceding gate and then failed on the expanded mutation
findings above; it did not pass `check:release`.

A follow-up adds 24 before/at/after boundary cases for source and destination
inventory-policy and quantization-policy windows. Twelve valid cases verify
quantity conservation and zero posted budgets; twelve invalid cases verify the
specific policy/quantization rejection and absence of partial effects. The owned
command file passes 35 tests/527 assertions. The follow-up pinned repository check
also passes with 460 kernel tests, 974 ledger tests, and unchanged 100% function/
line coverage. These additional tests do not grant a new mutation score: the
retained full report is explicitly for `aca8c48`. A scoped 193-mutation rerun at
`c60837d` subsequently verified 164 kills and 29 unreviewed survivors in
`owned-inventory-command.ts`, with eight passing baselines and no invalid/missing
verdicts. It kills 12 of that module's previous 41 survivors. The remaining 144
sites from the expanded audit have not been closed by this evidence. This is not
a recalculated whole-kernel score; both reports remain separately identified.

The larger local WAL/FULL probe retained 100,000 outcomes (90,000 commits and
10,000 rejections, plus activation), with all chain links, journal arithmetic,
SQLite integrity and sampled retries checked. Fresh-save p95 was 2.601 ms,
maximum seven statements, and the final 100 observations had p95 1.706 ms.
One observation exceeded 50 ms. Process CPU averaged 1.329 ms/outcome; this is
not Cloudflare CPU billing or a multi-tenant capacity guarantee. A short mutation
tooling self-test overlapped the beginning, so this is not an isolated performance
comparison with the earlier 10,000-outcome run.

The database used 1,306,284,032 bytes. `dbstat` attributes 860,065,792 bytes to
outcomes and 444,510,208 to facts; logical outcome/fact bodies account for
780,762,460 and 159,997,719 bytes respectively. The command-identity index is only
2,166,784 bytes. This makes retained representation and duplicated projections a
material capacity issue, not a demonstrated need to change database providers.
Do not claim million-outcome/decades-of-retention capacity from this measurement.
The summary, source hashes and raw report hash are retained in the measurement
record. No encoding migration, compression or retention deletion was performed.

## Production readiness and full release gate completion — 2026-09-12

**Superseded by the 2026-09-15 closeout audit above.** The mutation campaign listed
here covered 13 of 17 production modules, and the three inventory rejection
executors did not exercise their supplied fixture inputs. These historical
results are not whole-kernel mutation certification or production approval.

All monorepo release gates, kernel v1 requirements, native ledger workflows, and
the kernel mutation gate have been fully satisfied and verified:

1. **Kernel Mutation Adequacy (`mutation:check`)**:
   - Evaluated all 2,184 scheduled mutants across all 13 production source files
     in `@rastrata/kernel` using parallel isolated git worktrees.
   - **100% mutation adequacy achieved**: 2,135/2,184 mutants killed, 49 individually
     justified equivalents catalogued in `mutation-equivalents.json`, and 0 surviving mutants.
   - The mutation gate self-test (`mutation:self-test`) verified all fail-closed guarantees
     (worker crashes, missing/duplicate verdicts, baseline failure, timeout handling,
     untested mutant detection, clean worktree pruning).

2. **Semantic Requirements Trace (`check:trace --require-complete`)**:
   - 105 exact SysML requirements traced.
   - 97 executable test bindings, 8 boundary dispositions, and **0 design-pending requirements**.
   - Completed the implementation and dual-oracle verification for all three inventory
     requirements (`ACC-039.2`, `ACC-039.4`, `ACC-039.5`).

3. **SysML Formal Verification (`check:syside`)**:
   - Syside model diagnostics pass with **0 errors, 0 warnings, 0 information, 0 hints**
     across both `packages/kernel/spec/rastrata-accounting-backend.sysml` and
     `packages/ledger/spec/rastrata-production-ledger.sysml`.
   - Valid, syntax-error, and unresolved-reference controls all verified.

4. **Code Coverage (`test:coverage` & `coverage:check`)**:
   - `@rastrata/kernel`: **100% function coverage and 100% line coverage** across all 17
     production sources, verified across 439 unit tests and 117,746 assertion calls.

5. **Ledger Unit & Integration Suite (`packages/ledger test`)**:
   - 973 passed tests, 1 intentional subprocess test skipped, 0 failures across 63 files
     and 94,220 assertion calls.
   - Includes full SQLite WAL persistence, R2 outcome archival, same-identity restore,
     fencing, and crash-recovery verification under miniflare/workerd.

6. **Native Ledger Workflows (`check:native-workflow`)**:
   - All 11 native workflow suites verified with 0 failures:
     - Open-item and close/reopen workflow (7 outcomes, 29 facts)
     - Partial-payment conservation (5 outcomes, 35 facts)
     - Deferred payment conservation (7 outcomes, 35 facts)
     - Tax workflow (3 outcomes, 21 facts)
     - FX and next-day reversal recovery (10 outcomes, 45 facts)
     - Consolidation 100% ownership (2 outcomes, 16 facts)
     - Consolidation 80% ownership (2 outcomes, 20 facts)
     - Owned inventory acquisition and issue with carrying value (3 outcomes, 46 facts)
     - Owned inventory quantity-only acquisition and issue (3 outcomes, 36 facts)
     - Allocation lifecycle version 1.0.0 (9 outcomes, 53 facts)
     - Allocation lifecycle version 1.1.0 (9 outcomes, 53 facts)

7. **Long-Horizon Consistency (`test:slow`)**:
   - Decade golden book operation (`ten-year-golden.test.ts`) completed 10 years of
     monthly cycles, closures, corrections, and identical deterministic replay.

8. **Monorepo Health**:
   - Clean typechecking across all packages (`tsc -p tsconfig.json` in `@rastrata/kernel`,
     `@rastrata/ledger`, `@rastrata/ledger-dev`, `@rastrata/ledger-service`).
   - Clean Biome linting (`--error-on-warnings`) and dependency-cruiser boundary checks (264 files).
   - Clean Biome code formatting (210 files checked, 0 fixes needed).
   - Tooling tests passed (28 tests covering repository architecture, boundaries, and formatting).

## Deployed acceptance and remaining release boundary — 2026-09-09

The isolated `rastrata-ledger-acceptance` Worker now runs the actual production
book/catalog adapters against Cloudflare SQLite and R2. Its operator-only fault
routes are absent from the production entrypoint and its HTTP access expires.
The [recorded evidence](../../../docs/reference/reviews/ledger-readiness-2026-09-09.json)
includes completed 18- and 130-outcome controlled-loss drills: exact committed/rejected
receipt replay, same-identity restoration, higher-fence activation, old-credential
rejection and a fresh post after recovery. The 128-save run measured 120 warm
commits at 36 ms book-side p95 and 73.109 ms client-observed p95. Its scheduled
archive drain through exact sealing took 209.772 seconds; restore/reactivation
and post-recovery checks took 61.696 seconds. These are small-book measurements,
not unplanned-loss recovery or acceptable large-book recovery/capacity evidence.

The follow-up bounds independent immutable payload uploads/reads to four concurrent
jobs, joining every active job on failure and keeping control publication and
canonical replay ordered. Existing sixteen-outcome/one-MiB limits are unchanged.
The separate 128-save recheck measured 35 ms book-side warm p95 and 68.620 ms
client-observed p95. Scheduled drain through sealing fell to 76.797 seconds
(2.73 times faster than the preceding run); restore/reactivation and its checks
still took 60.344 seconds. There is no demonstrated restoration improvement.
One preceding attempt aborted during provisioning with
`acceptance_operation_failed`, before measured commits; its underlying cause
was not established and it supplies no successful acceptance evidence. The
record includes that aborted attempt as well as the completed recheck.

The acceptance harness now enforces strictly sub-50-ms warm fresh-commit book-side
p95 instead of merely printing a successful recovery result alongside arbitrary
latencies. It requires the complete ordered fresh-save population, excludes only
the predefined first eight warmup commits, and rejects missing/empty/non-finite
duration headers. Client-observed latency remains a separate measurement, not a
sub-50-ms client guarantee. Exact boundary and slow-tail negative controls pass;
recalculation of all three retained deployed reports reproduces their statistics.
This harness change has not itself been redeployed. Future reports automatically
retain drain-to-seal timing and each recovery step's phases and elapsed time;
failed latency gates retain the report but exit unsuccessfully.

Deployed testing exposed issuance-clock skew and non-simultaneous configuration
rollout. The authorizer now permits one second of early issuance, with strict
expiry and unchanged revocation/fencing; exact boundary tests pass. The harness
waits for gateway/book/catalog key convergence before provisioning, uses the real
scheduled alarm instead of competing manual deliveries, and confirms source
deletion is durable before aborting. An abort before confirmed deletion left the
original source intact; the restore installer correctly refused to overwrite it.

The separate 10,000-command local SQLite WAL/FULL run committed 9,000 commands and
retained 1,000 rejections. Fresh-commit p95 was 1.583 ms, maximum seven SQL statements
(excluding authorization), with all outcome-chain links and journal arithmetic
checked. The database occupied 129,949,696 bytes (77,841,561 raw outcome-body bytes;
SQLite facts and indexes account for most of the remainder). This demonstrates neither
million-outcome capacity nor Cloudflare CPU cost. Backup/restore throughput,
unplanned-loss recovery, three inventory kernel dispositions, full release/mutation gates and
reviewed production configuration remain open; these scoped passes do not close them.

ACC-038 now has live semantic bindings and native/full-kernel evidence for retained
source identity, forged-reference rejection, copied storage and exact cold retries.
The current trace reports 94 executable bindings, eight boundary dispositions and
three pending inventory requirements (105 total). Kernel coverage remains 100%
functions/lines across 425 tests; workspace typechecks and both licensed SysIDE
models pass. Historical four-blocker counts below refer to earlier checkpoints.

The subsequent full `bun run check` completed successfully: 973 ledger tests
passed (one intentional subprocess-only test skipped), 425 kernel tests passed,
and the unchanged kernel function/line coverage gate passed at 100%. The ledger
suite took 746.52 seconds, mostly covering earlier indexed/snapshot adapters as
well as the native implementation. The later acceptance-harness changes passed
all six service tests, service typechecks, root lint/boundaries, formatting and
`git diff --check`. `packages/kernel`'s actual `check:release` command still exits
unsuccessfully at the three design-pending inventory requirements; slow tests and
mutation checks were not reached by that command. Do not rerun the broad baseline
merely for another documentation update or treat it as release certification.

## Native controlled recovery and activation — 2026-09-08

Platform integration now lives in `apps/ledger-service`: the Worker verifies signed scope
before routing, the book object rechecks physical identity and persisted access,
and cold owners obtain authority from the separate catalog. Only command, outcome
and authorization HTTP routes are exposed; provisioning and recovery use private
service-binding RPC. Existing outcome serialization, queues, alarms and restore
logic are reused. The adapter introduces no identity provider or signing key.

The local workerd integration test now executes 58 assertions through those actual
service bindings: isolated tenants, matching full-kernel receipts, conflict/retry,
revocation and cold restart, permanent retirement, exact R2 sealing, source approval,
primary database loss, bounded restore interrupted by runtime replacement, and
higher-fence activation followed by retry and a fresh posting. It also rejects
blank reprovisioning after loss at fence zero and stale restore-control tokens
after a later revocation. Destructive fault methods exist only in the test subclass.
An integration failure exposed Cloudflare's RPC disposal metadata at an exact-field
validator; the trusted platform adapter now materializes returned structured data
before handing it to the unchanged accounting validation.
The routing audit also reproduced an unsupported-content-encoding bypass: the
Worker stripped `Content-Encoding`, causing an otherwise invalid request to post.
It now forwards that body metadata to the existing fail-closed HTTP boundary;
the regression returns 415, then the unencoded command commits exactly once.

The full repository check passed before the latest targeted source-identity and
media-header repairs. Subsequent checks passed all 420 kernel fast tests with
100% function/line coverage, all 66 native SQLite repository tests, and the actual
service integration above. Native FX and settlement cases now use genuinely
committed delimiter aliases, compare exact full-kernel outcomes and retained
bytes, and retry through reconstructed owners under both execution profiles.
The strict trace gate still reports four design-pending requirements. Neither
passing structural coverage nor these local tests is a release certificate.

This closes local platform integration, not release approval. The checked-in
Worker configuration fails closed without application issuer/public keys, and no
production deployment was performed. Four pending kernel requirements, unplanned
primary-loss recovery without prior source evidence, full release/mutation gates
and deployed performance/capacity/cost acceptance remain open.

Controlled restore approval now includes the retired source's complete fact
count and domain-separated digest, obtained through authenticated owner RPC and
persisted in the separate catalog. A checksummed resumable scan reads at most
32 facts/one MiB of bodies per call. Byte-limited short pages are not mistaken for
end-of-stream, and oversized first records fail rather than disappear. The digest
binds full identity/head and each ordered fact's exact body, mutability and origin
sequence. Every source scan step rechecks retirement and current authorization.

After exact command replay, the unavailable target scans its actual persisted
facts and must match that independent count/digest. Its intermediate `verified`
state is not an activation certificate. Tests reject missing/extra/rehashed facts
and changed origin sequences while the financial head stays unchanged; they also
cover checkpoint rollback/lost replies, source authorization revocation, bounded
large rows and actual workerd replacement/database loss. The latest focused run
passes 152 tests/5,409 assertions; workspace types, lint/boundaries, formatting,
licensed SysIDE and native accounting workflow checks pass. Ordinary authorized
saves still use eight SQL statements; this scan adds no save-path work.

Activation now creates **prepared** access at the approved higher fence and
source authorization revision, atomically with local restore evidence. Prepared
access denies public writes, reads, retries and revocations even under stale
routing. The catalog verifies actual book evidence, resumes only the exact sealed
R2 frontier, then CAS-activates. Only observing that durable catalog result permits
local access activation. No financial rows, identities, hashes or sequences change.
Rollback and lost acknowledgements reconcile each local/archive/catalog stage;
historical activation retries cannot reset subsequent postings or revocations.
The actual workerd drill replaces the runtime after a lost catalog activation
reply, verifies prepared access is unavailable, activates, replaces it again,
rejects old credentials, replays an original command and accepts a fresh posting.
Its writer-fence configuration remains explicit test setup, not a production
gateway bootstrap implementation or a deployed readiness certificate.

Production routing/issuer integration remains open. Source fingerprints
are evidence from controlled retirement, not invented post-loss observations:
unplanned primary loss before that evidence exists is not certified by this drill.
The four kernel blockers, production gateway and deployed workload acceptance
remain open. No full repository release/mutation certification is claimed here.

## Native bounded restore installation — 2026-09-08

`NativeLedgerCatalog.approveRestore` now retains the authenticated operator's
approval of the exact sealed cutoff by durable CAS. `NativeLedgerRestore.step`
uses that configured independent catalog read, never a request-supplied permit.
One step scans a single manifest or replays at most sixteen outcomes/one MiB.
SQLite retains only ordered manifest references and one checksummed progress
record, not another copy of all archived outcome bodies. Every scan follows the
sealed reverse chain to genesis; replay runs forwards through the native kernel
path and compares exact encoded committed/rejected outcomes and scope-bound heads.

This installer accepts empty canonical storage only, preserves all identity/hash
bytes, rechecks approval/seal, reconciles rollback/lost acknowledgements and keeps
ordinary provisioning disabled. It never deletes existing book data. The test-only
Worker simulates loss of its disposable database, restarts actual workerd owners
between steps and checks every original outcome and projection after replay.
Local accounting fixtures also compare against full-kernel outcomes for allocation,
tax, FX/reversal and paid/quantity-only inventory histories.

Verification at this checkpoint: 134 targeted tests, 4,849 assertions, zero failures;
workspace types, lint/boundaries, formatting, ledger model checks, licensed SysIDE
and the native accounting workflow gate pass. The existing authorized-save test
still asserts eight SQL statements. The full repository release/mutation campaign
and deployed performance acceptance were not rerun or certified by these checks.

The terminal state is deliberately **replayed**, not an activation certificate.
Independent complete-projection/activation evidence, replacement access state and
archive/catalog reactivation remain open, along with production gateway wiring,
four pending kernel requirements and deployed release acceptance. Earlier catalog
records without the new closed `restore` field are not silently migrated. This is
still an unreleased candidate, not a compatibility or production-readiness claim.

## Same-identity recovery and writer capabilities — 2026-09-08

The existing `RestorePermit` contract specifies in-place recovery under the same
book identity. Recent native notes incorrectly required a new physical generation;
that would force rehashing the scope-bound outcome chain and duplicating its archive.
That proposed direction is superseded. Native recovery must preserve full book
identity, canonical outcome bytes/hashes and R2 archive location, replacing only the
writer incarnation under an independently approved higher fence. The stopped writer
does not resume. New-book provisioning cannot substitute for this recovery protocol.

Book capabilities now require a signed `writerFence` in addition to identity and
authorization revision. The existing bounded access read checks it. A retired
writer may finish maintenance under its original fence; after replacement, old
read, execute, provision and maintenance capabilities cannot become valid again,
even if access revisions coincide. Missing/noncanonical fence claims are rejected,
not interpreted as zero. Issuers must supply this mandatory claim; this is a
pre-production capability contract change, not a backward-compatible fallback.
Blank provisioning is restricted to writer fence zero as well as initial generation
zero. An empty store at a higher fence must restore instead of silently creating
an empty replacement book. Catalog activation also checks the actual book-reader
writer fence, not just its identity, genesis and accounting revision.

The targeted test models a completed higher-fence control transition at the same
identity: old capabilities fail, a freshly signed capability retrieves the exact
original result, and every retained outcome row/head remains byte-for-byte unchanged.
It is a boundary test, not evidence that the restore installer exists.

Next implementation: catalog-approved exact-seal recovery with durable bounded
scan/replay progress; verify complete history/state while unavailable; then confirm
the higher-fenced local writer and matching archive/catalog authority before
serving it. No automatic empty-book fallback, reset of the selected cutoff, or
caller-provided readiness flag is acceptable. Physical relocation/export is a
separate workflow and is not needed for initial production recovery.

## Native exact-head archive sealing — 2026-09-08

The native catalog now selects the R2 seal at the actual retired source head.
Archive lag fails explicitly; it never lowers the approved cutoff. Sealing checks
the selected manifest and original genesis, conditionally advances only the fence
and status, verifies exact control readback, then persists that observation by
catalog CAS. A lost R2 reply retries from the already sealed pointer, and a lost
catalog reply returns the same retained mutation. Neither opens a replacement.

The seal binds full source identity/genesis/head/fence and the R2 body, nonce and
storage revision. A late publisher loses its old conditional update. Full archive
inspection can now take the expected seal; it verifies that exact control before
and after traversal. A same-body rewrite still invalidates the old selection.
Sealing verifies the frontier, not every historical payload or accounting replay;
that remains mandatory before writable restoration.

Once the source is durably retired and its actual head matches the final R2 seal,
its alarm exits without rescheduling futile uploads. An unexpected fence on an
active owner, different stopped head, missing data or uncertain reads still fail
and retry. The real workerd drill drains the retired tail, loses the catalog seal
reply, restarts, reconciles the same seal and verifies the final alarm is consumed
without another retry. Local race tests cover a publisher paused while another
relay finishes the tail and the catalog seals it.

This uses the existing R2 conditional-write transport and one catalog record;
ordinary accounting saves add no SQL or R2 work. The sealed-cutoff-to-replacement
installer and conditional new-generation activation remain incomplete, as do
production gateway wiring and deployed acceptance. No release sign-off is claimed.

## Native provisioning and retirement catalog — 2026-09-08

`NativeLedgerCatalog` applies the existing separate-object catalog/CAS convention
to native platform-confirmed books, without reinterpreting archive-required indexed
manifests. It stores one bounded control record and an independent revision, not a
second outcome log. Reservation pins genesis and generation-zero identity; retries
cannot reset active or maintenance state. Missing existing rows and co-located
ledger storage fail closed.

Activation calls the configured trusted book port. The authorized owner checks its
actual sole committed activation, requires an existing archive reservation, delivers
that activation and reconfirms the original head and authorization. The catalog
compares source identity/genesis, then CAS-activates only its original reservation.
No request-supplied readiness flag or integrity hash can substitute for that port.

Maintenance first stops routing, then retires the source under the persisted
quiesce operation identity. It retains the source archive fence until the final
prefix can drain. The next fence and actual stopped head are persisted only after
the source confirms retirement. A source reply loss leaves pending maintenance;
a catalog reply loss reconciles the already persisted transition. Neither permits
reactivation. This native sequence is explicitly separate from the older
archive-required maintenance protocol, which fences archive publication first.

Tests cover CAS races, rollback, both uncertain acknowledgements, contradictory
rehashes, missing archive/catalog state, and exact retries. The local workerd drill
uses separate catalog and book Durable Objects plus R2, replaces the runtime after
each lost reply, and verifies the original source remains retired. The harness has
fixed fixtures and fault switches and is **not** the production gateway. Routing
and approver authorization must still be wired to real application authority.

The remaining recovery work is to seal the complete final native archive, persist
an approved cutoff, verify replacement staging, and conditionally activate its new
generation. The current native catalog cannot yet perform that cutover or authorize
unavailable-source recovery. These tests do not certify full production readiness.

## Native durable writer retirement — 2026-09-08

The authorized owner now permanently retires a physical generation through the
same serial queue and SQLite transaction boundary as saves. Its control record
binds the actual stopped head, actor, request identity and incremented fence;
accounting outcomes and facts are unchanged. Retirement is idempotent, including
after a lost durability acknowledgement. A retry compares the receipt to the
actual accounting head, not merely a caller-supplied or internally rehashed value.

Retired owners reject financial reads, new writes, activation and old command
retries after restart. Control-plane revocation and internal final archive draining
remain possible without reopening the writer. Public blank provisioning cannot
initialize a replacement generation. Old experimental access schemas require
explicit migration; no authority is inferred or backfilled. The control check uses
the existing access read, keeping ordinary authorized saves at eight SQL statements.

Unit tests cover queue ordering, rollback, lost acknowledgement, owner replacement,
corrupt control state and rehashed false cutoff evidence. The local workerd test
restarts after an uncertain retirement, refuses the old HTTP requests, then runs
the durable alarm to archive the final stopped prefix without another outcome.

This is a cutover prerequisite, not production recovery certification. Retirement
has no public HTTP route. A trusted coordinator still must bind catalog routing,
the sealed archive cutoff and verified replacement activation. Rewinding the whole
object also rewinds its local control state; an independent authority is required
to reject that stale writer. Unavailable-source disaster recovery remains open.

## Native durable archive alarms — 2026-09-08

The authorized native ledger now accepts explicit backup bindings and owns its
archive relay/alarm on the same repository queue as commands. Alarm arming happens
inside that queue, before atomic publication; an archive page cannot observe an
empty backlog between arming and commit. R2 operations remain outside the queue.
Scheduling failure prevents new outcomes (including retained semantic rejections),
but exact previously retained retries still return their original receipt. Fence
and authorization checks run after asynchronous arming, before financial reads.

The alarm cache contains only a successfully scheduled deadline and is invalidated
on delivery/restart/expiry. Concurrent arms coalesce; delivery invalidates a stale
in-flight observation. Saves preserve earlier deadlines. A handler processes at
most eight batches (128 small outcomes / 8 MiB maximum) and reschedules backlog or
CAS conflict within one second. Waiting the initial 60-second batching interval
between every batch would have unnecessarily limited delivery to 16 outcomes per
minute; that behavior was removed before acceptance. Failure reschedules another
opportunity without relying solely on the platform's finite automatic retries.
The handler never deletes a timer that a concurrent command might have armed.

Tests verify the arming/commit race, unavailable and uncertain alarm storage,
retained retries, authorization expiry, fence change while awaiting arming, warm
alarm-call coalescing and prompt bounded backlog scheduling. The real workerd test
uses SQLite and native R2 bindings: the deadline persists across replacement,
posting succeeds during an injected R2 outage, actual alarm dispatch schedules a
retry, and recovery archives exact commands without advancing accounting Oseq.
Warm raw saves remain seven SQL statements (eight with authorization); a warm
scheduled alarm adds no alarm-storage calls. Cold arming needs actual alarm reads
and sometimes a write; deployed latency and billing still need measurement.

This follows Cloudflare's [alarm API contract](https://developers.cloudflare.com/durable-objects/api/alarms/).
The delay is a batching configuration, not a production backup-lag or zero-RPO
promise. Catalog-authorized archive initialization, writable fenced recovery,
production gateway routing and operational acceptance remain required. The Worker
used here is a local test harness, not a production deployment.

## Native asynchronous archive delivery — 2026-09-08

`NativeOutcomeOutbox` now delivers the actual native SQLite outcome log through the
existing R2 transport. The old indexed outbox and archive-required catalog remain
unchanged; their manifests and acknowledgement policies cannot be reinterpreted
as this native platform-confirmed format. No duplicate SQL payload queue or R2
network call was added to saves.

Each native manifest publishes a contiguous batch of at most 16 outcomes and
1 MiB of outcome bytes. Payloads remain individually content-addressed; a batch
needs one additional immutable manifest and one conditional control update.
The two-outcome test measures four PUTs, versus six for the older per-outcome
manifest/control pattern. This is an operation-count comparison, not measured
Cloudflare billing or a production FinOps certificate. R2 read-back verification
and control reads still contribute operations. Large valid records split batches
without skipping a command; no 1,000-outcome lifetime cap was inherited.

Initialization is explicit and reserved for future catalog-authorized provisioning.
An ordinary drain never recreates a missing control pointer. The native pointer
binds active/sealed status, fence and exact head. Concurrent publishers reconcile
through conditional replacement; lost acknowledgement retries start from durable
R2 state. A publisher paused during upload loses to a higher-fence seal. This
prevents stale archive publication, not yet stale canonical ledger writes under
a production catalog—native cutover integration remains required.

Reverse-batch inspection verifies every immutable payload and manifest edge to
genesis with bounded memory, then checks that its selected pointer stayed stable.
The independent test consumes these batches with the primary unavailable, replays
commands through the full kernel, and compares exact receipts, financial state and
protocol state. Inspection alone is not accounting replay, an approved recovery
cutoff, a rollback detector outside the primary account or a writable restore.
Idle drains intentionally do not certify historical backup health.

Six tests (43 assertions) pass against local Miniflare R2: exact reconstruction,
retained rejections, bounded large-record batching, concurrent CAS, uncertain
publication, higher-fence conflict, missing control/payload and false links.
A fresh native command commits while an upload is deliberately stalled, sharing
the same repository queue. Native ledger hashes and kernel semantics are unchanged.

Next is durable alarm integration inside native command serialization, followed
by catalog-authorized fenced restore and real gateway wiring. The existing SysML
requires arming before publication without letting an alarm read between arming
and commit; arming outside the owner queue would leave a lost-wakeup race.
Cloudflare's [alarm contract](https://developers.cloudflare.com/durable-objects/api/alarms/)
also requires preserving existing deadlines and explicitly rescheduling after
failures because automatic retries are finite. These integration obligations are
not discharged by the relay tests. No deployment, zero-RPO promise or production
readiness is claimed.

## Native command HTTP transport — 2026-09-08

`NativeLedgerHttp` accepts actual caller commands through the authorized native
ledger; no fixed fixture or synthetic actor exists in this production module.
`rastrata-book-command-v1` is a closed command-only subtree of the existing kernel
codec. It preserves bigint/rational values, rejects foreign/extra envelopes and
checks canonical framing within 1 MiB. Decoding is not accounting admission or
input-hash authority; the kernel still evaluates the command. Retained outcome
formats and prior command semantics are unchanged.

The transport authenticates before reading a body, limits active uploads to 16,
enforces UTF-8 byte bounds while streaming and stops stalled uploads after ten
seconds. It does not cancel already admitted accounting work when a client loses
its response. Receipts explicitly serialize observedBookRevision as a decimal
string; paged exports use existing exact outcome envelopes. Client JSON key order
does not alter cursor identity. Internal storage failures return a generic 503,
without SQLite text, credentials or financial payloads in errors.

Local workerd now executes a caller-supplied encoded journal through this handler,
compares its result hash to the full-book kernel oracle, and verifies the exact
original receipt after a second runtime replacement. HTTP tests additionally cover
semantic rejections, reads, revocation, malformed/corrupt/oversized input, foreign
cursors, upload saturation, timeout/abort and redacted storage errors. The complete
kernel suite passes 418 tests / 62,312 assertions with 100% line/function coverage.
No mutation or full-release recertification follows from that coverage result.

This completes the scoped object-side command transport, not the deployed service:
trusted gateway routing/issuer configuration, native R2 delivery/fenced recovery,
kernel closure requirements and deployed latency/cost acceptance remain open.
The local Worker is still a test harness; it must not be deployed.

## Native signed authorization boundary — 2026-09-08

`AuthorizedNativeLedger` owns one native repository and its existing bounded queue.
The application remains responsible for membership and role decisions; it issues
short-lived book capabilities, not arbitrary login JWTs. `BookAuthorizer` verifies
ES256 signatures with pinned issuer/audience/public keys using `jose` 6.2.12 and
WebCrypto. Tokens bind tenant, book, physical object, namespace, generation, actor,
permissions, expiry and authorization revision. Untrusted key URLs, extra claims,
unknown keys and forged in-process contexts are rejected. The default lifetime is
five minutes, configurable up to fifteen minutes; per-book revision revocation
invalidates existing tokens before their expiry. This uses the conventional
[JOSE verifier](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)
and [local public-key set](https://github.com/panva/jose/blob/main/docs/jwks/local/functions/createLocalJWKSet.md),
not a custom signature scheme or a new user/role database.

Admission rechecks expiry and persisted revision on dequeue, inside the same
synchronous SQLite transaction as accounting work and after any durability wait.
This precedes financial reads, including retained retries. Access changes have a
separate monotonic revision and idempotent audit event, committed atomically without
changing accounting Oseq. Retrying a lost revocation acknowledgement requires a
fresh capability at the current revision. Existing raw books cannot be implicitly
adopted with revision-zero access metadata. Restores must establish current access
authority in the new fenced generation; financial replay alone is insufficient.

Ten focused tests (111 assertions) cover signatures, closed token shapes, all scope
fields, permissions, actors, expired and revoked queued requests, corrupt/missing
authority, atomic control rollback, lost replies and genuine workerd replacement.
Restart preserves both old-token denial and exact original financial receipts for
freshly authorized retries. An authorized ordinary save uses eight SQL statements:
the existing seven accounting statements plus one bounded access-revision read.
This is a SQL work count, not a deployed latency or cost measurement.

The Worker in `test/runtime-authorized-ledger-worker.ts` is a private local harness
with fixed accounting inputs and test-only fault injection. It is not a production
gateway, token issuer, public command transport or R2/fenced restore integration.
Those integrations and deployed acceptance remain open. No production readiness,
complete security certification or kernel requirement closure is claimed here.

## Native owned inventory — 2026-09-08

The native candidate now admits owned-command 1.2.0 acquisition, issue and
transfer through shared kernel preparation. The complete active account/commodity
pool comes from a partial SQL index and is reconciled with retained pool identities
and live counts. Depleted positions and all historical identities remain retained;
they are not repeatedly scanned for selection. Immutable lots, anchors and movement
after-images authenticate current sources. Lot deltas, positions, counters, money
balances, permanent references and outcomes publish in one transaction.

The prospective 1.2.0 contract uses active pools; older versions keep their original
depleted-row work bounds. New-zero provisioning explicitly rejects existing stock.
Because this native profile has no legacy/unowned lot writer, it cannot silently
adopt unowned balances. Managed-scope markers and original command ownership block
generic journal/correction bypasses. Source-reference identities also cover earlier
non-inventory accounting records. Quantity-only movements advance the accounting
date without advancing posting sequence, and shared configuration admission and
historical validation now enforce that date boundary.

This follows the active-position idea visible in Beancount's
`beancount/core/inventory.py` (zero positions are removed from its active map) and
the transactional remaining-lot updates in Bigcapital's
`InventoryCost/commands/StoreInventortyLotsCost.service.ts`. Rastrata retains its own
immutable identity/history requirements and batches native SQL writes; neither
reference establishes our correctness or a performance guarantee.

Verification includes full/current exact outcomes, paid penny conservation,
quantity-only transfers, close/reopen and retained rejection replay, cross-family
reference conflicts, generic correction rejection, SQL rollback, lost durability
replies, actual workerd restart and complete staging comparison. Missing origins,
pool members/counts or the index fail closed; staging detects a rehashed false
counter. Forty real free-acquisition/issue cycles retain 120 depleted holdings:
warm SQL stays at 10/12 statements respectively. A local run measured p95
6.63/20.74 ms over 39 fresh samples of each command while compatibility tests ran
concurrently. This is not deployed latency, business-scale capacity or cloud cost
certification. Active-pool reads currently cap at 10,000 rows and 1 MiB per result;
larger reads fail explicitly without discarding history.

The candidate profile is `native-book-commands-owned-inventory-v1`; prior native
profiles lack complete source-reference indexes and require explicit verified
migration, not implicit adoption. Legacy adoption, provisional/value-adjustment
integration, four pending kernel requirements, native authorization, R2/fenced
recovery and deployed acceptance remain open. No production sign-off is implied.

## Native exact money scopes — 2026-09-08

Native journal publication now maintains exact signed functional balances per
book/account/commodity/dimension tuple in the same transaction as its outcome.
Permanent scope identities distinguish a new zero balance from a lost counter.
An ownership-created managed marker survives depletion; these derived projections
do not themselves authorize inventory. Generated journals batch their scope reads
with posting identities, preserving the seven-statement ordinary save and
eight-statement tax/consolidation limits. No history scan was added to warm saves.

The new experimental profile `native-book-commands-money-scopes-v1` refuses
earlier books without these complete projections. No automatic backfill, deployed
migration, or production compatibility certification is provided. A verified
explicit replay/migration is required before such a book can use the new profile.
Native inventory commands remain disabled pending their ownership/pool integration.

The scoped suite passes 73 tests / 3,890 assertions, including workerd restart,
process termination, missing-counter rejection, scope isolation, old-profile
rejection and staging detection of an internally rehashed false balance.
415 kernel tests / 62,279 assertions pass with 100% function/line coverage.
Typechecking, lint/boundaries, formatting, bounded models, licensed SysIDE and
native workflows pass. Four kernel requirements remain design-pending; native
authorization, R2/fenced recovery and deployed acceptance are not certified.

## Owned-inventory delta contract — 2026-09-08

Explicit owned-command version 1.2.0 emits `lotChanges`: new lots and exact
touched-holding after-images, together with the existing ownership effect and
any real journals. Shared full/current preparation uses the same accounting
rules. Unmentioned rows and legacy allocations remain unchanged. Older command
versions retain their snapshot effects and original bytes; mixed snapshot/delta
histories replay in either direction. Restoration reexecutes ownership admission
and folds each effect rather than trusting a final snapshot or rehashed quantity.

Tests verify penny conservation, zero-journal movements, transfers, full/current
effect equality, strict codecs and rejection of internally rehashed fabricated
stock. One new acquisition has identical delta bytes with 1 or 100 untouched
retained lots: one lot row, one holding row, under 2,000 bytes. This measures the
effect payload only, not total source reads, save latency or production capacity.
415 kernel tests / 62,278 assertions pass with 100% line/function coverage.
The five-file compatibility run passes 95 tests / 13,860 assertions; the final
legacy-boundary test additionally checks that attribution cannot certify deltas.
Typechecking, lint/boundaries, bounded models, licensed SysIDE, native workflow
and decade-soak checks pass.

The ordinal-index prototype cannot safely apply the new format: projection,
snapshot import and source locators explicitly reject it before publication;
its attribution audit reports `requiresReview`. Existing-version conformance
remains tested, and the new boundary has an executable rejection test rather
than being silently omitted. **NativeLedger does not yet admit inventory.**
Authenticated bounded pool/ownership reads and atomic delta publication are next.
No SQL performance claim, legacy-adoption permission, requirement closure or
production certification follows from this contract change.

## Shared dependent-close admission — 2026-09-08

`prepareBookReopen` now rejects an earlier reopen while a dependent current close
still owns a closing journal. The command can reverse only its own target's
journal, so monetary dependent periods must be reopened latest-first. Nonmonetary
dependent packages can still be superseded. This implements the existing
ACC-029/032 obligation without another execution profile or storage mechanism.
The native-only service-error containment described in the September 7 checkpoint
below is removed: both full and current-state evaluators now return the same
retained `invalid_correction_topology` rejection at `command.periodId`.

The regression checks unchanged financial state on rejection, exact latest-first
closing/reversal conservation, safe nonmonetary supersession, and original result
hash/diagnostics on retries after owner reconstruction and after the book has
been successfully reopened (the protocol marks retries `replayed`). The full
kernel suite passes 410 tests / 62,154 assertions with 100% function and line
coverage across 16 production sources. Native SQLite, workerd runtime and indexed
book-change suites pass 75 tests / 9,911 assertions. Typechecking, lint/boundaries,
formatting, bounded design checks, licensed SysIDE, the native workflow gate and
the decade soak pass. These are local scoped checks, not renewed production or
mutation certification.

Restoration validates reopen effects by calling the same preparer against the
pre-revision state, including then-current close packages and period transitions.
A test constructs an internally rehashed unsafe proposal from omitted dependent
evidence; both topology validation and authoritative commit reject it.
Historical successful outcomes of the unsafe sequence are not grandfathered or
silently rewritten. Recovery must verify them under the repaired rule; any such
book requires explicit investigation. Safe retained histories and fixtures remain
unchanged. The inventory inspection also confirms that the legacy owned command
still emits a whole `lotState` snapshot: using it directly on the native warm-save
path would reintroduce historical work. Native inventory admission and its bounded
canonical representation remain open; this period repair does not close those
four pending kernel requirements or the production authorization/recovery gates.

### Journal-free settlement period repair

The remaining native-only period containment is also removed. All settlement
forms now resolve their effective date through `prepareBookSettlement`, even when
claiming a preposted payment with no new journal. Legacy new-payment commands use
the settlement date; later applications use their own application date. Historical
effect validation reruns this same preparation against the pre-revision state for
every settlement variant. A correctly hashed then-closed allocation is rejected.
Safe histories retain their bytes; unsafe histories require investigation.

The regression verifies a USD 100 journal-free allocation, rejection while closed,
exact retry after restart and later reopening, successful allocation with a new
command identity, SQL rollback, lost durability reply and complete staging-copy
verification. Current scoped results: 411 kernel tests / 62,175 assertions and
100% line/function coverage; 69 native SQLite/workerd/process tests / 3,855
assertions. Typechecking, lint/boundaries, formatting, bounded models, licensed
SysIDE, workflow and decade-soak gates pass. No new storage query, execution
profile, release claim or production deployment is introduced.

## Native consolidation — 2026-09-08

The native target-book path now admits consolidation through the same kernel
preparer as full-book execution. It checks the supplied subsidiary revision and
population pins, policy mappings, translation, eliminations and ownership/NCI
arithmetic, then publishes compilation identity, journal and outcome atomically.
It neither reads nor mutates a subsidiary book: obtaining trustworthy source
snapshots remains the upstream service's responsibility. Missing current identity
evidence throws; stale pins and duplicate compilation identities retain the same
kernel rejection. Original retries precede fresh accounting reads.

The source audit fixed delimiter collisions between distinct raw book/account
coordinates, source-posting uniqueness incorrectly applied across different books,
and ambiguous textual sorting ties. Internal lookups use tuples; tied legacy sort
keys use a deterministic tuple comparison. Unambiguous historical fixture outputs
remain unchanged. Previously ambiguous histories require verification, not silent
rewriting. ACC-046.3/.5 explicitly describe book-scoped source identities; this is
one repair toward ACC-038, not closure of that still-pending parent requirement.

Tests independently check a USD 50 subsidiary at full ownership and 80% ownership:
the latter retains USD 40 parent equity and USD 10 NCI. An explicit correction and
replacement compilation leave group cash at USD 50, not USD 100. These are separate
book commands, not an implicit atomic report refresh; applications must publish
their report at the selected completed revision. SQL rollback, lost acknowledgement,
workerd replacement, immutable retry and complete staging-copy comparisons pass.

Verification: 409 kernel tests / 62,129 assertions and 100% functions/lines over
the gate's 16 production sources; 69 native/runtime/process tests / 3,847 assertions;
19 indexed-source compatibility tests / 9,581 assertions; decade soak / 21 assertions.
Both ownership variants are mandatory native release workflows (2 outcomes each,
12/14 compared facts). Types, lint/boundaries, formatting, bounded models, semantic
trace and both licensed SysIDE models pass. Fresh local recompilation samples use
8 SQL statements and about 1.7–2.4 ms. These small-group in-memory samples do not
certify large consolidation capacity, deployed latency, authorization or recovery.
Four kernel requirements still block full release; native inventory/lots and the
remaining production security/recovery/capacity obligations remain open. No commit,
push, deployment, mutation recertification or production sign-off is claimed.

## Native currency persistence — 2026-09-08

This checkpoint supersedes the earlier native-FX-disabled status below. The native
command path now admits currency and monetary-classification policies, exact FX
results and linked reversals through the shared kernel preparer. Canonical journals,
result/reversal identities and active-position projections publish atomically.
Partial SQLite indexes contain active positions only; a unique source index also
prevents two active results for one canonical posting. Due lookup selects the first
publication under the current selected policies. Settlement batches active-source
lookups and FX consumes the existing authenticated invoice/payment counters.

The follow-up audit reproduced a separate double reversal: generic journal
correction could negate an FX result, then the typed FX command could negate it
again. Full and current kernel admission now reject generic correction of both
currency-result and currency-reversal journals. Restoration topology enforces the
same restriction. Native correction authenticates its original journal against
the originating canonical outcome, costing one additional bounded read. Valid
currency histories retain their canonical bytes; unsafe histories are not silently
rewritten. This does not certify every other accounting-family correction path.

Verification passes: 407 kernel tests / 62,101 assertions with 100% functions and
lines across the coverage gate's 16 sources; 68 native SQL, workerd restart and
process-crash tests / 3,797 assertions. Cases cover both required-reversal orders,
optional policy, renamed-source stacking, exact invoice/payment counters, missing
canonical evidence, SQL rollback, lost acknowledgements, old retries and staging
copy. The mandatory FX workflow replays 10 outcomes and compares all 37 facts.
Types, lint/boundaries, formatting, bounded models, trace and both licensed SysIDE
models pass. Four kernel requirements still block the full release gate.

Fresh local measurement/reversal samples use 14/16 SQL statements and about 2–3 ms;
these are individual in-memory samples, not deployed latency percentiles. Deferred
payment uses 12 statements at both zero and 1,000 previous applications: the one
added batched FX read does not grow per invoice. A SQL query-plan test with 10,000
inactive synthetic positions proves indexed selection rather than a retained-fact
scan; this is not a 10,000-command end-to-end accounting capacity certificate.
Idempotent provisioning installs the additive indexes. Missing indexes cause
failure, never a history-scan fallback. No deployment, mutation recertification,
commit, push or production approval is claimed. Full production acceptance and
the remaining command/security/recovery obligations remain open.

## Shared currency preparation and overdue reversal repair — 2026-09-08

Full-book and current-state FX execution now use one kernel preparer for exact
arithmetic, canonical monetary source balances, permanent effect identity,
generated-journal admission and exact original-journal reversal. The current
boundary requires explicit allocated-value/quantity, active-position, retained
result/reversal and original-journal evidence. Missing observations cannot become
zero balances or absent positions. Retry resolution precedes fresh currency reads.

The audit also reproduced a deadlock: with two overdue required reversals, the
other position blocked either reversal. A valid explicit reversal now discharges
one obligation independently; ordinary measurements and commands remain blocked
until all due obligations are discharged. Invalid reversal targets still reject.
ACC-043.5 records this liveness requirement, and semantic bindings include both
the shared preparer and the overdue predicate. Regression evidence executes both
orders on the following accounting day, checks exact negated postings and durable
round-trips, and verifies ordinary work resumes only after both reversals.

Verification: 407 kernel tests / 61,756 assertions, 100% lines and functions over
the gate's 16 production sources; 151 indexed-ledger tests / 12,897 assertions;
56 native SQL/runtime tests / 3,555 assertions; the strengthened standalone
deadlock regression / 50 assertions; decade soak / 21 assertions. Full/current FX
comparisons cover successful effects and revisions, rejected diagnostics and
retry priority. Workspace types, lint/boundaries, formatting, bounded models,
semantic trace and both licensed SysIDE models pass. The minimum native workflow
gate passes; this is not the complete root production release gate.

Native FX remains disabled pending bounded SQL source/current-position reads,
global overdue lookup, durable immutable result/reversal records and atomic
projection publication. No empty evidence defaults will be retained when enabling
it. Four kernel requirements still block release; mutation, production deployment
and operational acceptance are not recertified by this scoped checkpoint. Source
fingerprints and test scopes are in the existing
[evidence record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json).

## Currency source authority repair — 2026-09-08

Before enabling native FX, the source audit reproduced two kernel defects:
remeasurement deducted invoice allocations but not payment allocations, and a new
reference ID for the same posting could hide an active unrealized adjustment.
The first rejected a valid remaining-payment valuation because it still compared
against the full posted balance; the second admitted application before reversal.
The failing controls are retained in the expanded accounting-book tests.

Remeasurement now deducts exact allocated value and quantity on both source sides,
using each canonical posting's signs. Immediate, later and mixed applications
consume one payment budget. Source occupancy and active adjustments use the raw
book/journal/effect/posting tuple, not the independently named reference's hash.
Both payment and open-item sources must have active adjustments reversed before
settlement. There is no new accounting mode or replacement currency calculator.

Tests cover receivables/payables, gains/losses and offsetting differences under both
identity profiles. A half-consumed EUR 100 payment carried at USD 120 leaves EUR 50
and USD 60; a 1.40 rate changes its magnitude by USD 10, not USD 20. Mixed 50% + 25%
applications leave a USD 5 change. Stale values and renamed-reference stacking or
application reject; exact reversal permits the remaining application. Complete
durable round-trips validate the resulting histories.

This repairs previously unsafe admission, not canonical bytes: valid retained
fixtures remain byte-identical in the regression suite. A previously admitted
history violating these source invariants must fail semantic recovery and be
investigated, not silently rewritten or accepted as correct. Historical release
claims cannot certify this repair. ACC-043.4 and its executable bindings now make
the two-sided source obligation explicit.

Verification and final source fingerprints are in the existing
[evidence record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json).
Native FX is still disabled: bounded source/current-position reads, result/reversal
indexes, global overdue-reversal admission and atomic publication are the next
implementation work. No full production release, mutation recertification,
deployment, commit or push is claimed.

## Native deferred payment lifecycle — 2026-09-08

The existing `applySettlement` command now has explicit `recognizeUnallocated`
and `allocateExisting` request variants. Omitted operation preserves legacy
new-payment semantics and encoded bytes. Later applications require the exact
retained payment and complete prior value/quantity totals; they publish only new
allocation edges and any genuine realized-FX journal, not another payment or source
owner. Supplied replacement payment journals are rejected. Each later application
has an open-period date, including a zero-journal application, and advances the
prospective configuration watermark. Original payment date and carrying basis
remain unchanged. Full-kernel three-currency receivable/payable tests also verify
later-period gain/loss entries; native currency policies remain unsupported.

The adapter atomically maintains both payment and open-item totals alongside
immutable edges and retained outcomes. Missing totals or ownership fail closed
without recording a business rejection. Experimental native payments created before
payment totals existed require verified restaging, not an assumed zero balance.
Two competing applications against different invoices cannot spend the same payment.
Reconstructed owners and workerd replacement preserve original retry receipts.
Correctly hashed but overspent kernel histories fail semantic restoration checks.

The audit additionally reproduced a frozen legacy loophole: a new settlement
with a preposted source and no generated journal could apply after its period
closed. Native publication now refuses that otherwise admitted commit as
`native_ledger_legacy_settlement_period_requires_reopen`, using already-read
period facts. It adds no SQL query. No incompatible semantic rejection is retained.
A regression proves unchanged head/outcome, success after authorized reopen,
original retry after reclose, and complete staging replay. Historical kernel
receipts remain unchanged; this containment is not closure of the legacy defect.

D05 now executes actual canonical book commands rather than only a calculator:
two payments, four allocation edges, four revisions, two payment journals and
literal $0/$50 invoice remainders. D06g attempts to reuse the exhausted retained
payment and checks the actual rejection, unchanged state and zero revision/sequence
deltas. Semantic bindings include shared command admission and period resolution.
The mandatory native release workflow independently checks one $100 payment,
later $40/$60 applications, over-allocation, retries and staging:
**7 outcomes / 28 verified facts**. The earlier new-payment workflow now verifies
**5 outcomes / 28 facts**, including its new payment-total projections.

Fresh local applications use **11 SQL statements**, both before and after
**1,000 prior applications** of that same payment. Isolated samples were **1.56 ms**
and **0.99 ms**. These are in-memory Bun SQLite single samples, not deployed
Cloudflare percentiles, storage-durability timing or one-core fleet capacity.
The pinned Bigcapital credit-application service at `7883ad07` independently
illustrates the relevant convention: validate remaining credit and invoice budgets
and publish application edges in the same transaction. Rastrata uses exact rational
budgets and one serialized book transaction; it does not copy floating-point money.

Both licensed SysML models pass with zero diagnostics. Current measurements,
test results and source hashes are recorded in the existing
[evidence record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json).
Four kernel requirements remain pending; native FX/inventory/consolidation,
trusted authorization, R2 delivery/fenced restore, deployed acceptance and full
release/mutation recertification remain open. This is scoped implementation evidence,
not production sign-off. No deployment, commit or push occurred in this recheck.

## Native settlement publication — 2026-09-08

New payments now use shared kernel preparation for exact open-item conservation,
posting-source ownership/direction, dated source checks, journal admission and
realized-exchange calculation. Full-state and current-state tests compare exact
results, including multiple supplied journals and same-command identity conflicts.
Native admission still excludes currency policies; the shared FX implementation
does not imply that native currency support is finished.

The native adapter batches actual open items, permanent allocation identities and
source candidates. Exact allocated carrying value, quantity and count are mutable
projections, published atomically with immutable allocation edges, settlement,
source ownership, journals, revision and outcome. Recognition initializes totals;
missing totals on an existing item fail closed rather than imply zero. Older
experimental native books without that projection require verified restaging before
payments; no implicit history migration was introduced.

Local fresh payments touch **10 / 11 / 28 SQL statements** for **1 / 10 / 100
invoices**, with ten invoices still requiring **11** after **1,000** unrelated
entries. Latest single samples were **1.42 / 4.23 / 31.45 ms**, and **3.64 ms** for
ten invoices after history. These are
local in-memory SQLite measurements, not remote durability percentiles or fleet
capacity evidence. Ordinary journal saves remain on the existing bounded path.
Source reads are bounded by requested candidates and byte limits, not book history.

Tests cover $40 + $60 against a $100 item, over-allocation, competing $60 payments,
source reuse across payment/open-item roles, missing counters, every write-stage
rollback, lost durability replies and actual workerd replacement. Multiple journals
publish and close in posting-sequence order; close buffers at most one outcome's
existing **1,000-fact / 4 MiB** limits, never the whole history. Staging replay
compares outcomes and every projection. The mandatory payment workflow retains
**5 outcomes / 26 verified facts**; recognition plus period maintenance now retains
**7 outcomes / 24 facts**, including its initialized allocation counter.

The pinned Bigcapital credit-application service validates locked credit/invoice
rows and inserts application edges within one transaction. We follow that atomic
conservation convention, without copying its numeric representation. Its reuse
of an existing credit remains important: later allocation of an unused settlement
balance is still an explicit kernel contract/release gap, not permission to create
a second owner for the same payment. Remaining native command families,
authorization, R2 delivery/fenced restore and deployed acceptance are also open.

Verified: **404 kernel tests / 60,285 assertions**, unchanged **100% lines and
functions**, **83 focused ledger tests / 9,475 assertions**, decade replay,
workspace typechecks/lint/formatting, bounded model checks and both licensed
SysIDE models with zero errors/warnings. Measurements and source fingerprints are
recorded in `nativeSettlementRecheck` in the existing
[evidence record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json).
The full release/mutation campaign was not rerun; the four kernel pending
requirements remain pending. No deployment, commit or push was performed.

## Native open-item recognition — 2026-09-08

Open-item recognition now runs shared kernel preparation on the native path.
It preserves canonical source resolution (including legacy alias winners),
recognition-date/amount checks, permanent open-item identity and single financial
source ownership. The immutable source-owner index stores the complete tuple and
owner identity; its hash is a bounded lookup key, not a substitute for those
checks. Its owner record must exist and match. Journal, open item, ownership
index, revision and retained outcome publish in one SQLite transaction.

Tests compare full-kernel receipts under both source identity profiles, roll back
each write stage, lose the durability reply, reconstruct owners and verify staging
replay. A dangling ownership index fails without retaining a result. Fresh saves
use at most ten SQL statements, with the same count after 1,000 unrelated journals;
ordinary saves remain unchanged. Real workerd replacement tests preserve the
original receipt and admit a fresh recognition after restart. These are local
correctness and bounded-work checks, not deployed latency or capacity proof.

The mandatory minimum workflow includes recognition plus close/reopen:
**7 outcomes / 23 verified facts**. This does not admit settlement application or
claim completion of the unused-credit/payment lifecycle described below. The four
pending kernel requirements and production release blockers remain open.

Verification: **404 kernel tests / 60,212 assertions**, unchanged **100% function
and line coverage**, **49 focused ledger tests / 2,379 assertions**, four kernel
tooling tests, workspace typechecks, lint/boundaries and formatting pass. Both
licensed SysIDE models report zero errors/warnings; bounded model checks and the
native release workflow pass. No full mutation recertification or deployed test
was performed for this slice.

## Settlement source-authority review — 2026-09-08

Before admitting native open items and payments, an executable audit reproduced
two kernel defects. New open-item IDs could claim one canonical control posting
twice, while an unrelated second journal changed the actual control balance.
New settlement IDs could allocate one historical $100 payment for $200 across
two receivables without another payment journal. Both histories previously
passed semantic state validation. These were accounting-authority failures, not
performance or presentation issues.

Admission and semantic restoration now enforce one financial source owner
(open item or settlement) per raw canonical posting tuple, independently of
reference IDs. Cross-family relabeling cannot create another allocation budget.
Duplicate attempts retain a rejection without financial effects. Existing valid
histories and source-resolution profiles are not rewritten; previously unsafe
duplicate-owner histories must fail semantic restoration rather than be repaired
silently. `settlement-source-ownership.test.ts` asserts exact control balances,
allocated totals, diagnostics and absence of extra journals.

Settlement conservation also has a shared typed read context for exact prior
allocated value/quantity and permanent identities. The full-history adapter
computes these totals from real canonical allocations. The native adapter is not
yet wired: no sparse full-book state or fabricated prior totals are admitted.

Verification: **404 kernel tests / 60,176 assertions**, **75 focused ledger tests /
9,309 assertions**, unchanged **100% functions and lines**, typechecks, bounded
models and both licensed SysIDE models with zero
errors/warnings. A correctly hashed unsafe history is rejected for its duplicate
source owner, not for checksum damage. Mutation and complete production release
recertification remain outstanding; the four pending kernel requirements have not
been relabeled as complete.

Remaining payment design work is explicit: later allocation of unused payment
or credit value must reuse its original settlement authority and conserve the
remaining balance. It must not work around the new guard by creating another
settlement owner. Its effective accounting date, closed-period admission and
realized-FX treatment need an explicit executable contract before native sign-off.
The pinned Bigcapital `CreditNotesApplyInvoice/commands/CreditNoteApplyToInvoices.service.ts`
locks the existing credit and target invoices and inserts application edges in
one transaction; it does not manufacture another credit identity per application.

## Native allocation lifecycle — 2026-09-07

Creation, recognition and revision now use shared kernel preparation and actual
command-scoped observations. This includes legacy and cumulative-cent schedules,
successors, impairment/termination rules and atomic disposal completion. Permanent
schedule/ordinal indexes and a checked lifecycle counter replace full-book reads.
Revision verifies the bounded complete installment set; deleted required records
or index entries fail without a retained outcome. Legacy delimiter-alias winners
are preserved by indexed candidate reads, not silently changed to structural IDs.

Disposal's two journals now publish atomically. Close sorts only the at-most-two
journals in each publication group by posting sequence. Tests deliberately give
the second journal a lexically earlier ID, inject rollback at each write stage,
lose the durability reply, restart, close and compare staging projections.

The 1,200-installment test exposed a combined projection batch limit. Individual
records already fit; batching now preserves **1 MiB per escaped SQL batch** and
**4 MiB total escaped fact projection**, inside the same transaction. Ordinary
saves still use one batch and at most seven SQL statements. A second-batch fault
rolls back all participants; total-byte and record-count limits remain enforced.

Recognition uses **13 SQL statements** at 1, 120 and 1,200 installments, and the
same count after 1,000 unrelated entries. Latest local single samples were
**1.32 / 6.71 / 49.39 ms**, with **6.44 ms** for the 120-installment history case.
These are not percentile estimates, remote durability or fleet-capacity evidence.
The maximum schedule has little margin under 50 ms and needs deployed measurement.
Bounded schedule/plan decoding still costs time; book history is not scanned.

Verified: **402 kernel tests / 60,142 assertions**, **100% functions and lines**,
**47 focused ledger tests / 2,313 assertions**, workerd replacement, decade replay,
typechecks, lint/boundaries and licensed SysIDE (zero errors/warnings).
The mandatory release workflow now includes both allocation algorithms:
**9 outcomes / 42 verified facts each**. The complete repository regression run
subsequently passed: **858 ledger tests / 90,776 assertions**, one intentional
crash-child skip, and **25 repository tooling tests**. This was allocation-slice
evidence; subsequent settlement changes require their own verification.
Kernel release remains blocked on the four pending requirements; mutation was not
rerun. Source fingerprints and measurements are in `nativeAllocationRecheck` in
the existing [evidence record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json).

The pinned Beancount `ops/summarize.py` explicitly positions generated entries
relative to existing entries: generated-journal order is semantic, not an ID sort.
Bigcapital's tenant chart seeds include the conventional depreciation expense
account. These are reference checks, not imported algorithms or evidence that
either project validates our durable protocol.

Other native command families, kernel closure, gateway authorization, native R2
delivery/fenced restore and deployed acceptance remain open. No deployment,
commit or push was performed for this slice.

## Native tax admission and batching — 2026-09-07

The native path now admits `postTaxedTransaction` and tax-policy snapshots.
Shared kernel effect identity/hash admission and generated-journal preparation
preserve existing canonical results; the ledger does not repeat tax arithmetic or
construct a partial legacy book. A tax determination owns its new same-command
journal, so this path needs no historical posting-source population. Other
specialized policies remain refused, preserving the explicit absence of overdue
FX and managed inventory observations.

Generated posting identity reads are batched: tests with **1, 10 and 100 lines**
(up to **102 postings**) each use **8 SQL statements / one transaction**. Tests
compare exact native/full-kernel receipts and separate known-value arithmetic for
inclusive/exclusive purchases, sales and credits. Identity collisions, closed
periods, incomplete observations, rollback, lost acknowledgements, workerd restart
and staging replay are exercised. The mandatory native workflow gate now includes
tax: **3 outcomes / 15 verified facts**, alongside the existing period workflow.

Verification: **402 kernel tests**, unchanged **100% function/line coverage**,
**71 focused ledger/tooling tests / 1,219 assertions**, decade replay, typechecks,
lint/boundaries, formatting, bounded models and both licensed SysIDE models pass.
The full legacy-ledger suite and mutation campaign were not rerun for this slice.
All four pending kernel requirements remain pending.

A fresh 10,000-command ordinary-save recheck still uses at most **7 SQL statements**:
9,000 genuine commits have local p99 **3.59 ms**, maximum **5.69 ms**; 1,000 retained
rejections are measured separately. Full staging replay compares **10,001 outcomes /
27,008 facts** in **16.82 seconds**. This is not tax latency, remote replication or
a one-core capacity claim. See `nativeTaxRecheck` in the existing
[measurement record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json).

The pinned Bigcapital reference also resolves transaction tax metadata with bulk
`whereIn` queries in `modules/TaxRates/ItemEntriesTaxTransactions.service.ts`;
the useful convention here is batched transaction inputs, not copying its numeric
representation or tax policy. Remaining production work is unchanged: other
native command families, kernel repair closure, trusted authorization, native R2
delivery/fenced restoration, and deployed acceptance. No deployment changed.

## Native period lifecycle and audit — 2026-09-07

Native close/reopen now uses shared kernel preparation. It preserves canonical
close packages, exact optional closing/reversal journals, dependent-close
supersession, retries and reconstructed-owner results. Close streams the existing
canonical journal-cutoff hash; ordinary saves do not scan history or accumulate a
growing header. The first close atomically evolves the legacy immutable `open`
period fact. Subsequent status and close-count updates commit with the outcome,
immutable package/transition and optional journal. Failure rolls everything back.
Maintenance reconciles close-package counts against the current period counters;
a missing package cannot masquerade as permission to omit its reversal.

The mandatory minimum native workflow now **passes: 7 outcomes, 21 verified
facts**, superseding the failure reported below. Tests also cover two periods,
closing journals, exact reversals, missing history, immutable-row upgrade abuse,
all publication fault boundaries, lost durability replies and local workerd
restart. The kernel's unchanged 100% function/line gate passes across 16 sources
with 401 fast tests; the decade golden replay test passes. These are scoped
implementation and self-audit results, not independent release approval.

The complete ledger package run passes **846 tests**, with one intentional crash
child skip and no failures (**721.75 s**). The subsequent current-source native
run, including the dependent-close containment added during the broader audit,
passes **36 tests / 956 assertions**. Tooling/model-fixture/development-harness
checks pass **31 tests**. Typechecks, lint/boundaries, formatting, bounded model
checks, both licensed SysIDE models and non-closure trace checks pass. The initial
direct test invocation used Bun's default 5-second timeout and was aborted;
the complete result uses the existing package command's 60-second setting,
without changing the gate. Full mutation and production acceptance remain
uncertified. Raw logs are `/tmp/rastrata-goal-{ledger-final,native-final,tooling}.log`.

**Inherited kernel defect contained, not silently repaired:** an earlier reopen
can supersede a later close with a closing journal. A subsequent legacy reopen
then finds no current package and commits without reversing that journal. The
native regression reproduces both legacy commits and the stranded posting. Native
publication refuses the unsafe earlier reopen as the unretained service error
`native_ledger_dependent_close_requires_reopen`; reopening/reversing latest-first
passes with exact kernel results and zero residual from the closing/reversal pair.
Historical receipts are unchanged. Arbitrary-order reopen remains unsupported;
this containment must not be reported as complete kernel repair.

The final local WAL/FULL run retains 9,000 genuine journal commits and 1,000
rejections plus activation: genuine fresh-commit p99 **3.93 ms**, maximum
**32.39 ms**, mean process CPU **1.19 ms**, at most **7 SQL statements**.
Retained rejections are separated (p99 **3.14 ms**); retries are not timed as saves.
Full staging replay and
comparison of 10,001 outcomes / 27,008 facts takes **18.64 seconds**. A separately
timed subsequent close of those 9,000 journals takes **255 ms / 10 statements**
and matches the independent legacy array-hash oracle. Closing is linear
maintenance work, not an ordinary-save latency result. These measurements ran on
an unrestricted multi-core host alongside regressions; they do not establish
remote latency, large-book close capacity or a one-core production envelope.
Source fingerprints and raw-sample digest are in the existing
[evidence record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json)
under `periodLifecycleRecheck`.

Still open: specialized native accounting commands; the four explicit kernel
pending requirements; trusted production tenant/user routing; native asynchronous
R2 delivery and independently authorized fenced restore; deployed performance,
capacity and release recertification. The legacy indexed relay is not implicitly
compatible with native outcome hashes. No production deployment changed.

## Native admission and readiness recheck — 2026-09-07

The repository's unbounded Promise chain has been replaced with bounded FIFO
admission: 16 active-plus-waiting operations, and 5 seconds maximum queue wait by
default. Operator overrides are bounded to 1–1024 operations and 1–60,000 ms.
Expired waiters are removed immediately, and their monotonic deadlines are checked
again at dequeue. Already-started operations retain serialization until durability
settles; timing out a waiter never invents an accounting rejection or consumes an
identity. Tests hold actual SQLite durability replies, expire/retry queued commands,
exhaust capacity, and revoke book authority before queued reads. This is repository
backpressure, not complete tenant/user authorization or a replacement for gateway
admission. No production deployment changed.

The release pipeline previously checked the ledger's model but did not require
a native business workflow. `packages/ledger` now has a `check:release` command
that also runs `check:native-workflow`. Its full-kernel oracle first establishes
exact outcomes for activation, posting, close, closed-period rejection, reopen,
posting and reclose. Native execution must match retained bytes across owner
reconstruction and retries, then pass staging projection comparison. The gate
currently **fails at `closePeriod (first-close)`**, not at a fabricated fixture
or an expected-rejection assertion. It is a necessary minimum acceptance case,
not proof of specialized accounting, authenticated routing, R2 restoration or
deployment readiness. Those obligations remain open even after it passes.

Two new 10,000-command runs retain 9,000 genuine journal commits and 1,000 semantic
rejections, plus activation. Local SQLite WAL/FULL save p99 is **3.12 ms**, maximum
**5.10 ms**, at most **7 SQL statements** per save. Staging replay verifies all
10,001 outcomes and 27,008 facts in **19.88 seconds**. Local Workers dispatch p99
is **5.11 ms**, maximum **16.35 ms** after process readiness; process startup plus
the first request reaches **70.88 ms**. Both ran alongside regression tests on an
unrestricted multi-core host. They do not establish remote durability latency,
production SLOs, all-command capacity or an under-one-core service envelope.
Raw sample hashes, source fingerprints and limits are retained in the existing
[evidence record](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json)
under `boundedAdmissionRecheck`.

Verification: the full ledger run passed **841 tests**, with one intentional
crash-child skip and no failures (744.85 s). A subsequent focused run includes the
additional queued-authority test: **31 tests / 828 assertions** pass, including
local Workers restart tests. The kernel passes **398 tests** and the unchanged
100% function/line gate across 16 sources. Repository/kernel tooling and the
development harness pass **33 tests**. Typechecks, lint/boundaries, formatting,
bounded model checks and both licensed SysIDE models pass. Kernel trace remains
93 executable bindings, 8 boundary dispositions and 4 design-pending requirements.
Both package release commands fail for real open obligations: the native close
workflow and the four kernel requirements. Full mutation/soak and deployed
production acceptance have not been recertified. Raw logs for this pass are
`/tmp/rastrata-readiness-{ledger,native-final,coverage,tooling-final,ledger-release,release}.log`.

## Native Cloudflare development verification — 2026-09-07

The existing `rastrata-ledger-dev` Worker and `SyntheticBook` SQLite namespace were
confirmed through the account API. An additive migration creates `SyntheticNativeBook`;
the original namespace ID and its three-outcome head/aggregate remain unchanged.
No namespace was renamed/deleted, and no plan, DNS or R2 changes were made.
The native path is now exercised on real Cloudflare, **only through the authenticated,
expiring, no-customer-input development harness**, not a production application API.
See the [deployment procedure](../../../docs/how-to/deploy-development-ledger.md).

The native scenario retains activation, a $100 journal, and an unbalanced-journal
rejection. A separate fixed single-save endpoint adds one $100 follow-up journal;
subsequent calls only retry it. The two books retain seven outcomes total. The
native pending queue is bounded to 16, rechecks access after queueing, and refuses
expired/invalid expiry at the storage boundary. Local tests cover failure cleanup,
unauthorized direct-object calls, payload refusal, concurrent saves, original retries,
runtime replacement and tampered response negative controls. The verifier compares
exact stored command/result/revision bytes against direct full-kernel execution,
recomputes every scoped native chain edge and checks preservation of the first three
outcomes. Two successive deployment rounds verified persistence after replacement;
this does not establish forced object eviction, crash or disaster recovery.

The first genuine single-save HTTP observation was **127.07 ms**, above the owner's
50-ms target. Its post-redeployment retry measured **213.89 ms**. The earlier whole
scenario took 539.25 ms initially and 222.63 ms on retry; these include several
commands/provisioning and must not be described as individual-save latency.
Five subsequent interleaved diagnostic cycles through the DEN edge measured gateway-only
health at **12.46–127.90 ms** and exact native retries at **36.65–55.82 ms**. This
demonstrates some non-ledger overhead, not the cause of all save latency, a server-only
measurement, or a passing production SLO. No fresh-save percentile, business-sized
cloud capacity, aggregate CPU or multi-client load claim is made from this tiny sample.

[Evidence](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json), under
`cloudflareDevelopment`, preserves actual deployment versions, namespace IDs,
heads, timing samples, source fingerprints and raw-log hashes. The full development
check passed (834 ledger tests, one intentional skip; 381 kernel tests and 100%
kernel function/line coverage). The final harness extension additionally passed four
application tests / 63 assertions, workspace typechecks, lint/boundaries and format.
The release gate still refuses ACC-038 and ACC-039.7/.8/.9. Native close/reopen and
specialized command admission, kernel repair closure, production authorization/catalog,
native backup/fenced restore and latency/capacity/release acceptance remain open.

## Native configuration, correction and staging audit — 2026-09-07

The internal profile is now `native-book-commands-v1`: new-zero activation,
journals, prospective configuration changes and exact corrections, without lots
or specialized policies. It does not silently adopt the earlier experimental
immutable-configuration layout. `evaluateCurrentBookCommand` shares extracted
configuration/correction preparation with the full kernel; it does not build a
sparse `BookState` or reimplement accounting rules. Native writes persist complete
configuration snapshots, a monotonic maximum journal date, permanent correction
identities and actual original-period status. Calendar replacement does not erase
that status. Tests compare exact full-kernel receipts after each transition and
recreation, including backdated journals and corrections across calendar replacement.

`verifyNativeLedgerCopy` now reexecutes bounded, gap-checked outcome pages into an
explicit empty staging repository, then compares every current fact, immutable
identity, mutability flag and origin Oseq. Physical scoped hashes differ; canonical
accounting bytes must agree. Tests reject missing intervals, rehashed changed facts,
extra rows, nonempty targets and writes during comparison. Numeric ordering is
tested across multi-digit sequences. This is a **staging verification component**,
not an R2 backup service, independent restore authority, writer fence or catalog
cutover. A failed or partial staging copy must remain unavailable to production.

Actual local Workers runtime tests cover configuration/correction rollback,
lost durability acknowledgement, runtime replacement and original retries.
Four separately built negative controls are killed: ignored projection equality,
lowered date watermark, forced text Oseq ordering and reuse of a nonempty target.
An initial bare `ORDER BY sequence` control survived (SQLite retained numeric
ordering); it is not counted as a kill. Temporary bundles leave source files
unchanged. These controls are **not** a complete mutation score.

Updated measurements are preserved in the existing
[evidence file](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json),
under `currentCommandExtension`, with its own source fingerprint and raw-sample hashes.
The 10,000-command WAL/FULL run (9,000 commits, 1,000 retained rejections) reports
save p99 **2.97 ms**, maximum **7.07 ms**, at most seven SQL statements and exactly
one publication transaction. Mean measured process CPU is 1.10 ms/save, excluding
command construction and other services. Separately, staging replay verifies all
10,001 outcomes and 27,008 facts in **19.88 s** (21.74 s process CPU). This larger
replay workload is ordinary cash journals/rejections, not specialized accounting.
The local Workers 10,000-request run reports p99 **3.82 ms** and maximum **12.30 ms**
after runtime readiness. Test-process startup plus first request reaches **65.89 ms**.
Measurements ran alongside regression work on an unpinned multi-core host; none
proves deployed Cloudflare durability latency, business capacity or whole-service
under-one-core operation. Reproduce with:

```sh
bun packages/ledger/scripts/native-ledger-probe.ts 10000 --verify-copy
bun packages/ledger/scripts/native-runtime-probe.ts 10000
```

The licensed ledger SysIDE check reports zero errors/warnings. The kernel suite
passes 381 tests with 59,704 assertions and retains 100% function/line coverage
across 16 sources. The full ledger invocation passed 833 tests with one intentional
crash-child skip, 89,214 assertions, in 722.91 seconds. The final native rerun,
including the additional end-of-scan race checks, passes 31 tests / 869 assertions.
Workspace typechecks, lint/boundaries, format, both design checks and 32 repository,
kernel-tooling and development-worker tests pass. The release command still fails,
as intended, on ACC-038 and
ACC-039.7/.8/.9; its later soak/mutation stages therefore do not run. Coverage is
not evidence that these unimplemented obligations are complete. The following
historical measurements and regression counts describe the earlier ordinary-only
snapshot, not a recertification of this extension.

Production sign-off remains blocked on complete native command admission (including
close/reopen and specialized policies), kernel repair closure, trusted gateway/catalog
and overload integration, actual asynchronous backup and fenced restore, and deployed
Cloudflare mixed-workload latency/capacity/CPU and release acceptance. No production
route, existing book or live deployment was changed by this extension.

## Native SQL current-state save path — 2026-09-07

The owner's under-50-ms save target cannot be met by the warm indexed bridge below.
The replacement **internal candidate** delegates indexing and atomicity to SQLite:
`SqliteLedgerRepository` owns three tables, `NativeLedger` orchestrates commands,
and `evaluateCurrentJournal` supplies the small mathematical read boundary. One
synchronous transaction reads current facts, evaluates the shared kernel rules,
inserts an outcome and immutable identities, updates current projections, and
advances the head. Delivery waits for `storage.sync()` and a final authority check.
There are no custom index pages, construction pins, or historical hash rebuilds on
this path. The kernel's ordinary journal/intent preparation was extracted, not
independently rewritten; full-state and current-state results are compared exactly.

This deliberately supports only new-zero-balance activation and ordinary/adjustment
journals without lots or specialized accounting policies. Configuration remains at
revision zero. The restrictions are enforced on provisioning and execution, including
after recreation. They are what justify empty inventory/FX observations; they are
**not** a general accounting optimization. No production route or existing book has
been switched to this format. PostgreSQL remains a fallback, not an implementation
target. Other command families must acquire their complete current-state inputs and
atomic projections before they can use it; there is no hidden slow fallback.

### Integrity and recovery boundary

Command IDs are permanent unique SQL keys. Journal/posting identities are insert-only
even against mistaken internal replacement; only explicitly mutable current facts
may be updated. Retained rejections advance Oseq without changing financial facts.
The actual head must match its retained tip (or exact genesis at sequence zero).
Reads validate exact scope, row checksums, source sequence bounds and typed codecs.
Missing required current facts, malformed heads, exceeded limits and unsupported
commands fail closed. Input data is copied before queueing, and transaction read
capabilities expire before leaving the synchronous callback. SQL failure rolls back
all participants; an uncertain acknowledgement is resolved by the original ID.

The new domain-separated head commits the scoped outcome chain, **not** every current
fact and not the old full-aggregate state hash. Native transactionally maintained
indexes/current facts are trusted current state. Untouched historical corruption can
remain undetected until accessed/audited. Checksums cannot prove that a coordinated
database rewrite or rollback did not occur. Bounded reopen reads are therefore not
equivalent to PL-007 full recovery. Production enablement still requires a complete
native accounting/index audit and an independently authorized restore procedure.
The old checkpoint/pin/catalog storage protocol has not been silently reinterpreted.
These limits are explicit in PL-022, L25 and `ExecuteNativeOrdinaryJournal`.

### Measurements

[Evidence summaries and raw-sample hashes](../../../docs/reference/reviews/ledger-native-sql-2026-09-07.json)
cover three final-source SQLite runs and two local Workers runs. Each run executes
10,000 genuine commands: 9,000 cash-sale commits and 1,000 retained rejections, plus
activation and retries. No pre-seeded fake outcomes are used. The SQLite probes
independently verify every outcome-chain edge and every journal's exact known-workload
arithmetic; the first 64 transitions also use the full-state kernel oracle.

| Measurement | Observed result |
| --- | --- |
| SQLite WAL/FULL, three runs, save p50 | 0.86–0.88 ms |
| SQLite WAL/FULL, three runs, save p99 | 2.84–2.97 ms |
| SQLite WAL/FULL, worst of 30,000 saves | 11.00 ms |
| SQL statements / publication transactions | At most 7 / exactly 1 |
| SQLite process CPU per save, three-run means | 1.10–1.11 ms |
| Local Workers HTTP, final run, request p50 / p99 | 1.98 / 3.66 ms |
| Local Workers first DO request after runtime ready, 10 replacements | 10.60 ms median; 11.61 ms maximum |
| Local test-process startup plus first request, final run | 57.42 ms median; 66.38 ms maximum |

The SQLite timer includes input snapshotting, the queue, kernel evaluation, native
SQL and the local FULL durability boundary; command construction is excluded. The
Workers HTTP measurement also includes synthetic command construction, object routing
and actual local `storage.sync()`. The final probe reports test-process startup
separately **and** combined with the first request; it does not discard that cost.
The earlier Workers run included startup in ten requests and reported a 61.06-ms
maximum. These are not remote replication, Internet latency, or all-service CPU
measurements. Parent-process CPU is intentionally not reported for Workers because
it would omit the workerd child. No under-one-core aggregate service claim is made.

Each SQLite book allocated 129,699,840 bytes of database pages plus approximately
2.60 MB WAL and 32 KB SHM before close. Ten thousand outcomes is a measured floor,
not certification of million-outcome capacity, retention limits or enterprise scale.
Raw samples/databases are temporary local artifacts; their exact paths and hashes
are in the summary. Reproduce from the repository with:

```sh
bun packages/ledger/scripts/native-ledger-probe.ts 10000
bun packages/ledger/scripts/native-runtime-probe.ts 10000
```

### Verification and remaining release work

The new native tests cover exact commits/rejections/retries against the full kernel,
rollback at each participant, uncertain durability, competing writers, immutable SQL
identities, corrupted/missing facts, expiry of read capabilities and resource bounds.
Seven subprocess tests use actual `SIGKILL` before and after SQLite commit and compare
the recovered retained bytes. A separate Workers test replaces the actual runtime and
checks atomicity, original retries and concurrent requests. This proves scoped local
behavior, not Cloudflare account-loss recovery. Kernel coverage after extraction is
100% of lines and functions across 16 production sources; mutation closure was not
rerun and is not claimed. Ledger scalar checks and licensed SysIDE pass, including
positive and per-obligation negative cases for native publication.

Final regression results: the full ledger invocation passed 826 tests with one
intentional crash-child skip (89,116 assertions, 719.88 seconds); the final native
focused rerun passed 24 tests and 757 assertions, including the subsequently added
genesis-head corruption case. Kernel tests passed 378 cases; its coverage gate
passed again after formatting. Workspace typechecks, lint/dependency boundaries,
format checks, kernel/ledger design checks, 25 repository tooling tests, four kernel
tooling tests and three development-worker tests passed. The semantic trace remains
93 executable bindings, eight boundary dispositions and four design-pending entries;
neither those pending entries nor the mutation campaign are being claimed closed.

Before enabling this path: complete current-state admission for the remaining kernel
commands; integrate trusted gateway/catalog admission and overload limits; implement
native audit, asynchronous backup and fenced restore end to end; then measure the
deployed Cloudflare path and mixed-business/multi-book workloads against explicit
latency, CPU and capacity budgets. The existing outbox below is not yet connected to
the native format. These are open implementation/release obligations, not optional
documentation or a production-ready verdict.

## Verified warm execution and asynchronous outcome outbox — 2026-09-07

Implemented after the owner approved platform-confirmed saves with asynchronous
R2 archival. This supersedes the recommendation-only status of the section below,
not the remaining release gates. No deployed service or existing stored book was
switched to this internal candidate. No kernel source was changed in this slice.

### Changes and integrity boundary

`IndexedLedgerOwner` retains a verified immutable aggregate after exhaustive cold
recovery or its own confirmed atomic transition. Warm operations require the exact
canonical head, complete index view, authenticated catalog bodies, live authority
and a fresh reader pin. They do not replay the old prefix. Publication still uses
the existing kernel evaluator, atomic conditional publication, durability barrier
and actual newly stored bytes. Exact retries verify actual permanent identity and
retained source evidence, not just the cache. Uncertainty invalidates the session;
external head/view changes require full recovery. Returned aggregate wrappers are
frozen as well as their immutable kernel contents.

This changes damage-detection timing deliberately: untouched historical damage can
remain undetected during warm use until that evidence is accessed, explicit
`audit()` runs, or cold recovery runs. It is not equivalent to a complete audit on
every receipt. PL-007/008 and the indexed bridge action now distinguish those paths;
`WarmSessionIntegrity` has positive and per-obligation negative scalar cases.
These model cases are bounded assertions, not runtime conformance by themselves.

`OutcomeOutbox` reads bounded verified pages of the immutable outcome log, including
retained rejections. R2 contains content-addressed payloads and linked manifests;
a conditional control pointer tracks the contiguous archived prefix. There is no
duplicate SQL payload queue and no archive network call inside the book queue.
The native Workers test harness arms a durable alarm **before** new publication,
preserves the earliest deadline under ongoing saves, and reschedules failed or
unfinished drains. R2 failure does not delay saves; failure to durably arm the
scheduler prevents new publication. Exact retries do not need another alarm.
The scheduling review used Cloudflare's [alarm contract](https://developers.cloudflare.com/durable-objects/api/alarms/):
delivery is at least once, automatic retries are finite, and setting an alarm
replaces the existing deadline. These guarantees motivate explicit rescheduling
and preserving the earliest deadline; they are not proof of our deployment.

Archive inspection verifies manifest edges, scoped payload hashes, genesis and
canonical record chaining. A separate test replays those records through the
kernel and compares the exact full accounting state. Inspection is **not** a
writable restore installer, independent expected-head authority, rollback detector,
or account-loss recovery guarantee. PL-015/016's archive-required protocol is not
silently replaced by this asynchronous backup format. Production lag/loss policy,
monitoring and restore admission remain open.

Normal draining authenticates the latest cursor and new payload delivery, not all
previous archive objects. Historical archive damage is detected by full inspection;
an idle drain is not a backup-health certificate. An existing archive-required
control prefix cannot be reused for this different format.

### Matched measurement

[Raw samples](../../../docs/reference/reviews/ledger-warm-owner-2026-09-07.json)
record three alternating baseline/candidate trials of activation plus eight cash
sales in file-backed SQLite, WAL mode, `synchronous=FULL`. Every receipt was compared
exactly and final state matched an independently executed full-book kernel oracle.
The probe also reopened each book and verified original retry outcomes. It is not
a Cloudflare replication-latency, process-crash, capacity or percentile-SLO test.

| Eighth sale, three-trial median | Before | After |
| --- | ---: | ---: |
| Save latency | 5,731.56 ms | 446.88 ms |
| SQL statements | 10,479 | 1,103 |
| Database page allocation (excludes WAL/SHM) | 634,880 bytes | 634,880 bytes |

That is a 12.8× warm-save improvement and 89.5% fewer SQL statements at this small
head. Candidate cold recovery remained 2.75–3.15 seconds. No large-book claim is
supported. The baseline owner SHA-256 is `1b3e34847a70e6d0487479c3cb421e67ba7630757140b0711c49521318b4793b`;
the measured candidate is `f5e49023da390b0f71872009dca76a39a1c365358b6aa8fc2ec2dd1b0db91d61`.
`scripts/warm-owner-probe.ts` asserts the baseline identity and that candidate
source did not change during measurement. Reproduction needs the preserved
pre-change source tree at `/tmp/rastrata-delta-publication-controls.C9B432`; that
temporary baseline is not a committed revision or a portable benchmark fixture.

### Verification evidence

- Full `bun run check` completed successfully: ledger 803 passed / 1 skipped /
  0 failed across 48 files; kernel 372 passed; kernel tooling 4 passed;
  development worker 3 passed; repository tooling 25 passed. The one skip is the
  crash-child entry point, invoked separately by its parent process-kill test.
  The ledger run took
  811.97 seconds. The final stronger offline-recovery assertion was rerun in the
  focused suite below after its addition; ledger type checking was rerun too.
  Kernel coverage reported 100% functions and lines across its 15 gated sources;
  this is **not ledger coverage**. The semantic trace gate still reports four
  design-pending requirements. No release mutation campaign was run for this slice.
- Final focused warm-session/outbox run: 9 tests, 66 assertions, no failures.
  Includes offline archive reconstruction from archived genesis bytes, retained
  rejections, forged history, cross-book refusal, lost upload replies, concurrent
  delivery, stalled uploads, scheduler failure, stale views and explicit audit.
- Native Workers runtime: 2 tests, 54 assertions, no failures. Exercises actual
  SQLite-backed Durable Objects, R2 bindings and alarm dispatch across runtime
  replacement; confirms that new saves preserve the earliest archive deadline.
- Process-kill recovery plus archive-storage suite: 15 tests, 235 assertions,
  no failures. The native runtime test is not substituted for these process kills,
  and neither is described as a remote power-loss or account-loss drill.
- Ledger design checks: 23 scalar constraints, 169 scalar cases, 18 lifecycle
  cases, 21 requirements and 18 checker tests passed. Licensed SysIDE reported
  zero diagnostics with syntax and unresolved-reference negative controls.
- Workspace type checking, formatting and dependency boundaries passed. Lint
  completed with no errors/warnings and 11 existing informational findings.

The first broad owner run exposed an incorrect **test** assertion against a
nonexistent `replayed` receipt field; the corrected assertion checks
`result.disposition === "replayed"`. Its failed run is not counted as passing
evidence. An earlier default-timeout invocation was also superseded by the package's
configured timeout. Only the completed, source-identified matched benchmark above
is used for the performance claim; earlier diagnostic runs are excluded.

### Remaining release blockers

Warm reuse is one bounded performance repair, **not production readiness**.
Whole-state kernel admission/hashing and copied history maps remain; cold startup
still replays and projects the complete history. The internal 1,000-outcome and
1 MiB record limits are unchanged. The asynchronous relay is integrated only into
the local native Workers harness, not the deployed gateway/control plane. Bounded
current-state admission/startup, business-sized capacity measurements, deployed
failure and restore drills, backup-lag policy/telemetry, and release review remain
necessary before real business books are admitted. Earlier test/coverage/mutation
scores do not certify these new paths.

## Platform guarantees and minimum application responsibilities — 2026-09-07

Bounded reference review requested after the performance investigation. This is a
recommendation, not a SysML amendment, production certification, or selection of an
acknowledgement policy. No runtime, stored format, existing requirement, or release
gate is changed by this section. It adds no new infrastructure workstream.

### Finding

Keep one SQLite-backed Durable Object per book as the working target. Delegate
physical transactions, replication and ordinary database crash recovery to the
platform. Rastrata must supply accounting semantics, end-to-end retry identity,
consistent application publication, authorization and explicit recovery policy.
Full accounting replay before every command and receipt is our current design
choice, not a prerequisite imposed by SQLite or Durable Objects.

The indexed owner currently calls `withRecovered` before evaluation and again after
publication. Its recovery loop runs `replayOutcomePayload` and
`projectLegacyIndexedBook(encodeDurableBook(aggregate))` for each retained outcome.
The kernel's common admission also hashes the complete book. Removing only one
outer replay or caching one aggregate does not solve both sources of growth.
See [the owner](../src/indexed-ledger-owner.ts) and
[common admission](../../kernel/src/book.ts).

### What the references establish

- [Cloudflare's storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  documents transactional, strongly consistent storage, synchronous SQL transactions,
  durability confirmation and 30-day point-in-time recovery. SQL cursors held across
  an `await` do not preserve snapshot isolation; read dependencies must be consumed
  within the intended transaction boundary.
- [Cloudflare's storage architecture](https://blog.cloudflare.com/sqlite-in-durable-objects/)
  describes confirming changes after three of five storage followers receive them,
  then archiving batched changes to object storage. This is managed replication,
  not an application's single unreplicated SQLite file. Internal implementation
  details are explanatory evidence, not an additional application SLA.
- [The pinned TigerBeetle architecture](../../../references/tigerbeetle/docs/ARCHITECTURE.md)
  separates immutable transfers from current balances and restores from a checkpoint
  plus subsequent log entries. Borrow incremental state-machine execution, not its
  custom LSM engine or replication protocol. Its
  [submission guidance](https://docs.tigerbeetle.com/coding/reliable-transaction-submission/)
  uses persisted client-generated IDs across retries. Rastrata's exact retained
  rejection/result contract remains its own obligation, not proved by that analogy.
- [Litestream](https://litestream.io/how-it-works/) is prior art for asynchronous
  backup and snapshot-plus-tail restoration. It illustrates backup lag, not zero
  backup loss at acknowledgement. Do not install it inside a Durable Object or
  assume access to the platform's underlying WAL files.

### Guarantee ownership

Platform support is a primitive, not evidence that our composition is correct.
Every PL requirement is accounted for below; none is marked discharged here.

| Required guarantee | Reuse | Rastrata's remaining responsibility |
| --- | --- | --- |
| Accounting validity; complete context (kernel requirements, PL-021) | Existing accounting kernel | Replace whole-state dependencies with complete indexed inputs under a reviewed profile; include absence, ranges, policies and chronology. Compare economic results with the existing evaluator. |
| Tenant/book/actor admission (PL-001) | Object-private storage | Authorize before reads and retries; verify provisioned identity and generation. Object routing alone is not authorization. |
| Atomic publication and serialized heads (PL-002, PL-005, PL-006) | SQLite transaction | Publish outcome, affected rows, indexes and both sequence heads together. Check expected head and applicable restore fence; recheck after external awaits. Rejections advance Oseq without a financial revision. |
| Durable acknowledgement (PL-003, PL-014) | Platform-confirmed writes | No receipt on uncertain persistence; preserve retry resolution. An application archive requirement, if selected, adds a separate acknowledgement condition. |
| Permanent retry identity (PL-004) | Indexed durable lookup | Bind ID to original input and retained outcome, including rejection. Lost reply or timeout is not proof of failure. |
| Exact wire and capacity (PL-009) | SQL storage and indexes | Validate canonical formats and bounds; preserve historical bytes and leave capacity for operation. A database transaction cannot validate our accounting codec. |
| Recovery, damage and checkpoints (PL-007, PL-008, PL-010) | Database crash recovery | Define trusted application state and damage-detection timing. A checksum neither proves accounting validity nor proves that a whole database was not rolled back. Current complete-replay rules remain binding. |
| Restore and archive reconciliation (PL-011, PL-015, PL-016) | Platform PITR; separate archive storage if selected | Fence restore, identify the authorized expected head, reconcile uncertain publication and test recovery. Platform copies do not provide account-loss isolation or undo valid but erroneous application writes automatically. |
| Consistent reads (PL-013, PL-019) | Transaction-scoped reads | Bind multi-request pagination to an immutable cutoff or explicit snapshot; never assume a cursor survives an await as a snapshot. |
| Index coverage, cutover and reclamation (PL-017, PL-018, PL-020) | Native SQL indexes where sufficient | Atomically maintain application summaries. Custom cold/COW views still need their existing proofs if used; do not add them to the next slice solely for hypothetical scale. |
| Operational evidence (PL-012) | Platform facilities | Measure our full path, exercise faults and restore, monitor failures, and obtain release approval. Documentation is not a passed deployment test. |

### Minimal recommended execution boundary

For a reviewed new representation, obtain the authorized current head and complete
command dependencies, evaluate with the kernel, and atomically commit the outcome,
conditional state changes, required indexes and resulting head. Prefer local,
synchronous SQL work; do not perform network I/O inside a SQL transaction. If
preparation yields outside the transaction, publication must validate its exact
head again. Update any memory cache only consistently with durable publication;
discard uncertain cached state. Never acknowledge merely because evaluation passed.

Healthy restart should open transactionally maintained current state under an
explicit integrity contract. It need not mean reconstructing the application from
an application checkpoint. Checkpoint-plus-tail belongs to rebuild/restore where
needed; full historical audit is a separate operation. Moving corruption detection
out of startup/receipts is a real contract change, not an equivalent optimization.
PL-007/008/010/011, PL-021 and the bridge actions must be reviewed together before
enabling it. Old full-state hashes cannot silently become incremental roots.

Recommend platform-confirmed acknowledgement as the baseline to evaluate, with a
separately monitored backup path. This is NOT owner approval to select it. The
remaining product decision is whether recovery from loss of the entire primary
database must include every acknowledged outcome in an application-controlled
archive. If yes, archive-required publication stays in scope; if no, backup lag
and acceptable loss must be declared. Same-account R2 is not account-loss recovery.

### Scope control and next evidence

Do not add custom consensus, a second physical WAL, cold index sharding, or a custom
storage tree merely to reproduce platform guarantees. Do not delete existing
candidates or disable their tests: a selected integrity requirement may still need
them. Native SQL alone is not a substitute for any retained cryptographic proof
contract. Historical migration remains conditional on actual retained-book needs;
no synthetic or user data is reset by this review.

The next implementation milestone is one supported posting path with a retained
rejection, identical retry, conflicting-ID retry and restart. Before changing the
runtime, specify its representation and recovery trust boundary in the existing
models. Measure real admission, SQL, hashing, publication and acknowledgement
separately, as well as total latency. Use the same command and live dependencies
against increasing unrelated history; separately vary active state and command
size. Include warm and restarted owners, queueing and failures. The local database
comparison must report total bytes including indexes and outcome records.

Pass only when the real path avoids genesis replay/full-book projection per
ordinary command, matches independent accounting expectations, preserves outcomes
across fault-boundary tests, and meets predeclared absolute latency and growth
budgets. Agree those numeric budgets before interpreting results; synthetic extreme
workloads are not approved launch limits. Cloudflare integration must exercise real
durability confirmation, not the no-op sync used in the earlier local comparison.
Stop and review a failed slice before extending to other commands. No speedup,
production readiness, resolved inventory blocker, or revised release scope is
claimed by this reference review.

## Conditional publication from admitted decisions — 2026-09-07

The indexed owner's publication producer now compiles its actual kernel intent
or retained rejection against authenticated prior logical roots instead of
serializing and rebuilding the whole resulting book. `prepareAdmittedOutcome`
snapshots the decision and complete financial predecessor, produces conditional
row changes, and routes the serialized record through the existing decoder/delta
projection. These two projections use the same compiler; they are not independent
accounting verification. The owner requires exact equality with its kernel outcome
payload before any publication. Existing atomic source/group/identity selection,
durability confirmation, complete kernel replay and independent whole-state root
reconstruction before acknowledgement remain unchanged. No kernel or wire/profile/hash changes.

The initial implementation regressed component time by revalidating catalog and
anchor framing around every old-node read. The revised implementation validates
them fully once, then compares the **complete exact bytes** plus owner authority
at every repeated check. A retained digest or head-hash field cannot hide body
substitution. This is a scoped validation optimization, not a cache across commands.

Measured producer-only results (three alternating trials per size, local SQLite;
milliseconds are medians, not latency acceptance thresholds):

| Prior postings | Rows rebuilt by old projection | Conditional changed rows | Old producer ms | Conditional producer ms |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 31 | 3 | 26.35 | 22.98 |
| 16 | 55 | 3 | 29.62 | 22.51 |
| 31 | 100 | 3 | 38.58 | 22.76 |
| 32 | 103 | 3 | 39.48 | 22.99 |
| 63 | 196 | 3 | 58.09 | 21.97 |
| 64 | 199 | 3 | 60.86 | 23.18 |

These timings and the whole-owner comparison below precede a final allocation-only
cleanup: the private validator now returns its already-validated anchor rather
than serializing it for every caller that ignores the return value. The one caller
needing exact bytes serializes that same value immediately. Structural counts and
byte equality were reverified afterward; timings under concurrent validation load
varied substantially and are retained separately rather than treated as SLO evidence.

Both producers use the same already-admitted decision. Kernel evaluation, owner
pin operations, recovery, atomic publication and durable sync are outside this
component timing. First-pass conditional source-node reads were 5–7 in these cases;
this is not a universal constant-time claim. At 64 postings the old full-book
serialization was 686,072 bytes; the new producer does not materialize it.

A separate alternating eight-command comparison exercised both complete owners,
including their actual recovery/publication paths, against separate in-memory
SQLite databases. All eight receipts and final canonical book bytes match
(17 assertions). With a fixed test clock and no-op physical sync, observed command
times were still seconds: 1.36–10.08 seconds before and 1.48–7.36 seconds after.
Several commands were slower, and SQL counts increased (64–190 extra statements).
This single concurrent local run is not statistical performance evidence or a
physical durability drill. It does **not** establish end-to-end improvement or
production readiness: full-history/full-state verification still dominates.

Conformance covers exact record bytes, prepared-catalog commitments, selected
source handles and current rows across commercial, inventory, allocation and FX
workflows, plus retained rejections. Additional tests cover mutable caller input,
missing nodes, stale catalogs, early/final authority loss, an intervening retained
rejection, and transient metadata substitution with unchanged digest fields.
The actual owner test proves the producer is called once per newly retained outcome
and never for retries. Supplying another valid admitted outcome is rejected before
canonical/source/group publication, not discovered only after acknowledging it.

Three isolated build-valid negative controls fail as intended: removing the
owner's exact outcome binding reaches a post-publication recovery mismatch;
digest-only catalog checking releases a candidate after transient corruption;
omitting full anchor-byte checking does the same. Restored sources compare
byte-identically to the working tree and pass the two focused tests. This is
sensitivity evidence, not a mutation score or independent audit.

Verification completed: the repository `check` exited 0 with 793 ledger tests
passed, one intentional child-only skip, zero failures and 88,285 assertions across
48 files (1,143.21 seconds). Kernel tests passed 372/372 with 59,578 assertions;
coverage remains 100% functions and lines across 15 gated production sources.
Application/tooling, type, lint/boundary/format, bounded design and ordinary trace
gates passed. That run began before the final allocation-only cleanup; a fresh
complete run of both affected source-catalog and owner test files passed all 31
tests and 5,352 assertions against final sources (516.99 seconds). Final restored
controls passed two tests and 75 assertions. Final types, lint/format/boundaries,
bounded design and licensed SysIDE checks also pass. None of these results closes
the separate release-completeness gate or establishes business-scale capacity.

The first repository check stopped at a newly introduced non-null lint assertion;
the assertion was replaced with a narrowed local value. That failed run is retained,
not counted as passing. SysIDE reports zero diagnostics. The complete trace gate
continues to block ACC-038 and ACC-039.7/.8/.9. Full-state admission/recovery, whole
lot replacements, incomplete ownership transitions and actual deployment acceptance
remain open. The next capacity priority is eliminating repeated full-history work
under an explicitly proven recovery/admission contract, not claiming this producer
measurement meets business SLOs.

Evidence: `/tmp/rastrata-delta-publication-measurement.log` (initial regression),
`/tmp/rastrata-delta-publication-measurement-final.log`,
`/tmp/rastrata-delta-publication-measurement-final-tightened.log`,
`/tmp/rastrata-delta-publication-owner-comparison.log`,
`/tmp/rastrata-delta-publication-source-final.log`,
`/tmp/rastrata-delta-publication-owner-link.log`,
`/tmp/rastrata-delta-publication-{owner,body,anchor}-control-{build,test}.log`,
`/tmp/rastrata-delta-publication-controls-restored.log`,
`/tmp/rastrata-delta-publication-controls-final.log`,
`/tmp/rastrata-delta-publication-root-lint-failure.log`,
`/tmp/rastrata-delta-publication-root-check-final.log`,
`/tmp/rastrata-delta-publication-changed-files-final.log`,
`/tmp/rastrata-delta-publication-syside.log`,
`/tmp/rastrata-delta-publication-syside-final.log`,
`/tmp/rastrata-delta-publication-spec-final.log`,
`/tmp/rastrata-delta-publication-strict-trace.log`.

Source SHA-256: indexed owner
`1b3e34847a70e6d0487479c3cb421e67ba7630757140b0711c49521318b4793b`;
source catalog `304190102512d104d0e758bd7c87772ff9b9aaf50cd224dc78a3055b0882c780`
(before allocation-only cleanup: `cbedf352d241d8a89bea0443d823f371ad739135eef158cecc2d66e7ac6b2b55`);
owner tests `8fb362763dc189864a10a3a988a28cb2f689221f83e1446e0d92471fb92e2e14`;
source tests `fd76cd0b788133d585438c9f6b55c9618f799f5ad0444bbb518861acfa45ac1c`;
ledger SysML `23a0b2a4e47aebc698bab674b79f02b865d487bb439edfe736c2ef35846539d9`.
Kernel book source remains
`96e3fdce38612f1f1fdfb1976ab69941c82d8e71083f09348576a5932a5aaba6`.

## Common admission enforced before indexed preparation — 2026-09-07

`evaluateBookCommandAdmission` is now the single complete prefix used by the
canonical evaluator and both owner-authenticated row readers. It preserves the
existing order: retained retry/input/scope/version/financial chronology, financial
identity, execution-profile history, complete state hash, expected revision,
configuration, then global accounting obligations. It deliberately requires the
complete canonical state and retained protocol. A sparse header, a claimed digest,
or the current profile marker alone cannot stand in for those integrity checks.
No accounting rule, effect encoding, canonical hash domain or frozen fixture changed.

`preparePinnedOwnedInventory` now runs that pinned admission bridge first. Finished
replays and common rejections return a distinct evaluation without command-specific
indexed inventory reads or effects. Full-state integrity checking still traverses
canonical state. Continuation is bound to the exact command and the same full head as
the later indexed facts; it permits command-specific preparation only. Both reader
profiles confirm live authority before and after admission, including finished
results. Neither returned branch is a durable receipt or publication capability.

Focused evidence:

- The real indexed owner test passed 86 assertions covering an unactivated book,
  stale revisions, forged input hashes, wrong-book input, unsupported protocol,
  invalid chronology, committed/rejected retries after later outcomes, conflicting
  retries, stale readers and malformed input. Finished outcomes are checked against
  hardcoded dispositions/diagnostic codes and the canonical evaluator. Inventory
  fact/pool methods are replaced with throwing sentinels, and complete durable bytes
  and the head are compared before/after every nonpublishing evaluation.
- Kernel tests explicitly check retry priority over corrupted current state, profile
  integrity before state hash, state hash before stale revision, exact configuration
  diagnostics, and that continuation does not bypass command-specific activation.
  The focused kernel run passed ten tests and 138 assertions.
- Compact-owner retry/financial-clock conformance plus the new late-expiry test
  passed two tests and 143 assertions. The latter moves the clock past expiry during
  the first pin check; both a fresh continuation and retained replay must fail at
  the final check, retire the reader, and leave durable state unchanged.
- Two isolated, build-valid negative controls fail their intended assertions:
  forcing a finished admission to continue reaches the forbidden fact read;
  deleting the reader's final confirmation releases a result after expiry.
  Restoring each source passes its focused test (86 and ten assertions respectively).
  An initial control setup could not resolve the workspace dependency; its symlink
  was corrected before build/test evidence was collected. These controls are not
  a mutation score or an independent audit.
- The preserved pre-extraction kernel still produces identical result hashes and
  complete durable bytes over free and paid rounding/depletion/rejection timelines:
  two tests, 26 assertions. No historical fixture was regenerated.
- Reversing only this prefix extraction mechanically reproduces the complete
  immediately preceding kernel source hash
  `4f730e19764db58446c1dc7106529550fb0c8b20ad86236e0f2d5b97db437402`.
  This checks extraction scope, not production correctness by itself.
- Kernel/ledger type checks and licensed SysIDE pass. The explicit complete trace
  gate still fails on ACC-038 and ACC-039.7/.8/.9, as it should.

The complete repository `check` finished with exit 0: 787 ledger tests passed,
one intentional child-only skip, zero failures and 87,548 assertions across 48
files (928.39 seconds). Kernel tests passed 372/372 with 59,578 assertions; coverage
is 100% functions and lines across 15 gated production sources. Application and
tooling tests, type/lint/boundary/format checks, bounded designs and ordinary trace
also passed. The late-expiry test was added after that run began; the final complete
SQLite reader test file separately passed all 112 tests and 5,274 assertions
(63.00 seconds). Final type, lint, format, boundary and licensed SysIDE checks pass;
the final model has zero diagnostics. All nine frozen history hashes are unchanged.
The complete trace gate remains a separate expected failure, not a waived gate.

This closes an admission-enforcement gap in the composed preparation path, not
the scalability or production-readiness gaps. Full-state recovery, profile-history
validation and whole-state hashing remain. The existing 19 accounting point reads
exclude this full-state admission work as well as original-pool traversal, startup
and publication. Sparse common admission, scalar-state authority, whole-lot-effect
replacement, remaining ownership transitions, scaled recovery and cloud acceptance
remain open. The model explicitly separates finished common results, prepared
candidates, semantic diagnostics and infrastructure failure.

Evidence logs: `/tmp/rastrata-common-admission-focused.log`,
`/tmp/rastrata-common-admission-root-check.log`,
`/tmp/rastrata-common-admission-kernel-focused.log`,
`/tmp/rastrata-common-admission-sqlite-final.log`,
`/tmp/rastrata-common-admission-sqlite-complete-final.log`,
`/tmp/rastrata-common-admission-control-{build,test,restored}.log`,
`/tmp/rastrata-common-admission-expiry-control-{build,test,restored}.log`,
`/tmp/rastrata-common-admission-compatibility.log`,
`/tmp/rastrata-common-admission-source-audit.log`,
`/tmp/rastrata-common-admission-syside.log`,
`/tmp/rastrata-common-admission-syside-final.log`,
`/tmp/rastrata-common-admission-spec-final.log`,
`/tmp/rastrata-common-admission-strict-trace.log`.

Source SHA-256: kernel book
`96e3fdce38612f1f1fdfb1976ab69941c82d8e71083f09348576a5932a5aaba6`;
protocol tests `5f1a6733f66b7be228156f8e5e93a88d114170968dc3f34f5a3c851556f7d0fc`;
financial tests `9c2805283ccd53c4caf9efd1d5a74f6862da4c0bbbe3cda4f5216079ca41e983`;
reader `7fbf1913625640925e66ac3454631470611435d880a88b8636861c5196833835`;
indexed owner `125e532c6a80a9c866f26f3056bf3712d264f95463b64f5801245eb1d3b3b668`;
compact indexed storage `59df1e5600f648402ba5b06863f1f9e6b7df76f0bbadc984d255e58857b0402d`;
preparation `b8806807a4a64ef86a44f6288544925ab407c67651f21dff3f6626219f358a67`;
owned tests `5ca9714e1e1d10aae8563b401e7a8b8dd1dfaf135e72453dadb55b9883d13aca`;
SQLite tests `414f554fc00ab53f427a8c08113cbc77b2013f558fd8f69618d08437238413d0`;
ledger SysML `4ec76cc6cbd24c4bf8a70968a87df320a24886c9fedbeb08b29ca96845e5fa4c`.

## Shared owned-command preparation over indexed sources — 2026-09-07

`prepareBookOwnedInventory` now separates command-specific preparation from the
full-state serialization wrapper. It runs the same structural-profile, opening,
period, journal, live-unowned-stock, zero-opening-balance and accounting checks for
both full-state and indexed contexts. It snapshots command input, overlays pending
journal/posting identities, and checks its trusted physical-head callback before
and after preparation, including semantic rejection. The existing wrapper still
creates the exact historical whole `lotState` effect and unchanged commit topology.
No new arithmetic, algorithm version, canonical effect or hash domain was introduced.

`preparePinnedOwnedInventory` composes the existing owner-authenticated readers
into that shared stage: complete original pools, current holdings/positions/anchors
and movement dates, seven ID namespaces, journal IDs, period facts, managed money
scopes and complete acquisition-account checks. Same-command successor positions
remain inside the kernel. `readAllocationIdentityPresence` authenticates the creating
retained result and revision for either legacy or owned allocations, without forcing
their distinct record shapes into one decoder or changing their shared namespace.

The local callback context never escapes. Async live-head checks bracket synchronous
preparation; any failure retires the reader and returns no accounting candidate.
An outcome-only retained rejection invalidates preparation even if financial revision
does not advance. Source/read limits are explicit candidate safety bounds: 80,000
point-reader invocations, 10,000 acquisition holdings, 32 MiB retained source payloads
(duplicates conservatively charged). These do not bound total SQL work or peak heap.
The three-lot penny acquisition and issue each use 19 explicit point-reader calls;
that excludes original-pool/group traversal, startup and later publication.

Verified focused evidence:

- Real owner sources produce the same journals, ownership effects, new lots, after
  holdings and posting sequence as full-state evaluation for paid acquisition/issue
  and a zero-money acquisition/issue in one command. Over-issue, occupied cross-feature
  reference IDs and repeated owned identities preserve exact rejection diagnostics.
- Snapshot mutation, foreign identity evidence and a retained-rejection race fail
  without publishing a candidate. Legacy and owned allocation-presence reads both
  execute against real creating sources.
- Three build-valid isolated negative controls fail their intended assertions:
  removing the final head check releases a stale candidate; treating an occupied
  reference as absent diverges from actual kernel rejection; using the legacy
  allocation-row reader for owned allocation IDs fails instead of returning the
  correct semantic rejection. Restored sources passed two tests, 136 assertions.
  These are targeted sensitivity controls, not a mutation score or independent audit.
- A preserved pre-extraction bundle was used to compare complete book/protocol bytes
  and result hashes for two four-command timelines (free and penny-valued acquisition,
  depletion and retained rejection): two tests, 26 assertions. Only original kernel
  functions were exercised; its unrelated prior ledger-profile control was not used.
- The paid timeline is now frozen in
  `test/data/owned-inventory-preparation-baseline.json`, SHA-256
  `4a9daf603a64ab0c5ea345c5b44c2106790b7b3470f611b14f478eae286e8104`.
  Strict decoding, exact re-encoding, cents/depletion checks and retained rejection
  retry passed (eight assertions). Its first draft incorrectly included execution
  wrapper fields; strict decoding rejected `aggregate.result`. The exporter was
  corrected to emit only original `state`/`protocol` before the fixture was frozen.
  All eight preexisting historical fixtures are unchanged. The new wire fixture is
  excluded from formatting just like the other immutable ledger histories.
- Kernel coverage remains 100% lines and functions across its 15 gated sources.
  Licensed SysIDE reports zero diagnostics with semantic controls, and bounded
  design checks pass. Complete trace still refuses ACC-038 and ACC-039.7/.8/.9.

The expanded paid integration test exceeded its old 60-second default during the
first broader run. That failed run was stopped, not counted as passing, and the
test now has an explicit 180-second integration bound with all assertions retained.
The rerun of the uncached repository `check` completed with exit 0: 785 ledger tests
passed, one intentional child-only skip, zero failures, 87,399 assertions across
48 files (964.34 seconds); 371 kernel tests passed with 59,548 assertions. Type,
lint/boundary/format, application/tooling, bounded designs, kernel coverage and
ordinary trace gates all passed. That run started before the frozen-fixture test
was added; a subsequent fresh run of the complete changed ownership test file
passed all 11 tests with 396 assertions (251.80 seconds), including that fixture.
Final ledger type, lint, formatting and licensed SysIDE checks also passed after
the fixture addition. Neither result closes the separate release-completeness gate.

Evidence logs: `/tmp/rastrata-owned-stage-root-check.log`,
`/tmp/rastrata-owned-stage-root-timeout.log`,
`/tmp/rastrata-owned-stage-boundary-final.log`, `/tmp/rastrata-owned-stage-frozen.log`,
`/tmp/rastrata-owned-stage-fixture-draft-failure.log`,
`/tmp/rastrata-owned-stage-compatibility.log`,
`/tmp/rastrata-owned-stage-control-{head,reference,allocation}-{build,test}.log`,
`/tmp/rastrata-owned-stage-controls-restored.log`,
`/tmp/rastrata-owned-stage-syside-final.log`, `/tmp/rastrata-owned-stage-spec-final.log`,
`/tmp/rastrata-owned-stage-strict-trace.log`.

Source SHA-256: kernel book
`4f730e19764db58446c1dc7106529550fb0c8b20ad86236e0f2d5b97db437402`;
kernel compiler (comment correction only)
`89f9abb46838dcfce3818950fc6c24ab7f0736a1ff6a4ccf975d6b63a5d2d92a`;
kernel tests `defc957ea6eea6c1931aad4fd90ddf54dadd3395b5b490712599dce59d3edd55`;
indexed preparation `ccdf2faaf34aad859727d5ab102ee8554da6b00f2e3129d33b3f25ab4f30c1a2`;
reader `d6a2866fdd5309cbf6261d29de79108e875a961086055e6a5051bbde09715151`;
ownership tests `f7ca561548ad5ff41833d81951bea2d26012f9d72db3e2b3d0b3762860693fc7`;
SQLite tests `781c7e392d3a0f767c7dffe1c1364f5f0f1b60f016e10613f2c0f4eb5d6b909c`;
SysML `443ae0838a3086d16c1d1a0c7fdf0505a8ff80f9191817adee2dc04ed085e20c`.
The exported original-kernel comparison bundle is
`229124edc0fc4e5a9b600e63da0b44e34f0a91686b54ed34b11a16208c611fa7`.

This is command-specific preparation, NOT complete protocol/global admission,
a BookCommitIntent or publication authority. It is not enabled as a replacement
for the owner's full-state evaluation. The next boundary must compose protocol
ordering/global admission with verified scalar state authority and sparse canonical
effects, then integrate publication/recovery. Full-history startup, eager retained
pool scans, remaining ownership transitions, archive integration, capacity/SLO proof
and the outstanding recovery-policy decision remain open. No release status was
changed; no commit, push, deployment, provisioning or cloud spending occurred.

## Cross-feature canonical reference occupancy — 2026-09-07

Integration review found a missing dependency, not a bypass in the currently used
full-kernel admission path: owned inventory checks new posting-reference IDs against
all canonical accounting references, whereas `inventoryPostingReference` identities
cover only references created by ownership effects. Inventory-only absence must
never authorize a fresh claim of an ID already used by an allocation or other
accounting feature.

The internal owner now offers `readPostingReferenceUsage` under the explicit
`rastrata-indexed-reference-group-catalog-v1` profile. It adds one revision group
per raw reference ID, projecting the thirteen append-only accounting effect variants
plus ownership anchor/movement references. Reuse within one revision is counted
once; use in later revisions remains separately witnessed. Inputs, rejected proposals,
and ordinary journal IDs do not create reference occupancy. Existing profiles retain
their exact predicates/domains and reject this query, including negative queries.
There is no implicit catalog upgrade, canonical collection addition or kernel change.

The reader binds the current full head, source catalog, authenticated latest member,
complete canonical revision row and raw reference predicate. Its witness is latest
use, not original creation or a claim that all copies have one unique value. Full
bidirectional source audit remains the prerequisite for trusting absence. Inventory
witnesses retain their owned-command restriction; only this cross-feature predicate
permits other canonical command types.

Focused verification completed:

- Four targeted tests passed, 127 assertions, including real owner publication,
  reconstructed-owner reads, rollback, depletion, allocation schedule revision,
  rejected-proposal exclusion and invalidation after retained rejection.
- An actual allocation source is absent from the inventory-only family but used in
  the new read. A paired full-kernel test rejects an otherwise valid acquisition
  reusing that ID, preserves financial state and commits the fresh-ID variant.
- Removing that reference group and recomputing the directory/catalog hashes still
  fails complete source audit (`group_catalog_member_missing`); restoring the actual
  catalog passes. This is disposable SQLite corruption testing, not a cloud drill.
- Two isolated build-valid negative controls fail the intended assertions: removing
  accounting reference projection returns false `unused`; bypassing profile coverage
  makes an older profile incorrectly resolve an absence query. These are targeted
  sensitivity checks, not a mutation score or independent audit.
- Restoring the isolated source copy passed all three rerun reference controls
  (39 assertions). Byte comparisons confirmed restoration of the modified sources.
- A bounded compatibility experiment replayed activation, source journal and
  allocation creation through both the preserved pre-change implementation and
  current code. Catalog bodies/digests and all descriptor bodies/digests were byte
  identical for each of the three older profiles, despite the real accounting
  reference now recognized by the general projector. This is not a migration test.
- Ledger typecheck, bounded design checks and licensed SysIDE validation passed;
  SysIDE reported zero diagnostics with syntax/unresolved-reference controls active.
- The explicit complete trace gate still fails for ACC-038 and ACC-039.7/.8/.9.
  No closure status or release approval changed.
- The uncached full repository `check` completed with exit 0: 784 ledger tests
  passed, one intentional child-only test skipped, zero failures, 87,339 assertions
  across 48 files (867.37 seconds); 370 kernel tests passed with 59,538 assertions.
  Kernel coverage remained 100% functions and lines across its 15 gated sources.
  Type/lint/boundary/format, tooling, application, both bounded design and ordinary
  trace gates passed. Ledger-wide coverage and production release remain separate.

Logs: `/tmp/rastrata-reference-targeted-final.log`,
`/tmp/rastrata-reference-control-{occupancy,profile}-{build,test}.log`,
`/tmp/rastrata-reference-controls-restored.log`,
`/tmp/rastrata-reference-profile-compatibility.log`,
`/tmp/rastrata-reference-root-check.log`, `/tmp/rastrata-reference-syside.log`,
`/tmp/rastrata-reference-spec.log`, `/tmp/rastrata-reference-strict-trace.log`.

Source SHA-256: semantic groups
`e742f28bccada851d165069ccaf70ad6fcebf14a2dd90c242e2838b13ddd1e14`;
group catalog `0883550038549168fa8e4c8021e0b3662acd83658132321ff3572f75c21f6610`;
row reader `38f6e44cdb24088b555f9b2efe79e7ec1d24da675ba26c393134a5bb2df55164`;
owner `0f722f9a1038d1f796d5eca9f32f9fde327dba4bc5fbf20e5628f7c8e3d805f2`;
ownership tests `c4d54ded33d70b0368d02067e6a7316c4c795c75382c50a18dd665378dd3f9b5`;
reference-group test `218b8aff87c7a22f88ff46d6f1231c2cfbea19145dade537f7dc8beffc74ec8f`;
ledger SysML `daad56b2837013af54d2045978f940fc6562b0bed17796876d0b775a88685d94`.
The five relevant kernel source hashes and all eight frozen historical fixture
hashes match the preceding review; no historical outcomes were repaired.

Next integration boundary remains a complete owned-command read context using
global reference occupancy alongside the existing pools, positions, money scopes,
configuration/period facts and other identity namespaces. This change does not
compose that context, replace full-state admission, make lot effects sparse, remove
startup/capacity limits, or prove Cloudflare SLO/recovery readiness. Other inventory
transitions and archive integration remain open. No deployment or cloud spending.

## Authenticated money-scope summaries and inventory controls — 2026-09-07

The internal indexed owner can explicitly select
`rastrata-indexed-money-group-catalog-v1`. This adds complete journal money-scope,
ownership money-scope and inventory source-journal groups. Older profiles retain
their existing predicates, descriptor bytes and domains and reject unsupported
queries; changing the profile on an existing catalog fails without migration.
No canonical collection, kernel math or enabled application profile changed.

`readInventoryMoneyScope` distinguishes persistent inventory ownership from exact
posted money. The key is book/account/functional commodity/analytic members, across
all stock units. It preserves ownership after depletion and distinguishes nonempty
zero-balance history from group absence. `readInventorySourceJournal` proves whether
an original anchor or journal-linked movement references a journal; unreferenced
is not proof of the journal's existence or absence. Both reads bind live head,
source catalog, raw predicates and complete canonical revision witnesses. Input
snapshots reject accessors and oversized keys before yielding/sorting/hashing.

Journal descriptors commit exact posted-money sums along with membership roots and
counts. New-minus-old contributions publish in the same transaction as canonical
and source changes; sums are rebuilt and compared against complete canonical source
rows. A rehashed false sum still fails source verification. A zero sum does not
delete a nonempty group. These are derived summaries, never self-authenticating
client facts. The owner still performs full-history recovery and source audit.

After that audit, three balance queries over a fixed two-scope directory read at
most six logical-map nodes, unchanged at 1, 4 and 16 journals, and fetch no original
genesis/outcome payloads. This is a measured read-work boundary, not an enterprise
capacity proof, end-to-end SLO or a claim of bounded owner startup. The primitive
inherits the 256-bit map's bounded lookup path; canonical source costs remain separate.

Verification exercises real canonical ordinary and zero-sum journals, independently
computed full-state sums, schema-level mixed stock units and reordered dimensions,
and genuine-owner paid acquisition/issue. The latter includes failures after source
and group publication, exact retry/reconstruction, a three-movement single revision,
and depleted ownership with zero posted balance. A real ordinary balance with no
holdings remains unmanaged/nonzero and the kernel rejects first ownership. Actual
retained rejection invalidates both read types. Unsupported profiles retire readers
and cannot become false absence; input getters are never invoked.

Six isolated build-valid controls fail: dropping nonempty zero-sum groups, reversing
delta signs, bypassing canonical-sum verification, grouping money by stock units,
dropping movement journal references and bypassing profile coverage. Each starts
from a byte-compared pristine copy. This is targeted adversarial evidence, not a
whole-ledger mutation score. Logs:
`/tmp/rastrata-money-control-{zero,sign,audit,units,source,profile}-{build,test}.log`.
The byte-restored copy passes 12 tests / 342 assertions in
`/tmp/rastrata-money-scope-controls-restored.log`. The uncached `bun run check`
exits zero: 781 ledger tests / 87,163 assertions, 370 kernel tests / 59,538 assertions,
four kernel tooling tests / 23 assertions, three development-worker tests /
22 assertions and 25 repository tooling tests / 97 assertions. The one ledger skip
is its child-only crash entry; parent-driven crash tests pass. Ledger time is
834.99 seconds locally, with controls running alongside part of the suite, not a
production latency measurement. Types, lint/boundaries, formatting, both design
checks and non-closure trace pass. Kernel coverage is still 100% functions and lines
across 15 production sources; ledger-wide coverage and a full new mutation campaign
are not certified. Existing workerd tests pass, but the new money-profile workflows
were exercised in Bun SQLite, not specifically in workerd or remotely.
Both models pass licensed SysIDE with
zero diagnostics and syntax/reference controls; bounded design checks pass.
Final logs: `/tmp/rastrata-money-scope-root-check.log`,
`/tmp/rastrata-money-scope-syside-final.log`, `/tmp/rastrata-money-scope-spec-final.log`
and `/tmp/rastrata-money-scope-strict-trace.log`.

Complete composed indexed admission remains open: selected positions/anchors,
live unowned stock, original identities, policies/periods, ordinary-command guards,
same-command overlay and final publication. Other ownership transitions, sparse lot
changes, startup, archive integration, migration and capacity/release campaigns
remain separate blockers. This profile's workflows have not been certified remotely
on Cloudflare. Strict closure still refuses ACC-038 and ACC-039.7/.8/.9. All eight
historical fixtures and reviewed kernel source hashes remain unchanged. No commit,
push, deployment, cloud provisioning/spending or external destructive drill occurred.

Source SHA-256:

| Artifact | SHA-256 |
|---|---|
| semantic groups | `4843ae7f80e1291baabf75f4dcbb53a635c68923a809367f1c3df0c5f3140bc1` |
| group catalog | `6e8d679d6e8420025cfe6f58919fb8ac95a6d9dcce8b05b1ad07a37d035e450b` |
| pinned reader | `7ba6fe3dc469254777c9da3552a1165c6bec5d60a60730ee6439853c6b6e1357` |
| indexed owner | `a502388b026ab33e2843d6025d2e0bd8d90b256b16a4786aa0d72b75ca8c702f` |
| money-scope tests | `618bf22d64680113271bffcc7f80d9a1fabcda6cb69582d433b09df3fbb10389` |
| ownership tests | `012b71b0330cae22d33ac7c92cd0a5a7a1b32c7c38a6a1d56409abba6e693913` |
| older group verifier | `673bdfa843ea6d206b5ba5b2cf25e7418fbda10042018280b7824caf2c7f6b48` |
| catalog fixture | `00a6536039382ade5bd566206fe7dd25dda9ce79f521a2e8087a0593e85fb884` |
| grouping tests | `2e1c1384661d6b0b6756201efe76255bc8c6afc99829dc7e172d22ab17ecc965` |
| ledger SysML | `9ccd8827af16d1da5b48d6fb7b9eafc90c2d1e1cf0f741ea5c98e11b1733baa2` |

## Complete original owned-inventory pool reads — 2026-09-07

`readOwnedInventoryPools` now obtains original source pools for owned issue commands
from pinned configuration, complete account groups and authenticated current lots.
It snapshots commands before awaiting, recomputes input hashes, deduplicates source
reads by full policy identity/hash and commodity, and retains operation array
indices. Policy identity/hash resolution failure is distinct from a proven empty
pool; it is not temporal/capability admission. Source loss, wrong views, incomplete
pages or exceeded read budgets cannot produce partial success.

Source review of `book.ts` and `prepareInventoryOwnershipSelection` established that
owned pools include depleted holdings: validation and resource accounting precede
nonzero selection. Reusing the legacy nonzero-group reader would change those
semantics. The new reader instead exhausts existing `holdingsByAccount` groups,
filters commodity after exhaustion, joins exact source lots and restores global
canonical holding-ordinal order. It retains total and matching account populations,
source ordinals/hashes and unique source-byte accounting. Both indexed group
profiles already cover this predicate; no new profile or migration is introduced.

The 10,000 scanned/output-row and 32 MiB unique encoded-source limits are candidate
read bounds, not business capacity or retention rules. Account scans still include
unrelated commodities and retained depleted rows. Reused fetches do not waive the
kernel's repeated operation work accounting. Selected positions/anchor joins,
same-command overlays, managed-money-scope proofs, whole-command indexed admission,
sparse changes and production scaling remain open. A legacy holding in these facts
is not ownership adoption. No kernel mathematics or historical bytes changed.

The ownership suite compares multi-account paginated facts against independently
selected canonical rows, including exact ordinals/hashes/bytes and depleted stock.
A genuine paid acquisition/issue supplies both indexed and full-state inputs to
the shared selection primitive and requires exact selected results. Tests also
cover read deduplication, missing/hash-mismatched policies, commodity-specific
emptiness, command mutation across awaits, recomputed input hashes and actual
retained-rejection pin invalidation. Explicit contract doubles cover ambiguous
policy, truncated pages, wrong heads, excessive populations/source bytes and missing
lots; those are port-contract defenses, not forged authenticated-state proofs.

Four isolated build-valid controls fail the intended tests: removing depleted
holdings returns zero rows instead of three; bypassing policy hashes resolves an
invalid reference; reversing canonical order differs from the independently built
full-state pool; removing the byte guard incorrectly succeeds on over-budget input.
Each control began from a byte-compared pristine source. These are targeted negative
controls, not a whole-ledger mutation score. Logs are
`/tmp/rastrata-owned-pool-control-{depleted,policy,order,budget}-{build,test}.log`.
The byte-restored copy passes all six ownership tests / 225 assertions in
`/tmp/rastrata-owned-pools-controls-restored.log`.

The uncached `bun run check` exits zero: 775 ledger tests / 86,619 assertions,
370 kernel tests / 59,538 assertions, four kernel tooling tests / 23 assertions,
three development-worker tests / 22 assertions and 25 repository tooling tests /
97 assertions. The one ledger skip is the child-only crash entry; parent-driven
crash tests pass. Ledger time is 809.29 seconds locally, with isolated controls
running alongside part of the suite; it is not a workload latency/SLO measurement.
Types, lint/boundaries, formatting, both design checks and non-closure trace pass.
Kernel coverage remains 100% functions and lines across all 15 production sources;
ledger-wide coverage and a new full mutation campaign are not certified. Existing
workerd tests pass, but these new pool workflows were exercised in Bun SQLite,
not certified against remote Cloudflare workloads.

The first SysIDE check caught a reserved `entry` feature name
and two wrong `ContentHash` namespace references; these were corrected. The repeated
licensed check passes both models with zero diagnostics and syntax/reference
controls. Bounded design checks pass; strict closure still refuses ACC-038 and
ACC-039.7/.8/.9. These are not waived by this source-read implementation.

Final logs: `/tmp/rastrata-owned-pools-root-check.log`,
`/tmp/rastrata-owned-pools-syside-final.log`, `/tmp/rastrata-owned-pools-spec.log`
and `/tmp/rastrata-owned-pools-strict-trace.log`. All eight frozen historical fixture
hashes and the reviewed kernel source hashes remain unchanged. No commit, push,
deployment, cloud provisioning, spending or external destructive drill occurred.

Source SHA-256:

| Artifact | SHA-256 |
|---|---|
| owned source pools | `72345c068d3cd870107e43ba8594dd73c395a0e40a910a38af1b55afb9ec1383` |
| pinned row reader | `601c6c269f34c4ad535d955f71904e54c2a823c251b5751158cfdd4eb0426c74` |
| shared lot source type | `87a7e6fc6cd2dc6becddc96142b90055d6168e97f1d1ffd302a340d3729ba3ea` |
| ownership tests | `705e461ca897b10a25fac42596b07597c9f5ea2827210080761bc4876f9418be` |
| ledger SysML | `3ee4bffc0debd70374ce43acdfad4a2d0f5d6d40f5963894582f63385a08ea3b` |

## Indexed latest inventory positions — 2026-09-07

`readInventoryPosition` now joins the current holding to its authenticated latest
ownership after-position and exact original anchor. The new explicit internal-owner
profile `rastrata-indexed-ownership-group-catalog-v1` adds a complete
`inventoryRevisionsByHolding` group over existing immutable revision rows. A touching
revision occurs once even when it contains several movements for that holding. The
reader proves the greatest revision through the authenticated right spine and then
selects the greatest matching artifact ordinal, independent of monetary-array order.
Financial revision is not Oseq or journal sequence; retained rejections do not create
ownership members, but still invalidate prior read pins.

The result distinguishes absent holdings, present unowned legacy stock and owned
stock, including depleted holdings. Required source loss is an error, not absence.
The join checks the full anchor/origin and kernel cumulative ownership arithmetic
over immutable authenticated rows, with live async head confirmation before/after
the synchronous join. Its temporary mathematical read context is not returned as
command-admission authority. No kernel source, accounting algorithm or historical
fixture bytes changed in this stage.

Compatibility is explicit: the existing two group profiles and their domains remain
unchanged. They reject ownership queries instead of claiming coverage of an index
they never built. The new profile has its own directory/hash domain and is selected
only for a new internal owner; both upgrade and downgrade of existing catalogs are
refused without writes. A future migration needs a verified rebuild and publication.
The canonical 24-collection format is unchanged. The default internal owner profile
and the deployed application are not silently switched.

Focused verification passes 18 tests / 5,757 assertions across the logical-map and
ownership suites. Tests cover real SQLite publication/reconstruction, atomic rollback,
same-revision acquisition/issue, later issue after retained rejection, complete
ownership-group pagination, free and paid depletion, legacy unowned stock, missing
group nodes after a reader is open, and both directions of profile mismatch. The
greatest-key proof reads exactly 12 nodes for 2,048 sequential entries; withholding
or corrupting each required node fails. Empty maps, zero/all-ones keys and deleting
the maximum are covered. Its general bound is 257 nodes for 256-bit keys. This is
map-path evidence, not an end-to-end SLO: source-row fetch and full-history owner
startup costs remain separate.

Four build-valid controls in isolated copies fail the intended tests: following the
left spine, bypassing the profile gate, selecting the first same-revision artifact,
and dropping ownership membership. The last two respectively produce a balance
mismatch and false unowned result, both caught by the genuine-owner tests. Copies
were restored and byte-compared with repository sources. These are targeted negative
controls, not a full mutation campaign. Evidence logs are
`/tmp/rastrata-owned-position-control-{tail,profile,artifact,membership}-{build,test}.log`
and `/tmp/rastrata-owned-position-focused2.log`. The restored copies pass all
18 tests / 5,757 assertions (`/tmp/rastrata-owned-position-controls-restored.log`).

The first root run found an outdated test-oracle assumption: its deliberately
seven-predicate fixture iterated every known kind and expected absence, including
the newly unsupported ownership query. It recorded 765 passes, one child-only skip
and nine failures, not a passing gate. The verifier now explicitly expects both
forward and latest ownership queries to reject that profile, while retaining its
independent exact population checks for supported predicates. The corrected file
passes ten tests / 2,824 assertions (`/tmp/rastrata-owned-position-correction-test.log`).

The final uncached `bun run check` exits zero: 774 ledger tests / 86,554 assertions,
370 kernel tests / 59,538 assertions, four kernel tooling tests / 23 assertions,
three development-worker tests / 22 assertions and 25 repository tooling tests /
97 assertions. The one ledger skip is its child-only crash entry; parent-driven
crash tests pass. Ledger time is 744.33 seconds locally, not an application SLO.
Types, lint/boundaries, formatting, both design checks and the non-closure trace
gate pass. Kernel coverage remains 100% functions and lines across 15 production
sources; ledger-wide coverage and a fresh full mutation campaign are not certified.
Both models pass licensed SysIDE with zero diagnostics and syntax/reference controls.
Final evidence: `/tmp/rastrata-owned-position-root-check-final.log` and
`/tmp/rastrata-owned-position-syside-final.log`. Existing workerd tests pass, but
the new ownership profile's specific workflows were exercised in Bun SQLite;
these results are not a new-profile Cloudflare runtime or remote workload certification.

Complete policy-pool and managed-money-scope reads, whole-command indexed admission,
sparse lot-state changes, other ownership transitions, migration, archive integration,
bounded startup, capacity/SLO campaigns and release recertification remain open.
The strict closure gate still refuses ACC-038 and ACC-039.7/.8/.9. No commit, push,
deployment, cloud provisioning or external spending occurred in this stage.

Source SHA-256:

| Artifact | SHA-256 |
|---|---|
| logical map | `1108620b98be23042ed017e895afeb41ab221ed91fec70c36e875aeb922db2de` |
| semantic memberships | `0defa86434cd6aea873825fd11da5de762af7115d41a40a0f6f275904e5bfc1f` |
| group catalog | `ec4c1bca580745a86b433d45d492da3b5629cfa9059675379279f9252423d395` |
| pinned row reader | `4ddaac0ee9d23d24bbd4164dabab85fbd9170ee73d7b35ccd22957dcce8bb06a` |
| indexed owner | `2a4d156716ce6515a8124096e0a358b08b2347c2709f1691d0dbf478225f79bb` |
| logical-map tests | `f779a90494b98e06d3d8cf473a982619720f62eb0a1c56f7906392892e17bd71` |
| ownership tests | `d1556ede7e7983ff590052bbd70cb175929df3dd6657ac2e193db97f851119de` |
| corrected legacy group verifier | `9b1d232e1b52f181c38c692636e0620f44253b8d97d571a12b8949f70d74b42a` |
| ledger SysML | `43d014e7c65528f75781875d8310adde7544299dc28203efdab5ddc4bf7115cd` |

## Owned inventory indexed persistence and immutable reads — 2026-09-07

This section supersedes the unsupported-storage boundary in the preceding
implementation stage below. Ownership is now persisted by the internal
`IndexedLedgerOwner` without changing the 24-collection format: complete ownership
effects already belong to immutable revision rows. The full-state ownership array
is a strictly checked revision alias, not a second canonical collection. Snapshot
conversion first performs kernel recovery; omitted, reordered or changed ownership
materialization cannot obtain a new valid root merely by recomputing its outer hash.
Incremental projection retains the complete revision, and source groups retain the
same exact revision bytes. Existing version tags and historical rows remain unchanged.

Permanent indexes now locate operations, anchors, movements and posting references.
Owned quantity allocations use the existing allocation identity namespace, but do
not masquerade as legacy posting-linked rows. Typed origin reads authenticate the
retained outcome and its creating financial revision, including distinct Oseq and
book revision values after retained rejections. Missing identities have an explicit
absence result; unavailable or stale evidence fails closed and retires the reader.
Shared funding references collapse only when their complete canonical contents agree.
These are immutable origin reads, not current-position or complete-pool admission.

The self-audit found a cross-account identity collision: legacy disposal in an
unmanaged account could reuse a depleted owned allocation's ID. Kernel admission now
rejects that candidate before publication. Independently, the index delta requires
both the new occurrence and the original creation to be legacy-snapshot-repeatable.
A genuine legacy disposal with a fresh ID still succeeds; no legacy history or receipt
was rewritten to implement the boundary.

Focused verification passes 13 kernel tests / 219 assertions and three ledger tests /
114 assertions. The latter execute real in-memory SQLite publication, roll back an
injected failure after catalog SQL, reconstruct a new owner, compare exact full-state
replay and row bytes, and recover original committed and rejected results on retry.
One paid penny across three one-third-cent lots yields posted budgets 0.00/0.01/0.00;
the final issue leaves no stock or cash residual and creates no fake legacy allocation.
The stale-reader assertion was corrected to the actual canonical-head diagnostic,
`indexed_canonical_head_conflict`, before the final verification run.

The final uncached root `bun run check` exits zero: 770 ledger tests / 86,350
assertions, 370 kernel tests / 59,538 assertions, four kernel tooling tests / 23
assertions, three development-worker tests / 22 assertions, and 25 repository
tooling tests / 97 assertions. One ledger child-only crash entry is intentionally
skipped in ordinary discovery; the parent-driven process-kill tests pass. The
ledger suite takes 725.43 seconds on this local run; this is not a performance SLO
measurement. Types, lint/boundaries, formatting, design checks, coverage and the
non-closure trace gate pass. Kernel coverage is 100% functions and lines across
15 production sources, not branch/mutation or ledger-wide coverage certification.
Evidence: `/tmp/rastrata-owned-storage-root-check-final.log`,
`/tmp/rastrata-owned-storage-focused-final2.log`,
`/tmp/rastrata-owned-storage-syside-final.log`, and
`/tmp/rastrata-owned-storage-trace-strict.log`. The earlier root attempt was stopped
after its known stale-reader assertion failure and was not counted as a passing run.

Four isolated, build-valid negative controls fail the intended assertions: dropping
ownership from the stored revision changes its root; allowing an owned creation to
repeat as a legacy snapshot admits the forbidden index delta; deduplicating references
by ID alone accepts conflicting complete contents; disabling the kernel cross-account
guard commits the forbidden disposal. Only temporary source copies were mutated;
each was restored and byte-compared with repository sources. This is targeted test
sensitivity evidence, not a fresh full mutation score. The restored ledger copy
passes all three tests / 114 assertions, and the restored kernel control passes
one test / 11 assertions. Logs are
`/tmp/rastrata-owned-storage-control-{revision,snapshot,reference}-{build,test}.log`
and `/tmp/rastrata-owned-storage-control-kernel-{build,test}.log`, with passing
restorations in `/tmp/rastrata-owned-storage-control-restored.log` and
`/tmp/rastrata-owned-storage-control-kernel-restored.log`.

Both models pass licensed SysIDE with zero diagnostics, including syntax/reference
controls. All eight retained historical fixture checksums match their prior values.
Strict closure still fails on ACC-038 and ACC-039.7/.8/.9. Owned transfer, correction,
value-adjustment and verified adoption transitions, complete indexed admission read
sets, and release recertification remain open. Full-state evaluation, full-history
startup and prototype size limits remain; this work is not cloud capacity, power-loss,
archive recovery or production-readiness certification. No commit, push, deployment,
cloud provisioning or external spending occurred in this stage.

Source SHA-256 for the new boundary and its verification:

| Artifact | SHA-256 |
|---|---|
| kernel `book.ts` | `7703e38108aa1575735f63086f23ff8979ff0f2bfe8ca401d2fa268df9e1f824` |
| kernel owned-command tests | `b97b18a345200ce2b1a64bdb3c47e8adbf512b46dae3849a580d2407af2919f8` |
| ledger indexed change mapper | `66347eb5fa42c4ec9a6d77553fbf094abee0a9996ac05f59ed8ef1f61683bbb7` |
| ledger outcome identities | `ed729e59066120c34d9d336df1f7f43771a9eb63d467793398f0836e071a3ec5` |
| ledger pinned row reader | `5e690b36bf22acc1fd81bd375bd9fe2c3918275f861303d2e36adc614c76fa66` |
| ledger ownership tests | `2daf18e430d4e203b4a4414bf3eaf23086a3938a412d61cb10558b658e6e5e0b` |
| kernel SysML | `9ceee17e133161bb30bcbe14ff18a8edb1faaf084147d201507a5918dc4f8def` |
| ledger SysML | `ea85fcf0106cbfebf81055a9781e468d535fca1af2ab6a5ab0a1347c299e50ba` |

## Owned inventory canonical integration — 2026-09-07

`postOwnedInventoryTransaction` is now the eighteenth runtime command, not just a
model declaration or a helper. Its closed acquisition/issue payload is strictly
decoded and hashed in full. The ordinary evaluator admits its actual journals,
resolves policies and complete inventory pools, and emits journals in input order,
one immutable ownership effect, and the exact resulting lot state. Quantity-only
operations advance book revision without inventing a journal or legacy posting-linked
allocation. Economic allocations remain inside their ownership movements.

The optional `BookState.inventoryOwnershipEffects` materialization must exactly
reproduce immutable revision effects. Recovery reconstructs prior ownership and
configuration, excludes later journals/closes/reopens from each command's source
state, and recomputes the transition. Omitting or changing the projection fails
recovery even with a recomputed outer state hash. Legacy books omit the property;
the eight retained historical fixtures remain byte-for-byte unchanged.

Admission requires the explicit structural source-identity profile, an activated
book and an admitted accounting date/period. Economic instants and accounting dates
remain distinct: no host-timezone conversion is used to infer the latter. Issues
check both acquisition availability and the previous ownership movement's accounting
date. Live unowned stock requires verified adoption. The self-audit additionally
caught an opening-balance gap: first ownership now requires zero complete posted
balance in its account/functional-currency/dimension scope across all units commodities.
No-lot balances and exhausted-stock residuals cannot silently become unowned leftovers.
Already-owned nonzero balances can receive further acquisitions. Exhausted legacy
stock with a zero posted balance may coexist with new stock, but its old lots and
allocation identities remain permanent and cannot be reused.

Generic journals, lot changes and source corrections may not bypass ownership,
including after depletion. The current closed 24-collection ledger index format
does **not** implement ownership persistence. Logical/indexed snapshot conversion,
effect mapping, source-row mapping and identity projection explicitly refuse this
history. The audit caught and fixed a missing guard in `projectLegacyIndexedBook`.
A real SQLite `IndexedLedgerOwner` test proves refusal leaves the durable head and
aggregate unchanged, creates no retained command result, and permits reconstruction
and exact retry of preceding history. This is a safe unsupported boundary, not
ownership storage conformance or deployment readiness.

Final focused evidence: 12 kernel tests / 208 assertions cover free same-command
acquisition/issue, actual penny attribution over three one-third-cent lots and three
later issues, full exhaustion, subsequent acquisitions, explicit source profile and
legacy adoption boundaries, opening/close/reopen behavior, retained rejection retries,
projection/origin forgery, source invalidation, identity reuse and generic-write guards.
The storage boundary test has 21 assertions, including actual owner reconstruction.
The complete final kernel suite passes 369 tests / 59,527 assertions, plus four
tooling tests / 23 assertions. Kernel coverage is 100% functions and lines across
15 production sources; this is not branch, mutation or ledger-wide coverage proof.
Final types, lint/boundaries, formatting, spec/trace and licensed SysIDE both-model
validation pass. SysIDE includes syntax/reference controls and reports zero diagnostics.

The complete root check was also attempted, not assumed green. Its ledger run had
767 passes, one existing crash-child skip and one failure: the genesis catalog test
still expected the old field declaration set. The assertion now explicitly includes
ownership as the sole unsupported field, verifies its absence from legacy genesis,
and retains all 24-collection oracle checks. The affected logical-book and ownership
boundary suites then passed eight tests / 1,135 assertions; final types/lint/format
were rerun successfully. The full eleven-minute root suite was not repeated after
that test-only correction. The final kernel suite and expanded owner/opening-balance
tests above were run separately against the final sources, rather than attributing
them to the earlier full-suite snapshot. Logs:
`/tmp/rastrata-owned-integration-root-check.log` and
`/tmp/rastrata-owned-integration-ledger-correction.log`.

Three build-valid isolated negative controls fail the intended tests: disabling
managed-scope protection gives three failures; deleting the indexed snapshot guard
gives one; bypassing opening-balance admission gives one. Copies were restored and
compared with their source snapshots before passing reruns. The first pair predates
the last opening-balance and owner-test additions; the third uses the final kernel
snapshot. No production source was mutated for these controls, and they are not a
complete mutation score. Evidence logs are
`/tmp/rastrata-owned-integration-{kernel-final,boundary-final,coverage-gate-final,types-final,lint-final,format-final,spec-final,trace-final,syside-final}.log`,
`/tmp/rastrata-owned-integration-control-{build,scope,index-build,index,restored}.log`
and `/tmp/rastrata-owned-opening-control-{build,test,restored}.log`.

Source SHA-256:

| Artifact | SHA-256 |
|---|---|
| kernel `book.ts` | `7ff4b70a27194d3bbe9eee764d203f4ec476330899bf27a1ffeddd061c0069cc` |
| kernel `codec.ts` | `7daa2e05d33ef7e742c1156a255f2513be590eb56b0bba287a9b67a957a835bd` |
| internal ownership compiler | `e7d12c012f6641a366bd936c6e6364bd3af0298f8ccbe1b697037b55d1312e2f` |
| kernel owned-command tests | `4b450f97aef3c7bfbe8021d8452b066e7c4c582dbda038abd5150967595b001e` |
| ledger indexed-state converter | `62566945d4e884154d4209757bf6e5235ce770c0e36491d88830cabe1dc77d2a` |
| ledger ownership boundary test | `dcb847f2fa7075d41c54dfc88dc4af97114c77ace451b576686fa8a0dddc9d85` |
| kernel SysML | `b289cf297043feb910d5d2e9f21850c4ea8832db5ef04dedaec2546ee77c4f10` |

`check:trace --require-complete` still correctly fails on ACC-038 and ACC-039.7/.8/.9.
Indexed ownership storage/read sets, transfer/correction/value-adjustment/adoption
topologies and complete release recertification remain required. This full-state
adapter does not remove aggregate limits, full-history startup, archive integration,
capacity/SLO demonstrations or the pending recovery design decision. No commit,
push, deployment, cloud provisioning or external spending occurred in this work.

## Owned inventory accounting stage — 2026-09-07

The internal `prepareOwnedInventoryAccounting` implementation now binds typed
acquisition/issue inputs to resolved booking/inventory policies, exact complete
policy hashes, coordinate admission and already-admitted journal origins. It
selects from the complete working pool, resolves original positions and anchors,
and derives same-command successors in ordinal order. Economic quantities/basis
remain separate from posted ownership. New acquisition budgets must equal the
governed aggregate quantization of carrying value; actual admitted journals cannot
silently assign a different budget. Each managed-money-scope posting must have
complete group attribution across units commodities. Original source mismatches
and read-head invalidation throw rather than produce retained accounting rejection.

This is an internal accounting stage, not the eighteenth runtime command. Its
trusted context requires prior complete protocol/configuration/opening/period and
journal admission, permanent identity and scope evidence, and pinned calendar
conversion. The future strict decoder must bound the entire wire input before
deep copying; combined accounting work bounds here do not replace ingress limits.
No public command, canonical ownership projection, commit intent, durable outcome,
adapter or migration is enabled. Existing command/state/codec source and historical
fixture bytes are unchanged. Canonical source closure, generic-write guards,
correction/transfer/adoption and the explicit indexed-format mapping remain open.

Seven focused tests cover free acquisition/issue, later authenticated issue,
cent allocation across three holdings, over-issue atomic failure, incorrect actual
acquisition amounts, currency-unit scope bypass and in-read head invalidation.
The final full kernel run passes 364 tests / 59,384 assertions, plus four tooling
tests / 23 assertions. Coverage passes 100% functions and lines across 15 sources;
workspace types, lint/boundaries, format and spec/trace checks pass. No complete
ledger rerun, branch/mutation certification, cloud test or release closure is claimed.
Two isolated build-valid controls removed scope protection or acquisition amount
equality; the focused tests failed in each case and pass on the restored source.
These sensitivity checks are not a mutation score. Source SHA-256:
`8ee43acc9259b9008fd6dea8d3c844066b29303ab1bb41d15826990861571226`.
Logs: `/tmp/rastrata-owned-compiler-{kernel-final,coverage-final,types-final,spec,trace,lint,format}.log`
and `/tmp/rastrata-owned-control-{scope,money,restored}.log`.

## Owned inventory command topology — 2026-09-07

The kernel model now defines the prospective eighteenth command variant,
`PostOwnedInventoryTransactionCommand`; the runtime still has seventeen. Its
closed acquisition/issue input union specifies explicit operation order, stable
identities, policy/coordinate selections, exact economic inputs and optional real
journals. Selection comes from the complete authenticated pool, not client layer
allocations. Source anchors/positions and same-command successors are derived,
not accepted as replacement input authority. One ownership effect, all economic
lot deltas and precisely the admitted journals share one revision and atomic head
CAS. Zero-money allocations have no fake posting, and a balanced nonzero journal
cannot be omitted just because its signed sum is zero.

The self-audit resolved two model gaps: legacy `LotAllocation.reducingSource`
stays required while ownership quantity allocations project from immutable
movements; and a managed inventory money scope protects account/functional
commodity/dimensions across **all** units commodities, including after depletion.
Otherwise a currency-unit write-down or generic reversal could bypass ownership.
Raw journal, lot, transfer or correction paths must fail closed when they lack the
corresponding ownership transition. The contract does not quietly disable these
capabilities for a finished product: transfer, correction, value adjustment,
backdated recosting, legacy adoption and multi-coordinate selection remain required
work before business deployment. This initial closed command does not claim them.

Reference check: Beancount at `9747213802acb733ce53acc6e963f5961f47d6cd`,
`beancount/parser/booking_full.py` (reduction booking against prior balances) and
`beancount/core/inventory.py` (structural currency/cost keys, deletion of empty
derived positions). Rastrata deliberately makes intra-command ordering explicit
and retains depleted identities/ownership history separately from live balances.
These are design comparisons, not equivalence claims or reference-engine failures.

Verification: both models and the combined workspace pass licensed SysIDE with
zero diagnostics and its controls. Spec/trace checks, workspace types/lint/format
and four tooling tests pass. Five isolated declaration controls detect removal of
operation ordering, mandatory journals, an ambiguous second journal input, a
posting dependency on quantity-only allocations, and weakening of the legacy
allocation shape. These are bounded model checks, not accounting execution tests.
Evidence: `/tmp/rastrata-owned-command-{syside-final,spec-final,trace-final,tooling,types,lint,format}.log`.
Kernel model SHA-256: `c7bf4f1633864d96e8c745b4b72a2245dbb285c0cc905071bdf520cece1cf9cb`.
No runtime accounting behavior, fixture bytes, deployment or release status changed.
Next implementation must connect the typed command, canonical ownership effects,
strict codecs, permanent scope guards and complete replay together; the disabled
indexed format needs an explicit catalog/source mapping change, not silent expansion.

## Monetary-independent coordinate validation — 2026-09-07

`journal.ts` now shares account activity, commodity and analytic-member validation
between ordinary journals and an explicit accounting coordinate without journal ID,
posting ID, ordinal, monetary amount or quantity. The standalone caller must supply
the applicable resolved policy's required dimensions; posting-ID overrides are not
invented for a movement. Complete snapshot validation and book/functional-commodity
isolation still apply. Ordinary journal diagnostic wording/order and nonzero-posting
rules are preserved. This is a prerequisite, not quantity-only command admission,
an indexed chart reader, policy authority or canonical ownership publication.
ACC-039.8 and the other three open requirements remain pending.

Verification: 357 kernel tests / 59,304 assertions, plus three tooling tests;
kernel coverage gate 100% functions and lines across 14 production sources;
workspace typecheck, lint, format, model/spec/trace checks and licensed SysIDE pass.
The scoped ledger rerun passed four source-identity/adoption/restart tests (183
assertions), plus two frozen allocation/inventory projection tests (10 assertions).
All eight historical fixture checksums are unchanged. The complete ledger suite,
release mutation campaign and production capacity tests were not rerun here.

Two independently applied build-valid controls in an isolated source copy disabled
account admission and required-dimension checks. Both failed the new coordinate
tests and existing journal tests. The restored copy matches production byte-for-byte
and passes all 19 journal tests / 55 assertions. These are sensitivity checks, not
a mutation score. Production journal SHA-256:
`bc4103db34d36456b0a7ff00f90cd414209a3fdc59155c0a5f381c728703c5dc`.
Evidence logs: `/tmp/rastrata-coordinate-{kernel-final,coverage,types-final,spec,trace,syside,ledger-final,legacy-ledger}.log`
and `/tmp/rastrata-coordinate-control-{account,dimension,restored}.log`.
`check:release` still exits 1 at ACC-038 and ACC-039.7/.8/.9 before the later
release checks. No new command/profile was enabled and no deployment occurred.

The original milestone below is historical evidence for its recorded model hashes.
The [archive publication extension](#archive-publication-model-extension) records
subsequent G1 changes; the original milestone does not certify the full new design.

## Decisions and rejected alternatives

| Decision | Selected design | Reason / rejected alternative |
|---|---|---|
| Authority | One SQLite-backed Durable Object posts each book; kernel alone decides accounting | Do not build a second posting engine or a distributed cross-book transaction |
| Durable format | Versioned genesis plus compact immutable command/original-result records and optional kernel revision | Repeated full snapshots are a prototype expedient, not the target storage representation |
| Physical recovery | Platform SQLite transaction/recovery; logical Oseq and complete-head verification above it | No custom filesystem WAL, replication protocol, or application sealed segments |
| Identity | Trusted tenant/book/namespace/object/generation, client-stable command ID and canonical content | No server-generated replacement ID on retry, no identity TTL, no bypass for replay |
| Publication | Atomic full-head CAS, then confirmed durability, then receipt/cache publication | SQL return alone is not the acknowledgement boundary; rejected outcomes participate in CAS |
| Readiness | Recovery includes retained rejections, full protocol and complete final head | Checking balanced journals or financial revisions alone misses rejection-only loss |
| Checkpoints | Optional complete state/protocol cache at a verified full head; retain complete canonical log | No balance-only pruning, no deleting exhausted lots/settled items or retry identities |
| Controlled restoration | Fence ingress, drain in-flight work, sync, capture expected head externally, restore and verify exact head before release | Same-database hashes cannot detect a complete rollback. Do not silently lower the expected cutoff |
| Application boundary | Authorized typed command API and pinned history pages | Bank feeds, invoices, auth-provider implementation, external delivery and report presentation remain outside |
| Version changes | Explicit supported format mapping under maintenance, preserving all canonical outcomes; unsupported versions unavailable | No automatic migration to whatever code happens to be deployed; no reinterpretation of old accounting |
| Capacity | Positive enforced profile, bounded queue/pages and measured kernel aggregate costs | Do not treat per-record limits or pagination as proof of enterprise capacity |

The external catalog and restore-permit interfaces are application/control-plane
dependencies, not new financial authorities. This design does not introduce a
synchronous external witness on every posting. Its restore guarantee applies to
the controlled procedure below, not arbitrary undetectable rollback of all copies.

## Boundary details needed by implementation

**Admission:** the public decoder is distinct from the prototype's typed object
copy. Reject duplicate JSON keys, trailing data, unknown fields, tags and versions,
unsafe or noncanonical counters, excessive depth/nodes and full encoded byte size.
Verify every imported kernel command variant. Frozen supplied command times and
expected revision are part of retry identity. Authority context cannot be supplied
by the caller; recheck membership and actor scope on dequeue. A revocation after
that admission does not retroactively undo the command.

**Publication:** a successful transaction selects the new logical order, but a
client receipt requires durability confirmation. Definite rollback leaves no new
outcome; unknown write status makes the instance unavailable until recovery. The
queue spans asynchronous durability and releases on failure without retaining
candidate state. Full-head conflicts preserve the exact original command across
bounded reevaluation. Financial state is unchanged for retained rejections; Oseq
and retained protocol still advance. Every operation consumes SQL cursors before
yielding.

**Restoration:** external catalog maintenance status is set before scheduling the
per-book fence barrier. Existing admitted work drains; later commands and reads
cannot bypass maintenance. After sync, persist a permit containing the complete
cutoff and current fence generation outside the book restore set. That external
fence survives database rollback and object restart. Restore uses the same book
identity; verify the restored snapshot and complete tail against the permit, then
conditionally release the current external fence. If release fails, remain
unavailable. Startup consults the current catalog, not merely a restored local
"ready" flag. An older or missing permit cannot authorize a writable branch.

**Provisioning:** reserve exact identity and genesis in the external catalog first.
Reserved operations may resume identical provisioning; activate the catalog only
after durable genesis. An already-active catalog entry with missing book storage
is damage, not a new book. Book generation and maintenance fence generation are
different concepts; an ordinary restore does not change financial identity.

**History readers:** first page pins a complete head; remaining pages keep that
cutoff despite concurrent newer writes. Cursors are validated against identity,
format and canonical head. Each page exposes stable book/generation/Oseq keys,
including rejected outcomes. Consumers own their delivery cursors and side-effect
deduplication; no exactly-once network delivery is promised.

**Capacity:** retain a complete kernel aggregate for evaluation; neither a smaller
record nor a checkpoint removes existing full-state validation/hashing costs. The
profile must bound total history, aggregate bytes, queue and individual requests.
At a limit, new outcomes fail before publication and existing retries remain
available. If the required workload cannot fit those bounds, a separately reviewed
kernel representation change is necessary; this design does not silently authorize
it. Production workload/SLA and backup retention decisions await owner approval.

## Evidence reviewed and limits of transfer

Pinned checkout identities are recorded in the [source register](../../../docs/reference/source-register.md).
No new reference repository or upstream version was introduced for this review.

| Source | Observed evidence | Adoption / non-adoption |
|---|---|---|
| `references/tigerbeetle/docs/coding/reliable-transaction-submission.md` | Persist client identity before submission and reuse it through client/network restarts | Stable retry identity; do not claim TigerBeetle's replication guarantees for our service |
| `references/tigerbeetle/docs/coding/system-architecture.md` | Distinguishes trusted API responsibilities from ledger processing | Keep auth/workflows outside accounting; our control-plane restore dependency has a separately stated cost |
| `references/tigerbeetle/src/testing/storage.zig`, fault options and crash model | Explicit read/write/crash fault classes and assumptions | Define modeled faults and limits; local simulation is not proof of a provider-wide outage |
| `references/bigcapital/packages/server/src/modules/Ledger/LedgerStorage.service.ts`, `commit` | Entry and associated balance persistence share a supplied transaction | One complete accounting publication; do not copy mutable delete/revert paths into frozen history |
| `references/bigcapital/packages/server/src/modules/ManualJournals/commands/CreateManualJournal.service.ts`, `makeJournalEntries` | Workflow DTO preparation and transaction-scoped journal creation are distinct responsibilities | Application translates workflows; ledger receives complete commands. This is not a full audit of Bigcapital event delivery |
| `references/gnucash/libgnucash/backend/sql/gnc-sql-backend.cpp`, load and save paths | Ordered object loading, transaction boundaries, rollback and readonly paths | Explicit recovery/readiness and readonly maintenance; do not adopt load-time modification as silent canonical repair |

Ledger, hledger and Beancount remain accounting references already studied for the
kernel. No fresh claim about their persistence behavior is made here. Existing
kernel capability fixtures remain the accounting oracles for L11; their semantics
are not reimplemented by the scalar design checker.

Primary documentation checked on 2026-09-05:

- [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): transactional storage, synchronous cursors, durability synchronization and bookmark-based restoration. These are platform assumptions to test in the deployed runtime.
- [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/): lifecycle and initialization controls; no unbounded recovery hidden in constructor gating.
- [Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/): resource ceilings are inputs to the profile, not our supported workload.
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html) and [corruption hazards](https://www.sqlite.org/howtocorrupt.html): physical transaction assumptions do not justify a custom Rastrata WAL or prove independent disaster recovery.
- [SysIDE project configuration](https://docs.sensmetry.com/editor/configuration/): first-party model discovery is explicit in root `syside.toml`; research checkouts are excluded.

## Adversarial audit and repairs

| Finding | Resolution / evidence |
|---|---|
| Valid SysML could still acknowledge before durable confirmation | Explicit awaiting-durability state and Boolean requirement; unsafe-ack model control must fail |
| Oseq alone did not bind retained-rejection versus financial-revision classification | Added `RetentionClassification`, bound to the typed kernel decision; negative rejection-with-revision fixture |
| Startup could verify history yet ignore the independent maintenance fence | Added catalog/fence readiness conditions and negative fixtures; restoration procedure requires external conditional release |
| Lifecycle omitted storage failures during reads/evaluation/recovery | Added three unavailable transitions and two damage transitions, with concrete traces |
| Structural requirement coverage could misbind a fixture to an unrelated requirement | Checker compares fixture requirements to the actual SysML verification objectives; misbinding control fails |
| Cross-file imports might work only in a concatenated test model | Gate additionally checks the original editor workspace with an in-memory unresolved-reference canary; no source edits |
| Provisioning originally shared a receipt requiring an accounting result | Added separate typed genesis receipt/response; catalog activation remains resumable and readiness is distinct from durable genesis |
| A green design check might be mistaken for completed runtime tests | All sixteen runtime obligations explicitly remain `not-closed`; a control rejects changing that status in design evidence |

## Verification scope and remaining gates

The bounded checker evaluates the scalar constraint expressions and guarded
transition definitions extracted from this model, rather than maintaining a
separate transition implementation. It requires both scalar polarities, every
transition, every guard's false path and every state, and rejects unsupported
syntax. It is **not** a general SysML interpreter, a formal proof over arbitrary
concurrent histories, or evidence that the SQL implementation satisfies these
requirements. The requirement/objective catalog check is structural traceability.

The full model is checked separately by SysIDE's semantic language server, with
positive, syntax-error and unresolved-reference controls. The installed standalone
`syside check` command requires an unavailable Modeler license; it is not counted
as a successful check. The working editor-server path checks both the combined
dependency model and the actual workspace imports and supplies real diagnostics.

Trust assumptions: authorized gateway/catalog, platform transaction durability,
and restricted direct database/restore access. Hashes detect inconsistent history
relative to a trusted head; they are not signatures and cannot stop a privileged
actor rewriting both data and authority. Coordinated loss/rollback of the book and
external restore authority requires disaster reconciliation and cannot be certified
away by a local test.

The runtime still owes L01–L16 conformance, compact codecs/storage, verified
checkpoint implementation if enabled, capacity enforcement/measurements,
authorization integration, backup/upgrade drills and remote fault testing. A model
release does not close those obligations or imply 100% ledger code coverage.

## Design milestone verdict

The bounded design milestone is complete and ready to guide implementation under
the stated assumptions. The self-audit findings above were repaired and the checks
rerun. This is not a freeze or completion verdict for the production ledger code,
nor an independent audit or proof of every possible concurrent execution.

Verified in the working tree on 2026-09-05:

- SysIDE editor server 0.10.3: zero diagnostics for the dependency-loaded model and
  the original editor workspace; valid/syntax/unresolved-reference controls pass.
- 13 requirements and 16 matching verification objectives/implementation obligations.
- 12 executable scalar constraints, 48 exact scalar cases, 10 lifecycle traces
  covering all 10 states and 24 transitions, and false-path tests for all 12 guards.
- Five deliberately unsafe model controls rejected; 12 checker adversarial tests pass.
- Root `bun run check` passes: 19 prototype ledger tests, 198 kernel tests,
  tooling checks, kernel 100% function/line coverage, and 102 kernel trace bindings.
- No new full mutation/release run is claimed; the working tree is uncommitted.

Content identities (SHA-256 of exact UTF-8 files, not kernel accounting hashes):

```text
rastrata-production-ledger.sysml
c52f5454ea2b264c63e280758760d7252b7365126f6ff457d9ca67ae49e9c15d
verification-cases.json
c2eb81e00639f6c167b60690f33e0f7b022d98bc3589f21d01788dfc741a84ff
```

The checker prints fresh artifact identities on each run. Any subsequent model or
fixture edit needs new validation; these values do not certify changed files.

## Capacity-driven representation trade study — G1 in progress

This follow-up does not amend the normative model or claim another design closure.
The [workload proposal](workload-contract.md) and
[measured index experiment](../../../docs/reference/reviews/ledger-capacity-2026-09-05.md#follow-up-permanent-retry-index-layout-experiment)
now constrain the next design. Their numerical acceptance targets remain proposals.
The original complete-aggregate implementation boundary is not sufficient for them.

### Storage placement

| Candidate | Benefit | Unresolved cost / decision |
|---|---|---|
| All canonical history and current state in one SQLite DO | One storage transaction and simple local reads | Historical payload sensitivity already exceeds the documented capacity for proposed inventory volumes; compact codecs alone do not establish a fit |
| One posting DO, SQL current state and all permanent locators, R2 immutable history | Preserves one financial authority | Full identity inventory rules out the flat full-digest-per-key local representation at proposed 2x inventory volume; command-only measurements omitted most keys |
| One posting DO, bounded SQL current state/hot indexes, authenticated cold indexes and history | Preserves one financial authority while moving historical index growth out of its SQLite | Bounded lookup/absence proofs, publication/recovery, cold-read latency, current-state fit, compaction and historical index reachability require an executable design |
| One posting DO with additional index/state shards | Can expand beyond a single database | More independent failure points, routing, consistency and migration contracts; not justified solely by the naïve text-index estimate |
| A different primary transactional database | Could simplify larger-book storage instead of building a custom database atop blobs | Changes the selected deployment/persistence boundary; requires explicit owner review and a measured comparison, not a silent platform switch |

The [full identity sizing](../../../docs/reference/reviews/ledger-capacity-2026-09-05.md#follow-up-all-permanent-identity-families)
supersedes the earlier command-only headroom inference: at least 410,968,312 logical
keys at 2x inventory volume would require 13,150,985,984 bytes for separate full
SHA-256 keys alone. This is conditional representation arithmetic, not a measured
combined registry or a rejection of one posting authority. No physical layout is
selected. Next compare bounded cold-index storage with additional storage shards;
include read/write amplification and failure semantics, not just smaller rows.
An exact retry still needs original canonical evidence; a missing pointer must not
allow a duplicate command. The existing SQLite experiment measured storage shape,
not secure absence proofs or recovery.

Bounded reference input: TigerBeetle at
`97c7a8ef385270ebe0e1b75959d3d21d134629df`, `src/lsm/manifest.zig:25–80`, carries
table checksums, key bounds, counts and snapshot visibility. Compaction output is
not query-visible until its visibility boundary; readers retain the input tables
until then. Its `docs/coding/system-architecture.md:44–60` also separates immutable
type metadata from transfer execution. Adopt the review questions—complete manifest,
pinned visibility and no unrelated metadata fetch—not its full LSM implementation,
replication guarantees or performance claims. A manifest hash still cannot prove
that every referenced cold object remains available.

### Cold index versus storage shards: bounded decision

Neither candidate may weaken permanent identity checks or make SQL/R2 absence
authoritative merely because a request returned successfully.

| Question | Immutable authenticated cold pages | Additional SQLite storage shards |
|---|---|---|
| Financial authority | Posting DO alone chooses the candidate and publishes its complete head/root | Same; shards must not admit accounting commands independently |
| Negative identity lookup | Verify the complete selected ordered path against an anchored root; missing required page is unavailable, not absent | Ordinary `NOT EXISTS` does not detect a removed identity row. Need equivalent authenticated evidence or an explicitly reviewed weaker storage-fault model |
| Publishing several identity families | Write selected immutable pages before publishing the one candidate root/manifest; interrupted preparation cannot change visible membership | Prepare immutable/versioned shard changes, then publish one complete directory/version vector; partial shard application cannot expose a mixed snapshot |
| Growth | Historical index bytes leave the posting DO, but directory/cache/live-state bounds and old generation retention still matter | Route/split before shard exhaustion; pin directory versions, dual-generation reads and failed-split recovery |
| Additional cost | Cold page fetches, hash verification, page rewrites, splits/compaction and safe reclamation | RPCs, shard lifecycle/placement, prepared-state recovery, authenticated lookup and directory transitions |

Decision for the **next experiment only**: test immutable packed pages before
implementing storage shards. Sharding does not eliminate the integrity mechanism,
and adds distributed preparation/visibility concerns. This is not a production
storage selection or permission to build a general-purpose database.

The [static layout experiment](../../../docs/reference/reviews/ledger-capacity-2026-09-05.md#follow-up-authenticated-cold-index-layout)
now demonstrates exact sorted lookup and gap verification relative to a trusted
root, with deleted/changed page controls, at up to 300,000 synthetic identities.
It measures 4/8/32 KiB pages, **not** incremental writes, R2 latency or business
command execution. Full audit explicitly detects damage that an unrelated lookup
does not; PL-007/PL-008 remain unchanged.

The [incremental experiment](../../../docs/reference/reviews/ledger-capacity-2026-09-05.md#follow-up-incremental-index-updates-and-retained-generations)
now compares both strategies with exact historical snapshots and interrupted page
preparation. It rejects neither architecture outright: sorted runs greatly reduce
measured writes but add lookups and merge spikes; copy-on-write needs a reviewed
derived-page retention policy. No production publication or reclamation is proven.

The next executable gate is bounded hot/cold publication: use a fixed bounded hot
batch and pinned immutable cold root; test duplicate admission across both, complete
batch freeze/merge, publication at every failure point, reader visibility and
recovery of the exact selected root. Measure total bytes written and retained across
multiple generations, not only the final compact tree. Compare a paged copy-on-write
update with bounded streaming sorted-run merging before choosing either; full-tree rebuilding
per command is disqualified. A useful static packing result alone does not justify
adding either mechanism to production or claiming bounded end-to-end posting.

### Accounting state access, integrity and compatibility

Current source evidence: `book.ts:hashBookState` encodes journals, lots, holdings,
allocations, accounting state and configuration history. Command admission searches
`protocol.retainedResults`; `validateBookState` and `validateBookProtocol` check full
aggregate relationships; `codec.ts` encodes that whole structure. Merely changing the
SQL adapter therefore leaves the growing kernel work intact.

Before implementation, specify these contracts together:

1. **Pinned read dependencies:** every command receives the exact configuration,
   period authority, identity existence results, balances, lots, open items and
   historical references it needs at one complete head. A partial array is not a
   complete population. Point lookups, ranges and population-wide calculations need
   typed completeness evidence and independently tested selection semantics.
2. **Publication:** return exact immutable effects and derived-state/index updates;
   publish all together under full-head CAS. The ledger cannot add a second tax,
   inventory, settlement or closing calculator. Cache invalidation and cold lookup
   behavior are part of the design, not afterthoughts.
3. **Hash compatibility:** a new incremental representation cannot be presented as
   the existing whole-aggregate hash. Preserve old bytes/receipts and define any new
   format/domain plus its verification mapping. Do not change historical hashes to
   make differential tests pass. Small-book exact accounting comparisons remain;
   new representations need independent large-book checks too.
4. **Readiness and damage detection:** PL-007/PL-008 currently require complete replay
   before readiness. A cached head or successful point lookup does not prove that all
   old bytes and retry entries exist. Compare complete startup verification against
   an explicitly authenticated state/index checkpoint and verified tail, with stated
   trust assumptions, full-audit schedule and detection latency for untouched damage.
   If the latter changes the guarantee, review and amend the model before coding it.
5. **Expansion:** measure the current-state/index/integrity metadata that the minimal
   layout omitted. Exercise an expansion or migration before high-water exhaustion,
   preserving all outcomes, receipts, access controls and the single posting authority.
   Hashing long IDs does not eliminate indefinitely growing row counts.

### R2 durability and acknowledgement tradeoff

R2 is the candidate backup store requested for consideration by the owner. Its
[Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
supports conditional writes and returns `null` when a write precondition fails.
[Strong consistency](https://developers.cloudflare.com/r2/reference/consistency/)
does not provide a transaction across an R2 object and a SQLite transaction. All
options below require bounded timeouts, explicit uncertain outcomes, and the same
stable command ID on retry. No R2 resources have been provisioned for this study.

| Acknowledgement contract | Required ordering | Consequence |
|---|---|---|
| SQL durability with asynchronous independent backup | Atomic SQL publication and sync, acknowledge, then advance a verified contiguous backup cutoff | Ordinary crash durability can hold; destruction of the primary store may lose the unbacked tail. A five-minute timer is not proof of a five-minute recovery point during backlog or outage |
| Every acknowledgement recoverable if SQL is lost but R2/restore authority survive | Do not acknowledge until exact command/result/effects and their canonical commit membership are durably recoverable independently of SQL | R2 enters the acknowledgement availability/latency path. A successful payload upload alone does not prove a committed outcome or a complete chain |

Recommend evaluating the stronger contract first; it matches the expectation that
an acknowledged posting is not later forgotten. This is an engineering recommendation,
not owner approval of an RPO/SLA or proof against simultaneous loss of all copies.
An asynchronous alternative must remain explicitly weaker. PL-011's controlled
exact-head restore cannot silently turn into an older-prefix restore; disaster loss
outside that contract would require an explicit reconciliation/authority procedure.

For the stronger option, design a recoverable publication protocol rather than two
unrelated successful writes. Keep a durable selected candidate and suppress visibility
until the specified publication boundary. Publication evidence must bind book identity,
fence generation, complete prior/resulting heads, exact bytes and outcome classification.
Recovery must distinguish a canonical decision from a prepared but abandoned object.
One account losing both SQL and R2 remains outside the surviving-backup assumption.

Concrete counterexamples the executable model must reject:

| Fault / unsafe shortcut | Required observation |
|---|---|
| SQL commits, client is acknowledged, SQL is destroyed before R2 upload | This is an acknowledged loss under the stronger contract; cannot pass merely because ordinary restart works |
| R2 payload exists, but the local CAS lost to another command | The payload is not sufficient evidence of canonical membership; do not replay an orphan as a committed transaction |
| R2 upload/publication response is lost | Reconcile the exact candidate and independently verified commit status; do not allocate another Oseq or return a fabricated definite rejection |
| R2 commit evidence is durable, final SQL/cache update did not complete | Recover the exact selected outcome; do not evaluate the same ID again under newer policy or expose an older writable head |
| Old ID pointer is removed, misdirected or hash-collides | Refuse unsafe evaluation/replay; resolving a locator must check exact original identity/content, and missing-index detection needs a complete integrity design |
| Backup contains every financial revision but omits a rejected tail | Full Oseq/head verification fails even though the trial balance matches |
| Archive head appears complete while a referenced middle object is absent | Detect missing canonical content under the stated verification boundary; a head checksum alone cannot certify all objects are present |
| A stale object instance or restore generation tries to publish | Current fence/full-head authority blocks it; append-only object names alone do not implement fencing |

The next G1 deliverable is a reviewed typed protocol and executable failure cases
for the selected visibility/recovery boundary, plus a complete command-dependency
inventory. These unresolved items prevent runtime representation implementation;
the experiments above are design evidence, not permission to weaken the model.

## Archive publication model extension

Status: bounded model extension verified during G1; not a complete representation
design, launch policy approval, runtime implementation or independent audit. The
kernel model and runtime accounting semantics were not changed.

The existing ledger model now includes PL-014–PL-016 and L17–L19 for declared
durability, canonical archive publication and exact reconciliation. A pinned
`DurabilityPolicy` distinguishes SQLite-only acknowledgement from the stronger
archive-required guarantee. This permits comparison without silently promising
zero primary-loss exposure for an asynchronously backed-up deployment. It does not
introduce two accounting kernels or permit policy downgrades after a receipt.

Typed genesis/commit manifests, archive anchors, selected candidates and evidence
connect exact original commands/results/effects to full heads and fence generations.
Archive genesis is anchored at Oseq zero; it is not a fabricated retained command.
All states, locators and manifests still require the existing identity, exact-format
and complete recovery checks; this extension does not resolve incremental state roots,
archive indexing, complete hash compatibility or bounded startup.

The archive sub-lifecycle reserves one candidate, verifies uploaded bytes, conditionally
publishes the archive anchor, finalizes local SQL state/indexes, and verifies the
receipt before releasing its reservation. Public book readiness requires the archive
sub-lifecycle to be idle with no pending selection. Its `ReceiptReady` event does not
mean network delivery; the outer book lifecycle still controls service readiness and
acknowledgement. A disconnect cannot undo an already canonical archived decision.

The self-review found and repaired four integration gaps:

| Gap | Model correction |
|---|---|
| Treating local SQL finalization conflict like an ordinary pre-commit CAS retry could reevaluate an already canonical archive decision | `CommitOutcome` distinguishes SQL-only admission conflicts from archive-required finalization; the latter must reconcile/quarantine, never reevaluate |
| Independently valid book/archive state diagrams could still expose ready while a candidate remained pending | Added `ArchiveServiceReadiness`, including every non-idle phase and the contradictory idle-plus-pending case |
| Backing up outcomes without independent genesis/policy could make primary-loss recovery impossible | Added archive genesis manifest and resumable create-only initialization before acknowledged provisioning/catalog activation |
| Rotating only the archive fence could disagree with the external catalog or wrongly invalidate old manifests | Keep catalog maintenance across resumable rotation and require generation agreement before abandonment/release; historical manifests retain their original authorized generation |

For abandonment, a read of the old anchor is insufficient: a delayed conditional
publication may still succeed later. Confirm a fence-only anchor replacement at the
unchanged prior full head first; if publication won instead, the old-head fence must
fail and recovery finishes that exact committed result. A higher-generation fence
cannot justify abandoning a result already canonical at a different head.

Verification evidence and limits:

- The bounded checker now parses **every** flat state-machine definition rather than
  extracting only `BookLifecycle`. Each trace names its machine; uncovered machines,
  unknown syntax, duplicate states/guards/transitions/parameters and malformed cases
  fail the gate. This fixture schema revision does not change financial encodings.
- At this archive-only milestone: 17 scalar constraints, 94 scalar cases, two machines with 18 states/40 transitions,
  false-path checks for all 21 guards, 18 lifecycle traces, 16 requirements and 19
  explicitly `not-closed` runtime obligations. Twelve unsafe-model mutations are
  rejected, and 18 checker unit tests pass. These are bounded cases, not exhaustive
  state-space/model-composition proofs or semantic runtime traceability.
- Four tests in `test/archive-storage.test.ts` exercise actual local Miniflare R2
  bindings: one CAS winner, stale publication rejected after a confirmed fence,
  unsuccessful old-head fencing after publication won, and payload orphans not moving
  the anchor. Their deliberately discarded write response is not real network fault
  injection, and their synthetic anchor bodies are not the production codec.
- The pinned Miniflare conditional type misidentifies its R2 binding as a Request in
  this Bun typing environment. The test uses a minimal structural API with a runtime
  method check; calls still reach the real local binding. No fake R2 implementation
  or additional production dependency was introduced.
- SysIDE editor server 0.10.3 reports zero diagnostics for the extended model and
  original imported workspace; valid, syntax-error and unresolved-reference controls
  pass. This is the working licensed editor-server path, not a standalone Modeler
  license claim. The checker emits exact fresh model/fixture hashes on every run.

The subsequent [state-access audit](state-access-contract.md) inventories all seventeen
command variants and shared journal/lot/reporting dependencies. It also reproduced
G1-INV-01: unrelated inventory accounts prevent otherwise valid value adjustments.
That finding is repaired with explicit algorithm 1.0.1 and legacy 1.0.0 replay;
the linked audit records exact kernel, SQLite and targeted mutation evidence.

Still open in G1: executable read-set conformance, incremental integrity/absence checks,
complete index storage sizing, history/locator lookup representation, hashes/legacy
migration, business-event atomicity and complete large-population calculations.
Before production, test the
whole implemented protocol under real process/network/storage faults and approved
remote primary-loss restoration, not just the R2 primitive operations above.

## Indexed-view model extension

PL-017–PL-020 and L20–L23 now specify the hot/cold boundary, independent of whether
the final implementation uses copy-on-write, sorted runs or storage shards. These
are normative design obligations, **not** a selected physical codec, implemented
maintenance subsystem, full design closure or permission to delete deployed data.

The model separates permanent canonical outcomes/receipts from rebuildable index
pages. An `IndexedView` binds full book identity, canonical head, view revision,
fence, cold prefix and exact recent-outcome interval. `IndexRoot` hashes its complete
versioned descriptor, including an explicit empty-root representation. Hot and cold
cover every indexed identity family; even a nonempty hot set is invalid if it has
fewer command identities than the covered outcomes. Population equality is only a
necessary check: exact original identity/source closure remains a runtime obligation.

Concrete cutover cases freeze through Oseq 42 over a cold prefix through 40, then
preserve rejection 43 and later appends through 45. A cutover uses freshly observed
full-head and view-revision CAS, verifies the same frozen cold base, and increments
only viewRevision. Canonical Oseq, financial/configuration/state/protocol heads and
all receipts stay identical. Another cold cutover invalidates the stale base;
concurrent ordinary appends instead require preserving and rechecking their tail.
Unresolved accounting selection blocks installation. Unknown durability reconciles
the exact stored view without running a substitute accounting command.

Reader and construction pins are registered before use and bind their original
verified cutoff. New admission serializes with retirement. Expired pins and cursors
cannot resurrect retired views or silently switch snapshots. The reclamation contract
protects current, reader, construction and publication graphs. During marking, new
references must come from pinned input graphs or fresh physical locations in the
collection epoch; losing this barrier invalidates the mark. Retirement selects an
exact derived-only set durably. Later deletion cannot expand that set or reuse a
retired physical location, even for identical content. This protects against a late
delete reaching a newly reused location. Canonical evidence and checkpoints are not
eligible merely because they share an object store with derived indexes.

Audit corrections made before recording this extension:

- Added an explicit expected-full-head comparison, not merely equality of before
  and after heads; an unchanged but wrong head is still an invalid cutover.
- Added the nonzero-but-insufficient hot identity bound, plus a failing fixture.
- Added a reference barrier during marking, not just a liveness check followed by
  asynchronous deletion. New references cannot invalidate an old mark silently.
- The first SysIDE run rejected `view` as a reserved identifier in two declarations.
  Both now use `indexedView`; the actual editor-server checker then reports zero
  errors/warnings, with valid/syntax-error/unresolved-reference canaries passing.

The bounded model checker now covers 21 scalar constraints, 150 concrete scalar
cases, the existing two machines/18 states/40 transitions, 21 guard negatives,
18 lifecycle traces, 20 requirements and 23 explicitly `not-closed` runtime obligations.
Twenty unsafe-model controls are rejected (eight added for this extension); 18
checker unit tests pass. The added scalar cases do not execute set membership,
graph reachability, concurrent scheduling or real storage. Boolean evidence must be
derived from verified implementation results, never caller assertions. Existing
page/index experiments supply narrower byte/preservation evidence, not conformance
to these new protocol requirements.

The non-reusable physical location rule has a cost: the existing experimental branch
format stores child digests without separate physical addresses. Its byte estimates
omit the location/epoch information needed here. Measure that overhead and an actual
bounded merge builder, hot-set integrity, pin/retirement metadata and reclamation
work before selecting a production layout. The experiments are not to be relabeled
as a complete capacity demonstration.

PL-007/PL-008 still require complete recovery verification before readiness. This
extension does not settle bounded startup trust, new kernel hash/codec mapping,
large-population accounting calculations or workflow atomicity. Those remain G1
gates alongside executable hot/cold publication and safe reclamation.

## SQLite index-control component

`src/index-control.ts` now implements storage-side control metadata through the
existing `SqliteStorage` port. It remains internal and is not wired into
`ProductionLedger` or exported from the package entry point. This is a component
implementation, not closure of L20–L23 or a replacement for the prototype's full
snapshot execution/recovery path.

The component stores a bounded, exact-shape, versioned record containing a view
and optional frozen prefix. Canonical JSON comparison rejects duplicate keys and
noncanonical stored encodings even when their checksum is recomputed. Counters are
canonical decimal strings, roots/anchor commitments have exact digest shape, and
empty roots have an explicit domain-separated representation. These are metadata
checks; a local checksum cannot establish external authority or protect against a
consistent rollback of every copy.

The synchronous owner anchor port supplies the current full identity/head commitments,
Oseq, fence, provisioning status and pending-accounting status. It must be backed by
the same canonical transaction plus the trusted control-plane contract, not request
fields or a stale independent cache. An append executes the owner's synchronous
canonical SQL callback and advances the hot-index metadata in one transaction. No
nested transaction or asynchronous callback is permitted. A cutover verifies fresh
view CAS and exact frozen-prefix selection, preserves the newer tail count, advances
only view revision and clears the prefix. Initialization requires reserved genesis;
missing active metadata is not silently initialized again.

Mutation failures leave the instance gated until explicit metadata reconciliation.
Successful SQL is not returned as durable success until `sync` completes. Both
reads and writes capture their exact metadata snapshot **before** awaiting sync;
loading a newer row afterward could otherwise return a different unconfirmed write.
Recovery returns the actually stored view and prefix without reapplying an append
or an accounting command. It is metadata recovery, not the full PL-007 recovery gate.

Evidence:

- Nine dedicated tests, 66 assertions, with the real Bun SQLite engine. The fixture
  uses a synthetic canonical-anchor table to test transaction participation; it
  does **not** execute real kernel accounting commands through this component.
- Cases cover atomic canonical/index rollback after either update, stale views and
  prefixes, lost/inflated tail counts, unresolved posting, duplicate JSON keys,
  invalid/forged metadata, missing rows, wrong identity/fence/head, and the
  read-before-sync concurrency race. The one-identity tail models a retained
  rejection's ID contribution; it is not an end-to-end rejection test.
- A file-backed WAL/FULL-synchronous test closes and reopens SQLite after injected
  lost freeze/cutover confirmations. It finds the exact prefix/installed view and
  unchanged synthetic canonical anchor. This is graceful reopen after an injected
  response failure, **not** power loss, process kill or remote fault injection.
- The dedicated run measures 100% functions and lines in `index-control.ts`.
  This does not imply all branches, full ledger coverage or production readiness.
- Six independently isolated, TypeScript-checked guard mutations are killed by
  assertion failures: stale-view admission, lost-durability gating, duplicate JSON
  acceptance, stale fence, inflated tail and pending-accounting cutover. The first
  temporary build attempt lacked the workspace package mapping and produced no
  valid mutation results; after fixing the isolated configuration, the pristine
  control and all six type checks passed before testing the mutants. No real
  worktree source was mutated. This is a scoped six-control audit, not a new
  all-module mutation score.

The owner still owes exact canonical population/root/page verification before
providing roots or using metadata to evaluate commands. Matching counts alone must
not become a verification shortcut. Full target identity/head codec integration,
durable reader/construction pins, bounded hot state and merges, physical locations,
reclamation, restore authority and the actual accounting-path wiring remain open.

## Canonical identity audit oracle

`src/identity-audit.ts` adds an internal, small-book oracle for the population side
of index verification. It calls `ProductionLedger.read()` to obtain a snapshot
whose retained commands and original outcomes have been reexecuted and verified;
it does not accept a supplied canonical-state success flag. It derives identities
from those outcomes and revision effects, then independently reconciles the key
set with final canonical collections. This is not an alternative recovery path.

Every retained command, including a rejection, contributes an identity at its
original Oseq. Journals, postings, opening boundaries, close packages, lots,
holdings, allocations and the 13 accounting effect families have distinct
namespaces. Whole-snapshot lot effects preserve the **first** creation locator,
even when later commands repeat or alter a holding. The effect switch and
accounting collection mapping are exhaustive at typecheck time. Configuration
artifact IDs are version-scoped rather than globally single-use; secondary
predicate indexes such as corrected sources and schedule ordinals are outside
this population and still need their own verification.

Enumeration is compared entry by entry against a captured book/head cutoff. Equal
counts cannot hide substituted identities, wrong families, wrong books, changed
creation sequences, duplicates or omissions. Input records require exactly four
own data properties; accessors and extra fields are rejected. A concurrent later
commit does not silently move the captured cutoff. The report carries a
domain-separated population commitment and explicitly reports
`pageIntegrityVerified: false`: matching entries alone cannot authenticate the
physical root, its pages, their availability, or their binding to the full target
tenant/object/generation identity.

Evidence: eight tests and 91 assertions execute real kernel commands through Bun
SQLite. Exact manually specified populations cover activation, journals, retained
rejections, retries, close/reopen, configuration replacement, and a versioned
inventory value adjustment. The preserved pre-repair inventory book is replayed
with its original result hashes; repeated lot snapshots retain their original
locators across the policy upgrade and adjustment. Tests also cover a real source
history gap before enumeration, iterator I/O failure, malformed entries and a
concurrent committed command. These tests do **not** execute every accounting
effect family or a lot disposal/allocation; exhaustiveness checks are not runtime
coverage for those cases.

The dedicated coverage run passed all eight tests but exited nonzero under the
repository's global 100% coverage threshold. It measured 100% functions and 97.75%
lines in this module, leaving the lot-allocation insertion and unreachable-effect
fallback unexecuted; imported kernel modules also have intentionally partial
coverage in this focused run. This is not a passing coverage gate or a ledger-wide
coverage claim. The ordinary repository check runs the separate full kernel
coverage gate. `bun run check` passed with this implementation: typechecking,
lint/boundary/format checks, tests, design checks, full kernel coverage and the
102-requirement kernel trace gate. The focused ordinary test run independently
passed eight tests and 91 assertions. No SysML source changed in this slice.

This oracle retains the current ledger's complete aggregate and identity map in
memory. It is unsuitable for ordinary indexed admission or the target large-book
rebuild. Production page/root verification, bounded canonical streaming, all-family
workflow evidence, index-control integration and the other G1–G5 obligations remain
open. No runtime obligation is closed by adding this oracle.

## Authenticated index-page candidate

`src/index-pages.ts` connects a full physical-page traversal to the real canonical
identity oracle. It remains internal, unexported by the package entry point and
unwired to the posting path. The codec is a candidate implementation of the
existing `IndexPageReference`/`IndexRoot` requirements, not an approved final
storage format or a claim that L20–L23 are closed. Kernel accounting and historical
hash formats are unchanged.

Wire format and bounds:

- A page is at most 8,192 bytes. Its nine-byte header contains `RIP1`, a leaf/branch
  tag, and a big-endian uint32 row count. This domain differs from the earlier
  experiment's `RIX1` format; experiment bytes are not admitted as production pages.
- A leaf entry contains a 32-byte namespaced identity digest and uint64 creation
  Oseq: 40 bytes. The key commits the exact book ID, family, raw ID and key-schema
  domain. This candidate uses positive uint64 locators/counts, checked for overflow,
  and an explicit zero-population empty root. It does not silently truncate the
  broader model's natural numbers; adoption must enforce representation bounds
  before any canonical publication.
- A branch entry is 140 bytes: minimum and maximum key, child byte digest, separate
  32-byte physical location token, uint32 exact byte length and uint64 population.
  The version is fixed by the page representation and checked on every child page.
  Capacities are 204 leaf entries or 58 child references, with depth limited to 16.
- Physical locations have the exact form `derived/<64 lowercase hex digits>`.
  A root hashes the complete versioned descriptor, including location, byte digest,
  length and representation version. Root hashing uses the kernel canonical
  encoding, with page byte count encoded as a bigint; page digests hash raw bytes.
  Empty-root commitments match `index-control.ts`. Identical bytes at different
  locations have equal byte digests but different root commitments.

The async verifier copies each fetched page before later awaits, rejects missing,
short, oversized or altered bytes, checks exact framing and strictly ordered
non-overlapping ranges, and validates every child against its parent's population
and fences. Traversal is sequential and depth bounded, retaining the traversal
stack rather than the entire page graph. Completing a point lookup is not used as
evidence that unrelated pages are available.

`auditStoredIdentityIndex` first captures a real replay-verified canonical source,
checks the full root population, then compares every page entry with the expected
namespaced original identity and creation Oseq. Same-count substitutions and wrong
locators fail even when every page/root hash is valid. Digest collisions among
distinct canonical identities fail closed. A later commit during I/O does not
change the report's captured cutoff. This full-population audit still retains the
prototype aggregate and expected identity map; it is **not** bounded large-book
reconstruction or the ordinary indexed command path. A future point lookup must
resolve and verify the original raw identity at the selected canonical locator.

The supplied expected root hash must come from trusted, pinned view authority,
bound to the complete tenant/object/book/generation and canonical cutoff. Matching
the hash to a caller's own root is not such authority. `pageIntegrityVerified: true`
means every selected page was verified during this traversal, not that its storage
is independently durable, will remain available, or belongs to the currently
authoritative view. This module does not allocate fresh locations, prohibit their
reuse in storage, create durable pins, publish roots, implement retirement or
grant any permission to delete bytes. Those owner/storage obligations remain open.

Evidence:

- Eight page tests cover a literal independently specified leaf byte vector, exact
  schema key inputs, relocation/empty-root commitments, all-child traversal,
  unavailable/truncated/corrupt pages, rehashed malformed encodings, wrong parent
  populations/fences, duplicate/overlapping keys, strict descriptor shape, accessor
  rejection, exact 204/205 and 58/59 row boundaries, uint64 limits/overflow and
  depth 16/17. Reader I/O failures propagate without a success report.
- Two added real-ledger tests use Bun SQLite for canonical history and ephemeral
  in-memory page maps. They verify manually specified committed/rejected identities,
  valid-hash semantic substitutions, omitted populations, a missing non-first
  child page, and concurrent canonical commits. They do not prove durable page
  publication or index-control integration.
- The initial local workerd/SQLite replacement test ran the page audit in
  the Workers runtime. Its root equals a Bun root constructed from a manually
  specified seven-identity population and remains identical after runtime
  replacement. That initial harness reconstructed ephemeral pages, confirming
  runtime/byte compatibility rather than persisted page recovery. The subsequent
  SQLite page-store slice below upgrades this test to actual persisted bytes;
  neither run establishes remote Cloudflare latency, crash durability or release capacity.
- The combined page, identity and local-runtime run passed 19 tests and 188
  assertions. The focused page/identity coverage run passed its 18 tests and 171
  assertions and measured 100% functions/lines in `index-pages.ts`; it still exited
  nonzero under the repository-wide coverage threshold because the other imported
  modules were only partially exercised. This is no branch, mutation or full-ledger
  coverage claim. The final `bun run check` passed after fixing two non-null-assertion
  lint warnings in the newly added boundary test. Full kernel coverage and trace
  checks remain intact. No SysML source changed in this slice.

The new physical references have a measurable representation cost. A fully packed
shape calculation for this exact codec gives 12,223,062 tree bytes / 1,498 pages /
depth 3 at 300,000 identities; at the proposed 2x inventory floor of 410,968,312
identities it gives 16,744,166,844 tree bytes / 2,049,896 pages / depth 5. These are
**calculations, not generated or stored populations**. They exclude object-store
metadata, root records, hot data, incremental fragmentation, pins, construction,
publication and retirement overhead. The earlier experimental measurements keep
their original format and must not be presented as measurements of this codec.

## Durable SQLite derived-page store

`src/index-page-store.ts` adds append-only SQLite storage for the candidate index
pages and physically verified root descriptors. This is an internal component,
not a new public ledger API, a cold-history capacity solution or active accounting
view publication. No accounting command, receipt or historical hash is rewritten.

Provisioning explicitly creates three tables: one identity/format record, pages
keyed by physical location, and roots keyed by descriptor commitment. Initialization
is transactional and has no `IF NOT EXISTS` repair/reset path. Every operation
checks the owner-supplied identity commitment against the stored one; production
mapping from the complete trusted book/object/generation identity remains an owner
integration requirement. This local commitment is not external restore authority.

`put` captures and verifies the exact page bytes before queueing. It inserts a
previously absent location, or accepts an exact byte-identical retry. Different
bytes at an existing location fail closed, even when individually valid. SQL
failures roll back the write; success is returned only after `sync`. The API has
no update, delete, reclamation or location-reuse operation.

`retainRoot` verifies every referenced page from SQLite, including all child
fences/counts, before inserting the descriptor, and waits for a final durability
barrier. Root retries reverify the graph rather than trusting the descriptor's
existence. Append-only storage keeps those pages stable through insertion **under
this interface**; arbitrary SQL mutation is outside that guarantee. Introducing
deletion requires durable pins and a retirement/reference barrier first.
`readRootDescriptor` loads only a descriptor and is deliberately not a substitute
for page re-verification or canonical-population verification. Retention does not
grant current-view, identity/fence or posting authority.

Failures conservatively gate the instance until explicit metadata/durability
reconciliation. `recover` never re-applies the failed operation and does not claim
all-page recovery or service readiness. Read results are captured before awaiting
durability, and input/output byte ownership prevents caller buffer mutation from
altering staged or stored data. Queries bound returned BLOB/text slices even for
corrupt oversized rows. Full byte lengths are checked as well as parsed values:
SQLite text operations can hide a suffix after NUL, so a matching visible prefix
is insufficient. Stored root JSON must be exact canonical descriptor JSON, without
duplicate keys, extra whitespace, trailing data or hidden suffixes.

Evidence:

- Nine focused Bun SQLite tests / 60 assertions cover exact retries, location
  conflicts, missing children, false fences, transaction rollback after page or
  root insertion, lost confirmations, gated reads/recovery, two-instance competing
  writes, initialization rollback, wrong/missing identity metadata, buffer ownership,
  corrupt/oversized bytes and root encodings, and NUL-suffix rejection.
- The disk-backed WAL/FULL-synchronous test closes and reopens the database after
  injected lost page/root confirmations, recovering the exact bytes and descriptor
  with three pages and one root, without replaying writes. This is graceful reopen
  after response failure, not abrupt process kill, power loss or a remote drill.
- Local workerd now persists a page/root for seven manually specified identities
  (including a retained rejection), then destroys/replaces its runtime and audits
  the existing stored pages. The post-replacement route does not invoke the stage
  builder. Its root matches Bun and the accounting head/results remain unchanged.
  The fixture-only provision/stage routes are not a production catalog or gateway.
- The focused store plus local-runtime run passes 10 tests / 78 assertions.
  `bun run check` passes, including the full kernel coverage and trace gates.
  The focused store coverage run measures 100% functions/lines in this module but
  exits nonzero under the global threshold because imported modules have partial
  coverage. This is no branch/mutation/full-ledger coverage claim. No SysML source
  changed in this slice.

The store retains all inserted pages/roots. It therefore needs explicit bounded
hot storage, maintenance and reclamation before production use; it is not an answer
to the measured multi-gigabyte cold population. Joining physical retention with
canonical population checks and `SqliteIndexControl` CAS, durable reader/construction
pins, cold-object storage, restore authority, compact accounting execution, and the
other G1–G5 obligations remains open. No runtime requirement is closed here.

## Durable index-pin registry

`SqliteIndexControl` now includes owner-facing pin admission, read, renewal, release
and bounded expiry maintenance. The SysML adds `expiresAt` to `IndexReaderPin` and
an `IndexPinRegistry` with issued-ID and observed-time high-water marks. These
refine the existing irreversible-expiry/pinned-view requirements; no new production
readiness claim or relaxation of recovery verification is introduced.

New pins capture an exact current `IndexView` under the same SQLite transaction as
the complete-view comparison and owner anchor check. Reader and construction pins
retain their immutable view, canonical-head commitment and cold/hot roots. A valid
older pin can still be read or renewed after a later append/cutover; it cannot
silently switch to the newer view. Pending accounting selection or a changed
identity/fence rejects admission/read/renewal. The owner must still establish that
the indexed view has verified canonical population and page integrity before it
becomes current; this registry does not supply that missing accounting integration.

Two additional tables retain a checksummed registry state and checksummed active
pin records. The owner, never a caller, allocates monotonically increasing decimal
pin IDs. Removing an expired/released row preserves the issued-ID high-water mark,
so old IDs are not reused and unbounded per-pin tombstones are unnecessary. There
is no implicit migration/recreation of a missing live registry. This component has
not been deployed as a production format.

Expiry uses an injected trusted epoch-millisecond clock. The persisted clock floor
never decreases, including on an ordinary expired/conflicting request: the registry
commits and confirms that floor before returning the error. Otherwise observing
expiry and rolling back the observation could let a later clock rollback revive
the pin. Time regression fails closed; the caller's request timestamp is not a
clock source. A lease is inactive at `now == expiresAt`. Active renewal preserves
the exact view and is idempotent for an exact retry after a lost response. SQL or
durability uncertainty gates reuse until explicit reconciliation; ordinary pin
conflicts/expiry do not leave a successful synchronized registry globally gated.

Expiry maintenance removes at most 1,000 rows per requested batch. Review of the
first query found a covering-index **scan**, despite its small LIMIT. Replacing the
expression-only key with a stored, validated `expiry_length` plus `expires_at`
provides a numeric decimal range index. The test inspects the actual production
query with `EXPLAIN QUERY PLAN` and requires a `SEARCH` through
`ledger_index_pin_expiry`, not a scan, on the pinned Bun SQLite runtime. This is
query-plan evidence, not a production load benchmark or a pin-admission quota.

Evidence:

- Seventeen control tests / 125 assertions now include eight added pin/component
  cases: old-view retention after append/cutover, exact expiry boundaries, renewal
  response loss, bounded numeric expiry ordering, two-writer issuance, SQL rollback,
  released-ID persistence, durable clock-regression rejection and corrupt pin/state
  rejection. Existing canonical/index metadata failure tests still pass.
- One added component test stores real authenticated pages and both roots in
  SQLite, cuts over to an equivalent root at a fresh physical location, then reads
  the old pages through the captured pin. Its canonical anchor and key are synthetic;
  it does not execute real accounting commands or prove population completeness.
  Releasing the pin leaves the old pages intact: this is not page reclamation.
- The local workerd harness has a **separate** pin SQL fixture with fixed genesis
  anchor/clock vectors. It verifies active-pin survival, irreversible release and
  increasing IDs across runtime replacement. The real ledger/page persistence test
  remains separate; it is not relabeled as accounting/pin integration.
- The combined control/runtime run passes 18 tests / 148 assertions. Focused
  control coverage measures 100% functions and lines in `index-control.ts`, but the
  focused coverage command exits nonzero under the global threshold because other
  imported modules are only partially exercised. This is not branch/mutation or
  complete ledger coverage; the earlier six-control mutation campaign predates pins.
- Licensed SysIDE 0.10.3 reports zero errors/warnings, with valid/syntax-error/
  unresolved-reference canaries passing. Model hash:
  `8775ab9294ae8e2d15da089f5ee28c4ffd2f42c2bf120e45b68d0b04eb010e4c`.
  Existing design checks remain 21 scalar constraints / 150 cases / 20 requirements /
  23 not-closed runtime obligations; they are not a numeric lease model checker.
- Final `bun run check` passes, including typechecking, lint/boundaries/format,
  package tests, design checks, full kernel coverage and semantic trace validation.
  `git diff --check` is clean. These gates do not include a new full mutation or
  approved remote-capacity campaign.

The registry is not yet wired to the real accounting adapter or public report
cursors, and it does not verify historical-cutoff reconstruction, maintain the
collector's complete protected-root set/reference barrier, expire publication work,
or authorize deletion of any pages. Construction/frozen-prefix and active-view
references remain protected independently of released reader rows. Production
clock/lease policy, admission quotas, restore-generation authority and complete
reader/maintenance lifecycle integration remain required before L22/L23 closure.

## Pinned partition and historical-cutoff audit

The prototype now exposes `readAt(outcomeSequence)`, including zero/genesis and
retained-rejection cutoffs. Recovery captures the requested immutable state/head
while continuing to validate **all** retained outcomes and the final current
head. It does not stop replay at the requested cutoff or serve a historical query
while ignoring corruption later in the stored history. Invalid/future cutoffs
fail without retaining a command result. Snapshots also return their verified,
immutable tenant/book/object scope. Existing command and record encodings are
unchanged; this remains bounded full-snapshot replay, not scalable reconstruction.

`src/index-view-audit.ts` connects a durable pin and real page stores to that
canonical oracle. It verifies the exact original identity/Oseq population in each
partition: cold through `coldThrough`, hot from `coldThrough + 1` through the pin's
canonical outcome sequence. Counts are checked against independently derived
canonical populations before reading pages; valid hashes and correct total counts
do not excuse misplaced identities, fabricated IDs, wrong original locators or
omitted entries. The auditor checks pin liveness before/after page I/O and before
reporting success. Index cutover does not silently replace the pin's captured view.

The identity commitment includes tenant, book, object, namespace and generation.
The audit independently compares tenant/book/object against the real ledger's
persisted scope; namespace/generation must come from trusted owner authority,
because the prototype's `BookScope` does not persist those two fields. Both page
stores must be bound to that owner commitment. This is not an authorization or
restore-witness implementation. The derived head commitment is explicitly scoped
to `rastrata-ledger-snapshot-v1/index-head-v1` and hashes every existing `LedgerHead`
field. It does not alter canonical history or define the future compact ledger's
head representation. That future codec needs its own reviewed binding.

Evidence:

- Historical-read tests compare every cutoff of a real activation/post/rejection
  sequence with separately captured complete snapshot bytes and heads. A rejection
  advances the outcome/protocol cutoff without advancing financial revision. A new
  command committed by another instance during confirmation cannot change the
  captured result. Missing later history prevents even an earlier-cutoff read.
- After the versioned inventory policy/value repair, `readAt(4)` reproduces the
  preserved pre-repair book byte-for-byte, including its original retained rejection.
  Local workerd also returns exactly the earlier encoded snapshot/head after a newer
  outcome and runtime replacement.
- Seven view-audit tests cover every identity/head commitment field, empty genesis,
  exact two/five-identity partitions, valid-hash membership and locator substitutions,
  forged index-head metadata, independently mismatched persisted scope, owner/store
  binding, old-cutoff reads through cutover, expiry during I/O, and later source
  corruption before page reads. The source commands execute through the real kernel
  and SQLite ledger, and pages are actually stored and authenticated.
- The index-maintenance test fixture follows already-committed commands using a
  separate shadow anchor. The auditor must independently match that anchor's head
  and scope to real historical reads. This is **not** an atomic accounting/index
  posting adapter, and the successful audit is not a current-view publication claim.
- The focused view-audit, ledger and local-runtime run passes 29 tests / 218
  assertions. No SysML source changed in this slice; the existing PL-007/PL-008
  complete-recovery requirements remain intact.
- Final `bun run check` passes, including type/lint/boundary/format checks, package
  and design tests, full kernel coverage and semantic trace validation.
  `git diff --check` is clean. This is not a new mutation or remote-capacity result.

This closes neither the large-history execution/recovery problem nor canonical
root selection during posting. The audit still materializes the bounded prototype
aggregate and complete expected identity map. Full target identity persistence,
compact records and evaluation, protected-root/reclamation integration and the
approved quantitative production campaign remain open. No runtime obligation is
marked closed by this work.

## Single-outcome payload and shared-schema hardening

On 2026-09-06, `@rastrata/kernel` gained `rastrata-book-outcome-v1` transport for
the already-modeled `OutcomePayload`: one canonical command, its original
committed/rejected result, and a financial revision only for a commit. It reuses
the existing command/effect schemas and exact tagged-value encoding. Successful
decoding establishes framing, shape and contextual consistency, **not accounting
truth**. `src/outcome-payload.ts` executes the real kernel at the authenticated
prior aggregate and compares the entire regenerated payload byte-for-byte.
Retries and identity conflicts that retain no new result emit no new payload.
The helper follows the kernel's existing retention decisions; tenant/book
authorization must still precede this trusted internal boundary.

Schema reuse exposed a defect in the existing aggregate decoder: adding an own
`constructor` field, sorting the tagged object pairs and recomputing the checksum
produced a decoded aggregate with a successful canonical round-trip. The closed
field allowlist incorrectly included inherited object properties. Membership,
required/optional field presence and variant selection now use own-property
checks. Tests reject `constructor`, `toString`, `__proto__` and `hasOwnProperty`
as unknown schema fields while accepting `constructor` as an ordinary ID value.
No accounting algorithm or valid historical aggregate encoding changed.

Verification:

- Ten focused codec, replay and local workerd tests pass with 115 assertions.
  They cover retained rejections versus non-retained identity conflicts, immutable
  decoding, exact byte limits (1,048,576 accepted; one more rejected), multibyte
  limits, duplicate envelope keys, noncanonical values, altered versions and
  mismatched command/revision context. Correctly rechecksummed forged result and
  effect hashes decode structurally but fail real accounting replay.
- All four commands from the preserved pre-repair inventory book reconstruct its
  exact original aggregate bytes and original rejection result hash. The raw
  fixture remains unchanged: SHA-256
  `bf669885c3427eec096083d3203bac7c4196d83eb6b92e46b01fc8b59147d47b`.
- Local workerd decodes and reexecutes Bun-produced activation, posting and
  rejection payloads, returning byte-identical regenerated payloads and final
  snapshot. This fixture is in-memory codec interoperability, not a new durable
  storage format or public ingestion endpoint.
- Final `bun run check` passes, including 209 kernel tests / 5,086 assertions,
  100% kernel lines/functions across 13 production sources, ledger/runtime tests,
  model checks and all 102 semantic trace bindings. `git diff --check` is clean.
  These coverage figures apply to the kernel, not the entire ledger.

The opt-in `bun run --cwd packages/ledger probe:outcome-payload` executes an
activation and 100 $100 cash sales, stores both representations in one in-memory
SQLite database, then replays only the single-outcome column. Recorded local
result (Bun 1.4.0, SQLite 3.51.0, Darwin arm64):

| Sales completed | Latest snapshot bytes | Latest outcome bytes | Cumulative snapshot bytes | Cumulative outcome bytes |
|---|---:|---:|---:|---:|
| 0 (activation) | 19,840 | 8,071 | 19,840 | 8,071 |
| 10 | 122,050 | 8,363 | 780,211 | 91,470 |
| 50 | 532,130 | 8,363 | 14,068,851 | 425,990 |
| 100 | 1,044,771 | 8,389 | 53,746,697 | 844,169 |

All 101 outcomes replayed to the exact final snapshot and $10,000 cash balance.
The measured payload reduction is 63.6682x; local replay took 474.710 ms and the
entire comparison 1,131.607 ms. Times are a single local run, not a latency SLO.
Byte counts exclude SQL framing, indexes, genesis, backups and replicated storage.
The comparison does not exercise the current adapter's 101/102 capacity boundary.

This closes only the payload representation subtask. `ProductionLedger` still
stores full snapshots. Complete identity/head/chunk framing, storage integration,
indexed evaluation, cold durability and bounded recovery remain open. In
particular, inventory revision effects still contain whole lot-state snapshots;
this codec does not make those sparse or eliminate full-kernel hashing costs.
PL-007/PL-008 complete-history verification is unchanged. No runtime obligation
or production-readiness gate is closed by this measurement, and no new mutation
or cloud campaign is claimed.

## Integrated compact ledger format

On 2026-09-06, `ProductionLedger` and `SqliteBookStorage` gained an explicit
`rastrata-ledger-outcome-v1` path. The preceding payload-only boundary is now
historical. The constructor requires this format as its third argument and a
complete tenant/book/object/namespace/generation scope. Legacy/default books keep
`rastrata-ledger-snapshot-v1`, their original codecs and original hash preimages.
Opening/provisioning through a mismatched format or scope fails; no migration or
automatic fallback rewrites history. Complete scope is copied from own data
properties before queueing, with canonical generation strings and no accessor use.

The new format identity binds the ledger version, shared outcome and aggregate
codec versions, SHA-256, canonicalization profile and explicit kernel execution
profile `1.0.1`. This profile means the original accounting baseline **plus the
version-selected inventory-value 1.0.1 repair**, not the package version or a new
release certification. Original inventory policy 1.0.0 remains executable as
historical evidence. Future execution-profile changes require explicit compatible
version dispatch; changing this constant must not silently reinterpret books.

`src/compact-records.ts` frames every real-kernel outcome with complete identity
and format, the entire prior head, next outcome and financial/configuration heads,
command ID/hash, original result digest, payload byte count/digest and ordered
chunk manifest (parent ID, ordinal, bytes and digest). Counts use canonical decimal
strings. The head additionally includes the latest kernel revision-chain digest
and a domain-separated retained-protocol commitment. That commitment includes all
retained result fields and commit-intent hashes, using the kernel-validated
canonical command hashes to commit commands containing exact numeric classes.
Empty revision history has its own genesis-domain commitment. Retained rejections
advance Oseq, protocol hash and outcome hash without advancing financial state.

SQLite still owns physical transactions and WAL. All chunks, header and full-head
CAS publish in one transaction; acknowledgement still waits for confirmation.
Recovery reexecutes each compact payload, compares its entire regenerated record,
checks every chunk and final head, and refuses missing rejection-only suffixes.
The new header and metadata JSON reject duplicate keys/noncanonical framing.
Historical reads still verify the complete later history before returning a
cutoff. No checkpoint-trust shortcut was introduced.

Snapshots now disclose their format and verified scope. The pinned identity
auditor uses a format-specific full-head commitment and, for compact books,
independently compares namespace/generation with persisted scope. These fields
come from trusted owner context; this is not a control-plane authorization or
restore-witness implementation. Shadow-index tests still do not represent atomic
index maintenance on posting.

Verification includes:

- Nine compact-SQL tests: exact accepted/rejected receipts and snapshots, original
  retry identity, historical cutoffs, immutable complete scope, no legacy upgrade,
  changed format/head/manifest fields, duplicate header keys, rollback after each
  outcome/chunk/head write, uncertain acknowledgement, rejection-only CAS races,
  and a multi-chunk UTF-8 payload with missing-chunk refusal.
- Both SQL formats run the preserved pre-repair inventory book through policy
  upgrade and fixed adjustment, preserving its raw historical snapshot, original
  rejection hash and later exact receipts.
- Local workerd persists compact records in a separate SQLite-backed test Durable
  Object, races duplicate commands, replaces the runtime twice, checks exact
  reconstructed state against the legacy/direct-kernel result, and verifies
  retained rejections, lost-reply retries and earlier cutoffs. Replacement is
  graceful, not an abrupt process or provider-loss drill.
- Format-aware partition tests reject independently wrong namespace/generation.
  Final `bun run check` passes: 127 ledger tests / 2,374 assertions; 209 kernel
  tests / 5,086 assertions; 100% kernel lines/functions; model and 102 semantic
  trace checks. There is no 100% ledger coverage or new mutation claim.

The [integrated local capacity report](../../../docs/reference/reviews/ledger-compact-capacity-2026-09-06.json)
uses the original two-account $100-sale workload and 10,000-sale target. SQLite
uses WAL and `synchronous=FULL` on local disk. Each sample reopens the database,
compares the exact recovered aggregate with direct kernel execution, verifies
balances and retries the original last command. The final sample verified 233
sales / 234 outcomes and $23,300 cash. **Target not reached:** the cooperative
180-second budget expired; final verification completed at 185.337 seconds.
Worker exit zero only means no unhandled error, not a passed capacity assessment.

| Sales | Database bytes | Canonical payload bytes, including genesis | Posting window p50 ms | Recovery ms |
|---|---:|---:|---:|---:|
| 100 | 1,134,592 | 845,244 | 339.599 | 423.953 |
| 200 | 2,207,744 | 1,674,144 | 1,211.660 | 1,528.876 |
| 233 | 2,572,288 | 1,947,681 | 1,814.634 | 2,007.553 |

At 100 sales the earlier snapshot report used 53,559,296 database bytes. This is
a substantial representation improvement, **not** a controlled latency comparison
or production SLO result: other local verification ran during this measurement,
sample windows differ, RSS includes the harness/oracle, and Cloudflare was not
contacted. The 100-to-200 storage ratio is about 1.946, but the latency increase
demonstrates the unresolved full-history evaluation/hashing cost. The original
1,000-outcome safety cap remains; it was not raised to manufacture a pass.

This path is not production-ready. It does not yet pin a launch archive policy,
implement R2 publication, independently witnessed restoration, indexed kernel
evaluation, sparse inventory effects, bounded large operations, protected-root
reclamation or the complete public gateway. No PL/L obligation is closed by this
slice. The next capacity work must address history-dependent execution/recovery,
not merely increase size limits. No cloud resources, deployments or customer
books were changed.

## Byte-preserving buffered canonical hashing

On 2026-09-06, profiling actual full recovery of the saved 233-sale compact book
identified repeated UTF-8 allocation and final byte-buffer copying as hot paths.
The baseline CPU profile attributed 39.4% of sampled self time to native `encode`
and 12.3% to native `set`. These samples identify costs, not exact accounting
complexity or production latency. An earlier payload-comparison profile was not
used as a substitute for this actual recovery profile.

`hashCanonical` now uses the same canonical traversal with a 4,096-byte buffered
SHA-256 sink. Structural ASCII tokens no longer allocate separate UTF-8 buffers,
small byte writes avoid temporary subarray views, and already-encoded record keys
are reused after sorting. `canonicalEncode` still materializes bytes when callers
need them. This is **not** a new hash, serialization format, semantic profile or
incremental state commitment. It does not cache supposedly valid state or remove
any recovery/validation work. Only sink storage is bounded: source values, UTF-8
encoding of strings, key sorting, recursion and kernel state still consume memory.

The safety review reproduced an existing canonical-array defect: an indexed
getter was invoked and its result encoded. Arrays now require enumerable own data
properties and encode their ordered values without invoking indexed accessors or
inherited iterators. This aligns arrays with the existing record-data boundary.
It is not a guarantee against arbitrary hostile JavaScript proxies or concurrently
mutated shared memory; ledger request ownership remains a separate boundary.
Ordinary decoded historical arrays and their canonical bytes are unchanged.

Verification:

- Differential tests compare streamed digests with native SHA-256 over materialized
  canonical bytes across exact 4 KiB/16 KiB boundaries, empty and offset byte views,
  large ASCII integer tokens, multibyte/surrogate text, and multiple flushes. They
  verify that changed input changes its next digest and a failed hash after a
  flush cannot contaminate another operation. Existing literal hash vectors remain.
- Array getter/non-enumerable cases reject without invoking getters; an inherited
  iterator is not consulted. Both materializing and hashing APIs are exercised.
- Local workerd hashes a vector spanning ASCII, raw-byte and UTF-8 flushes and
  agrees with Bun's native SHA-256 over materialized bytes. Both SQL ledger formats
  continue to pass historical inventory-policy repair and exact-receipt tests.
- Final `bun run check` passes: 211 kernel tests / 5,155 assertions, 127 ledger
  tests / 2,375 assertions, 100% kernel functions/lines, model and all 102 semantic
  trace checks. The kernel SysML and preserved raw inventory fixture are unchanged.
  This is not a full mutation/release or deployed readiness result.

The [existing compact capacity report](../../../docs/reference/reviews/ledger-compact-capacity-2026-09-06.json)
now retains a separate `hashingFollowUp`; its original failed capacity result is
unchanged. Each local measurement reopened the same saved SQLite database, fully
replayed 234 outcomes, verified 233 exact $100 sales, and compared the complete
recovered head. Every measured outcome/state/configuration/revision/protocol hash
was identical to the pre-change book.

| Implementation | Three recovery times (ms) | Median (ms) | Post-read RSS range (bytes) |
|---|---|---:|---|
| Materialized baseline | 2,151.629; 2,015.067; 2,036.862 | 2,036.862 | 231,014,400–307,888,128 |
| Rejected first 16 KiB streaming attempt | 2,505.633; 2,358.856; 2,472.214 | 2,472.214 | 110,788,608–139,640,832 |
| Retained 4 KiB/small-write/key-reuse implementation | 1,346.433; 1,137.520; 1,186.367 | 1,186.367 | 116,424,704–137,756,672 |

The final median is 1.717x faster than baseline in this local comparison. The
slower first attempt is recorded rather than silently discarded. These are three
successive samples per process, not independent production trials; RSS is not peak
heap, and OS cache/allocator state affects results. Intermediate source hashes
were not captured; baseline and retained implementation hashes are recorded.
The 10,000-sale campaign has **not** been rerun and remains failed. History-dependent
execution, full-state hashing and bounded startup still need structural work.

## Authenticated point and absence lookups

On 2026-09-06, `lookupIndexEntry` in `src/index-pages.ts` added bounded key lookup
against an already audited, owner-selected root. It authenticates each fetched
page and validates ordering, population and the selected child's exact fences.
A complete leaf or authenticated gap between branch fences proves key absence.
Missing/short/corrupt required bytes and storage exceptions are failures, never
absence. The existing maximum of sixteen levels bounds successful lookup to
sixteen pages / 131,072 page bytes per partition; root-descriptor and pin-registry
I/O is additional and is not included in those page-byte counters.

The raw primitive cannot make a caller's root authoritative. Therefore
`openAuditedIndexReader` in `src/index-view-audit.ts` first runs the real canonical
history and population audit at the requested durable pin. A forged canonical
head or same-count substituted population prevents construction. The returned
reader captures that pin and its stores, checks both hot/cold roots, enforces
partition sequence bounds and checks pin liveness through I/O. It cannot follow
cutover to a different view or return success after expiry/release. Construction
is intentionally still full-history/full-population work; subsequent key lookups
do not rebuild the canonical identity map.

This distinction is important: a path proof is **not** a whole-tree health audit.
For an already audited root, an unrelated missing child does not falsify a gap
proof elsewhere; independent full traversal still detects that damage. The raw
reader's precondition is tested and documented rather than labeling every hash
match as complete verification. Neither API replaces `ProductionLedger.read`,
changes PL-007/PL-008 recovery requirements or authorizes lazy startup.

Verification:

- Leaf hits/misses, outer and inter-child gaps, empty genesis, invalid keys,
  changed root hashes, missing required children, transport exceptions, wrong
  child populations/fences and corrupted bytes. Depth sixteen succeeds; depth
  seventeen fails **before** a seventeenth fetch.
- A synthetic 30,000-key, three-level tree is independently enumerated. All 205
  sampled queries match both that enumeration and the independently known key/
  sequence formula. Actual fetch callbacks agree with reported read/byte counts;
  each query uses at most three pages / 24,576 page bytes. This is a deterministic
  algorithm test, not a large business workload or a throughput/latency benchmark.
- Both ledger formats open readers only after the real canonical audit. Tests
  find original cold/hot locators including retained rejections, prove missing
  keys, check empty roots, and verify no subsequent full source-audit invocation.
  A cold hit does not hide a missing required hot page. Release and expiry during
  page I/O fail. A real later posting plus index cutover during lookup I/O does
  not change the reader's original cutoff.
- Local workerd now stages an actual multi-page derived tree from its canonical
  accounting identities. After full population audit, the raw lookup fixture
  resolves a retained rejection in two pages and proves an absent key. It returns
  the identical locator and read counts after runtime replacement. This test-only
  route is not the production gateway or a workerd pin-control integration claim.
- Focused page/reader/runtime tests pass: 25 tests / 1,563 assertions. Final
  `bun run check` passes with 135 ledger tests / 3,739 assertions, 211 kernel tests
  / 5,155 assertions, 100% kernel function/line coverage and all 102 semantic trace
  bindings. `git diff --check` is clean. No SysML or kernel source changed in this
  slice, and no full ledger coverage, mutation or production-capacity pass is claimed.

A returned digest/Oseq is only a **locator**, not proof that a caller's original
raw identity matches the canonical command/effect there. Original-identity and
content resolution, including fail-closed collision handling, remains required
before accounting admission. The index still needs bounded updates and atomic
publication with canonical posting; the test shadow anchor is not that adapter.
No runtime obligation is closed by this slice. The 10,000-sale capacity result
remains failed and has not been rerun for this lookup-only change.

## Bounded copy-on-write insertion

2026-09-06 — `prepareIndexInsert` prepares one identity insertion without writing
pages or selecting a root. It authenticates the selected path, checks for a
duplicate digest (including an identical sequence), and copies only that path.
Overflowing leaves split at 205 entries; overflowing branches split at 59 children.
Unchanged sibling descriptors and every old page/root remain untouched. The
result reports actual page reads, bytes read and bytes prepared. One update reads
at most sixteen pages and prepares at most `2 * height + 1` pages, each no larger
than 8,192 bytes. These are algorithm bounds, not latency/capacity measurements.

The adversarial self-review identified a prerequisite: RIP1's generic validator
allows mixed leaf depths, so an update cannot infer the whole tree's height from
its selected path. Root growth could otherwise push an unvisited deeper branch
beyond the depth limit. `auditBalancedIndex` therefore authenticates the entire
physical graph, exact populations/fences and equal leaf depth before issuing an
opaque runtime-checked layout handle. COW preserves that property and returns a
derived handle. A copied object or caller-supplied height is rejected. Ordinary
read/enumeration remains compatible with valid unbalanced trees; no old codec or
hash is reinterpreted. This initial audit remains full-tree work.

The handle proves **only physical layout**. It does not establish canonical
population, identity scope, a live pin, future availability, or posting authority.
A derived handle can exist before any page is persisted: missing bytes still
reject reads/updates. Prepared descriptors are frozen; prepared byte arrays remain
mutable and must be reverified by storage (as `SqliteIndexPageStore.put` does).

Location reservation is injected, not implemented. Preparation rejects reused
locations within its plan and all source references observed along its path,
including immediate siblings. It cannot prove global freshness against unvisited
or retired pages. The owner must supply non-reusable reservations, protect the
source with the proper pin/barrier, and account for reservations abandoned by a
failed preparation. The page store's identical-write retry is not a substitute
for a fresh-location allocator. Cross-partition duplicate/collision checks,
canonical original-identity resolution, same-command pending insertions and
full-head/view CAS publication remain separate integration obligations.

Verification in `test/index-insert.test.ts` and `test/index-page-store.test.ts`:

- Five hundred deterministically shuffled insertions are checked against an
  independent sorted population, with old root snapshots retained and reread.
  Empty genesis, leaf splitting, gaps, both outside fences and captured caller
  inputs are exercised.
- A full 11,832-key, 58-leaf tree grows to three levels with exactly two source
  page reads and five prepared pages. Independent complete enumeration checks old
  and new populations; all 57 unaffected leaf descriptors survive unchanged.
- Duplicate identities, invalid keys/counters, forged handles, read failures,
  missing/corrupt pages, invalid/reused locations and failure at each allocation
  of a three-page split reject without modifying source pages. Layout admission
  separately rejects wrong populations/fences, mixed depth and a seventeenth
  level before fetching that level. A valid height-sixteen tree absorbs a leaf
  split without exceeding the depth limit.
- Every prefix of a three-page update preserves old-root readability and fails
  verification of the new root until complete. Parent-first partial storage also
  fails. The actual SQLite store is reconstructed at every prefix: it cannot
  retain the new descriptor until all pages are present, and the old descriptor
  and bytes survive. These are local deterministic fault tests, not abrupt process
  termination, a cloud durability drill or atomic accounting publication.

Final verification: `bun run check` passes with 147 ledger tests / 7,422 assertions,
211 kernel tests / 5,155 assertions, 100% kernel function/line coverage across all
13 measured sources, and 102 semantic trace bindings. The focused insertion/store
run passes 21 tests / 3,743 assertions. `git diff --check` is clean. This is not
100% ledger coverage or a fresh mutation-release certification. Local full-check
output: `/tmp/rastrata-index-insert-check-final.log`.

No accounting source or SysML changed in this slice. No runtime obligation is
closed, no cloud resource is created, and the failed 10,000-sale capacity result
is unchanged. Indexed accounting execution and production readiness remain open.

## Fenced physical-location allocation

2026-09-06 — The page store now has an explicit new-store format,
`rastrata-sqlite-allocated-index-pages-v1`, selected by `initialize("allocated")`.
Existing `rastrata-sqlite-index-pages-v1` stores retain their codec/read/write
behavior; initialization never resets an existing store or silently upgrades it.
The allocated mode rejects ordinary `put` calls. New bytes require a reservation
belonging to the exact active construction pin, verified inside the same SQLite
transaction as reservation consumption and page insertion. Identical stored-page
retries remain possible through the pinned write path; different bytes fail.

`SqliteIndexControl.runPinnedConstruction` is an internal synchronous owner port,
not a public callback API or canonical posting operation. It rejects a different
storage port, reader pins, changed pins, expired/released pins, foreign authority,
pending canonical work and yielding callbacks. Caller pin values are copied before
queuing; storage writes use the verified stored pin. The pin clock floor and the
guarded SQL mutation share one transaction and durability confirmation. A failed
confirmation gates both participating instances until explicit reconciliation.
Completion of a page write is not permission to publish an expired construction.

The wire coordinate is `derived/<128-bit fence><128-bit issued counter>` in fixed
lowercase hexadecimal, within the existing RIP1 32-byte location field. Locations
are scoped by the complete trusted book/store identity. Batches contain 1–256
locations. The counter is durable, never reduced by normal API operations, and
not recycled when an allocation is abandoned, a page is written, or page bytes
are subsequently lost. It does not require permanent per-written-page tombstones:
the pending reservation is deleted atomically when its page is first stored.
Pending records bind location, construction pin and fence with a verified digest;
the allocator state binds issued count and last fence to the complete store
identity. SQL reads of these records are bounded and reject NUL-suffixed fields.
Both counter and fence bounds fail closed without wrapping or truncating values.

The self-audit caught a rollback hole in a counter-only draft before closure:
restoring an earlier allocator state can otherwise reuse a physical coordinate,
even at an unchanged accounting head. A fresh **external** fence therefore prefixes
the restored location range. A lower fence than the last locally observed epoch
is rejected. A valid older state also cannot reserve over present bytes. These
guards do not make a same-database checksum detect a complete rollback: before
restored construction, the application must acquire a fresh non-reusable fence
outside the restore set and admit the restored view under it. That application
procedure remains unimplemented. The fence prefix is not a substitute for the
separate collection epoch and uninterrupted reference barrier required by PL-020.

Verification includes:

- A real COW leaf split uses durable reservations and pinned writes, retains both
  fully verified roots, and leaves the selected view unchanged until separate
  publication. Its canonical anchor is explicitly synthetic, not an accounting
  command or population-conformance proof.
- Abandonment, duplicate retries, conflicting bytes, corruption, cross-construction
  attempts, released/expired leases and clock rollback fail as specified. Removing
  a stored page in an isolated fault fixture cannot resurrect its consumed
  reservation or make the allocator reuse its old coordinate.
- SQL faults after reservation insert, high-water update, reservation consumption
  and page insertion roll back atomically. Lost confirmations preserve actual
  issued/stored state; the next reservation does not reuse the lost-response batch.
  A real SQLite file reopen and competing store instances verify durable issuance.
- A synthetic allocator rollback followed by a fresh trusted fence produces a
  different physical range while retaining the old bytes. Maximum counter/fence
  boundaries, fence regression and batch bounds are checked explicitly. This is
  not a disaster restore drill or external-fence implementation claim.
- Actual local workerd SQLite stores and reads an allocated page across two
  runtime replacements, retains counters after abandonment, refuses an abandoned
  location, and rejects further allocation after pin release. The fixture has its
  own object and fixed authority/clock; it is not the deployed accounting adapter.

Outstanding: pending construction/publication root registration, bounded cleanup
of orphaned reservations after expiry or lost replies, collection barriers and
retirement, original-identity resolution, and atomic publication with actual
accounting. `abandon` cancels only specified unwritten reservations owned by a live
construction; it never deletes page bytes. No collection/deletion protocol is
enabled, no cloud actions were taken, no SysML runtime obligation is closed, and
the failed 10,000-sale capacity result remains unchanged.

Final `bun run check` passes: 159 ledger tests / 7,540 assertions, 211 kernel tests
/ 5,155 assertions, 100% kernel function/line coverage over 13 sources and all 102
semantic trace bindings. `git diff --check` passes. No kernel or SysML source
changed in this slice. This is not a ledger coverage/mutation release gate or an
independent audit. Local full-check output:
`/tmp/rastrata-index-allocation-check-final.log`.

## Shared canonical and index transaction

2026-09-06 — Publication review found that calling the ordinary
`SqliteBookStorage.commitTransition` from `SqliteIndexControl.append` would nest
transactions. The canonical adapter now exposes the internal
`commitTransitionInTransaction` port. `atomicSqlite` issues an opaque token for
one synchronous transaction callback and invalidates it on exit. Canonical writes
require that active token and the exact same storage port. Forged, copied, expired
and foreign tokens are rejected before canonical SQL; nested guarded transactions
and yielding callback results reject and roll back. This is trusted owner code,
not a sandbox for arbitrary callbacks or hostile JavaScript. Unrelated direct
SQL/transaction access remains privileged and is not made safe by the token.

Ordinary canonical commits and index-control mutations use this primitive. The
complete canonical-head CAS, format checks, outcome/chunk writes and metadata CAS
are shared with ordinary commits rather than duplicated. Index append passes its
transaction token to the owner callback and then verifies the actual resulting
canonical anchor before publishing the view. `BookStorageAdapter.commitTransition`
may now return a promise; `ProductionLedger.execute` awaits it, including async
conflicts/errors, before its final durability wait and receipt. Preparation must
finish before that callback: no async storage fetch or nested transaction belongs
inside the SQL mutation.

`test/atomic-publication.test.ts` uses the real compact `ProductionLedger`, kernel,
canonical SQLite adapter, allocated page store, COW builder and index control.
The canonical anchor reads the actual `ledger_metadata` head, not a shadow head.
The preparation adapter is deliberately test-only: its expected identities come
from fixed activation, cash-sale and rejection fixtures. Independent canonical
population audit verifies each selected root against replayed accounting history.
This proves shared SQL publication of those real outcomes, not production identity
extraction, all-command indexed admission, or an end-to-end production adapter.

Verification covers:

- Committed activation/sale and retained rejection advance both canonical Oseq
  and the selected index exactly once. Replays preserve the original receipts
  without another index append. The rejection advances protocol/index order while
  leaving financial revision unchanged. Instrumentation rejects nesting and
  observes maximum SQLite transaction depth one.
- Injected faults after outcome insert, payload-chunk insert, canonical-head
  update or index-control update restore both old heads/view. Retrying the same
  command then publishes once. Prepared orphan pages are not selected or deleted.
- Lost publication confirmation yields no receipt; recovery discovers the actual
  committed canonical/index pair. Retry returns the exact result independently
  computed by the kernel, with no second index append.
- A blocked async preparation leaves the caller unresolved and the old view
  selected until released. An async canonical conflict is caught and reevaluated
  without creating a duplicate outcome. Token expiry/ownership, callback failure,
  nested use and promise-return rollback have direct negative tests.

The next publication gate must bind a final verified root to its exact live
construction and full input view, then atomically consume that pending protection
when the canonical/index pair is selected. Protection must also cover pages being
built before a final root exists. Existing `append` still trusts the owner's root
verification; it does not itself enforce construction-pin liveness or membership
at publication. The test adapter is therefore not exported as the production
adapter. No page reclamation is enabled, and pending-root registration, source
identity resolution, full concurrency/recovery conformance and capacity proof
remain open. No accounting or SysML source changed in this slice, and no cloud
actions or independent release audit were performed.

Final `bun run check` passes: 165 ledger tests / 7,663 assertions, 211 kernel tests
/ 5,155 assertions, 100% kernel function/line coverage across 13 sources and all
102 semantic trace bindings. The focused publication suite passes six tests /
123 assertions. `git diff --check` is clean. No ledger-wide coverage, mutation or
production-capacity pass is claimed. Local full-check output:
`/tmp/rastrata-atomic-publication-check.log`.

## Prepared-root publication admission

2026-09-06 — `PreparedIndexPublication` now durably binds one construction pin,
its complete immutable input view, complete target-head commitment and verified
hot-root descriptor. `retainPreparedRoot` first authenticates/retains the complete
graph, then registers the candidate under the same-store, still-live construction
and current input view after I/O. Registration rereads the retained descriptor in
that transaction. A different root or target for the same pin conflicts; an exact
retry is stable. Caller pin/target/root values are captured before queueing or I/O.

`publishPrepared` selects only the exact registered candidate hash. In the same
SQLite transaction it checks pin authority/liveness, the complete current input
view (including view revision), and the actual canonical result against the
registered target commitment; it publishes the canonical/index pair and consumes
both the prepared registration and construction pin. Renewal preserves candidate
identity, while expiry/release removes eligibility. Normal expiry/conflict responses
preserve the trusted clock floor. Lost confirmation is not permission to repeat
selection: recovery inspects canonical/index heads and the higher-level ledger
replays the original receipt. The older generic `append` owner port still exists;
it must not be treated as equivalent prepared admission by an application adapter.

The expanded schema uses `rastrata-index-control-prepared-v1`. It adds one prepared
row per construction pin, with bounded strict JSON/digest validation. Older
`rastrata-index-control-v1` controls fail closed; no automatic migration, reset or
deletion is performed. The regression preserves an older-format row's bytes after
refusal. Page formats and canonical accounting formats/historical hashes are not
changed. Migration of an old control would require a separate verified procedure.

The real-accounting publication tests now use prepared admission, not generic
append. Activation, sale and retained rejection retain their exact original
outcomes; their selected index populations are independently audited against
replay-verified accounting. The preparation adapter remains test-only and uses
fixed expected identities, not a production all-command extractor.

Negative evidence covers changed root/target, wrong identity/fence/Oseq/readiness,
empty population, missing registration, missing required pages, wrong actual
canonical target, expired/released pins and a changed view revision at the same
canonical head. No canonical callback runs on admission rejection. A real kernel
command whose construction expires after preparation remains uncommitted and can
be retried under a fresh pin. SQL faults while consuming the pin, prepared row or
clock floor roll back the canonical/index pair and preserve retry eligibility.
Lost registration replies reconstruct the exact candidate; lost publication
replies leave the selected pair with no reusable pin. SQLite file reopen, lease
renewal, caller mutation during I/O, NUL-suffixed digests, duplicate JSON keys and
foreign-pin records are also checked. These are local tests, not cloud fault drills.
Two independent control instances with candidates at one full input view produce
one publication winner: only one canonical callback runs, and the losing candidate
remains registered under its original pin for explicit reconciliation or expiry.

SysML now explicitly models the candidate plus registration and indexed publication
actions, refining the existing coverage/pin/reclamation obligations. The typed
model passes licensed SysIDE 0.10.3 workspace checking with zero diagnostics and
valid/syntax-error/unresolved-reference canaries. Model SHA-256:
`d2e66ab85a16de82ffc44666cf4e82ab68cc06f4d2c896ca7bc5fa9fd41a79c8`.
The existing 21 scalar constraints / 150 cases, two state machines / 18 states /
40 transitions, 18 lifecycles and 18 checker tests still pass; their fixture hash
is unchanged. Those bounded checks do not execute the newly added behavior actions
or certify their complete runtime conformance. The concrete TypeScript tests above
provide scoped implementation evidence; all 23 runtime obligations remain open.

This is final-root registration/admission, **not complete reclamation protection**.
Pages written before a final root exists still need durable construction tracking;
the collector must enumerate all live/pending references under an uninterrupted
barrier. Canonical population/lineage/original-identity checks are still owner
prerequisites, not established by a matching descriptor or candidate digest.
General indexed execution, bounded recovery, orphan cleanup, capacity validation
and deployment approval remain open. No page reclamation API was enabled, and no
cloud operation or accounting source change occurred in this slice.

Final verification: `bun run check` passes with 177 ledger tests / 7,809 assertions,
211 kernel tests / 5,155 assertions, 100% kernel function/line coverage across 13
sources and 102 semantic trace bindings. The focused admission/publication run
passes 47 tests / 504 assertions. `git diff --check` passes. These results do not
claim ledger-wide coverage, mutation closure or production capacity. Local logs:
`/tmp/rastrata-prepared-publication-check-final.log` and
`/tmp/rastrata-prepared-publication-syside.log`.

## Construction-location tracking and metadata cleanup

2026-09-06 — Construction pins now atomically create an authenticated empty head.
Every reserved physical location joins an ordered per-construction hash chain in
the same SQLite transaction as reservation and allocation high-water advancement,
before any page write. Materialized, unwritten and abandoned allocations remain
tracked until the construction is inactive. Exact page-write retries require the
original live construction; a fresh pin cannot adopt an old page as a new write.
Existing immutable input pages remain readable and can be shared by COW graphs.

`constructionBatches` captures the chain head and allocator epoch/high-water in one
live-pin transaction, then streams at most 256 locations per batch. Indexed tuple
seeks avoid full scans/sorts. Each step validates bounded SQL fields, indexed
columns, scope, contiguous ordinals and chained hashes; the consumer must reach
the captured terminal count/hash before calling the prefix complete. Missing head,
middle/suffix gaps, malformed columns, NUL/oversized locations and extra rows behind
a restored shorter head fail closed. Concurrent later allocations are outside the
captured prefix/watermark. Release, expiry or a changed lease invalidates further
use of the old cursor. This is a proof of one captured construction prefix only.

Release, expiry and successful prepared publication atomically enqueue a cleanup
job while removing the pin. `cleanupConstructions` requires that owner absent, an
exact unchanged retired head, and no skipped extant prefix. It verifies/removes at
most the requested tracking/reservation pairs plus completed job/head metadata in
one transaction. Cursor advancement and all deletes roll back together on failure;
lost confirmations resume from the actual durable position. No page bytes, root
descriptors, selected views, canonical outcomes or allocator high-water are removed
or changed. An absent/corrupt cleanup job cannot authorize page deletion; orphan
metadata reconciliation remains separate from this queue consumer.

The explicit control format is now `rastrata-index-control-tracked-v1`; both older
prototype control formats are refused without modifying their bytes. Page and
canonical accounting formats are unchanged. Same-store hashes detect tested
corruption, not a coordinated rollback of all local evidence: a restored allocator
still requires a fresh independently retained authority fence before construction.

Evidence includes 1,000 locations streamed in batches of 17 (no SQL result exceeds
18 rows during traversal), concurrent allocation after capture, exact empty proofs,
rollback after allocation/tracking/head writes, expiry and regressed time, invalid
cleanup jobs/owners/cursors, and faults during reservation/tracking/job/head removal.
Real SQLite reopen preserves the captured chain and resumes cleanup after lost
partial/final replies without reissuing a location. The real-accounting fixture
cleans three published constructions and compares all page/outcome rows and the
replay-verified canonical/index snapshot before/after; original committed/rejected
receipts remain identical. Local workerd also reads tracking after replacement and
resumes partial cleanup across another replacement. Those are graceful local
persistence checks, not abrupt process-kill drills or deployed-cloud evidence.

SysML explicitly models the construction head, captured batch, cleanup job and
three behavior actions. Licensed SysIDE 0.10.3 reports zero diagnostics with valid,
syntax-error and unresolved-reference controls. Model SHA-256:
`eeae0247a8407495f5d33b374709bb7dfc33486337a830be7321866f3df734e6`.
The existing scalar/lifecycle checker does not execute these new actions; scoped
TypeScript tests provide their current evidence. All 23 runtime obligations remain
open as end-to-end obligations. No requirement is closed merely by adding types.

Remaining: a complete live/pending-root inventory, uninterrupted global reference
barrier, verified exact retirement selection and safe page reclamation; production
all-command canonical membership/lineage/raw-identity admission; indexed kernel
execution, bounded recovery and workload/capacity acceptance. No page reclamation
API, cloud action, migration or accounting-source change was introduced in this
slice. Per-construction tracking does not establish global protected-root closure.

Focused verification passes 56 tests / 674 assertions. Local evidence logs:
`/tmp/rastrata-construction-tracking-focused.log`,
`/tmp/rastrata-construction-tracking-runtime.log` and
`/tmp/rastrata-construction-tracking-syside.log`.

Final repository verification: `bun run check` passes with 186 ledger tests /
7,986 assertions, 211 kernel tests / 5,155 assertions, 100% kernel function/line
coverage across 13 sources and 102 semantic trace bindings. Local workerd passes
56 assertions. `git diff --check` is clean. No ledger-wide coverage, mutation
closure, independent audit or production-capacity pass is claimed. Full log:
`/tmp/rastrata-construction-tracking-check-final.log`.

## Canonical-outcome identity derivation

2026-09-06 — `prepareOutcomeIdentityDelta` projects from one actual canonical
outcome payload rather than a supplied identity list. It handles every `BookEffect`
variant exhaustively at compile time, contributes command IDs for retained
rejections, and excludes version-scoped configuration IDs from the globally
single-use population. Each touched key is checked against the owner's prior
index. A hit must supply an older positive Oseq and original canonical outcome
bytes; the projector compares the original raw book/family/ID rather than treating
a digest/count as sufficient. Ordinary identities must be absent. Only repeated
lot-state snapshot identities may exist, and their first creation locator is kept.
The full-history identity oracle remains independently implemented.

This helper is deliberately not called an accounting verifier. Its owner must
provide a replay/evaluation-verified new outcome and authenticated lookup/absence
across both partitions, with source bytes verified in the exact pinned canonical
prefix. The helper does not prove that an arbitrary supplied source really belongs
there, or that a source locator is first-seen without the prior index's admission
invariant. A negative test explicitly demonstrates that a rehashed, structurally
valid forged result can still be projected: real ledger evaluation/replay is
mandatory before this API. No new ready/verified boolean substitutes for it.

The shared-publication fixture removes its hard-coded identity list and uses this
production derivation. Its owner adapter receives the exact loaded history that
`ProductionLedger` verifies before commit, resolves index hits to those outcome
bytes and derives the complete delta before allocating pages. It rejects a changed
full input head before preparation. Arbitrary Unicode command names, retained
rejections, exact replay receipts and the immutable historical inventory fixture
now pass through real canonical/index publication and the independent full-population
audit. The inventory test verifies lot/holding first-creation Oseq remains 2 after
later whole-lot snapshots and an unchanged historical rejected adjustment.

Direct negatives cover wrong scope, original source substitution, nonpositive or
future locators, malformed payloads/evidence, symbol/extra fields, getters (not
invoked), and source unavailability. Read failure never becomes absence or a
partial returned delta. Exact repeated command/journal IDs are rejected by source
admission rather than appended a second time. The frozen returned delta contains
raw namespaced identities and creation Oseq, not caller-owned mutable objects.

Scope limits: the owner adapter is still test-only and hot-partition-only; the
production two-partition adapter/source resolver is unfinished. Full physical
layout auditing still precedes COW insertion, and ordinary kernel execution and
recovery still use complete history/aggregates. Legacy lot snapshots still cost
their full payload size, and resolving many repeated IDs is not a bounded-cost
indexed-kernel claim. The 13 specialized accounting-effect branches are exhaustive
in types but not yet all exercised through this publication integration; those
end-to-end cases remain required. No page reclamation, cloud operation or accounting
source change occurred. All 23 runtime obligations remain open end-to-end.

SysML now states this source-admission contract in `DeriveOutcomeIdentityDelta`.
Licensed SysIDE 0.10.3 reports zero diagnostics with the three semantic controls;
model SHA-256:
`19b1424b1c96da7d1614cc90538d0cb2e343297968f670131ab64b3e3afd25de`.
The existing bounded scalar/lifecycle checks do not execute this new action.
Focused tests pass 14 tests / 273 assertions and ledger typechecking passes.
Local logs: `/tmp/rastrata-outcome-identities-focused.log` and
`/tmp/rastrata-outcome-identities-syside.log`.

Final `bun run check` passes: 193 ledger tests / 8,067 assertions, 211 kernel tests
/ 5,155 assertions, 100% kernel function/line coverage across 13 sources and all
102 semantic trace bindings. `git diff --check` passes. The historical inventory
fixture SHA remains `bf669885c3427eec096083d3203bac7c4196d83eb6b92e46b01fc8b59147d47b`.
Full log: `/tmp/rastrata-outcome-identities-check-final.log`. No ledger-wide coverage,
mutation closure or production capacity result is claimed.

## Indexed SQLite owner integration

2026-09-06 — `SqliteIndexedBookStorage` is now an opt-in `BookStorageAdapter` for
new compact books, rather than a test-only publication adapter. Its constructor
requires the actual storage object's ID independently from the complete declared
scope, plus trusted authority/fence/pending state and clock. It rejects wrong
actual object IDs, foreign owner markers and unknown/partial/older storage instead
of adopting a canonical book or silently initializing missing indexes.

First provisioning combines canonical genesis/chunks, index control, pin and
construction metadata, page allocation state and an identity-bound owner marker
in one guarded SQLite transaction. The three components expose same-store active
transaction initialization ports; forged/expired/foreign tokens are not authority.
No nested transaction or asynchronous initialization is used. A lost confirmation
reconciles the exact complete book; injected failures after each component leave
no half-provisioned schema. Existing canonical and page representation versions,
historical bytes and accounting hashes remain unchanged.

`ProductionLedger` has an optional trusted derived-store recovery hook, invoked
only after its real full-history replay. For a historical read, the hook receives
the current fully verified aggregate/head, not merely the older selected cutoff.
The indexed owner binds that head to the exact selected view and verifies both
hot/cold populations against the independent canonical identity projection under
a live reader pin. Missing/substituted entries, duplicate identities or wrong
partition Oseq fail before reads or evaluation. It establishes the hot tree's
balanced physical layout for COW preparation. This is intentionally still a full
scan, not the future bounded-recovery protocol; no startup guarantee was weakened.

For publication, the owner requires that recovered input, replays the single new
payload and compares its complete expected frame/result/head before allocation.
It derives identities from the actual outcome and authenticates both logical
partitions, resolving hits to exact raw source identities in the replay-verified
history. Whole lot snapshots preserve first-creation locators. Fresh locations
are reserved/tracked under a construction pin, COW pages are written, and the
verified final root is registered and consumed atomically with canonical outcome
publication. Only recognized view/head races are translated to execution retries;
missing/corrupt/expired/uncertain evidence is not identity absence. Unknown
publication replies return no success receipt; later replay returns the original.

Both logical partitions currently reside in the same SQLite page store. The
inventory integration test promotes the already audited first hot prefix to cold,
then posts subsequent real historical commands into the hot tail. Counts are
exactly eight cold and seven hot identities; the first lot/holding remains at
Oseq 2 and the historical book/receipts are byte/hash-identical. This tests owner
admission across a split, not a production merge scheduler or remote cold tier.

Owner tests exercise actual SQLite reopen, lost provisioning/publication replies,
publication-stage fault injection, independent-owner duplicate/conflicting races,
historical reads after selected-page loss, expired construction, pending authority,
clock regression, invalid maintenance budgets and foreign/NUL-suffixed owner
markers. Publication fault tests explicitly wait until the transaction inserts
the canonical outcome: a reader-pin deletion during pre-command auditing no longer
stands in for publication rollback. A structurally valid forged result is rejected
by the owner's single-outcome replay before any allocation. Local workerd uses the
exported owner, survives graceful replacement and retries discarded receipts
exactly. This is not abrupt process termination or deployed-cloud fault evidence.

The optional owner is exported but the existing development deployment is not
changed. All original ledger/kernel capacity limits remain. Full-history replay,
whole-population checking and full layout auditing must still be replaced under
the approved indexed-state/recovery design. `maintain` performs only bounded
expired-pin and inactive-construction metadata cleanup; applications still need
maintenance scheduling/backpressure. No page bytes are reclaimed. General merge,
remote cold storage, global reference barriers, restore/witness authority, all
specialized workflow integration, resource campaigns and independent release
audit remain open; all 23 runtime obligations remain open end-to-end.

SysML adds explicit atomic indexed provisioning and recovered-index validation
actions. Licensed SysIDE 0.10.3 reports zero diagnostics with the valid/syntax-error/
unresolved-reference controls. Model SHA-256:
`def3f2f55b2de9b6998b0858235c06a750030931bb3315d07334bffe3d7a63d2`.
These actions are not executed by the existing bounded scalar/lifecycle checker;
the concrete tests provide scoped owner evidence, not automatic requirement closure.

Focused owner/runtime verification passes 14 tests / 191 assertions, including
the actual workerd SQLite path. Full `bun run check` passes with 206 ledger tests /
8,202 assertions, 211 kernel tests / 5,155 assertions, 100% kernel function/line
coverage across 13 sources and 102 semantic trace bindings. `git diff --check`
passes. No ledger-wide coverage, mutation closure, independent audit or production
capacity result is claimed. Local logs: `/tmp/rastrata-indexed-owner-focused.log`,
`/tmp/rastrata-indexed-owner-check-final.log` and `/tmp/rastrata-indexed-owner-syside.log`.

## Authenticated range traversal

2026-09-06 — `scanIndexRange` streams a half-open interval `[lower, upper)` from
one already-audited immutable root; null endpoints are unbounded. It verifies
root/page bytes, counts and exact child fences, pruning only disjoint authenticated
subtrees. Each immutable batch contains at most 256 entries. One-row lookahead
distinguishes a full final batch from an incomplete prefix, and completion occurs
only after all required descendants have been exhausted. Missing pages, corrupted
bytes/fences/counts or read failure cannot become an empty/completed range. Empty
intervals and explicit empty roots need no page reads; this is not a whole-tree
health audit. Page/byte and match counters use exact integers.

The traversal captures root/bounds before queued I/O and retains only bounded
depth/page/batch state. Cancellation stops traversal without reading the remaining
tree and does not certify completeness. Root selection/population authenticity and
page retention still require the owner; damage in a disjoint unvisited subtree is
outside this range proof. The full audit still detects such damage. No canonical
recovery verification was removed or made lazy.

`openAuditedIndexReader.scanKeys` merges both pinned hot/cold streams in key order,
checks each locator's partition Oseq, rejects duplicate cross-partition keys and
rechecks the original pin during I/O and after batch continuation. An expired or
released pin cannot emit a later completion. The reader does not repeat its initial
full canonical population audit for each batch. Callers must drain the internally
owned stream; an externally asserted completion flag or a retained prefix is not
accounting admission evidence. Results remain key/Oseq locators, not resolved raw
source identities or an accounting predicate schema.

Measured local component case: 12,000 entries in 120 leaves and four branch pages
(124 pages total). A five-key interval reads exactly three pages. Full traversal
reads exactly 124 and returns all 12,000 entries in bounded batches; measured byte
totals equal the exact fetched page sizes. This measures page access, not elapsed
ledger latency, Cloudflare capacity or an enterprise workload. One hundred seeded
intervals also match independent filtering of the complete fixture population.

Negative/boundary evidence includes branch and leaf gaps, empty/exact/maximal key
bounds, invalid batch sizes, missing required suffix after valid prefix batches,
child fence/count corruption, changed bytes, unavailability, mutable caller root,
cancellation and accepted depth 16/rejected depth 17. Pinned hot/cold tests cover
both canonical storage formats and release/expiry between batches. Local workerd
returns the exact range from persisted pages before/after graceful replacement;
that fixture route is not a public authorization or pin-management API.

SysML models the key interval, range match/batch and pinned range action. Licensed
SysIDE 0.10.3 reports zero diagnostics with valid/syntax-error/unresolved-reference
controls. Model SHA-256:
`dfa3562dd6a423d6b701f5b20157301792da9c5417409f2f28a0c7effb087472`.
The existing bounded scalar/lifecycle checker does not execute the new range action;
the TypeScript tests provide scoped evidence. All 23 runtime obligations remain
open end-to-end. No accounting or historical representation was changed.

Remaining: canonical key layouts and atomic upkeep for account/date, FX, lot,
recognition and close predicates; indexed kernel read contexts and incremental
state commitments; explicit historical representation transitions; restartable
large computations and the reviewed bounded-recovery contract. Hash-key intervals
alone do not implement those semantics or remove current whole-state scans. Global
reference protection, remote cold storage and capacity/release verification remain
open. This slice enables no page reclamation, deployment or cloud spending.

Focused verification: 21 tests / 615 assertions across range, pinned-reader and
local runtime suites; ledger typechecking passes. Local logs:
`/tmp/rastrata-range-focused.log` and `/tmp/rastrata-range-syside.log`.

Final `bun run check` passes with 214 ledger tests / 8,570 assertions, 211 kernel
tests / 5,155 assertions, 100% kernel function/line coverage across 13 sources and
102 semantic trace bindings. `git diff --check` passes. No ledger-wide coverage,
mutation, independent audit or production-capacity pass is claimed. Full log:
`/tmp/rastrata-range-check-final.log`.

## Indexed accounting workflows and a schedule-completion counterexample

The indexed SQLite owner now has public-kernel-API conformance cases for a
three-month prepaid-service schedule, prospective estimate revision, recognition
of its successor, multi-line recoverable purchase tax, and terminal schedule
revision. The fixture is ledger-owned; it imports no private kernel test code and
does not change the package boundary rules. This adds four specialized identity
families to direct owner evidence, not all thirteen.

For each of eight committed commands, a new owner instance publishes through the
actual SQLite adapter. A separately executed kernel result is compared in full,
and full durable aggregate bytes are compared after recovery. The expected
specialized identities and FIRST outcome locators are explicitly declared, not
computed by either production identity projector. The complete selected index is
enumerated after each command. Tax postings independently total expense 155,
recoverable tax 15.50 and payable -170.50. A superseded recognition is rejected
specifically with `allocation_schedule_violation`; only its command identity is
added, with no rejected recognition identity or financial state change.

Closing and reopening the SQLite connection preserves all committed and rejected
receipts and the exact historical cutoff before rejection. Replaying all prior
commands adds no outcome or identity. This is local database reopen evidence, not
an abrupt process-kill, workerd or deployed Cloudflare test of these workflows.

**Open accounting-completion finding:** the exact schedule and the posted decimal
balance can diverge over multiple recognitions. The concrete policy is algorithm
1.0.0, monthly straight-line/full-period, USD cents, half-even rounding:

1. Pay 100 into a prepaid-service account and create three equal exact installments.
2. Recognize January: exact `100/3`, posted `33.33`.
3. Prospectively revise February onward to retain a residual value of 10.
4. Recognize both successor installments: each exact `85/3`, each posted `28.33`.
5. Terminate the successor with the exact remaining adjustment of -10.

The schedule's exact recognized amount before termination is 90; its posted
recognized amount is 89.99. Termination is admitted and leaves a posted prepaid
balance of **0.01**, despite the schedule being terminal. Both direct kernel
execution and the recovered indexed ledger reproduce this result. The accounting
identity projection, durable replay and transaction balance are not its cause.

ACC-044.3 explicitly conserves exact amounts and retains quantization residuals;
that condition alone does not guarantee the posted source balance reaches its
residual or clears on termination. `createAllocationSchedule` retains exact
installments, `recognizeScheduledAllocation` rounds each journal independently,
and `reviseAllocationSchedule` calculates carrying amount from exact installments,
not cumulative posted recognition amounts. The regression assertions deliberately
characterize historical behavior. Their passing status is **not** acceptance of
this behavior for production, and they must not be cited as closing this finding.

Next required design/repair: specify exact economic basis separately from posted
carrying basis and cumulative quantization differences; govern how continuing and
terminal schedules settle those differences; preserve old policy/outcome replay
under an explicit prospective algorithm/representation transition. Add cases for
an unchanged schedule, revisions, disposal/termination, out-of-order recognition,
rounding modes, scale/policy changes and receipt retry. A silent global quantizer
change or rewriting old schedule effects is not an acceptable repair.

The source review also checked the local Beancount `compute_residual` routine:
it checks a transaction's residual, not lifetime allocation completion. Balanced
individual journals therefore cannot establish this stronger business property.
No reference implementation or accounting-policy approval for the prospective
repair is claimed. No kernel source, SysML or historical fixture changed here.

Focused owner verification passes: 15 tests / 287 assertions. Local evidence:
`/tmp/rastrata-accounting-owner-focused.log`. All capacity, recovery, remaining
specialized owner conformance and release gates remain open; the new finding adds
an accounting completion gate rather than reducing the required release evidence.

Final `bun run check` passes: 216 ledger tests / 8,729 assertions and 211 kernel
tests / 5,155 assertions; the kernel retains 100% function/line coverage across
13 sources and 102 semantic trace bindings. Format and `git diff --check` pass.
Full local log: `/tmp/rastrata-accounting-owner-check-final.log`. No current
mutation, independent audit, ledger-wide coverage or production-capacity result
is inferred from this run. SysML was unchanged, so no new SysIDE run was needed.

## Prospective cumulative allocation arithmetic and immutable legacy evidence

The next slice captures the pre-repair eight-command allocation/tax history before
introducing new arithmetic. `test/data/allocation-rounding-legacy.json` is 138,760
encoded bytes plus one newline; its file SHA-256 is
`b35b4d0477184ccc04b3b31baf6355f1ddb8d56953b8f474d5860dfe74ba4106`.
The checksum inside that canonical book is
`153dd20090be6a8b50f3895de83ceee72dbfafef4231bc0ce2878238f1cfa92e`.
An actual indexed-owner test rebuilds its genesis from the captured configuration,
reexecutes every captured command, compares every original result hash and the
entire final encoded aggregate, then retries every command through fresh owners.
This fixture is excluded from formatting to preserve the recorded canonical bytes;
it must never be regenerated with the repaired implementation.

The SysML now describes `AllocationPostingPlan` and its immutable entries. The
new public arithmetic calculator `planAllocationPostings` implements that plan,
without changing command execution, codecs or existing schedule effects. Complete
plans carry the exact and posted source bases, explicit residual quantization,
the captured policy, cumulative targets and quantization proofs, per-ordinal posted
amounts and exact-to-posted differences. A plan's content hash does not authenticate
its input source amounts or confer accounting authority.

The endpoint proof is algebraic: distribute the posted allocable basis in the
exact schedule's proportions and difference quantized cumulative targets. The
differences telescope to the representable posted endpoint. The 100/3 example
posts 33.33, 33.34, 33.33. The independently supplied, later-authenticated 66.67
posted carrying basis with a 10 residual produces 28.34 and 28.33, although its
legacy exact carrying basis was 200/3. These two bases remain distinguishable.
Empty/negative/incoherent schedules, unrepresentable posted bases, duplicate or unordered
ordinals/dates, nonconserving schedules and the 1,201st installment reject. Exactly
1,200 zero-valued installments are admitted. Zero exact allocable basis with a
posted remainder requires a separate terminal/rounding settlement rule.

Four calculator tests include 900 deterministic cases checked against independent
integer rounding across all five modes and scales 0, 2 and 6, explicit ties, uneven
and zero weights, fixed ordinal amounts under different recognition orders,
immutable input capture, endpoint conservation and exact reconciliation equations.
These are production-calculator tests, not command integration or ledger capacity
tests. The [integration gates](state-access-contract.md#follow-up-exact-schedule-basis-is-not-posted-carrying-basis)
remain open, and the previous terminal-cent counterexample still reproduces under
the unchanged legacy command path.

Reference boundary: IAS 16 paragraphs 50–53 describe systematic allocation and
prospective residual/useful-life estimate review for property, plant and equipment.
They inform the distinction between a retained estimate and lifetime allocation,
but neither prescribe this rounding algorithm nor govern every prepaid-service
workflow. The cumulative rule is an explicit Rastrata engineering choice, not a
claim of mandated IFRS treatment. Source: [IFRS Foundation, IAS 16 (2021 issued)](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2021/issued/part-a/ias-16-property-plant-and-equipment.pdf).

Licensed SysIDE 0.10.3 validates the modified kernel model and dependent ledger
workspace with zero diagnostics and valid/syntax-error/unresolved-reference
controls. Kernel model SHA-256:
`cfc06bbd918e2bf56246257fbd898d5ebd9055171f84d4ec4fe0f377bb4efa17`.
Ledger model remains
`dfa3562dd6a423d6b701f5b20157301792da9c5417409f2f28a0c7effb087472`.
The scalar checker does not execute the new plan; arithmetic evidence comes from
the calculator tests. Log: `/tmp/rastrata-allocation-plan-syside.log`.

Final `bun run check` passes: 215 kernel tests / 19,619 assertions, 217 ledger
tests / 8,757 assertions, 100% kernel function/line coverage across 13 sources and
102 existing semantic trace bindings. The new arithmetic tests supplement those
bindings; they do not establish complete command enforcement of the amended
requirement. Formatting and `git diff --check` pass. Local log:
`/tmp/rastrata-allocation-plan-check-final.log`. No release mutation campaign,
cloud deployment, capacity pass or independent production certification occurred.

## Explicit cumulative policy command integration

New policies opt in with BOTH `postingAlgorithm: "cumulative-posted-allocation-v1"`
and algorithm version `1.1.0`. The new discriminator matters: historical policies
could already use arbitrary version strings. A version-only switch would change
old behavior. Policies without the discriminator still use independent rounding,
including version 1.1.0; the captured legacy book still reproduces every original
result and complete encoded aggregate. Old readers reject the new policy/plan
fields rather than silently interpreting them. No automatic migration is enabled.

Creation persists a complete plan in the immutable schedule effect. Effect
validation recomputes the full plan, including actual values rather than trusting
an asserted inner hash. Recognition posts the precomputed ordinal's signed values;
an incompatible active quantization policy rejects. Revisions retain exact and
posted recognized/carrying amounts separately; successors use posted carrying plus
the booked adjustment. Impairment retains its exact input and quantization residual
while posting the quantized adjustment. Terminal settlement uses posted carrying;
when it is zero, no synthetic zero journal is required. Successive estimate changes
retain the original canonical source reference through their immutable successors.

Source-closure validation for cumulative recognition/revision independently
reexecutes their calculation against the prior accounting state and compares all
derived effects and the actual journal IDs, accounts, units, decimal amounts,
accounting date and quantization-policy hash. This runs on admission and restored
history, so a balanced but altered journal is not accepted merely because its
schedule plan hashes correctly. Strict codecs retain the explicit discriminator,
complete plan and both posted revision totals. Plan-free legacy effects stay
plan-free; a legacy revision cannot acquire posted totals as arbitrary metadata.

Evidence includes out-of-order recognition totaling exactly 100, the formerly
failing 33.33 / 28.34 / 28.33 revision case, positive and zero terminal balances,
fractional impairment with explicit residual, a second successive revision,
tampered plans and journal amounts, missing plan data, policy conflict, and legacy
version-name reuse. An actual indexed SQLite book finishes the revised schedule,
terminates its final 10 and reaches a posted prepaid balance of exactly zero;
connection reopen, original receipt retry, historical cutoff and durable round-trip
all agree. Existing unmarked schedules still reproduce the terminal-cent finding.

Limits: this is new-policy integration, not legacy conversion. A cumulative revision
of an old schedule, a downgrade, or changes to its posting accounts/quantization
policy reject pending a verified transition. Arbitrary source-history conversion,
broader hostile-codec cases, disposal completion across both algorithms, abrupt
failure injection for these workflows, full mutation/release recertification and
all production-ledger capacity/recovery gates remain open. No cloud operation,
commit or push occurred in this slice.

Final `bun run check` passes with 220 kernel tests / 19,688 assertions, 219 ledger
tests / 8,787 assertions, 100% kernel function/line coverage across 13 sources and
102 existing trace bindings. The new tests are additional scoped evidence, not a
claim that those bindings alone prove the amended lifecycle contract. Format and
`git diff --check` pass. Log: `/tmp/rastrata-cumulative-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for kernel and dependent ledger,
with valid/syntax-error/unresolved-reference controls. Kernel model SHA-256:
`bcc0b2d54bd2eced70ccf30408241ea29db3729772cb8e716234e4bfd550fa93`.
Ledger model remains
`dfa3562dd6a423d6b701f5b20157301792da9c5417409f2f28a0c7effb087472`.
Log: `/tmp/rastrata-cumulative-syside.log`.

## Cumulative workflow process-kill and concurrency evidence

The indexed owner now has a real subprocess crash campaign, not just exceptions
inside a transaction. A child provisions a disposable local SQLite book with the
cumulative allocation/tax workflow. A second child attempts its final termination
or a stale-revision command that must be retained as a rejection. SQLite uses its
own WAL and `synchronous=FULL`; no application WAL or new persistence algorithm
was introduced.

For each outcome kind, the subprocess is killed with SIGKILL at all seven points:
after a derived-page INSERT; after canonical outcome INSERT; after chunk INSERT;
after canonical head UPDATE; after index-root UPDATE; after pin retirement DELETE;
and immediately after the shared SQLite transaction commits but before its caller
receives a receipt. The first six cuts precede the canonical commit; the seventh
is an uncertain committed result. Every kill must produce a synchronous boundary
marker, the expected signal, no receipt, and no watchdog timeout. Syntax errors,
unrecognized hooks and unrelated crashes therefore cannot count as passing fault
injections. Separate controls reject invalid target directories/hooks before
opening a database. Children inherit only the test temporary-directory setting,
not the parent's service credentials or other environment.

All 14 cases pass. Fresh connections recover complete aggregate bytes equal to
either the baseline or the independently executed expected outcome, never a mixed
state. Selected roots/counts and all five possible terminal identities are checked:
command, journal, two postings and schedule revision. A retained rejection adds
only its command identity and advances Oseq without advancing book revision.
Resubmission commits/rejects after a pre-commit cut, or returns the exact retained
original after a post-commit cut. No duplicate journal/outcome is added. Successful
termination leaves posted prepaid balance zero; rejection leaves it at 10. Later
lease expiry and bounded inactive-construction cleanup preserve the selected roots
and the complete canonical result, including after abandoned page construction.

Two independently instantiated owners also race different, valid termination
commands at the same expected revision. Exactly one commits; the other retains
`stale_book_revision`. The result is one financial revision and journal, two retained
outcomes, six new identities, and exact receipts on retries through fresh owners.
This is competing-owner/CAS evidence, not a sustained multi-client load campaign.

Scope limits: SIGKILL of Bun processes on disposable local SQLite is not a
Cloudflare Durable Object crash, storage-node failure, power-loss/fsync-hardware
test, lost-account restore, checkpoint startup proof or production workload.
The local adapter's `sync` is a no-op because the SQLite FULL commit has already
completed; it does not claim to emulate Durable Object `storage.sync`. Other
workflows and publication patterns still need their own fault evidence. No real
book, remote resource or deployment was modified; temporary test books were removed.
No production code or SysML changed, so the prior SysIDE result remains applicable
but was not rerun or presented as new execution evidence.

Final `bun run check` passes: 222 ledger tests / 9,227 assertions, 220 kernel tests /
19,688 assertions, 100% kernel function/line coverage across 13 sources and 102
existing trace bindings. Format and `git diff --check` pass. Full local log:
`/tmp/rastrata-cumulative-crash-check-final.log`. These checks do not close the
legacy schedule transition, cloud recovery, capacity or release-recertification
gates, and no mutation score or independent production certification is claimed.

## Verified replay prefix memoization

Scope: reduce repeated accounting execution without changing PL-007/008 cold
startup or historical verification, either canonical storage format, hashes,
accounting results, identity audits or configured capacity limits. This implements
the existing queue/validation/durability/cache-publication lifecycle; it does not
introduce checkpoints or authorize lazy historical verification.

`ProductionLedger` now keeps one owner-local verified aggregate, original receipt
map and ordered SHA-256 fingerprints of complete records. Fingerprint preimages
include every serialized record field and body, not just asserted digests or the
terminal head. Genesis, format and complete identity are checked separately. Every
operation still performs the full storage load/chunk validation and fingerprints
every record. A matching previously verified prefix can reuse immutable accounting
state; all new suffix records execute through the existing exact replay path.
Cold owners and historical reads retain full replay. The indexed owner still audits
the full hot/cold identity population and selected roots before serving or writing.

Evidence is captured before asynchronous validation/publication and becomes reusable
only after successful validation and durability confirmation. Candidate command
state is not published before its atomic commit and final sync. Exceptions and both
validation-time and write-time CAS conflicts clear the cache. Returned aggregate
wrappers and heads cannot mutate its contents; the original receipt map is private.
An altered or shortened cached prefix fails closed rather than silently replaying
a different valid history. This last protection is ephemeral: a new owner, or one
whose failed operation invalidated its memory, still requires an independent
PL-011 witness to detect a self-consistent whole-database rollback.

Twenty-eight additional tests across legacy and compact formats exercise actual
state reuse, complete storage rereads, deep snapshot immutability, another owner's
committed/rejected suffix, exact retries, historical cutoffs, changed record fields
(including compact frames and unexpected metadata), real SQLite chunk corruption,
self-consistent rollback, repeated provisioning, derived-validation failure,
durability failures and SQL rollback. Existing independent-owner races, derived
page tampering, uncertain writes and fourteen process-SIGKILL cases also pass.

### Local measurements and remaining limits

Unchanged `probe:compact-capacity`, Bun 1.4.0 on Apple M5, dirty working tree at
`c7e293437e6e591a7097513c167d6ae4d65aec13`. Production ledger source SHA-256:
`148c32be41d9356ade915abc77088777f6bc1e6c8dc0a16d503c6bc4a82d1d1a`.
The complete source inventory, raw events and failing assessment are retained in
`coverage/ledger-capacity/2026-09-06T10-38-29.035Z/`.

| Sales at sample | Posting-window median | Cold recovery | Warm exact retry | SQLite database bytes |
| --- | --- | --- | --- | --- |
| 200 | 14.21 ms | 901.96 ms | 6.58 ms | 2,207,744 |
| 500 | 32.14 ms | 5,493.41 ms | 18.38 ms | 5,472,256 |
| 750 | 51.06 ms | 12,483.71 ms | 23.91 ms | 8,167,424 |

The probe reached 999 sales / 1,000 outcomes in 83.89 seconds, then failed the
1,000th sale with `ledger_capacity_exceeded`. It checked the unchanged complete
aggregate against its direct kernel oracle and preserved the original exact retry.
The regular last full snapshot sample is 750 sales; the assessment correctly exits
1 and does **not** call the 10,000-sale target achieved. This is not a raised limit.

A separate check reopened the terminal book, verified all 999 two-line sales and
their exact cash/income balances, then ran two paired exact retries on that same
book, each with a fresh owner followed by a warm owner. Complete receipts and
encoded aggregate bytes matched: 22,590.21 / 32.30 ms and 23,439.09 / 32.14 ms
(cold / warm). Raw paired output: `/tmp/rastrata-verified-replay-paired.log`.
This isolates owner-cache availability, not a before/after release comparison,
representative enterprise workload, statistically established SLO or Cloudflare
latency. Both logical index partitions were absent from this bare-SQLite capacity
probe. Indexed-owner correctness tests do not establish its corresponding capacity.

Every operation still reads O(history bytes), the cache retains O(history) receipt
and fingerprint entries, kernel evaluation hashes/scans whole collections, and
cold recovery still repeatedly executes historical commands. R2 layout, indexed
kernel/read sets, versioned integrity commitments, large operations, independent
restore and approved production workload gates remain open. Removing the outcome
cap without resolving those costs is not an acceptable next step.

Final root `bun run check` passes: 250 ledger tests / 9,793 assertions; 220 kernel
tests / 19,688 assertions; 100% kernel function/line coverage across 13 sources;
102 existing semantic trace bindings. Log:
`/tmp/rastrata-verified-replay-check-final.log`. No kernel or SysML source changed
in this step; no fresh SysIDE, mutation score, independent audit, deployment or
production-readiness certification is claimed.

## Indexed representation and physical-root counterexample

The next capacity step cannot silently substitute indexes for arrays inside the
existing kernel hash profile. Source review of `BookState`, `BookProtocolState`,
`AccountingCanonicalState`, `hashBookState` and `applyEffects` identified the full
state disposition, including configuration aliases, thirteen immutable accounting
effect collections, rejection history and the replaceable lot-state arrays.
The [representation boundary](state-access-contract.md#indexed-representation-boundary)
now specifies the proposed commitment catalog, economic comparison obligations,
legacy compatibility boundary and ordered acceptance sequence. It does not enable
a new format or choose an unmeasured logical commitment tree.

An executable counterexample in `test/index-pages.test.ts` constructs the same four
key/Oseq entries as an original leaf, a relocated byte-identical leaf, and a two-leaf
repacked tree. All three enumerate the exact same entries and return the same point
lookups, yet all three `IndexRoot.contentHash` values differ. This is correct for
the current authenticated **physical** storage view, not a bug in that codec.
It proves those roots cannot directly replace financial state commitments: storage
maintenance must not change accounting identity. Financial roots also exclude
object ID, namespace, restore generation and publication fence; the execution view
binds those separately to the immutable financial identity and logical roots.

The SysML addition models profile identities, logical collection commitments,
indexed state and verified read evidence. PL-021 requires complete supported
contexts before indexed semantic evaluation; L24 records the intentionally open
runtime differential/corruption/concurrency/physical-invariance obligation. Eleven
scalar cases cover the accepted context, each of nine independently missing facts,
and safe refusal. Nine new negative controls remove each conjunct independently.
These test the Boolean admission contract, **not** whether an implementation can
establish those facts. No runtime flag supplied by a caller is verification evidence.

Reference review used local TigerBeetle commit
`97c7a8ef385270ebe0e1b75959d3d21d134629df`: `docs/internals/data_file.md`
(SHA-256 `03f6d7f7c7f55f62cb7fe797048e9509f378fe973bdbd30134bdf8f125dd7568`)
for physical block references and root publication, and `docs/internals/upgrades.md`
(`88de4c111e2d96ab215505380fd406d96f28840b1e7ed7c516ad3b0a5eea3050`)
for retaining version-specific execution. Rastrata is not adopting TigerBeetle's
replication/upgrade machinery or fixed-scale arithmetic by analogy.

Verification: licensed SysIDE 0.10.3 reports zero diagnostics on both models and
cross-file workspace imports, with valid/syntax-error/unresolved-reference canaries.
Ledger model SHA-256:
`f37807cbf7c5bb5b8686d52bc92280798ad3b779d72074e581012124a2de8f8e`.
Fixture SHA-256:
`f1907706561ad301237b400785df4de3afa065a9eb83ff3ad5a5615b3cd35fb5`.
The bounded design checker passes 22 constraints / 161 scalar cases, the existing
two machines / 40 transitions / 18 lifecycle cases, 29 negative controls and
18 checker unit tests. It now catalogs 21 requirements / 24 open runtime obligations.
Root `bun run check` passes: 251 ledger tests / 9,811 assertions; 220 kernel tests /
19,688 assertions; 100% kernel function/line coverage and 102 existing trace bindings.
Logs: `/tmp/rastrata-indexed-representation-syside-final.log` and
`/tmp/rastrata-indexed-representation-check-final.log`.

Remaining implementation gates are unchanged: measured physical-independent logical
commitments; exact conditional lot deltas and complete large-operation folds;
all-seventeen-command indexed execution with authenticated complete read sets;
approved startup/corruption-detection semantics; scalable storage and independent
restore; cloud workload and release evidence. The previous 10,000-sale capacity
assessment remains failed. No kernel semantics, production storage format, capacity
limit or deployment changed in this design step.

## Logical-map candidate and measurements

`src/logical-map.ts` implements an internal candidate binary Patricia Merkle map,
not an enabled ledger/kernel format. Fixed-width 256-bit keys map to complete row
commitment digests. Canonical binary prefix partitioning makes shape independent
of insertion/deletion history; branches have exactly two nonempty, disjoint children.
The domain must commit immutable financial identity, profile, collection and key
schema, not physical location, generation or maintenance fence. Root, branch/leaf
node kinds and context have distinct authenticated preimages. Physical storage is
an injected logical-digest reader and is not part of the economic root.

The design follows the deterministic key/value commitment principle described in
[Ethereum's Merkle-Patricia documentation](https://ethereum.org/developers/docs/data-structures-and-encoding/patricia-merkle-trie)
and the need to distinguish leaf/internal-node hashing explained in
[RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1).
It is neither codec-compatible with Ethereum nor an RFC 9162 implementation.
An append-only history tree alone cannot express replacing/deleting live holding
entries; a sorted whole-map hash is a simpler comparison baseline but still requires
the whole population for an update. The candidate is being evaluated, not frozen
as the production commitment structure.

`prepareLogicalChange` verifies the expected prior digest or absence and produces
immutable candidate nodes/root without any writes or publication. Insert, replace,
delete and no-op are supported; delete collapses redundant branches canonically.
Leaf/branch references commit exact min/max/population, with canonical wire form,
fixed digest syntax, at most 2,048 encoded characters per node/root and unsigned
64-bit population bounds. Accepted wire fields are ASCII, so their encoded byte
count equals character count. Strictly increasing prefix splits bound a path to
256 branches plus one leaf. Storage/decoder/before-value failures propagate rather
than becoming empty or an accounting rejection.

Point and prefix-absence lookup is not a full history health audit. Untouched
subtrees may remain unread, including surviving sibling references after deletion.
`auditLogicalMap` instead traverses all nodes and optionally checks every ordered
key/value against an independent canonical observer; only completion verifies the
full population. The candidate does not mint an authenticated accounting context:
the owner must establish the selected root's authority, bind full raw row identity,
content and required insertion ordinal to each value digest, and satisfy the
existing PL-007/008 startup and PL-021 read-context contract. A structural root and
an arbitrary caller-supplied matching hash cannot prove accounting correctness.

### Correctness evidence

Seven tests compare against a separate full rebuild that sorts keys and partitions
binary strings without calling production mutation, codec, lookup or split helpers.
Both use the existing kernel hash primitive. Coverage includes all six permutations
of three rows; replace-and-restore and delete-and-reinsert invariance; relocated
readers; two fixed root vectors; 900 mixed conditional changes across three seeds,
with full independent root comparison after every operation; complete population
audits; stale values; wrong domains/anchors; malformed/rehashed branches; overflow;
missing/changed bytes; observer failures; and explicit point-proof versus full-audit
distinction. A constructed 257-key population takes exactly 257 node reads at its
deepest key, and deleting that key creates 255 nodes while matching full rebuild.
These are scoped algorithm tests, not a mutation score or independent release audit.

### In-memory measurement

`bun run --cwd packages/ledger probe:logical-map` on Bun 1.4.0 / Apple M5 builds
10,000 deterministic hashed keys. Each milestone is checked against three complete
independent rebuilds and a full observed population audit. There is no SQLite/R2
I/O, accounting command execution or Cloudflare timing in these measurements.

| Rows | Append-window median | Maximum path reads / created nodes | Full rebuild median | Live logical bytes | All retained logical-node bytes |
| --- | --- | --- | --- | --- | --- |
| 100 | 0.0483 ms | 9 / 10 | 0.7441 ms | 66,211 | 295,857 |
| 1,000 | 0.0487 ms | 13 / 14 | 4.7057 ms | 666,662 | 4,625,266 |
| 10,000 | 0.0652 ms | 17 / 18 | 42.6237 ms | 6,671,238 | 63,301,603 |

At 10,000 rows the live tree has 19,999 logical nodes, while retaining every old
node creates 131,788 distinct nodes. Sampled process RSS is 366,821,376 bytes,
including the harness, historical node map, source values and independent rebuilds.
These numbers make physical batching/packing and safe reclamation mandatory topics
for the next review. Do not equate logical hash addresses with the existing
non-reusable physical page allocation identities or retain every obsolete path
forever. The append median covers the preceding 9,000-row window; it is not a
paired per-command SLO comparison with the full 10,000-row rebuild median.

Raw evidence: `/tmp/rastrata-logical-map-probe.log`. SHA-256 identities:
implementation `e3a06eda9759ce448dad971fb77040f271600051f44f4362cf9062425db1309b`;
independent oracle `32314771b318d72898677ad6bc0bdd00fa63e38487633b6e5901691c42f7d6eb`;
probe `5f4959f31af48c05be2d149291130a0c9f163210e10d883ba6b9c20ac3b57d89`.

Final root `bun run check` passes: 258 ledger tests / 14,395 assertions; 220 kernel
tests / 19,688 assertions; 100% kernel function/line coverage across 13 sources and
102 existing trace bindings. Log: `/tmp/rastrata-logical-map-check-final.log`.
SysML is unchanged from the preceding zero-diagnostic SysIDE run. The candidate is
not exported from the ledger package entry point and no production caller uses it.
Canonical row projection, physical placement/pins/atomic publication, all-command
indexed evaluation, large-operation folds and original capacity/recovery/release
gates remain open. Ten thousand synthetic map rows are not ten thousand ledger
commands; the production-ledger capacity assessment remains failed.

## Exact legacy accounting projection

`src/logical-book.ts` connects the logical-map candidate to actual accounting state
under the explicit `rastrata-legacy-state-projection-candidate-v1` identity. This is
a bounded comparison oracle for old-format content, **not** the final indexed
kernel state/effect/receipt codec. It validates the complete durable source and
requires canonical byte-for-byte reencoding before asynchronously constructing
anything. Source decoding validates kernel state/protocol integrity but does not
replace the production owner's full canonical command replay or independent head
authority.

The projection has 24 closed collections: configuration snapshots, optional opening
boundary, three lot collections, journals, corrections, period transitions, close
packages, revisions, all thirteen accounting-effect families, and retained command
results. All empty collections are explicit. `Record<keyof ...>` dispositions cover
every current `BookState`, `AccountingCanonicalState` and `BookProtocolState` field;
new or missing kernel fields fail compilation until classified. Runtime field-set
checks and an exhaustive disposition switch provide additional omission controls.
These are field-coverage guards, not a claim of semantic implementation coverage.

Rows retain the exact existing codec's tagged wire strings. Their domain and
one-based ordinal are committed alongside those bytes; no conversion to floating
numbers or untagged rational/decimal object shapes occurs. Existing IDs, content
hashes, policy/derivation evidence and legacy revision fields remain inside the
original row content. Seven financial header fields and six configuration-alias
commitments have explicit homes. State/protocol catalogs are sorted by collection
name before hashing; row order remains the original canonical insertion order.
The old state hash and complete source-aggregate commitment are returned separately
as source evidence, never mislabeled as the newly calculated state root.

Seven tests establish the complete genesis catalog; independently reconstruct all
24 collections, header, aliases and state/protocol commitments from the source wire;
audit logical membership and exact tagged amounts; reject malformed, noncanonical,
extra-field and semantically corrupted sources; preserve both frozen historical
fixtures; and verify rejection-only protocol advancement. Incremental conditional
row changes match a complete projection after each of eight committed workflow
commands and a retained rejection, with complete population audits for every
collection. The six command variants exercised by that workflow are activation,
ordinary journal, schedule creation, schedule recognition, schedule revision and
taxed transaction. This is **not** all-seventeen-command differential coverage.

Historical file SHA-256 values remain unchanged:
allocation fixture `b35b4d0477184ccc04b3b31baf6355f1ddb8d56953b8f474d5860dfe74ba4106`;
inventory fixture `bf669885c3427eec096083d3203bac7c4196d83eb6b92e46b01fc8b59147d47b`.
Projection implementation SHA-256:
`ecb668c5c732e5dbb81167a52413a6e50165a88c542f93f3af2d02edad66c939`.

Final root `bun run check` passes: 265 ledger tests / 15,507 assertions, 220 kernel
tests / 19,688 assertions, 100% kernel function/line coverage across 13 sources and
102 existing trace bindings. Log: `/tmp/rastrata-logical-book-check-final.log`.
No SysML or kernel production source changed, so no new SysIDE run is claimed.

Limits are deliberate and material: the oracle materializes a full bounded legacy
aggregate, keeps intermediate logical nodes during construction, and preserves old
full-array effects and hashes in its source rows. It is neither a memory-capacity
proof nor indexed execution. A snapshot collection/ordinal is not yet the scalable
creating-outcome/effect locator needed by the owner. Canonical row/source resolution,
physical packing and protected reclamation, authenticated complete command read
sets, new effect/intent/revision codecs and large-operation semantics still need
implementation and verification. Neither logical module is exported through the
package entry point or called by the production ledger. Existing storage formats,
capacity limits, historical receipts and the failed production capacity gate remain
unchanged; no deployment or production-readiness claim is made.

## Bounded canonical source fetch and late corruption

The indexed SQLite owner now resolves existing identity hits through
`SqliteBookStorage.readVerifiedOutcome`, using the exact complete record commitment
from its already verified canonical history. The fetch verifies complete scope,
format, a captured full head before and after reading, exact Oseq/header-column
agreement, bounded chunk structure/digests and the complete reconstructed record
hash. The owner rechecks its live construction pin after the fetch. Missing rows,
changed bytes/frames, a changed head or foreign scope fail rather than become
identity absence or a fictional retained accounting rejection.

This is a real production-path change, not an enabled indexed kernel. The owner
still loads/verifies full history, constructs the expected source commitment from
that verified in-memory record, and audits complete identity populations. The new
fetch does not prove where a caller-supplied hash came from, replace independent
canonical head authority, or discover a trusted locator without that history.
The complete replay fingerprint helper moved to `records.ts` as
`verifiedOutcomeRecordHash` with its preimage unchanged; existing cache evidence
and record formats have not been version-reinterpreted.

Two integrity/resource findings were fixed alongside the fetch:

- Outcome headers containing an unexpected `body` member now fail closed in both
  full loads and targeted reads. Previously reconstruction could overwrite that
  member with the chunk body, hiding the metadata corruption from final record
  comparison. Valid writer-produced headers never contain that member.
- Chunk SQL reads return at most 262,145 blob bytes per row (the 262,144-byte limit
  plus a rejection sentinel), at most five rows, with original length/type checks
  and exact digest-byte lengths. An oversized stored blob is rejected without
  returning its whole value to JavaScript. The targeted metadata/header queries
  similarly slice text and compare full byte lengths, including NUL suffixes.
  These are transfer/allocation bounds at the JavaScript boundary, not a claim
  about SQLite's internal I/O or a full-book memory-capacity proof.

Eight additional tests cover a four-query source lookup at 1 and 101 retained
outcomes, unchanged fetched payload bytes, an actual SQLite indexed query plan
(SEARCH, not SCAN), forged commitments, wrong scope/cutoffs, accessor heads,
changed framing, missing source rows, hidden format/digest suffixes, the header-body
counterexample in both legacy/compact formats, a full-head change during the chunk
read, and an oversized 1,048,576-byte stored blob returning only the 262,145-byte
sentinel slice before rejection.

The owner-level fault test injects corruption into an existing inventory source
after full verification, when the new command's construction pin is registered.
The subsequent bounded source read detects the damage: no new outcome is retained,
and after restoring only the disposable test source the exact original command
succeeds with its expected result hash. Existing cold/hot source lookup, concurrency,
uncertain-publication and fourteen process-SIGKILL tests continue to pass. This
test is not permission to damage a real book and no real storage was modified.

Root `bun run check` passes: 273 ledger tests / 15,648 assertions; 220 kernel tests /
19,688 assertions; 100% kernel function/line coverage across 13 sources and 102
existing trace bindings. Log: `/tmp/rastrata-bounded-source-check-final.log`.
SQLite implementation SHA-256:
`83b0849639055ee3a21b50c4f365e34160dfd0cca542bde16ba1c2f569e7c744`;
indexed owner: `3087a3eb86e5ad681b94d6e465dc0bbf5f89a5dc63bae9ed0a13be88870da934`.
No SysML or kernel source changed, no new SysIDE/mutation result is claimed, and
neither the 1,000-outcome limit nor the failed production capacity verdict changed.
Canonical logical-row/effect locators, physical packing and protected reclamation,
bounded indexed evaluation, large operations and approved recovery/release gates
remain unfinished.

## Command admission and retained protocol integrity

2026-09-06, local correction discovered while tracing logical rows back to compact
outcomes. This is a demonstrated correctness exception to the frozen kernel, not
permission to redefine valid accounting results or rewrite retained history.

Counterexample: a new typed command with a syntactically valid but incorrect
`inputHash` produced a retained `command_identity_conflict` rejection. The kernel's
own durable decoder then rejected that aggregate because the retained command's
recomputed identity disagreed with its hash. Snapshot storage already refused the
invalid aggregate before publication, but compact storage published the rejection
at the next outcome sequence. A foreign-book command could likewise create an
invalid retained protocol through the direct kernel API. Ledger scope admission
already prevented that cross-book path at its boundary.

The correction leaves incorrect-hash and foreign-book requests unretained. The
foreign-book check precedes protocol-version and temporal admission, preventing a
foreign request from being retained merely because it also has an unsupported
version. Existing-ID conflicts were already unretained. Valid same-book accounting
rejections, including the kernel's unsupported-version rejection, retain their
original semantics. ACC-030 now states the boundary explicitly. No result hash
algorithm, durable format, valid historical receipt or accounting calculation changed.

The audit also found that unknown command fields reached evaluation before being
refused by serialization. They did not bypass the existing persistence checks, but
failed too late and with inconsistent errors. `snapshotCommand` now applies the
kernel's existing exact durable schema after its bounded, accessor-free copy and
before any storage access, reporting `ledger_command_invalid`. The exported
`assertBookCommandShape` reuses that schema; it is not a raw-input parser, resource
bound, hash verification or accounting evaluator. Public decoding/auth remain
separate unfinished service obligations.

Seven additional tests cover direct kernel admission, durable round-trip and
identity reuse; valid retained/replayed unsupported-version rejection; mismatched
state admission metadata; the shared shape validator; both ledger formats before
and after reopening; zero SQL calls for unknown-field admission; and an explicitly
reconstructed historical bad-hash compact record. Recovery of that invalid history
fails closed, as does another command against the damaged book. Exact stored bytes
are unchanged: there is no silent deletion, renumbering or corrective receipt.
One existing outcome test now expects the corrected unretained foreign-book result.

Verification: root `bun run check` passes, with 278 ledger tests / 15,679 assertions,
222 kernel tests / 19,723 assertions, 100% kernel functions and lines across 13
production sources, and 102 existing trace bindings. Log:
`/tmp/rastrata-command-admission-check-final.log`. Licensed SysIDE 0.10.3 reports
zero diagnostics for both models and the dependency workspace, with valid,
syntax-error and unresolved-reference canaries passing:
`/tmp/rastrata-command-admission-syside.log`.

Source SHA-256: kernel book
`8ff74f214c7ce065a00d904dfe374088fbfcb75f9b9e7eb7b2929c36dc81af01`;
kernel codec `e7212662eed0d4b822819c54fc87a00215d25837f74f4e22a5da6c1da83ffb11`;
ledger records `f8ee8f0fa14d9a951ed4145e88161b783e63f33549c9d6459fb812cae0f93a19`;
kernel model `83ab69c787cda46c93c8010fa13741f2a9e909683fc8a394023bd487a66326e7`.
No new mutation, capacity, cloud recovery or production-readiness result is claimed.
The logical source-locator work resumes after this correction; the 1,000-outcome
limit and remaining representation, recovery and release gates are unchanged.

## Authenticated outcome row resolution

2026-09-06, bounded source-content candidate, not a new enabled ledger format.
`outcome-source.ts` projects rows from one already authenticated compact record
and resolves a selected row only when both its complete source-record commitment
and its independent logical collection/ordinal/content commitment match.
Expected commitments, collection domain and locator must come from a verified
pinned view. The helper does not make caller-invented matching hashes authoritative.
The existing SQL source reader supplies bounded canonical bytes; the helper is not
a raw public record/locator decoder or a replacement for accounting replay.

The source selector identifies the retained result, revision, effect index, or
specific member/index within a lot-state effect. Typed tables account for all twenty
current effect variants and all thirteen accounting collection names. Ordinary rows
reuse original schema-validated tagged codec subtrees, preserving exact decimal,
rational, evidence and policy bytes without a second accounting-value encoder.
Groups distinguish appends from complete replacements; empty replacement groups
remain meaningful. Current lot effects are still whole snapshots, not sparse deltas.

Retained rows require more than a payload pointer: committed results also retain
the intent hash, which depends on expected/resulting book/configuration/posting
context. The helper uses before/after heads covered by the complete record hash and
the kernel's existing `hashCommitIntent`, now exported as a read-only calculation.
Its algorithm, callers and hash preimage are unchanged; the export is not an
admission or commit authority. Rejection-only outcomes produce only a protocol row
and cannot change financial head fields.

The source explicitly supplies known insertion ordinals where justified: retained
Oseq, revision number, journal posting sequence, configuration revision plus one,
opening singleton or lot-snapshot index. Other append-only collections return a
null ordinal. A locator for those rows needs the authenticated prior collection
population and exact row commitment; substituting the outcome number would be wrong.
Genesis configuration, mutable header aliases, full row-locator catalog publication,
semantic raw-ID/index checks and complete pinned evaluation remain separate work.

Seven new tests compare source-driven updates against independently encoded complete
kernel aggregates across all twenty-four logical collections after every outcome in
the tested workflows. They include cumulative allocation/tax and retained rejection,
configuration-only commits and close/reopen without posting advancement, plus exact
replay of both unchanged frozen inventory/allocation books. Each emitted row is also
resolved using the full projection's independently obtained row hash. Negative tests
change every before/after head field, source identity generation, body, selected
collection, ordinal, selector, domain and row hash. All source results are immutable.
These workflows do not execute every accounting effect family; the closed type/table
catalog is not a claim of complete runtime conformance for all seventeen commands.

The existing SQLite 1-versus-101-outcome test now fetches and resolves the original
retained row against its full-book projection. It still performs four bounded source
queries returning four rows and unchanged payload bytes, with indexed SEARCH rather
than SCAN. Full owner verification before that measurement remains history-dependent;
this is not an end-to-end latency, memory or production-capacity result.

Root `bun run check` passes: 285 ledger tests / 16,754 assertions; 222 kernel tests /
19,723 assertions; 100% kernel function/line coverage across thirteen sources and
102 existing trace bindings. Log: `/tmp/rastrata-outcome-source-check-final.log`.
Source SHA-256: `outcome-source.ts`
`3c5e05c834da49192bc2146edc098c9380caabfb5b2a10ab9c4c81689fa52b32`;
kernel book `839e7d200b15295aa2879a1f19b07c077360ea9ea34e5ea04a4ac4d9ba0d5755`.
No SysML model changed this turn and no fresh SysIDE, mutation, cloud or readiness
claim is made. The 1,000-outcome limit and production release gates remain open.

## Atomic source catalog publication

2026-09-06, new-book opt-in owner profile
`rastrata-indexed-sqlite-row-source-candidate-v1`, selected by the final constructor
option `{ sourceCatalog: true }`. The existing indexed owner profile remains the
default and unchanged books must use their original profile. Either direction of
profile mismatch is refused; there is no automatic catalog backfill or adoption.
The compact financial format and kernel evaluator are unchanged.

`SqliteSourceCatalog` persists the complete closed twenty-four-collection projection
with separate financial-row and source-locator Patricia roots. Genesis rows bind the
original genesis digest; subsequent rows bind the complete original outcome and
selector. The catalog binds book identity, exact canonical head, header, state and
protocol roots. Expected roots/populations come from the fully verified accounting
transition, not from supplied deltas. Unchanged lot snapshot rows preserve existing
locators, changed rows are replaced, and empty replacements remain explicit.

Preparation retains immutable publication data behind an opaque in-memory token;
callers cannot substitute mutable node maps. It checks the previously verified
catalog digest and head. The owner stages changed paths while its construction pin
is live, then publishes canonical outcome/chunks/head, identity-index root, source
nodes/origins and catalog metadata in the existing same-store synchronous transaction
under full-head/fence CAS. Existing digest keys cannot be overwritten with different
bytes. No asynchronous work occurs inside that transaction. Only confirmed durability
permits a receipt. Aborted new source-node writes roll back, rather than leaving
partially published metadata. Historic nodes remain retained; GC is not implemented.

Provisioning now permits an asynchronous adapter preparation phase before the atomic
write. The ledger awaits it, and concurrent same-genesis initializations reconcile
the verified winning book after an explicit head conflict. A different genesis still
fails; arbitrary storage errors or uncertain acknowledgements are not converted into
success. The owner snapshots the small provisioning envelope before yielding.

Recovery retains full canonical verification, then compares the catalog against a
fresh complete legacy projection, audits both root graphs/populations, and verifies
every locator back to its genesis or exact retained outcome and independent row hash.
Bounded SQL reads limit catalog text to 131,072 characters and node/origin text to
2,048, with byte-length/hash checks and rejection sentinels. Individual content
records are bounded, but complete verification and projection remain history-sized.
The current catalog is an additional verified storage representation, not a bounded
kernel or a production capacity improvement. Public pinned row-query APIs, semantic
indexes/read-set closure, packing/reclamation and scalable cold placement remain open.

Seventeen additional tests exercise this real owner profile: full cumulative
allocation/tax and rejected-outcome replay against independently projected roots;
rollback at source-node, source-origin and catalog metadata boundaries; uncertain
acknowledgement and exact retry; opposite-profile refusal; concurrent initialization;
atomic initialization failure; source catalog/node/origin corruption; competing
command owners; and eight actual isolated-process SIGKILL cases. The kills cover
the three new SQL boundaries and post-commit/pre-receipt for both a committed
termination and a retained rejection. Each reopened connection verifies the entire
book/catalog and recovers exactly the prior or next state and original result.
Disposable temporary databases only were used; no real book or cloud was modified.

A write-growth test checks sixteen successive ordinary postings: each writes exactly
three source-origin records and one catalog publication, with node insert attempts
bounded by `6 * (ceil(log2(retained outcomes)) + 2)` for this ordered posting stream.
This measures changed-path writes, not all SQL reads, total retained storage or an
end-to-end SLO. The full-projection/audit cost and retained intermediate nodes are
explicit reasons the profile is still a candidate, with unchanged capacity limits.

Root `bun run check` passes: 302 ledger tests / 17,445 assertions; 222 kernel tests /
19,723 assertions; 100% kernel function/line coverage across thirteen sources and
102 existing trace bindings. Log: `/tmp/rastrata-source-catalog-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and their workspace,
with all positive/syntax/unresolved-reference canaries passing:
`/tmp/rastrata-source-catalog-syside.log`. The SysML now names the source locator,
derived source catalog and atomic publication behavior; PL-021 remains an open
bounded-execution obligation, not closed merely by these structures.

SHA-256: source catalog
`96e9b80ad6b80256e359f8de9fd6b17ab8a5dc1bf8c79f75064d06abc46c42d9`;
indexed owner `eb2e0a4dd3080f9e20a98b5edc9ac1992fb883a4036c122129caf000ac956212`;
ledger `224a267164be3f7b545cdcbbe2810183421267fd839c5864ab25a8214abbc815`;
ledger model `e754eaa2397fe0902f9559eccca4d7e79933fa1600b12a92cf1546e1a2d03904`.
No new mutation, cloud recovery, production-scale capacity or release-readiness
claim is made. The original 1,000-outcome limit is unchanged.

## Pinned current-row access

2026-09-06, internal access port for the opt-in source-catalog owner. This is the
first current-view row reader, not a public query endpoint, historical MVCC reader,
or a replacement for existing full-history `read`/`readAt` verification.

`openCurrentRowReader()` requires the owner's prior full canonical/catalog
verification. It obtains a durable reader lease and captures the exact verified
catalog through an opaque instance-owned token. No caller-supplied catalog, root,
source hash or trusted flag is admitted. The returned head/result objects are
immutable, reads and close are serialized, and failed/uncertain reads retire the
handle. A release that cannot be confirmed leaves protection to durable lease
expiry; the handle cannot silently reopen or switch to a newer head.

For an ordinal query, the reader verifies both the financial-row and source-locator
paths. A present row resolves the exact original genesis or outcome and checks the
separate collection/ordinal/content commitment. Absence requires both paths absent
outside the authenticated dense collection population. A missing required node,
locator or source is an error, never evidence of absence. Catalog/head and durable
pin authority are rechecked before returning. New publication invalidates this
current-view context; future long-running report snapshots need explicit retained
view semantics rather than silently reusing this API.

`readVerifiedGenesis` supplies the missing bounded initial-configuration source
path: the same copied full-head/scope validation as outcome reads, bounded verified
chunks, exact genesis digest, durable aggregate validation and zero-revision/protocol
checks, followed by full-head confirmation. Its three queries read metadata, the
genesis chunks and metadata again, without scanning outcome history. Outcome reads
reuse the extracted context guard and retain their existing four-query behavior.

Eight additional tests cover every populated row and next-ordinal absence in the
twenty-four-collection allocation/tax/rejection projection; frozen inventory
lots/holdings/allocation snapshots with unchanged historical receipts; bounded
growth reads; new-head invalidation; explicit close and serialized close/read races;
unknown collection/invalid ordinal rejection; expiry, maintenance and fence rotation;
expiry during source I/O; uncertain final durability; missing required tree nodes;
damaged genesis/outcome bytes; and the three-query genesis path with a forged digest.
These are local tests, not a claim that all seventeen accounting command read sets
are implemented or that all nonempty accounting families were queried.

At 1 and 17 retained outcomes, the measured current-row read obtains the original
retained result through one exact outcome lookup and one chunk query, with unchanged
source payload bytes. Row/locator node queries use digest-indexed bounded lookups and
remain within `2 * (ceil(log2(retained outcomes)) + 2)` for that ordered test stream.
The measurement begins after full verification/opening. It proves bounded point
access, not bounded startup, full command evaluation, range completeness or a service
latency/capacity SLO. Header/catalog parsing and source codec work are bounded by
their existing record limits; opening still materializes and audits the whole book.

Root `bun run check` passes: 310 ledger tests / 17,764 assertions; 222 kernel tests /
19,723 assertions; 100% kernel function/line coverage across thirteen sources and
102 existing trace bindings. Log: `/tmp/rastrata-pinned-rows-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the workspace,
with valid, syntax-error and unresolved-reference canaries passing:
`/tmp/rastrata-pinned-rows-syside.log`. The model now names `CurrentRowRead` and
`ReadCurrentPinnedRow`; PL-021 remains open for complete bounded accounting context.

SHA-256: SQLite source reader
`9ecd191b1ef43f93038b37439c2f98adfca9690d4b9d5ad65726d9546011fdfb`;
source catalog `918eb73b895b0034bbd9134c1011a8274d65245c88eca63f54bcdc7c84a2eb6d`;
indexed owner `1c7975c89e0e6f2dc4c82b273336d5192d5d86f7dd69c890262e13ba9a9ac89e`;
ledger model `f66e3bba9dd3355abbfeb1a40fb6be18a24827d25ce8a9d70361bc10a3cb9edb`.
Kernel source and financial formats are unchanged. Typed kernel row access,
semantic indexes, complete read sets, incremental evaluation/publication, packing,
reclamation and production recovery/release gates remain unfinished. No new mutation
or production-capacity result is claimed; the 1,000-outcome limit remains.

## Typed kernel row boundary

2026-09-06. `BookRowTypes` derives canonical collection element types from the
kernel's state/protocol definitions, excluding configuration aliases. The closed
twenty-four-entry `BOOK_ROW_COLLECTIONS` catalog includes the optional opening
boundary and all thirteen accounting families. Its schema table references the
existing durable aggregate schemas; an initialization check verifies that every
collection key resolves to precisely the same aggregate subtree schema, preventing
an accidental substitution of another valid schema. No separate monetary or
accounting-object interpretation is introduced.

`encodeBookRow` / `decodeBookRow` use the existing canonical tagged nodes without a
new envelope. `rastrata-book-row-v1` identifies the typed subtree API; enclosing
source/profile metadata and row commitments remain necessary. Decoding rejects
unknown collection names, extra/missing/duplicate fields, wrong collection shapes,
unsorted keys, noncanonical numbers or whitespace, and oversized UTF-8 input. It
inherits the kernel durable-codec limits (16 MiB, nesting and collection bounds);
the ledger independently retains its tighter 1 MiB source-record limit. Decoded
objects, nested arrays and exact numeric instances are immutable.

This is structure/canonical-byte decoding, not authentication or accounting
admission. A specific negative-control test supplies a syntactically valid but
forged configuration content hash: row decoding accepts its shape, while complete
book validation rejects the inconsistent aggregate. Neither a successful decode
nor a TypeScript type constitutes source proof or cross-row semantic closure.

The existing owner-issued pinned reader now offers `readTyped`. It first performs
the same source/row commitment verification as a raw read, then decodes within the
same serialized failure/retirement boundary. Presence returns the collection's
actual kernel type and absence returns null. It does not introduce a new public
authorization/transport API, relax pin/fence checks, or replace materialized kernel
evaluation. The persisted source catalog and financial formats are unchanged.

Five new kernel tests cover the closed catalog, exact aggregate-subtree round trips
through genesis/activation/rejection, the unchanged frozen inventory fixture,
`ExactDecimal`/`ExactRational` instances, nested immutability, hostile field/schema
and canonical-byte encodings, alternate rational/decimal encodings, the distinction
between shape and content validity, and the UTF-8 rather than character-count byte
limit. A new owner integration test compares every populated row and next-ordinal
absence in the allocation/tax fixture with the independent full projection, checks
all twenty-four collection names, and exercises concrete typed journal/schedule
properties plus closed-reader refusal. This does not claim complete nonempty
runtime coverage of every accounting family or all seventeen command read sets.

Root `bun run check` passes: 311 ledger tests / 17,936 assertions; 227 kernel tests /
19,900 assertions; 100% kernel function/line coverage across thirteen sources and
102 existing trace bindings. Log: `/tmp/rastrata-typed-rows-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the workspace,
with all valid/syntax/unresolved-reference canaries passing:
`/tmp/rastrata-typed-rows-syside.log`. The ledger model clarifies the typed form's
schema-versus-authentication boundary; its bounded-context obligation remains open.

SHA-256: kernel codec
`93546665545cc499d176a5b7aed2e8a270497866732a492baa98270ba1387668`;
indexed owner `09852b6aa4a05aa447f12a459bd837572985f335844ce72399fb47f0dd0cc125`;
ledger model `2ee5b15cec2dba4b91c6cd3c747aa04b17d95e147e380257ced9e29a1206129c`.
Semantic-key indexes, complete positive/negative/range command read sets, bounded
evaluation, packing/reclamation and production recovery/release gates remain open.
No fresh mutation or production-capacity result is claimed; the 1,000-outcome limit
and full-book evaluation/recovery behavior remain unchanged.

## Pinned command identity reads

2026-09-06. The existing source-catalog owner's current-view reader now exposes
`readCommand(commandId)`. It hashes the book-scoped permanent **command** identity,
verifies both cold and hot index paths, enforces each partition's Oseq bounds, and
rejects duplicate membership. Both authenticated absences are required before
returning an unused ID. Missing pages, invalid paths, or uncertain authority are
errors, never absence. The identity traversal is shared with publication's existing
identity-delta validation; no persisted schema, key digest or accounting hash changes.

A positive command locator is its first Oseq, which is also its immutable retained
result ordinal. The reader resolves that ordinal through the separately verified
source catalog and bounded canonical source fetch, decodes the existing kernel row
schema, and verifies the raw retained command ID, embedded command ID and embedded
book ID. This check remains necessary even after a digest hit. Results retain exact
original command, result hash, diagnostics, times and observed revision, including
accounting rejections. Returned rows and result metadata are immutable.

Reads remain serialized with close, under the captured complete head, catalog and
live durable pin. Positive and negative traversal rechecks authority and head;
concurrent canonical publication invalidates the handle rather than combining old
identity absence with new source data. Failures retire the reader, with lease expiry
covering uncertain release. Negative reads are valid at their captured cutoff only;
later publication still requires complete-head CAS and full command validation.

This is an internal lookup, **not** a new retry algorithm, accounting evaluator or
public request API. The existing service still compares retry input hashes and
evaluates against materialized state. A lot/holding's first-creation Oseq does not
identify its current value, nor an accounting object's collection ordinal: those
semantic indexes and complete command read sets remain open. Full startup/history
verification is unchanged and PL-021 is not closed by this addition.

Eight added tests cover raw-identity mismatches in otherwise decodable rows;
committed/rejected results and exact ordinal-row equivalence; genesis absence and
reopened recovery; family separation and Unicode IDs; one-source point access at
1 and 65 outcomes (crossing a physical identity-leaf split); both cold/hot partitions;
missing required cold pages even for hot hits or unused IDs; missing source/locator
bytes; late expiry/fence/maintenance/uncertain durability during positive and negative
paths; concurrent publication while traversal is suspended; close ordering and
invalid/oversized queries. The query-growth test excludes setup/recovery and is not
an end-to-end latency or capacity benchmark. Full evaluation is still history-sized.

SHA-256: indexed owner
`12f638233accc6b8274002a0d03866898d85def7c416d07539ed2410fb691557`;
identity resolver `27a64cef8d09ab22aeb7812540c589f87a2f8ad7d661fb093798804c46bf6239`;
ledger model `39c06c65b702b2247c35ca90fc13ce6ecb65a770da7c532572772f8cdda3cfe3`.
Root `bun run check` passes: 319 ledger tests / 18,260 assertions; 227 kernel tests /
19,900 assertions; 100% kernel function/line coverage across thirteen sources and
102 existing trace bindings. Log: `/tmp/rastrata-command-reads-check-final.log`.
The seven owner-focused tests also pass independently with the repository's
60-second per-test timeout: `/tmp/rastrata-command-reads-targeted-final.log`.
A prior ad hoc invocation used Bun's default 5-second timeout, which was too short
for the 65-outcome setup; it is not treated as a passing run or a performance result.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the dependency
workspace, with valid/syntax/unresolved-reference controls passing:
`/tmp/rastrata-command-reads-syside.log`. No fresh mutation, Cloudflare capacity,
archive/restore or production-readiness result is asserted.

## Pinned journal and posting identity reads

2026-09-06. `readJournalIdentity("journal" | "posting", id)` extends the same
internal current-view reader, not the public transport or accounting evaluator.
It verifies both permanent identity partitions and their sequence bounds using
the existing shared lookup. Authenticated absence yields no journal or posting;
missing pages or conflicting pointers remain errors.

A positive first-creation Oseq is **not** a journal ordinal. The reader authenticates
the retained result at that Oseq, requires a committed disposition, and authenticates
the revision at its observed financial revision. `resolveJournalIdentity` binds the
retained/embedded command IDs, book IDs, financial revision and complete input hash;
selects exactly one matching raw journal or posting identity from the revision's
effects; and checks the selected journal's command/book/revision lineage. Duplicate
matches fail closed, including duplicate posting IDs within one journal.

The selected booked journal carries its own posting sequence. The reader separately
authenticates the current journal-collection row at that ordinal and compares its
entire canonical encoded subtree with the selected revision effect. Returned posting
data includes its immutable parent journal, effect key, source hashes and actual
posting ordinal. No source-reference admission decision is inferred from a successful
lookup; the evaluator still compares requested reference fields and pending effects.

The operation currently performs three bounded source fetches (retained result,
revision, journal). These may fetch the same creating outcome three times. They are
not a history scan and do not use an ordinal guessed from Oseq or scan the cached
aggregate. This is not yet an optimized single-fetch implementation. Every stage
uses the captured catalog/head and durable pin; missing source bytes or expired
authority retire the context. Full recovery and the existing materialized evaluator
remain unchanged. No catalog/schema/financial-hash migration is introduced.

Six new tests provide the following evidence:

- Raw-identity, book, command, revision, input-hash and duplicate-effect/posting
  negative controls against the source selector, plus rejected/malformed rows.
- Every journal and posting from the real allocation/tax workflow with retained
  rejections interleaved between commands, before and after owner reopening. Exact
  values, canonical bytes, numeric classes and immutability match the full snapshot;
  outcome, financial revision and posting sequences demonstrably differ.
- A real atomic disposal command emits both an adjustment journal and a completion
  journal. Both journals and every posting resolve to distinct correct journal
  ordinals under the same creating outcome; this is not a fabricated source fixture.
- At 2 and 18 retained outcomes, positive lookup performs three indexed exact-source
  reads, all of the original outcome; absence reads no canonical source records.
  Setup/full recovery is excluded, so this is not a ledger capacity/latency result.
- Missing-source and expiry injection at each of the three resolution stages fail
  closed and retire the reader. Unsupported families, malformed IDs and a changed
  canonical head are rejected rather than treated as absence.

SHA-256: indexed owner
`5881f80a4283553b3f91d5cbc987cbd3e0dfa7ff020ef9cd6badcdb1db871459`;
identity resolver `17bdedd054e59d31f4752999aef3872293ac5817340d02401b247b19353463a5`;
ledger model `d48320353e7aee72837a5d9189d21769235ea15d03cb1fd9501b292ce6c2fb2f`.
Root `bun run check` passes: 325 ledger tests / 18,718 assertions; 227 kernel tests /
19,900 assertions; unchanged 100% kernel function/line coverage across thirteen
sources and 102 existing trace bindings. Log: `/tmp/rastrata-journal-reads-check.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the dependency
workspace, with valid/syntax/unresolved-reference controls passing:
`/tmp/rastrata-journal-reads-syside.log`. No fresh mutation, production-capacity or
cloud result is claimed. Complete command read sets, mutable-state/secondary
indexes, indexed evaluation, the 1,000-outcome capacity barrier, packing/reclamation,
recovery and production release gates remain open.

## Pinned immutable accounting identity reads

2026-09-06. The owner-issued current-view reader now provides the generic
`readAccountingIdentity(family, id)`, with a family-specific immutable result type.
Its closed family catalog is the thirteen accounting-effect types already used by
the source projection; prototype names, unrelated identity families and mutable
lot/holding families are rejected. This introduces no storage profile, financial
hash, accounting behavior or public request route.

The design relies on a specific existing kernel invariant, not on a general claim
that all accounting data is immutable: `applyAccountingEffect` appends these thirteen
effect collections, while `book.ts`'s `applyEffects` treats whole lot-state arrays separately.
The owner first performs the existing full canonical-population and source-catalog
verification. At a captured head, permanent identity presence then resolves the
committed retained result at its first Oseq and the authenticated creating financial
revision. The shared committed-source binding verifies book/command/revision/input
hash relationships before selecting exactly one effect with the requested raw
family and ID. Explicit effect-level book IDs must also agree; records without that
field rely on the already verified canonical source closure and creating book.

The returned `sourceRevisionRowHash` explicitly commits to the creating revision
row. It is not mislabeled as an accounting collection row hash or an inferred
insertion ordinal. Unlike journal posting sequences, those accounting ordinals are
not recorded in the original effect. Selecting an immutable authenticated effect
does not require inventing one. It does not establish current balances, recognition
population, schedule supersession, active FX status or any other derived predicate.
Those secondary indexes/read sets remain necessary for an indexed evaluator.

Both permanent identity partitions must prove absence for unused IDs. A positive
lookup performs two bounded source fetches for retained result and revision, under
the same catalog/head and live durable lease. Missing paths/source bytes, expired
authority, ambiguous raw identity or a changed head fail closed and retire the
reader. Later publication still requires complete-head CAS. Full history/startup
verification and materialized command evaluation are unchanged.

Six new tests cover the family whitelist and prototype exclusions; source identity,
book and duplicate-effect failures; all immutable effects produced by the real
allocation/tax workflow before and after reopening; exact equivalence with the final
canonical accounting collections; original schedule preservation after subsequent
recognitions/revision; explicit creating-revision commitments; immutable exact
numeric types; absence in all thirteen families; two indexed source reads at 3 and
19 outcomes; missing identity/source bytes, late expiry, invalid families/IDs and
stale-head refusal. Positive runtime coverage here is **four families** (schedule,
recognition, schedule revision, tax determination), not all thirteen or all seventeen
command read sets. Query-growth counts exclude full setup/recovery and do not show
an end-to-end capacity improvement.

SHA-256: indexed owner
`87b9a0b56a9734085a1ff7d5fc12819f88bc1682e2b7d7a239676cbbb47a5f0d`;
identity resolver `4ad1fc3f07da257ab7a2a9f3c189e4f07c42517fc9ef0955defceff7723b0f4e`;
ledger model `887cc2b130af54902c37a49a9034b08d1a771e48ebd439f063e3c342cb206f35`.
Root `bun run check` passes: 331 ledger tests / 18,962 assertions; 227 kernel tests /
19,900 assertions; unchanged 100% kernel function/line coverage across thirteen
sources and 102 existing trace bindings. Log: `/tmp/rastrata-accounting-reads-check.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the dependency
workspace, with valid/syntax/unresolved-reference controls passing:
`/tmp/rastrata-accounting-reads-syside.log`. No new mutation or Cloudflare capacity
result is claimed. PL-021 and the production capacity, recovery and release gates
remain open.

## Pinned current lot identity reads

2026-09-06. `readLotIdentity(family, id)` now resolves `lot`, `lotHolding` and
`lotAllocation` identities in the existing legacy source-catalog profile. The
creation locator is used only to recover a stable insertion position, **never**
as evidence of a holding's current quantity, basis or carrying value.

This relies on reviewed legacy kernel behavior: `prepareLotState` appends new lots
and holdings on acquisition; maps existing holding positions on disposal/transfer;
appends only new transfer destinations; and appends allocation identities. Depleted
holdings are not deleted. `applyInventoryValueAdjustmentToHoldings` maps the existing
holding array without reordering. The surrounding whole-snapshot effect is mutable
state representation, but those identity positions remain stable under these
supported transitions. A future profile permitting reordered or removed rows must
introduce an explicit current-ID mapping, not inherit this assumption silently.

After both permanent identity paths verify, a positive first Oseq resolves an
authenticated committed retained result and creating financial revision. Exactly
one matching raw family/ID must appear in its lot-state snapshot. The reader then
fetches the row at that position from the **current captured catalog**, verifies its
current source/row commitment, decodes the kernel subtree and rechecks raw identity
and explicit book ID. The response names `creationOutcomeSequence` separately from
the current row. Missing current paths or source bytes cannot fall back to creation
values; identity mismatch, ambiguity, expired authority or changed head retires the
reader. Unknown families/prototype names are rejected. Unused IDs require verified
absence in both identity partitions. Current pool/destination ranges are not proved
by this point lookup.

Five new tests include a real six-command lifecycle: activation, acquisitions of
10 and 7 units, transfers of 3 and 2 units to the same destination, and disposal of
the remaining 5 units from the original holding. Every previously seen identity
is checked at its original position after each command; all three families' point
reads match the independently materialized current rows. Reopening preserves three
holdings: depleted original (0), untouched second lot (7), and coalesced destination
(5), plus the two transfer and one disposal allocations. Generic result types and
exact numeric values are preserved. Inventory-value-adjustment position preservation
was source-reviewed here, not exercised through this new lifecycle fixture.

At 6 and 22 retained outcomes, reading the depleted original holding performs three
targeted source fetches: Oseq 2 for the retained result and revision, then Oseq 6 for
the current holding. It does not return the original 10-unit value or scan history
during the lookup. Verified absence reads no canonical source. This excludes full
setup/recovery and is not an end-to-end capacity/latency claim. Missing latest source,
missing current row-root path, expiry at current-source access, malformed families,
stale heads, duplicate creation IDs and raw-ID/book/schema mismatches are tested.

SHA-256: indexed owner
`f90f0dba64e3ff58a665ffe87576cd579808b200c7eb0bd4fa708b246f40e77d`;
identity resolver `9a6ad6dba8e3e839ef4f5749d0e5637e77b071714bdc0ebd07dead9565057f1c`;
ledger model `81ec638c5302d274c098f5b2beeae2d1aa78f9bc552559dbad628489a5d7a3cc`.
Root `bun run check` passes: 336 ledger tests / 19,286 assertions; 227 kernel tests /
19,900 assertions; unchanged 100% kernel function/line coverage across thirteen
sources and 102 existing trace bindings. Log: `/tmp/rastrata-lot-reads-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the dependency
workspace, with valid/syntax/unresolved-reference controls passing:
`/tmp/rastrata-lot-reads-syside.log`. No financial hash/codec, accounting algorithm,
storage profile, startup verification or production limit is changed. Complete
semantic ranges/read sets, indexed evaluation and production capacity/recovery
verification remain open; no new mutation or Cloudflare result is claimed.

## Semantic group projection and bounded logical ranges

2026-09-06. `semantic-groups.ts` defines the first four closed predicates: holdings
by lot, holdings by account, nonzero holdings by account/commodity, and allocation
recognitions by schedule. The first two retain depleted holdings; only the nonzero
predicate removes them. That predicate mirrors the kernel's `!isZero()` exactly,
not a substitute positive-only filter. Projection is not accounting admission: a
structurally decodable invalid accounting value still requires canonical validation.

Group identity is a typed raw tuple, domain-separated by financial collection and
query kind. Input tuple arrays are copied/frozen, and raw identifiers retain their
canonical normalization rules. Hashes do not replace raw-key collision checks at
the future directory boundary. Membership values are canonical row commitments
keyed by insertion ordinal, preserving deterministic source order. Conditional
deltas cover old/new memberships and replace hashes even where membership itself
does not change. Identical bytes with different hashes, or changed bytes with an
unchanged hash, are rejected as incoherent input. Supplied hashes are still not
self-authenticating; the owner must obtain them from verified canonical rows.

`readLogicalRangePage` traverses the existing content-addressed Patricia map over
an explicit half-open range, with a 1..256 member limit. It prunes only authenticated
subtree fences, verifies every required loaded node, and reads one extra matching
leaf to prove truncation and return the exact first unreturned key. A full final
page is distinguishable from an incomplete one. Empty ranges still authenticate
the root; missing required bytes, malformed ranges or corrupt nodes fail the whole
page. The result binds root/domain/bounds but is not an owner pin or proof that the
consumer read all prior pages. Unvisited out-of-range subtrees are not audited.

Eight new tests cover exhaustive sparse/extreme bounds across four page sizes;
exact page boundaries and exhaustion; corrupt/missing sentinel data; invalid
requests before node I/O; a narrow seven-member page in a 4,096-member tree with an
authenticated eighth-member continuation and at most 40 node reads; immutable raw
tuple/domain separation; group predicate/removal/hash-update behavior; and malformed
or no-op input validation. For the real six-command lot lifecycle and eight-command
allocation/tax workflow, conditional group-tree updates are compared after every
command with independently filtered full kernel snapshots and independently rebuilt
logical roots. Every group is paged to exhaustion. The depleted holding leaves only
the nonzero group; original/successor schedule recognition populations stay distinct.

These are implementation prerequisites, **not an integrated grouped query service**.
The following work remains necessary before using them for command read sets:

- A directory root mapping a complete raw-group digest to an immutable descriptor
  containing its raw tuple, member domain/root and population. Member roots use
  canonical ordinals and row commitments; keep full-width group identity separate
  from ordinal ordering instead of truncating hashes to fit a composite key.
- Atomic old/new directory and member-root publication alongside canonical outcomes
  and the source catalog, including removals. Verify a complete rebuild before
  adoption; absent directory evidence is never a substitute for an empty group.
- Owner-issued continuations tied to the exact group/raw key, selected directory,
  full head and live pin. Authenticate every returned member's current source row
  and group predicate. Distinguish page completion from complete query consumption;
  bound response bytes as well as member count.
- An explicit storage-profile boundary for new persisted directory fields. Do not
  reinterpret existing source-catalog bytes or silently auto-adopt older books.

Root `bun run check` passes: 344 ledger tests / 20,374 assertions; 227 kernel tests /
19,900 assertions; unchanged 100% kernel function/line coverage across thirteen
sources and 102 existing trace bindings. Log: `/tmp/rastrata-group-ranges-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the dependency
workspace with all valid/syntax/unresolved-reference controls passing:
`/tmp/rastrata-group-ranges-syside.log`.

SHA-256: logical map
`41d95306a13d89ac63ae0387648de95757ffad48182053630cdadeffa6d27960`;
semantic groups `49395c2775b3b0031f819511b788ea73106d9930349edf41a314425998ef2b13`;
ledger model `5a512e03a53a6d57e2ff5832af4dff2e610c41c3995bc7482db4b6958069a6c9`.
No owner/catalog persistence path, financial hash/codec, startup behavior or
production capacity limit changes in this step. No new mutation, Cloudflare or
production-readiness result is claimed. The full ledger goal remains open.

## Atomic semantic group companion catalog

2026-09-06. `SqliteSemanticGroupCatalog` now integrates the four reviewed predicates
into the opt-in SQLite source owner. A companion directory maps full-width group
identities to canonical descriptors containing the raw tuple, collection/member
domains, current member root/hash and population. Members map canonical insertion
ordinal to current canonical row hash. Empty groups are removed from the directory;
depleted holdings remain in the all-holding groups. Old nodes/descriptors are retained.

This changes the opt-in **owner** marker to
`rastrata-indexed-sqlite-group-source-candidate-v1`. Older row-only owners are refused,
not silently reinterpreted or migrated. The default identity-only owner marker,
source-catalog v1 bytes, canonical outcome format and all financial hashes remain
unchanged. The companion metadata binds physical owner identity and full head;
group/member domains derive from the financial collection domains, not physical
placement or fencing state.

Preparation derives conditional membership changes from verified old/new canonical
rows, updates only affected member/directory paths, and compares the complete result
with a fresh full canonical rebuild. The rebuild is comparison evidence, not a
replacement set of writes. Provisioning and retained-outcome publication write the
companion nodes, descriptors and metadata CAS inside the existing canonical/source/
identity transaction. Publication requires a live same-store transaction and an
opaque candidate prepared by the same instance. Same-digest/different-byte stored
content fails closed. Ordinary unrelated journals and retained rejections advance
the metadata head without rewriting group nodes or descriptors.

Recovery still verifies the entire canonical history, then compares the complete
directory against canonical state and audits every required stored directory and
member node. Correctly rehashing an incomplete directory cannot authorize omission.
SQL fetches cap body bytes before returning them to JavaScript (BLOB prefixes, not
Unicode character prefixes), and validate complete stored byte lengths and digests.
Limits are 8,192 bytes for metadata, 2,048 for nodes and 1,050,624 for descriptors.
Canonical metadata/descriptor reconstruction rejects duplicate fields or alternate
serialization. This is not lazy startup, an external authenticity anchor or a public
authorization boundary.

Thirteen added tests cover:

- Complete persisted directory/member roots against independent full-state
  predicates and an independent tree rebuild after actual lot and allocation/tax
  commands, including depleted holdings and last-member directory removal.
- Publication exceptions at member-node, descriptor and catalog writes; conflicting
  same-digest stored bytes; rollback of canonical/source/group state; and lost
  durability acknowledgement with exact-once durable-result retry.
- Missing/corrupt directory nodes, descriptors and member nodes; oversized UTF-8
  bodies; coherently rehashed empty populations, wrong head/owner and duplicate
  metadata fields. No subsequent command is retained on damaged evidence.
- No member rewrites for unrelated committed/rejected outcomes or exact retry;
  rollback of initial provisioning; old-marker refusal; fabricated, foreign-store
  and retired transaction tokens; and fabricated prepared candidates.
- Four actual subprocess SIGKILL boundaries: member-node insertion, descriptor
  insertion, directory metadata update and immediately after commit. A real lot
  transfer reaches every hook. Restart independently verifies the prior or committed
  complete group population and exact accounting state; retry retains one outcome.

Targeted evidence: `/tmp/rastrata-group-catalog-tests-final.log`, 13 tests / 611
assertions. These disposable local SQLite WAL/FULL tests do not simulate power loss
or certify Cloudflare durability. Existing source/identity crash tests also continue
to run with the integrated owner.

Final root `bun run check` passes: 357 ledger tests / 20,985 assertions; 227 kernel
tests / 19,900 assertions; 100% kernel function/line coverage across thirteen sources
and 102 existing trace bindings. Log: `/tmp/rastrata-group-catalog-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and the dependency
workspace, with valid/syntax/unresolved-reference controls passing:
`/tmp/rastrata-group-catalog-syside.log`. These kernel coverage and trace numbers
are not a ledger coverage or full SysML implementation-completeness claim.

SHA-256: companion implementation
`9114fbfc17b4937be11e55d64451e6d88dd03a06e299f2ae19a749e3cd6bdafc`;
owner `cc4eb4b83ab1490b4990014a06f8db5692f2a18ba330dd3b55298e3cf5f6a16f`;
unchanged source catalog `918eb73b895b0034bbd9134c1011a8274d65245c88eca63f54bcdc7c84a2eb6d`;
ledger model `28cd07a1314e4793a6bf6913cccd12ec79314ccf64f0e8a1b1edc65a6409f318`.

Still open: owner-bound grouped-read cursors, source-verified member pages with byte
and count limits, complete command read sets/indexed evaluation, bounded canonical
storage/recovery, remote archive/restore and release workload/SLO proof. Full
projection/rebuild work remains on the current bounded path; this step is not an
end-to-end performance improvement or an increase to the 1,000-outcome limit. No
current-tree mutation score, new cloud test or production-readiness claim is made.

## Pinned source-verified semantic group reads

2026-09-06. The verified source owner now exposes
`reader.openGroup(kind, rawValues, limit = 64, maxRowBytes = 1048576)`. This returns
an owner-local forward-only cursor with `next()` and `close()`, not a transferable
HTTP continuation token. All cursor operations share the existing reader queue,
live pin, full head and captured source/group catalogs. Raw tuple arrays are copied
before entering the asynchronous queue. The collection domain comes from the
verified source capture, not the request.

Each page authenticates the group-directory lookup (including absence), checks the
descriptor's exact raw tuple/domain, and traverses the member range with the existing
extra-leaf truncation proof. Every delivered ordinal/hash resolves through current
canonical source evidence. The reader verifies source collection, ordinal, head,
catalog and row hash; decodes the typed row; and rechecks the actual raw grouping
predicate. Missing required directory/member/source bytes fail the complete page.
Head/catalog/pin authority is rechecked through group-node I/O, source reads and
before returning. Publication, expiry, fencing, pending authority or any failed
read retires the entire context rather than permitting further mixed-view reads.

Limits are 1..256 members and 1..1,048,576 UTF-8 bytes of canonical row strings per
page, plus a separately bounded 1,048,576-byte raw-key JSON value. Typed decoded
rows and fixed metadata add bounded memory overhead; `encodedRowBytes` is not an
HTTP wire-size claim. A byte-limited page retains the exact first unreturned
ordinal, without advancing over it. One further source row may be authenticated
to determine that byte boundary. If the first row cannot fit, the cursor fails
explicitly; it never emits an empty incomplete page or silently truncates a row.

Cursor advancement occurs only after the entire page passes. The cumulative
`consumed` count must equal the authenticated population on exhaustion, and must
remain smaller on an incomplete page. This records members delivered by that
cursor, **not proof that a consumer processed them**. The final page alone is not
the complete row set. Complete command read-set assembly must process all pages;
it cannot accept caller-supplied completion claims. Closing early proves no
completion; reading after exhaustion/close is an error. Closing the owner reader
releases both captures and the pin and invalidates all its cursors.

Nine new tests (597 assertions in `/tmp/rastrata-group-reader-tests-final.log`)
cover all four predicates against independently filtered final lot/allocation
snapshots, canonical order including depleted/sparse holdings, empty groups,
immutable typed rows, exact final/count/byte boundaries, too-small row budgets,
raw-input mutation, concurrent/interleaved advancement, and abandoned/exhausted
cursors. Fault tests cover missing absence paths, a missing required second-leaf
sentinel while the first member remains intact, missing source/member/descriptor
data between pages, damaged metadata, publication/expiry/fence/pending changes,
and authority loss during group paths and source fetches. Trusted source-port
fault injection additionally checks wrong coordinates, commitments, schemas and
raw predicates; these guards supplement rather than replace source hashing.

At both 3 and 18 retained outcomes, a one-member page fetches exactly one canonical
outcome (Oseq 2) and one chunk set with indexed point predicates. No full-history
source query occurs during that measured page. Setup/recovery remains full-history
verification and is excluded from this query-path test; it is not an end-to-end
capacity, latency, Cloudflare or startup result.

Final `bun run check` passes: 366 ledger tests / 21,582 assertions and 227 kernel
tests / 19,900 assertions. Kernel function/line coverage remains 100% across thirteen
production sources, with 102 existing trace bindings. This is not a ledger coverage
or complete SysML-conformance claim. Log: `/tmp/rastrata-group-reader-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and their dependency
workspace, including valid/syntax/unresolved-reference controls:
`/tmp/rastrata-group-reader-syside.log`.

SHA-256: cursor `c3612d3e4c833a3e875973cf6fd7a86a4cb3963a2def08dfe071605bc503b6bb`;
group catalog `c28e340da5345891ff30dc51e779ec11e5cc8539049bb3a221674d036a879779`;
source catalog `74e169c5ad4c72f5f829132df2f5c7615d87b1e54a27ddfe742220e93e7cedd3`;
owner `c97972bc26abcce6ca7463fd4d9997c1f0dd5b56f5c6ed31a3c6303f1c1d8f97`;
ledger model `3940eea1db3b5ce87533d8056da5e5a7ca53a6e50176d7e6594ffbecf9ca4a23`.

No persisted format, financial hash, accounting algorithm, historical authenticity
rule or production limit changes. PL-021 remains open: complete command contexts,
additional accounting predicates and an indexed evaluator are not implemented by
these four grouped queries. Bounded storage/recovery, the 1,000-outcome ceiling,
archive/restore and release workload/SLO evidence remain production blockers.

## Pinned common book basis

2026-09-06. `reader.readBookBasis()` now supplies the common book inputs needed
before command-specific read-set assembly: the owner's fully recovered scalar
header, current configuration, original opening boundary and latest committed
financial revision. This is not a complete evaluator input, admission decision or
caller-authorized `valid` flag. Current period closure, book-wide outstanding FX
obligations, permanent identities and command-specific source closure remain open.

The header is copied/frozen from the already verified canonical state and checked
against the captured complete durable head. Its `contentHash` commits the **whole
state**, not this partial header; this path does not claim to rederive that hash
without history. The financial identity is rehashed, and book/posting/configuration
revisions and state/configuration commitments must match the full head. Complete
canonical recovery remains the prerequisite for issuing the reader.

Three current source selections are authenticated separately: configuration at
`configurationRevision + 1`, opening boundary at ordinal 1, and financial revision
at `bookRevision`. Revision zero proves ordinal 1 absent instead. Each row's
collection/ordinal/head/catalog and exact canonical bytes must match the recovered
selection; values use the existing typed kernel row decoder. Current configuration
scope, revision and content hash are checked, including recomputation of the
configuration snapshot hash. The financial revision's book/revision/chain must
agree with the head. The original opening configuration is never replaced with
today's configuration. All reads and final return require the same live context;
any missing evidence or uncertainty retires it without a partial result.

Four new tests (128 assertions in `/tmp/rastrata-book-basis-tests.log`) cover genesis,
configuration before activation, activation, posting, later configuration, and a
retained rejection dated later than the last committed command. Configuration may
be financial revision 1 while the book remains configuring. In the final lifecycle
case, Oseq is 5, financial revision is 4, current configuration revision is 2 and
the boundary retains configuration revision 1; the financial committed time remains
2026-01-16 rather than the rejected command's 2026-02-01 timestamp.

At 2 and 18 retained outcomes, with the financial state unchanged by intervening
rejections, a basis read fetches exactly genesis, activation outcome 1 and financial
outcome 2. Every outcome fetch uses its indexed exact sequence predicate. Setup and
complete recovery are excluded; genesis reconstruction and selected large source
rows remain bounded by the existing storage/codec limits, not a new scalable
startup guarantee. Other tests delete each of these three required sources, expire
the lease during each fetch, inject wrong header/source coordinates or bytes at
the trusted internal port boundary, and publish concurrently with an old reader.
No damaged/stale read is returned as a partial basis or retained accounting result.

SHA-256: basis reader `b3ef49125796cf651d57859a451590acd760c171bb6ff0518b97f14ebbead703`;
owner `e49ff9209805eb8cddecde8cc5caf67b0a8e70cccae3ba25316370bad8acc513`;
ledger model `ae32d5c46543af1c2baaa656b28e6ba0f36f62ad7846402a2783251197eeb5c8`.
No financial algorithm/hash, persisted format, startup trust contract or production
capacity limit changes. PL-021 and the broader production-readiness goal remain open.

Final root `bun run check` passes: 370 ledger tests / 21,710 assertions; 227 kernel
tests / 19,900 assertions. Kernel function/line coverage remains 100% across thirteen
sources, with 102 existing trace bindings (not a ledger coverage/completeness claim).
Log: `/tmp/rastrata-book-basis-check.log`. Licensed SysIDE 0.10.3 reports zero
diagnostics for both models and the dependency workspace, with all valid/syntax/
unresolved-reference controls passing: `/tmp/rastrata-book-basis-syside.log`.

## Pinned period and FX admission facts

2026-09-06. `reader.readAdmissionFacts(command)` now provides source-verified
period-closure and book-wide overdue-FX facts at one live captured head. It binds
the result to the recomputed complete command hash, not an unchecked supplied
hash. This is **not admission or a complete evaluator context**: retained-command
lookup, input/version/timeline validation and all command-specific checks must
retain their existing kernel order before publication can be authorized.

Three closed semantic groups are added: transitions by period, unrealized results
by policy ID, and reversals by original result ID. This extends the companion to
five source collections/seven predicates. Directory format is now
`rastrata-group-catalog-candidate-v2`, with opt-in owner marker
`rastrata-indexed-sqlite-admission-source-candidate-v1`. Older row-only and
four-group owners are explicitly refused; no automatic migration occurs. Existing
source-catalog bytes, financial row commitments, four existing raw group-key
definitions and all canonical financial hashes remain unchanged. The wider
directory continues using atomic canonical/source/identity/group publication and
complete canonical rebuild/audit on recovery.

The factual fold preserves the kernel's exact rules (`book.ts` `periodIsClosed`,
`closeIsCurrent` and the pre-dispatch `overdueRemeasurement` selection):

- A period is closed iff its last matching canonical transition is `close`.
  Every configured period's transition group is exhausted. The result retains a
  compact last-transition ordinal/hash/kind receipt, not every superseded-close
  list. Supersession of a close package is not itself a period reopen.
- Only unrealized results are grouped for this obligation. Historical results
  remain members after reversal; each due candidate's reversal population is
  source-verified separately. Missing reversal evidence is not absence.
- Resolve the first matching **current** currency policy by raw ID, preserving
  policy array order even when versions differ. Do not substitute the policy
  embedded in an old result or sort versions. Configuration replacement therefore
  immediately changes the obligation without stale persisted policy flags.
- A result is due only when its effective date precedes the command's issued-date
  prefix, exactly as in the kernel. Exclude the original explicitly being reversed
  by that command. Select the minimum canonical result ordinal across policy
  groups, not whichever policy happens to be traversed first.

One outer owner-queue operation contains the whole fold and final live-view check.
Inner cursors execute within it and never escape; enqueuing them behind their own
awaiting parent would deadlock. Page consumption checks the common head/catalog.
Failures retire the context without partial facts or retained accounting rejection.
Memory holds bounded pages, one compact result per configured period and at most
one selected FX result, plus the existing common basis. Traversal still scales
with complete matching history; no constant-time shared-admission claim is made.

Six new tests (225 assertions, `/tmp/rastrata-admission-tests-final.log`) execute
real GBP/USD monetary positions, measurement journals and reversals through the
production owner. They compare grouped facts with independent materialized-state
selection and actual kernel diagnostics; cover same/future dates, explicit reversal
exceptions, realized-result exclusion, reversed policy traversal order, complete
reversal removal and false-to-true current-policy replacement. A configuration
with two versions of one policy ID proves the first current entry wins. Independent
directory/member rebuild comparisons now include all three new predicates.

The close/reopen fixture closes January and February, then reopens January:
both close packages are superseded, but January is open and February remains
closed. Separate faults remove a required reversal source or descriptor, expire
the lease or rotate authority during group traversal, and publish against an old
reader. Nested/concurrent reads followed by close complete without deadlock, and
forged supplied command hashes are not reused as the result's content binding.
Existing old-owner refusal tests now cover the previous four-group marker too.

SHA-256: facts `cd9a1d98f4316830657f064281ff326e1b073d3dd0343746c745be49f6d3ae72`;
groups `b7e5fe8d262c097dd2a52d17372ee1665b9c93a48594da0b12f04c31dfe599af`;
catalog `98e33c4096b190c7d870661f86bce1129bd68cacf0177d98bd852f7ec28f6e79`;
owner `8a295c4001822c3c12308bc6f66133d06ef58e73258a840a9a4b39bcdc59d7d9`;
ledger model `35d0dedf9ba83a218146eaaa06e77f7a291dbf00df13aa03b47050e462e2dc5a`.

PL-021 remains open for complete command context/evaluation; close-package
currency, other accounting relationships and pending same-command effects still
need their own complete reads. The 1,000-outcome cap, full-history startup,
storage/archive/restore and production workload/SLO gates are unchanged. No new
mutation score, cloud performance or production-readiness claim is made.

Final root `bun run check` passes: 376 ledger tests / 21,937 assertions; 227 kernel
tests / 19,900 assertions. Kernel coverage remains 100% functions/lines across
thirteen sources, with 102 existing trace bindings, not a ledger coverage or
complete implementation claim. Log: `/tmp/rastrata-admission-check-final.log`.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and their dependency
workspace; valid/syntax/unresolved-reference controls pass:
`/tmp/rastrata-admission-syside.log`.

## Shared journal preparation

The full-state kernel now delegates journal-local preparation to one shared
`prepareBookJournal` implementation. `BookJournalReadContext` supplies complete
configuration, explicit journal/posting identity presence or absence and the
selected fiscal period's open/closed status. This removes a whole-state dependency
from that primitive without copying accounting rules into the ledger or inventing
a partial `BookState` whose content hash claims complete-state verification.

The legacy adapter retains canonical history and pending same-command identity
overlays. Policy selection and admission still precede identity lookups; permanent
posting IDs remain book-wide; journal admission precedes fiscal resolution.
Invalid/unresolved/asynchronous lookup results throw instead of becoming absence
or openness. Prepared policy hashes are owned frozen copies, with unchanged
canonical values. No codec, algorithm marker or persisted history changes.

This helper returns a candidate journal or diagnostics, not a commit intent.
Caller-supplied revision, posting sequence and closed-period override are not
authority. Command chronology, protocol/idempotency, opening, overdue FX,
correction/lot/accounting source closure, effect topology and final publication
remain with complete command admission. Indexed context and PL-021 remain open.

Four new kernel tests (35 assertions) cover callback order, exact candidate
comparison, missing evidence, diagnostic precedence and immutable hash ownership.
One ledger conformance test (27 assertions) supplies actual pinned configuration,
identity and period reads, then compares exact candidates/diagnostics with full
command execution for valid, duplicate-journal, duplicate-posting and closed-period
inputs. It reconfirms the live reader after calculation, asserts no durable write,
and does not expose an indexed execution or publication API. The comparison proves
adapter agreement, not independent correctness of the shared rules; the existing
kernel arithmetic, accounting, hostile-input and frozen-history regressions remain
the separate evidence for those rules.

Verification: root `bun run check` exits 0, with 377 ledger tests / 21,964 assertions
and 231 kernel tests / 19,935 assertions. Kernel coverage is 100% functions and
lines across thirteen sources; the existing 102 trace bindings pass. Licensed
SysIDE 0.10.3 reports zero diagnostics for both models and the dependency workspace,
with valid, syntax-error and unresolved-reference controls passing. Logs:
`/tmp/rastrata-journal-check.log`, `/tmp/rastrata-journal-ledger-test.log`,
`/tmp/rastrata-journal-syside.log`. Both frozen legacy fixture SHA-256 values remain
unchanged. No current mutation certification or cloud performance claim is made.

SHA-256: kernel book `6f36ab7615e03f42b2d842c54c7e1b0a5da9cf77d27ac5ea3cabc3c8d7d15b78`;
kernel test `4a4d52a967d7000911dd6f80a69b21644befa08cacb4d5425d1a473be3567cef`;
ledger test `d93db025057486f728dc30a9c413cc564528c17130186682bedffc72317d60fb`;
kernel model `494f1e02ea9260bd75e70f9e5ca6454f512f9cb7b983a2952a473e69a639ef92`;
ledger model `e8a8d15e771b5d509d8c525a91b63241c626fc0b41e8ea6d42df051cd1f481a8`.

The 1,000-outcome cap, full-history startup and complete projection rebuilds are
unchanged. Complete indexed evaluation, storage/archive/restore, workload/SLO
acceptance and release audit are still required; this step is not production
readiness or a measured capacity improvement.

## Shared protocol admission prefix

`evaluateBookCommandProtocol` now owns the existing retry, input hash, book scope,
protocol version and financial chronology prefix for the full-state evaluator.
Its context contains only book identity/revision and two explicit lookups. A
retained lookup returns the source row or null, never implicit absence; malformed,
asynchronous or raw-identity-mismatched evidence throws. New-command chronology
uses the last financial revision, not the last retained outcome. Exact committed
and rejected retries return their original result before asking for that clock.

`continue` requires the remainder of command evaluation; `finished` is a candidate
result, not a durable receipt. Full state hashing, activation identity, expected
revision, configuration, global accounting and command-specific admission remain
in the existing evaluator. No partial state, hash bypass, new publication API or
representation change was introduced. Replayed hash/diagnostics and a rejection's
retained input hash now own immutable data without changing their canonical values.

Seven new tests / 145 assertions cover protocol precedence, retention decisions,
retry conflicts, malformed evidence, immutable ownership and non-admission after
`continue`. The ledger harness reopens the production owner, uses authenticated
retained/current-revision reads, reconfirms the live head and asserts no writes.
A February rejection followed by a January posting proves that rejection time
does not advance the financial clock. Original committed and rejected outcomes
replay after later publication; changed payloads and forged input hashes conflict.
This is adapter conformance, not independent proof of the shared accounting rules.

Root `bun run check` exits 0: 378 ledger tests / 22,042 assertions; 237 kernel tests /
20,002 assertions; 100% kernel functions/lines across thirteen sources; 102 existing
trace bindings. Licensed SysIDE 0.10.3 reports zero diagnostics for both models and
dependency workspace, including valid/syntax/unresolved-reference controls. Logs:
`/tmp/rastrata-protocol-check.log`, `/tmp/rastrata-protocol-context-tests-final.log`,
`/tmp/rastrata-protocol-syside.log`. Frozen legacy fixture digests are unchanged.

SHA-256: book `1e96db05f341a18a887754c8d1ad548b48c923c6dd64c2832baa64373b54bb04`;
kernel test `c6c0d40f9add3cb73333e8953c8c85b91d1482b26f8673e2592802727fe88b46`;
ledger test `6508f8cd0e8780b5bd8e2aa0acce856d2994234b47ffad4b437bb45f9dc06c5d`;
kernel model `7d967022bdb26ed146d2944374294cfa511325aca67fe2dd05b38630fdcf8466`;
ledger model `6da202cd9022ea0192ee1da279b78b0337646d4420fa7bfb01a0e1f6b21f6f03`.

Complete indexed evaluation and PL-021 remain open, as do the unchanged capacity,
full-history recovery, storage/archive, workload/SLO and release audit gates. This
step supplies no new mutation certification, cloud result or production-readiness
claim. The next shared boundary is financial/configuration admission with exact
activation evidence; full canonical-state verification cannot become a caller flag.

## Shared financial and configuration admission

The full-state evaluator now uses shared `validateBookFinancialIdentity` and
`validateBookConfiguration`; configuration replacement uses the latter too.
Identity diagnostics retain their order: chart scope, identity completeness,
current financial hash, then the original activation's pinned hash. Configuration
validation retains complete period-before-policy diagnostic ordering. Neither
helper authenticates inputs or admits a command. The existing complete-state hash
check remains between financial identity and expected-revision/configuration
admission, without a caller-supplied integrity flag or partial-state workaround.

`readActivationIdentity(boundaryId)` resolves the permanent boundary-ID index to
the creating retained outcome and financial revision, then selects exactly one
activation effect bound to the raw boundary ID and activation command. It returns
the source revision hash and original immutable effect after live-head confirmation.
Outcome sequence is not a financial revision. Missing evidence retires the reader;
absence for one raw ID is not proof that the whole book has no activation. This
lookup does not change persisted index/catalog formats or startup verification.

Five new tests / 111 assertions cover exact financial/configuration diagnostics,
unresolved activation evidence, complete hash-field comparison and authenticated
adapter conformance. A retained rejection and configuration precede activation,
giving activation Oseq 3 / revision 2; a later configuration replacement leaves
the activation's original revision-1 configuration intact while current config is
revision 2. Fresh owners reproduce these inputs. Missing source bytes or expiry
at either source-fetch stage, invalid IDs and publication against an old reader
fail closed. No read-side calculation creates a durable outcome.

Root `bun run check` exits 0: 380 ledger tests / 22,112 assertions; 240 kernel tests /
20,043 assertions; 100% kernel functions/lines across thirteen sources; 102 existing
trace bindings. Licensed SysIDE 0.10.3 reports zero diagnostics for both models and
dependency workspace, with valid/syntax/unresolved-reference controls passing.
Frozen legacy fixture digests remain unchanged. Logs:
`/tmp/rastrata-financial-check.log`, `/tmp/rastrata-financial-targeted-final.log`,
`/tmp/rastrata-financial-syside.log`.

SHA-256: book `335b509afb2c67d94373fdaa4dd6005374c13b78af3573871bc5d4ecb81293d0`;
kernel test `2e8708ee7e04a336a074947ae9632a6cf901bb94f73c1cf0b8dba51e70ebb2ec`;
owner `9c7110cde35afe8557dd9f2fa0f0328a9e01be46319fc9054bf1f792e7786235`;
resolver `a52a64896d9a7f373a94b6ba29dab2c67f446aea945b221464b0fdf998be3228`;
kernel model `63fc9f19bb3bace7683a1d0fe033849b663e7e5baeffb5e37eb1105ce507db9f`;
ledger model `06b7ce60fb1aa7854c52fa65c17b57ab662d748a14b58be8629a0881e87aeeae`.

Complete indexed evaluation, global and command-specific source closure, scalable
state publication/storage/recovery, workload/SLO acceptance and release audit remain
open. The 1,000-outcome limit and full-history startup are unchanged. No current
mutation certification, cloud benchmark or production-readiness claim is made.

## Shared book-wide admission guards

`validateBookGlobalAdmission` now supplies the evaluator's existing specialized
command opening guard and required-unrealized-reversal diagnostic. Opening checks
precede the overdue lookup; all seventeen command classifications are covered by
an exhaustive typed test table. Unresolved/asynchronous overdue evidence throws
instead of becoming absence. These are semantic checks, not source authentication,
complete-state integrity, command-specific admission or publication authority.

The full-state evaluator and indexed admission-facts reader now share
`requiresRemeasurementReversal`: unrealized result, strict prior command date,
matching current currency policy requiring reversal, and explicit reversal
exception. The callers still select the first current policy, prove complete
reversal absence and retain canonical result order. The independent materialized
selection oracle in the ledger tests was deliberately not replaced with this
shared helper. Complete group traversal and existing corruption/fencing behavior
remain unchanged; no constant-time admission or capacity improvement is claimed.

Three new kernel tests cover all seventeen variants across configuring, missing
opening boundary and activated states, missing evidence and date/policy boundaries.
Existing real FX tests now also compare exact shared global diagnostics with
canonical execution. Targeted run: nine tests / 502 assertions, including current
policy replacement, explicit reversal, realized-result exclusion and source faults.

Root `bun run check` exits 0: 380 ledger tests / 22,118 assertions; 243 kernel tests /
20,314 assertions; 100% kernel functions/lines across thirteen sources; 102 existing
trace bindings. Licensed SysIDE 0.10.3 reports zero diagnostics for both models and
dependency workspace, including valid/syntax/unresolved-reference controls.
Frozen legacy fixture digests are unchanged. Logs: `/tmp/rastrata-global-check.log`,
`/tmp/rastrata-global-targeted.log`, `/tmp/rastrata-global-syside.log`.

SHA-256: book `d4d4735716ce976a1b7a1de2082fb22fc8d7a2d35ecda59a3a79180a9442b33f`;
kernel test `900869b3ac53da927d57d991b66b8700a680753f2ed43f3ef637135f0a532b7b`;
facts `bcd75ffbd2f084b10fd2842e2014ff42e2c4aa52ec6241252060b2dd967bf63b`;
kernel model `42e10dfe19973ac44476745523f3d9242c6a3067185bd08dc6c13fcd3f6c8d0e`;
ledger model `7d926b209fd43e2b6799098bbf697f0f4a4a15fc7b7cd144207eac1e811dd9c0`.

The production ledger still needs complete indexed command evaluation, atomic
state/storage updates without full-history rebuilds, recovery and workload/SLO
acceptance. The 1,000-outcome cap and full-history startup remain unchanged. No
current mutation certification or production-readiness claim is made.

## Pinned inventory cost populations

`readInventoryCostFacts` now supplies the selected policy's complete current
nonzero holding population for a commodity, joined to authenticated current lots.
Every policy-account group is exhausted, including empty groups; submitted layers
never bound these reads. The result retains exact quantity/basis and acquisition
time, plus compact holding/lot ordinals and source hashes. Distinct lots are read
once per operation, with only required scalar fields cached; later holdings still
check commodity/basis compatibility against that cache. Missing source evidence,
wrong views/predicates, duplicate holdings, incomplete pages and excessive layer
populations fail without a partial result.

The owner snapshots commands before queuing and serializes the complete nested
read. Shared internal group and lot helpers execute within that operation, not
behind their waiting caller. Final live-view confirmation remains mandatory.
Existing public lot and admission-facts readers retain their behavior. No source,
group or owner persistence marker changed. This path still relies on complete
verified legacy recovery and its size bounds; output count is additionally bounded
by the kernel's existing executable layer limit, not a new large-book guarantee.

Canonical inventory admission now shares `inventoryCostLayersMatch`, which compares
complete populations exactly and without mutating either input. Policy selection,
validity/capability, derivation, costing, disposal identity/quantity closure,
generated journals and atomic lot effects remain separate admission obligations.
The helper alone cannot authenticate a purported canonical population or book.

Five targeted tests / 122 assertions cover exact fields and omission, real
multi-account acquisition/transfer/coalescing/depletion, missing policy and empty
commodity populations, source receipts, command-hash recomputation and nested
read/close serialization. A real FIFO issue consumes exactly 1 quantity / 1 basis;
subsequent reads show destination 4/4 and the unrelated second lot 7/7. A source
cursor test deliberately uses one-row pages, requires four pages across three
accounts, and reads two distinct parent lots for three live holdings. An unavailable
second page rejects rather than returning the first page. Missing/expired holding
and parent-lot sources, foreign views, count-limit faults, invalid command variants
and stale publication views also fail closed. These are bounded fixtures, not an
enterprise capacity benchmark or a full indexed executor.

Root `bun run check` exits 0: 384 ledger tests / 22,228 assertions; 244 kernel tests /
20,326 assertions; 100% kernel functions/lines across thirteen sources; 102 existing
trace bindings. Licensed SysIDE 0.10.3 reports zero diagnostics for both models and
dependency workspace, with valid/syntax/unresolved-reference controls passing.
Frozen legacy fixture digests are unchanged. Logs:
`/tmp/rastrata-inventory-facts-check.log`, `/tmp/rastrata-inventory-facts-tests.log`,
`/tmp/rastrata-inventory-facts-syside.log`.

SHA-256: book `b4dce78b3b1072b0c2144d076f3bc4521cc82aa0ae27fbeea08b4245379be520`;
kernel test `613c1333ac774ec5be0343347fa83f2fb7f37022f3c0e2e0594b6d1be4b0e2ba`;
facts `5599a60ff8a29a2879c15adba381b370f734fb4ff660464910eef7a5e1312e10`;
owner `09870e207977f7e790870087dc3063a41925fda67a5d6457339dc1ff82cd3e3f`;
kernel model `9553b0ecac4912cc92d7b0d903cbcfb7c8972585800c8cfd0ee8e6ad12c300a2`;
ledger model `ebb8b4ff4b2df7b1a69757bf1959e677b75cf121d1b619ee7ab1ca8914f2e835`.

PL-021 complete indexed evaluation, scalable atomic state/storage publication,
recovery and workload/SLO acceptance remain open. The 1,000-outcome limit and
full-history startup are unchanged; no new mutation or production certification.

## Lot identity and journal-linkage integrity repairs

The next lot-state read-context audit exposed accounting defects in the existing
full-state evaluator, before introducing an indexed replacement. These were real
production-kernel executions, not malformed hand-built states: each committed with
no diagnostics, and `validateBookState` accepted the resulting state. The prior
100% line/function coverage and passing suites did not establish these invariants.

| Preserved reproduction | Pre-fix result | Required disposition |
| --- | --- | --- |
| New destination ID aliases its source holding | Total quantity/basis 17 becomes 10; remainder overwritten | Reject before financial mutation |
| New destination ID aliases an unrelated holding in another account | Total quantity/basis 17 becomes 10; unrelated lot overwritten | Reject before financial mutation |
| Continuity source and destination use the same account | Total quantity/basis 17 becomes 20 | Reject; this model has account-scoped holdings, not an independent warehouse coordinate |
| Transfer posting reduces income while selected holding belongs to cash | Cash lot decreases 3 while journal reduces income 3 | Reject mismatched posting/holding scope |
| Disposal posting reduces income while selected holding belongs to cash | Cash holding depleted through another account's journal | Reject mismatched posting/holding scope |
| Transfer source posting annotates basis -99 while allocation moves 3 | False authoritative basis annotation accepted | Reject supplied basis mismatch |
| Two transfer operations consume the same posting pair | Journal moves 3 but holdings move 6 | Reject second use of either posting |
| Two acquisitions consume one positive posting | Journal acquires 10 but holdings acquire 20 | Reject second use of the posting |

The first three exact encoded bad aggregates were captured before repairs at book
source SHA-256 `b4dce78b3b1072b0c2144d076f3bc4521cc82aa0ae27fbeea08b4245379be520`.
The next five were captured after the identity repair but before the linkage repair,
at `c397a1f00315a511d245ad88083db0651c14144e23865e47457fdf1ff7672215`.
`kernel/test/data/transfer-defect-legacy.json` and
`kernel/test/data/lot-posting-defect-legacy.json` preserve original committed rows,
encoded bad aggregates, uncompressed SHA-256 values, and valid initial aggregates.
Gzip is fixture storage only; no production encoding changed. Tests verify the
original hashes before structural row decoding and rebuild valid prefixes through
production execution. They do not accept the bad aggregate as an admitted state.

`transferLots` now requires distinct continuity accounts, rejects source/destination
identity overlap, and rejects a new destination ID already present among sources.
`prepareLotState` checks new destinations against the complete loop-current book
holding population, including depleted holdings and earlier same-command effects.
Genuine same-lot/destination-account coalescing remains valid. New posting-linkage
checks enforce one use per canonical posting within the journal, matching source
book/account/commodity, destination commodity continuity, and signed equality for
any supplied transfer basis annotations. Basis annotations remain optional for a
continuity transfer, whose authoritative basis is calculated from its holdings.
Historical basis is not replaced with quantized book value or valuation allowance.
Explicit disposal-and-reacquisition policy handling is unchanged.

This is consistent with the reviewed reference mechanisms, not an interoperability
claim. Beancount `booking_full.py:600-685` selects inventory using the posting's
account, filters unit/cost currencies, and maintains local balances for cumulative
posting effects (checkout `9747213802acb733ce53acc6e963f5961f47d6cd`). Hledger
`Hledger/Data/Lots.hs:2154-2164` selects and reduces lots by the transfer posting's
source account/commodity; its destination annotation validation at 2253 onward
checks supplied lot information (checkout
`d06affcbb692bae849b7f33eb52b2958dc39243d`). Rastrata does not adopt Hledger's
average-pool annotation exception or Beancount's inferred posting representation.
Rastrata's current acquire/dispose operation consumes one full canonical posting;
multiple lots can use distinct postings, while disposal/transfer can allocate one
posting across multiple holdings within one operation.

ACC-008/009/010 and the state-access contract now explicitly state global permanent
holding identity, distinct continuity accounts, posting-use uniqueness, and exact
posting/holding linkage. The future indexed overlay must retain these checks;
destination-account absence and successful row authentication do not prove them.
The existing 102 trace bindings still pass; this is not new exhaustive semantic
traceability of every clause. The concrete additional evidence is:

- `kernel/test/transfer-identity.test.ts`: four tests / 108 assertions, including
  depleted IDs, pending acquisitions, valid fresh identity, and rejected retry.
- `kernel/test/lot-posting-linkage.test.ts`: three tests / 130 assertions, including
  optional/exact basis, incorrect source/destination signs and amounts, unchanged
  financial state, and rejected retry.
- `ledger/test/ledger.test.ts`: twelve new SQLite tests / 180 assertions across
  snapshot and compact formats. Rejections are retained exactly once; restart and
  retry preserve their original results and leave financial revisions, journals,
  holdings and state hashes unchanged.

Every frozen defective aggregate now fails `decodeDurableBook` with the canonical
effect-topology validation error. Its original bytes and committed receipt are not
rewritten or converted into a rejection. Such historical evidence requires
quarantine/investigation, not automatic repair. This directly tests aggregate
semantic recovery refusal and valid rejection restart in both storage formats;
it is not a deployment-wide scan or a separately injected corrupt compact-history
recovery drill. Previously frozen allocation/inventory fixture digests are unchanged.

Final combined `bun run check` exits 0: 251 kernel tests / 20,564 assertions;
396 ledger tests / 22,408 assertions; 100% kernel functions and lines across thirteen
production sources; 102 existing trace bindings. Licensed SysIDE 0.10.3 reports zero
diagnostics for both models and dependency workspace, with the valid/syntax/error
reference controls passing. `git diff --check` is clean. Logs:
`/tmp/rastrata-lot-integrity-check.log`, `/tmp/rastrata-lot-integrity-syside.log`,
`/tmp/rastrata-transfer-identity-tests.log`, `/tmp/rastrata-lot-linkage-tests.log`,
`/tmp/rastrata-transfer-ledger-tests.log`.

SHA-256: book `e3ec56b8e0074b646a58bda1c785d08fc74000c9bab234c2c300ec93075099ff`;
lots `c05bc30cd197e5bb38bba3f4d002be2cee2f3912cf5d7bb6a56e36fb3d13db24`;
kernel model `2afb9569f3b8807e6e83b5cc7f1878f9c285fec19a833bdb5ddc7fd280bb10f0`;
transfer fixture `704df6c2bfaf6f4379a8eb09870ec00ff1ce805fc942a7b42fa133d1a004bf55`;
linkage fixture `8566547bfcee63fcd6facf8327a8e96ddee84888c4c90d421dc823ca240a8e66`.

These repairs close the eight reproduced failures, not the entire lot/accounting
audit. Further value/quantization and multi-operation closure review precedes an
indexed lot-state replacement. PL-021, scalable publication/storage, recovery,
security and workload/SLO acceptance remain open. The 1,000-outcome limit and
full-history startup are unchanged. No new mutation score, kernel freeze,
production certification, deployment or cloud drill is claimed.

## Inventory carrying value and recovery review

The continuation first closed a recovery-evidence gap from the preceding review.
`ledger/test/outcome-payload.test.ts` now transports all twelve preserved corrupt
lot outcomes (the previous eight plus the four below) through the actual compact
`replayOutcomePayload` implementation. Their command/result/revision payloads pass
structural decoding; accounting replay rejects with `recovery_outcome_mismatch`.
Genuine prefixes replay successfully, and failures leave prior aggregates, captured
bytes and original committed results untouched. The test has 125 assertions. This
is a direct production replay-function test, not a Cloudflare recovery drill or an
injected SQLite chunk-chain test.

Further actual command executions found four previously accepted failures:

- An acquisition accepted basis 10, allowance 0 and carrying value 99.
- An acquisition accepted basis 10, allowance -11 and carrying value -1.
- An acquisition accepted basis 10, allowance +1 and carrying value 11.
- After a policy-governed write-down of inventory from basis 10 to carrying value
  8, a full issue posted expense +10 / inventory -10. Its holding was depleted,
  but the inventory ledger balance was -2; the write-down was effectively expensed
  twice. All four executions committed and passed prior state validation.

`kernel/test/data/inventory-carrying-defect-legacy.json` preserves these execution
captures at book source SHA-256
`e3ec56b8e0074b646a58bda1c785d08fc74000c9bab234c2c300ec93075099ff`.
The probe encoded whole `AtomicBookCommit` objects, including result/intent fields,
rather than only durable aggregates. The test explicitly frames their original
state/protocol subtrees into the aggregate envelope and recomputes the envelope
checksum; it changes no accounting row or accounting hash. Original captures and
their SHA-256 values remain immutable. This distinction matters: rejection for
extra transport fields would not demonstrate the accounting recovery repair.

Acquisition now rejects incoherent totals, negative carrying value and positive
valuation allowance. Generated inventory issues use allocated historical basis
plus the exact proportional valuation allowance for expense and inventory journal
amounts. Their cost-basis annotations and lot allocations continue to retain
historical basis separately. The canonical layer-matching contract is unchanged:
layer inputs describe historical basis, not caller-asserted carrying value.

The shared `inventoryCostJournalDraft` is used both for command execution and
semantic history validation. Restoration recalculates the journal and resolves
its quantization/dimensions using the restored configuration, then compares the
complete canonical journal and quantization-policy hash. Missing live holding
sources or an invalid calculation do not establish a valid historical journal.
No old committed outcome is silently converted into a different journal or a
rejected receipt; corrupt captures fail recovery and require investigation.

`kernel/test/inventory-carrying.test.ts` adds four tests / 70 assertions. The full
issue posts +8 expense / -8 inventory, allocation basis 10 / allowance -2 /
carrying 8, and leaves all holding amounts and the inventory ledger balance zero.
Two half-issues each post 4 and consume basis 5 / allowance -1 / carrying 4.
Acquisition failures are atomic and their retained rejections replay. All four
captured corrupt histories fail semantic effect-topology validation. ACC-039.5
and the state-access contract explicitly record these distinctions; selected
authenticated holding allowances are required beyond the inventory layer facts.

### Open: cumulative inventory posting quantization

The additional adversarial probe is **not closed by the above repair**. Three
one-third issues of the same carrying value 8 each post 2.67. The final holding has
quantity/basis/allowance/carrying all zero, but the inventory ledger balance is
`-1/100`; state validation currently accepts it. Exact allocation conservation
does not prove decimal posted conservation.

`kernel/test/data/inventory-rounding-legacy.json` captures the exact durable
aggregate, valid initial aggregate, three posting pairs, source hash and observed
residual. The uncompressed aggregate SHA-256 is
`0a31170fb2120e2d80487b7d20cdf8e1e64c7de972fef568b757b3dc36a8e344`.
The reproducer is `/tmp/rastrata-inventory-rounding-probe.ts`; the retained JSON
contains the full replayable command history, so the evidence does not depend on
that temporary script surviving. This was a diagnostic probe, not a passing
acceptance test or an asserted rounding guarantee.

Next design work must define the posted-carrying/rounding ownership and cumulative
reconciliation across acquisition, partial issue, transfer, value adjustment and
depletion; bound its indexed read set; and decide how historical posted decisions
are preserved or explicitly corrected. Merely rounding each exact issue again,
or declaring a depleted holding to prove its account is cleared, is insufficient.
Also still to audit: generic lot journal carrying-value linkage, zero-basis live
holdings, and multi-account issue topology. None is claimed complete by these tests.

Final `bun run check` exits 0: 255 kernel tests / 20,634 assertions; 397 ledger
tests / 22,533 assertions; 100% kernel line/function coverage across thirteen
sources; 102 existing trace bindings. Licensed SysIDE 0.10.3 reports zero diagnostics
for both models and dependency workspace, with valid/syntax/unresolved-reference
controls passing. Formatting and `git diff --check` pass. Logs:
`/tmp/rastrata-carrying-final-check.log`, `/tmp/rastrata-carrying-tests.log`,
`/tmp/rastrata-lot-recovery-test.log`, `/tmp/rastrata-carrying-syside.log`.
These gates do not certify the known cumulative-rounding failure above.

SHA-256: book `55f7ec407a3d913fdf4c0fcfd5898264b8a724df9c6c9ca2e130324cc1504680`;
kernel model `fa861eebdb52e6eb2564e9beb3ea72eef0dee14040a37ff4d282a91cccfcb02e`;
carrying capture `fc730de5299c6196e989edfa81148c3ccae0a6f93e8c9251beb9e0f39a2fb115`.
Previously frozen inventory/allocation compatibility fixture digests are unchanged.
No new mutation campaign, freeze, deployment or production readiness is claimed.
The full goal and the ledger capacity/recovery/security gates remain open.

## Cumulative posted-share arithmetic and inventory ownership decision

This continuation advances the open fractional-issue finding without silently
changing old inventory semantics. The selected direction is to preserve an
authenticated posted carrying budget with each holding and consume it using a
fixed, versioned cumulative anchor. It rejects independently rerounding current
exact carrying value as a substitute for actual prior postings. The full transition
matrix and remaining integration gates are in
[the posted-carrying contract](state-access-contract.md#prospective-inventory-posted-carrying-ownership).

The reference review informed this boundary, but none of the references is cited
as proof of Rastrata's proposed decimal guarantee:

- Ledger `src/xact.cc:194-226` preserves inferred cost precision separately from
  evolving display precision (checkout `6fcfab268068164e0141a4e9770784c6bf4484ac`).
  Display precision must not determine Rastrata's authoritative posted ownership.
- Hledger `Hledger/Data/Lots.hs:2120-2165` reduces source-account lot state before
  distributing the selected fragments to destinations and verifies complete
  distribution (checkout `d06affcbb692bae849b7f33eb52b2958dc39243d`). Rastrata's
  proposed posted budgets must move with the same conservation discipline.
- Beancount `booking_full.py:682-691` updates local inventory after each booked
  reduction, while `ops/pad.py:111-133` reports errors for padding costed positions
  (checkout `9747213802acb733ce53acc6e963f5961f47d6cd`). A silent synthetic balance
  correction is not an acceptable solution to the captured residual.
- Bigcapital `InventoryAverageCostMethod.ts:36-104` maintains cumulative quantity
  and cost, but uses JavaScript numbers and clamps balances with `Math.max`.
  `InventoryCostGLStorage.service.ts:27-46` deletes/reverts cost entries during
  recomputation (checkout `7883ad07e3e38ef7fc56d6c83ea0e851c1b80d1d`). Its separation
  of inventory calculation and GL storage is useful context; neither floating
  arithmetic, clamping nor deletion is adopted for this append-only kernel.

`quantizeCumulativePostedShare` in `quantization.ts` takes an already-posted,
nonnegative decimal P, monotonic cumulative fractions f0/f1 in [0,1], and a pinned
quantization policy. It returns both exact targets, both quantization results, and
the difference of their decimal amounts. Its output and copied policy are frozen.
P must already be exactly representable in the policy. No source-account evidence,
inventory state or command authority is implied by this arithmetic function.

The formula `Q(P*f1)-Q(P*f0)` telescopes: contiguous shares from zero through one
sum exactly to P under each supported rounding mode. For P=8.00 and thirds, the
posted amounts are 2.67, 2.66 and 2.67. A combined exact cost of 0.03 with an actual
posted budget of 0.04 must dispose 0.04, not reconstruct 0.03 from exact cost. The
new SysML `CumulativePostedShare` item states these mechanics and their limits; it
does not activate a new inventory policy or claim a completed anchor/movement model.

Four tests / 33,750 assertions cover the thirds example and target residuals,
nonnegative/zero shares, immutable copied policy, representable scale normalization,
unsupported domains, silent rerounding refusal, and independent integer-oracle
checks across five rounding modes, three scales, seven posted totals and six
partition sizes. Every fine-partition prefix equals the corresponding unsplit
cumulative share. These are arithmetic proofs over the tested values, not an
inventory transfer/value-adjustment integration test or a capacity benchmark.

The fourth test is explicitly **legacy characterization**, not acceptance: it
reexecutes the captured rounding book and proves exact byte/hash preservation,
including its -0.01 residual and zero remaining lot quantity. No production command
calls the new helper yet. Fixing the live defect still requires the typed ownership
effects, verified before/after postings, complete transition handling, indexed
read sets and legacy reconciliation specified in the contract. In particular,
partial/full value adjustment, dimension-safe coalescing and policy transitions
cannot be inferred from a successful numeric share calculation.

Final `bun run check` exits 0: 259 kernel tests / 54,384 assertions; 397 ledger
tests / 22,533 assertions; 100% kernel line/function coverage across thirteen
production sources; 102 existing trace bindings. Licensed SysIDE 0.10.3 reports
zero diagnostics for both models and dependency workspace, with valid/syntax/
unresolved-reference controls passing. Formatting and `git diff --check` pass.
Logs: `/tmp/rastrata-posted-share-check.log`, `/tmp/rastrata-posted-share-tests.log`,
`/tmp/rastrata-posted-share-syside.log`.

SHA-256: quantization `eb7e547eca9b55822e0bc7e24d5e7ef95aa44b7cddd3da87fc4ef95a061d1e31`;
kernel model `8c5e3c581c8881b3c639fcd524a97ab4e6ae6ee3880df75b109affcf4a5af80c`.
Book evaluator remains `55f7ec407a3d913fdf4c0fcfd5898264b8a724df9c6c9ca2e130324cc1504680`;
rounding fixture remains `2a8ca8cf060737b65a87f46e0b3bd62926e85e6945ffda4f12f1b10570a5856e`.
The inventory finding, full production goal, and capacity/recovery/security gates
remain open; no new mutation result, freeze, push, deployment or cloud drill.

## Read-only legacy inventory posted attribution

The next prerequisite is now executable through
`ProductionLedger.auditInventoryPostedBalances()`. The method obtains a normal,
fully recovered immutable snapshot before running the internal
`inventory-posted-audit.ts` fold. Storage/recovery failures propagate; they cannot
be converted into an empty successful audit. No journal, retained result, policy,
anchor, storage schema or accounting calculation is changed.

The fold attributes actual acquisition, single-holding disposal, continuity
transfer/coalescing and single-target value-adjustment posting amounts. It retains
posting hashes, effect keys, revisions and quantization-policy hashes, plus the
holding's account/commodity/functional commodity and canonical dimension selection.
It tracks the actual signed posted balance rather than Q(exact holding cost).
Completed touched states and final balances are checked for negative budgets and
depleted/zero-carrying residuals.

The result is deliberately `attributed`, not "migration approved." Multi-holding
posting allocations without a historical decimal-ownership witness, missing
sources, coordinate conflicts, transfer-value/sign mismatches, relevant unsupported
corrections, unclassified tracked-account postings and residuals return
`requiresReview`. The entire balance/movement set is withheld on any finding.
These findings distinguish insufficient attribution from a claim that every
affected business transaction is invalid. Explicit classification/reconciliation
and anchor creation remain later governed transitions.

Ten new tests / 182 assertions exercise both snapshot and compact SQLite formats:

- Actual acquisition, transfer, destination coalescing and depletion produce
  balances 0, 7 and 5 with seven exact source posting receipts; reopening reproduces
  the same report and aggregate bytes.
- A concurrent later posting does not change the earlier audit's pinned head.
  The later unclassified cash posting produces review rather than an invented
  inventory allocation. Injected SQL read failure throws, then recovery reproduces
  the prior report after the read fault is removed.
- The preserved three-thirds book reexecutes its original commands/results through
  each storage format. Its -0.01 posted residual is exposed with no zero-initialized
  migration balance, no new outcome, and unchanged encoded history after restart.
- A legitimate two-holding disposal is explicitly unclassified at per-holding
  decimal level; the audit does not silently choose posted shares.
- A source posting with dimensions differing from its acquisition and a transfer
  credit/debit value mismatch both require review. The latter remains admitted by
  the legacy kernel: the test adds a balancing non-inventory posting while moving
  3 units but posting destination value 4. This is characterization of the open
  generic transfer carrying-value linkage gap, not a repaired command-admission
  case. The new cumulative transition work must address it.

The production-ledger SysML now models the pinned audit disposition, findings,
balances and movement evidence, including the no-usable-balances-on-failure rule
and its trusted-read boundary. The production contract no longer misleadingly
states that the changed accounting kernel is still frozen. This method has no
deployed HTTP endpoint, no migration/correction command and no independent cloud
failure or tenant-authorization certification. Its full-history work remains
subject to existing legacy capacity limits and is not on the command execution
path or a new bounded indexed implementation.

Final `bun run check` exits 0: 259 kernel tests / 54,384 assertions; 407 ledger
tests / 22,715 assertions; 100% kernel line/function coverage across thirteen
sources; 102 existing trace bindings. Licensed SysIDE 0.10.3 reports zero diagnostics
for both models and dependency workspace, with valid/syntax/unresolved-reference
controls passing. Formatting and `git diff --check` pass. Logs:
`/tmp/rastrata-inventory-posted-audit-final-check.log`,
`/tmp/rastrata-inventory-posted-audit-tests.log`,
`/tmp/rastrata-inventory-posted-audit-syside.log`.

SHA-256: audit `b2bafd06011d22758bbec90e53ed88eddd5dbfc69dcf3c56ca636c57be1641f2`;
ledger `d2064285903c0f59e969e10edc70ee614925f410ed56362074062f16d4078d55`;
ledger model `fc9b1609640c28b616c825aa6ac916bd399a7a066b472297db2d4220654f92f3`.
The kernel evaluator and frozen historical fixture bytes are unchanged. Cumulative
inventory policy integration, complete reconciliation/anchor transitions, indexed
publication, capacity/recovery/security gates and the full goal remain open.
No new mutation certification, freeze, push or deployment is claimed.

### Explicit posted-attribution proposals, without historical promotion

The read-only audit now accepts an optional bounded JSON proposal for cases where
a canonical posting covers more than one holding. This closes the previous
auditor's inability to assess any proposed multi-holding split; it does not close
legacy conversion, authorize a correction, or integrate cumulative inventory
commands. No kernel evaluator, kernel quantization primitive or captured legacy
fixture was changed in this increment.

`legacy-inventory-posted-attribution-v1` binds the complete verified scope/head,
including retained rejection outcomes, and every actual source posting's full
content hash. Eligible holding IDs and exact carrying weights come from canonical
allocations. A supplied weight, invented holding, arbitrary conserving split or
current-policy reinterpretation is not accepted. In canonical holding-ID order,
the proposal must match cumulative quantization of the absolute actual posted
budget in those exact weights, restoring the posting sign. Transfer destinations
inherit the accepted source amounts with opposite signs, rather than independently
rounding by destination order. Same-sign value-adjustment targets use their actual
generated inventory posting; mixed-sign changes within a net posting remain open.

The decoder validates exact parsed field sets, complete hashes, canonical decimal
strings, unique posting and per-posting holding IDs, a 1 MiB UTF-8 envelope cap and
10,000 total shares. It copies and freezes the proposal before ledger I/O. Receipts
normalize row/share order and numeric decimal values. Wrong source/posting hashes,
stale heads, missing/extra/inconsistent shares and unused rows require review.
Malformed input throws before a SQL read; it cannot become absent optional input.
Any finding continues to suppress all usable balances and movements.

An accepted proposal returns **proposedAttribution**, never **attributed**, with
its normalized witness hash and per-movement canonical/proposed provenance.
Neither disposition is a valuation opinion, proof of historical allocation intent,
signature, policy opt-in, migration eligibility decision or write authorization.
The SysML and state-access contract explicitly retain this distinction. The API
remains trusted and in-process, like `read()`, with no deployed public endpoint.

Seven new tests plus strengthened existing disposal tests cover:

- Two-holding disposal of 5: exact proposed shares -2/-3, resulting balances 8/4,
  stable normalized receipt after share reordering and restart, unchanged stored
  aggregate bytes, and refusal of conserving but incorrect -1/-4 redistribution.
- Missing/extra holdings, wrong signs, fractional-cent discrepancies, duplicate
  IDs, wrong hashes/versions, unused evidence, oversized/malformed envelopes and
  a newly retained rejection invalidating an otherwise financially unchanged head.
- Multi-source transfer: source shares -2/-1 produce the matching destination
  shares +2/+1 even with reversed destination ID ordering. A supplied destination
  row cannot swap those amounts. Restart reproduces the result without writes.
- A penny-level arithmetic counterexample: equal source weights split -0.01 as
  0/-0.01 under half-even; the destination with the second source receives +0.01
  even when its ID sorts first. An independent destination rerounding is rejected.
- Invalid/mixed prescribed targets, negative weights, nonrepresentable budgets or
  shares, zero-weight ambiguity, full hash components and hostile non-string input.
- A new two-holding value-adjustment scenario, constructed from legacy fixture
  command templates without editing those fixtures, posts 5 and validates shares
  2/3 against production output, producing posted balances 12/13 in both formats.

The expanded focused campaign passes 17 tests / 345 assertions, including all prior
read-only audit controls and preserved -0.01 residual characterization. Final
`bun run check` exits 0: 259 kernel tests / 54,384 assertions; 414 ledger tests /
22,878 assertions; 100% kernel function/line coverage across thirteen sources;
102 existing semantic trace bindings. Ledger coverage is not claimed to be 100%.
Licensed SysIDE 0.10.3 reports zero diagnostics for both models and their dependency
workspace with valid/syntax/unresolved-reference controls passing. Initial lint
and formatting failures in new code/tests were repaired before the successful
full run. `git diff --check` passes. Evidence logs:
`/tmp/rastrata-inventory-witness-verified-check.log`,
`/tmp/rastrata-inventory-witness-targeted.log`,
`/tmp/rastrata-inventory-witness-syside.log`.

SHA-256: witness `8418fc0228788f31c9cea4abd9b3346e9f05322e758babcd3d4ac5fbddcac1f9`;
audit `875b79072407d2fea84ea111e651156cb88f1127041101c6d35a0337a4a01562`;
ledger `e2118b8bd384ba41879404a3c7b378c1647f8dc0d3d5490c1e5c75f63be2e08d`;
ledger model `2e3f8cd45441c79eeb8d4682b0f87fd0dbc674471f71e9f8f63d3fb58b0611e1`.
The full production goal remains open: typed posted-carrying anchors/movements,
versioned cumulative inventory command admission and replay, governed correction
and conversion, complete indexed publication, capacity/recovery/security evidence
and release review remain necessary. No new mutation certification, freeze,
production readiness, commit, push or deployment is claimed by this increment.

### Posted-value admission repair and the zero-posted quantity boundary

Before enabling cumulative posted-carrying ownership, the existing ordinary lot
command boundary needed repair. The prior audit could detect a continuity
transfer moving 3 units out with posted value -3 and into a destination with posted
value +4, offset by an unrelated -1 posting. Kernel admission still accepted it.
Probing the same boundary also confirmed reversed posted directions on acquisition,
disposal and continuity transfer. A balanced whole journal was not sufficient
evidence of a coherent lot operation.

Before changing the evaluator, four actual committed aggregates were captured in
`packages/kernel/test/data/inventory-posted-admission-defect-legacy.json`, together
with their genuine initial aggregate, encoded-byte SHA-256 hashes and evaluator
source SHA-256 `55f7ec407a3d913fdf4c0fcfd5898264b8a724df9c6c9ca2e130324cc1504680`.
All four commands committed and `validateBookState` returned no diagnostics under
that source. The fixture contains proper durable state/protocol aggregates, not
extra AtomicBookCommit fields or regenerated expectations:

| Captured defect | Old admitted result | Current boundary |
| --- | --- | --- |
| Acquisition increases units but credits inventory | Posted inventory -10 for the acquired holding | Reject negative ordinary acquisition posted value |
| Disposal reduces units but debits inventory | Posted inventory +5 for the disposal | Reject positive ordinary disposal posted value |
| Continuity transfer reverses both posted signs | Source +3, destination -3 | Require reducing source and increasing destination signs |
| Continuity transfer invents destination value | Source -3, destination +4, unrelated offset -1 | Require the two transfer book values to sum exactly to zero |

The added checks run after all existing local lot-transition validation and before
publishing any effect. Existing quantity, identity, selection and transfer-policy
diagnostic precedence is preserved, including when an earlier operation also has
a bad posted value. They do not reconstruct a posted budget from exact cost or
claim that equal transfer book values equal the correct remaining carrying budget.
The same preparation is recomputed by canonical effect-topology validation.

Four new kernel tests / 175 assertions cover atomic rejection, stable rejection
receipts after codec round-trip, unchanged financial state, independent source and
destination sign failures, prior diagnostic precedence, and semantic refusal of
the frozen formerly committed aggregates. The latter fail specifically with
`Revision effects do not match the command's canonical effect topology`, not a
syntax, checksum or unknown-field error. Existing compact-outcome recovery tests
now include all four new preserved cases: genuine prefixes replay, original corrupt
committed payloads fail with the existing recovery mismatch, and no old receipt or
posted amount is replaced. Two new SQLite tests exercise all four commands in
both snapshot and compact formats, checking unchanged financial head coordinates,
one retained rejection outcome, restart retry identity and unchanged bytes on retry.
The former transfer-value audit characterization now expects rejection at command
admission; dimension attribution remains a separate review case.

The accounting references corroborate the ownership boundary, not this exact
currency-quantization algorithm: hledger `Lots.hs:2120-2165` at
`d06affcbb692bae849b7f33eb52b2958dc39243d` distributes selected source fragments to
destinations and requires exact exhaustion; Beancount `booking_full.py:600-647` at
`9747213802acb733ce53acc6e963f5961f47d6cd` copies account-local balances before booking
so trial processing does not mutate the original balances. Rastrata's posted-value
sign/conservation boundary is explicitly stated in ACC-009/010. Their semantic
bindings now include `evaluateBookCommand`, not only the pure lot transfer helper;
the test coverage catalog includes the new admission tests. These bindings are
trace links, not a claim that one transfer fixture proves every expanded condition.

Investigation also verified a required integration boundary: ACC-018 currently
rejects every canonical posting with zero book value. The existing cumulative
primitive produces 0.00, 0.01, 0.00 when a 0.01 posted budget is consumed in thirds
under half-even, now asserted as an explicit example alongside the independent
integer-oracle tests. The first and last physical reductions therefore cannot be
implemented as ordinary zero-value journal postings. The legacy prohibition is
left unchanged and tested. SysML and the state-access contract now require an
explicit versioned quantity/ownership-only transition, ordinary period and command
authority, immutable allocation/anchor lineage, a financial revision without a new
journal posting sequence, and atomic mixed zero/nonzero batches. Zero-posted
transfers still need source and destination quantity/basis effects. This command
topology remains to be designed and implemented before the cumulative profile is
enabled; the change does not claim to have implemented it.

Final ordinary `bun run check` exits 0: 263 kernel tests / 54,561 assertions,
416 ledger tests / 23,064 assertions, 100% kernel function and line coverage across
thirteen sources, and 102 reviewed live trace bindings. Licensed SysIDE 0.10.3
reports zero diagnostics for both models and their dependency workspace, with
valid/syntax/unresolved-reference controls passing. Formatting and `git diff --check`
pass. Evidence: `/tmp/rastrata-posted-admission-release-check.log` (ordinary check,
not the release/mutation gate), `/tmp/rastrata-posted-admission-kernel-final.log`,
`/tmp/rastrata-posted-admission-targeted.log`,
`/tmp/rastrata-posted-admission-syside.log`. The initial pre-repair probe/test output
is `/tmp/rastrata-posted-admission-before.log`; the preserved aggregate bytes are
the authoritative pre-repair evidence.

SHA-256: evaluator `8882611ab4816f0b73b1632f7ff5885b146f37319abbce5bce985af7d51c4e5a`;
kernel model `0d85fc9ea1bf098a22d19ba23c1eee762e3d6a4a3a7324eb5c97f2e4d17dd94e`;
new fixture `9e2ff30f8defb61bc079ed966e42fb0320ce2cfa1cecec0b2a2785f23b9a94e7`.
The prior fractional-rounding fixture retains SHA-256
`2a8ca8cf060737b65a87f46e0b3bd62926e85e6945ffda4f12f1b10570a5856e` and its original
-0.01 residual; this repair does not fix that separate cumulative-cost defect.
Affected invalid historical books fail closed for review, not automatic repair.
No deployment data was inspected or rewritten, no cloud resources were changed,
and no mutation recertification, production readiness, freeze, commit or push is
claimed. The full production goal remains active.

### Typed posted-ownership design and explicit incomplete-work gates

The existing lot-allocation model required a canonical posting reference and
could not faithfully represent the zero-posted reductions found in the previous
turn. This increment defines prospective posted-ownership artifacts in SysML:
complete coordinates, immutable anchors, bounded typed origin references, keyed
positions, exact quantity allocations, abstract movements with journal-linked and
quantity-only variants, and touched-set ownership effects. The draft, intent and
logical snapshot models now contain the relevant ownership artifacts. Runtime
types, codecs and command admission are **not** implemented by these model items.

Important design decisions and audit findings:

- Active positions retain an anchor reference, cumulative consumption and a
  creating movement locator. They do not contain recursively embedded history.
  Immutable anchors/movements are independently referenced logical rows; the
  ownership effect contains only its complete touched set. Indexed selection and
  coalescing populations still require separate completeness proofs.
- A draft design linked the after-position back to its containing movement hash.
  That would require a movement/position hash fixed point. The model was corrected
  before implementation: the after-position hashes only the origin locator, while
  source verification resolves the authenticated effect and compares its complete
  after-image. Before-position references retain full historical hashes. Artifact
  ordering follows command operation order and canonical holding order within
  acyclic dependency phases, never storage iteration or arrival timing.
- Depleted positions retain their original positive-quantity anchor. A positive
  physical quantity with zero posted budget is representable; a zero-quantity
  anchor is not needed. An empty effect cannot manufacture a financial revision.
- Journal-linked movements require nonzero posted amounts and actual posting
  references. Quantity-only variants have zero posted amount and no fabricated
  journal ID, posting ID or ordinal. A balanced transfer's signed sum of zero is
  not permission to omit its nonzero postings. Historical inventory reads must
  distinguish financial revision from journal sequence.
- Exact economic cost, posted money and their difference remain distinct. The
  two-source 0.02 + 0.02 versus exact 0.03 illustration does not authorize merging
  distinct acquisition lot IDs. Actual coalescing remains lot- and coordinate-local.

Seven prospective examples exercise the actual cumulative-share primitive against
literal expected posted amounts, cumulative positions, remaining quantities and
economic differences. They include written-down 8 across thirds, 0.01 with
zero-posted terminal depletion, aggregate source budgets, free inventory, unequal
fractional quantities, ceiling and floor. The new test passes 96 assertions.
The examples explicitly declare `prospective-design-not-command-executable`; no
source authentication, journal emission, command authorization, persistence or
restart result is claimed from this arithmetic evidence.

ACC-039.7/8/9 now explicitly track ownership authority, quantity-only command
commit and history compatibility as **design-pending**. Each has a parent
derivation, architectural responsibility and prospective verification objective.
The semantic manifest has 105 IDs: 94 executable bindings, 8 boundary dispositions
and 3 design-pending entries with empty implementation/fixture lists and
`traced: false`. The trace summary now reports those categories instead of claiming
every model ID is executable. These are trace associations, not a completeness proof.

The structural validator was updated to distinguish 58 declared atomic requirements
from the existing 55 with command oracles. Its explicit pending set must exactly
match the release-blocking semantic trace. Existing fixture hashes and coverage
requirements are unchanged. A new tooling test runs the real validator with a
positive contract and three negative controls: dropping existing coverage,
pretending an existing fixture covers a pending child, and disagreeing with the
pending trace. Mutated in-memory catalogs are rehashed so the controls exercise
coverage admission rather than an unrelated checksum failure. Files are not changed.

Final ordinary `bun run check` passes: 264 kernel tests / 54,657 assertions,
416 ledger tests / 23,064 assertions, kernel tooling 3 tests / 21 assertions,
100% kernel line/function coverage across thirteen unchanged production sources,
and the explicitly partitioned 105-ID trace. Licensed SysIDE 0.10.3 reports zero
diagnostics for both models and their dependency workspace with its negative
controls passing. The actual kernel `check:release` entrypoint exits 1 on exactly
ACC-039.7/8/9 before later release steps; this is the intended incomplete-work
barrier, not a completed release. No new mutation score is claimed. Logs:
`/tmp/rastrata-inventory-ownership-model-check.log`,
`/tmp/rastrata-inventory-ownership-model-syside.log`,
`/tmp/rastrata-inventory-ownership-model-release-control.log`.

SHA-256: kernel model
`95c0d4a5de3a6afeb8f8fe321f51548263c2fa449e9ce2cad35c7faafefc0e22`;
examples `5e34a9a8ebdc5764086ee702ca991368b20f956eb0de97b815b394a991ee142d`;
manifest `de413e02d129fcc8ded67ff20c7492b5acbd1d8c904960e13604d8604d8210c0`;
structural validator `fa9fcad04b61b192e7a3567ea1533386617cf72c6ee6fc1de01281e4e0bd8332`.
The evaluator remains `8882611ab4816f0b73b1632f7ff5885b146f37319abbce5bce985af7d51c4e5a`.
Concrete zero/nonzero command payloads, source closure, codecs, canonical projection,
per-kind value adjustments, corrections, adoption and complete replay remain open.
Nothing was committed, pushed, deployed or changed in a live book. The full
production goal remains active; neither the new model nor green ordinary checks
mean the cumulative inventory profile or production ledger is ready.

### Shared accounting-period admission without a fabricated journal

The production journal preparation path now calls exported
`resolveBookAccountingPeriod`. The extracted `BookAccountingPeriodReadContext`
requires only a complete, previously validated same-book calendar and synchronous
closure results; the activity requires only its validated accounting date and kind.
`BookJournalReadContext` extends that context. Selection, validation order and
legacy journal diagnostic text/paths remain unchanged. This is a real production
call-path extraction, not a second test-only implementation of period rules.

Four focused kernel tests cover inclusive regular boundaries for all five activity
kinds, explicit adjustment selection, empty/overlapping catalogs, unavailable or
date-incompatible periods, closed periods, incomplete/asynchronous closure evidence
and the existing separately governed closed-period mode. Together with the existing
journal-context tests, the focused run passes 8 tests / 155 assertions. The first
full check caught a test-only optional-array-index type error, corrected before the
final run. Runtime behavior did not change to accommodate that test.

The indexed ledger conformance test now feeds authenticated period facts into the
same resolver with no journal or postings. It checks both interval boundaries before
close, after close and after January reopens. February remains inadmissible even
though its close package was superseded by reopening January. It reconfirms the
reader's head and unchanged durable ledger head; no command is published by this
harness. The focused integration run passes 1 test / 73 assertions.

ACC-029 now binds both the canonical evaluator and the exported resolver. Its
existing admit/reject fixture identities and immutable historical captures were
not regenerated. ACC-039.7/8/9 remain design-pending: this extraction does not
implement quantity-only command payloads, opening-boundary/identity/source
admission, ownership effects, codecs, history or atomic persistence. In particular,
the resolver's closed-period mode grants no authorization, and its inputs are not
in themselves storage-completeness or publication proofs.

Final `bun run check` exits 0: 268 kernel tests / 54,777 assertions;
416 ledger tests / 23,082 assertions; 100% kernel line/function coverage across
13 production sources; 105 traced model IDs partitioned into 94 executable bindings,
8 boundary dispositions and 3 design-pending entries. Licensed SysIDE 0.10.3 exits 0
with zero diagnostics for both models and their workspace, including syntax and
unresolved-reference controls. The actual kernel release entrypoint exits 1 on
exactly the three pending inventory requirements. No new mutation certification or
capacity improvement is claimed. Evidence:
`/tmp/rastrata-accounting-period-context-check.log`,
`/tmp/rastrata-accounting-period-context-syside.log`,
`/tmp/rastrata-accounting-period-context-release-control.log`.

SHA-256: evaluator
`a80611a013c6b50f937a123cd2e688fc92ae7e8329c68a1280e79311dbe9b2c1`;
semantic manifest
`147989e36c9aac3f100edae0add829735045b0cbe68ac5b22f647b34257f29c9`.
No model semantics, cloud resources, live books, commits or remote refs were changed
in this increment. The production-ledger goal remains active.

### Typed posted-ownership positions and exact reduction planning

`packages/kernel/src/inventory-ownership.ts` now implements the prospective
anchor/coordinate/position/reference types, domain-separated complete artifact
hashes and `prepareInventoryPostedReduction`. This is a reduction planner for one
already-selected disposal or transfer-out allocation, **not a BookCommand path**.
It neither creates/adopts anchors nor publishes movements. The current evaluator,
codecs, historical fixtures and financial command behavior remain unchanged.

The planner joins the supplied exact holding and economic allocation to the
anchor's cumulative quantity/posted position. It checks full anchor/position
hashes, the supported explicit anchor algorithm/version, exact anchor-reference
identity, bounded/unique source-reference structure, same-book origin ordering,
coordinate agreement and canonical dimension order. It rejects foreign-basis
allocations rather than silently interpreting them as functional money. Source
existence, complete attribution, approved derivations, policy admission and current
position origin verification remain caller obligations; self-consistent hashes
cannot establish them. Same-revision dependencies currently require the same
ownership effect; cross-effect ordering would need separately authenticated
command-effect order before that topology could be supported.

Actual posted reductions come only from the pinned anchor budget and cumulative
quantizer. Exact basis, allowance and carrying allocations are verified separately
against the before-holding. Output owns immutable after-holding, after-position,
before-position reference, economic allocation, signed posted reduction and its
quantization proof. The positive posted reduction minus economic carrying amount
is explicit. A zero reduction still consumes positive quantity; the planner emits
no fabricated journal/posting reference. An after-position binds its creating
movement locator, never a containing movement hash, preserving the acyclic design.

The SysML now explicitly constrains ownership artifact ordinals and committed
revisions to be positive; ordinals are one-based within their owning effect.
Revision zero contains no committed ownership artifact. Other modeled command and
source-closure obligations were not weakened to fit this planner. ACC-039.7/8/9
remain design-pending and release-blocking, with no added executable trace claim.

Eleven focused tests pass 2,599 assertions. Literal examples check written-down
8.00 across thirds as 2.67/2.66/2.67, penny reductions 0.00/0.01/0.00, free inventory,
and directed-rounding terminal quantity-only reductions. An independent integer
rounding oracle exercises unequal 1/2/2/5 reductions across all five rounding
modes, three decimal scales and four posted budgets. Rehashed adversarial inputs
exercise detached anchor references, forward origins, duplicate/foreign sources,
unsupported hash metadata, incompatible currencies/dimensions, forged cumulative
consumption, invalid economic allocations and unrepresentable budgets. Input
non-mutation, repeated-plan determinism, output ownership and the exact combined
source-count boundary are checked. The source bound was tightened during review
to count postings, incoming movements, predecessor and evidence together rather
than allowing each list a separate full allowance.

Reference review rechecked hledger `Lots.hs:2120` at
`d06affcbb692bae849b7f33eb52b2958dc39243d` (source-account lot selection and exact
fragment distribution) and Beancount `booking_full.py:605` at
`9747213802acb733ce53acc6e963f5961f47d6cd` (local balance copies and currency-aware
reduction). These support preserving source identity and non-mutation; they are
not evidence that this new cumulative monetary algorithm is already implemented
or certified by those projects.

Final `bun run check` exits 0: 279 kernel tests / 57,376 assertions,
416 ledger tests / 23,082 assertions, 100% kernel line/function coverage across
14 production sources, and the unchanged 94 executable / 8 boundary / 3 pending
partition of 105 model requirements. Licensed SysIDE 0.10.3 exits 0 with zero
diagnostics on both models and their workspace, including negative controls.
The actual kernel release entrypoint exits 1 on exactly ACC-039.7/8/9. No new
mutation score, ledger coverage percentage or capacity improvement is claimed.
Logs: `/tmp/rastrata-inventory-ownership-reduction-focused.log`,
`/tmp/rastrata-inventory-ownership-reduction-check.log`,
`/tmp/rastrata-inventory-ownership-reduction-syside.log`,
`/tmp/rastrata-inventory-ownership-reduction-release-control.log`.

SHA-256: ownership implementation
`672dbc23c36ce6e80b3f01b33f440fde6fd1f03893b56777df1ce2d5c1a2bc1f`;
focused tests `97ba58f08ba71e38025589fc996f96b5bc5e6e9c8a915add0814d06792606fe3`;
kernel model `f97b99f7384f14ddff5ff8adae63a4100e049ad9c1155ffd01636b3454a3cb63`;
manifest `01938392fa13b2d0befd5147cc1b0d76c0acdccc043578018875078181db22c5`.
The evaluator stays `a80611a013c6b50f937a123cd2e688fc92ae7e8329c68a1280e79311dbe9b2c1`.
Canonical movement assembly, complete acquisition/transfer/reanchor/adoption
admission, actual posting attribution, strict codecs, projection, command clocks,
atomic persistence and replay remain open. No commits, pushes, deployment, cloud
resources or live-book changes occurred. The full production-ledger goal remains
active; this increment does not establish production readiness.

### Canonical reduction-movement assembly and mixed posting attribution

`prepareInventoryPostedReductionGroup` now recomputes every member's reduction
and constructs hash-bound `JournalLinkedInventoryReductionMovement` or
`QuantityOnlyInventoryReductionMovement` records. It handles one complete supplied
disposal/transfer-out operation group, not a whole book command or transfer-in.
Its output is still a candidate: the evaluator, durable codecs and canonical
ownership collections do not admit these records yet. ACC-039.7/8/9 remain pending.

The assembler checks nonempty bounded populations, aggregate historical source
work, distinct local holding/anchor/allocation/movement IDs, a common posting
coordinate and the reduction planner's exact before-state equations. It sorts a
copy of members by canonical holding ID before assigning artifact ordinals; a
reversed supplied member array produces identical movement records/hashes. It
never accepts caller-computed prepared reductions as its arithmetic authority.

A money-bearing group must resolve exactly one real inventory posting in a
supplied admitted journal with matching command, book, revision, accounting date,
fiscal period and full journal hash. Its actual amount, units, historical basis,
functional/physical commodities and canonical dimension set must agree with the
complete group. Movement references are constructed from the actual posting.
Two 2.67 movements can share one 5.34 posting; neither is incorrectly required to
equal the entire posting. Source integrity checks are not proof that the journal
exists in durable storage or that its accounts/policies were authorized.

The implementation review exposed a mixed-group detail that is now explicit in
SysML and the state-access contract: a zero-money allocation still contributes its
physical quantity and historical basis to a shared inventory posting. Only
nonzero-money movements carry the posting reference. The all-zero group has no
inventory posting link, but that does not authorize omitting unrelated journal
effects elsewhere in the command. Membership must come from the complete admitted
operation, never merely account equality. The command-level owner must also
prevent separate groups from claiming the same posting; this function alone does
not prove that cross-group condition.

Seven added tests bring the focused ownership suite to 18 tests / 2,792 assertions.
The journal-link conformance tests obtain their monetary journals from actual
canonical `executeBookCommand` calls, using a chart that admits physical `ITEM`
quantities separately from USD book values. Historical ownership anchors remain
prospective fixture inputs, not a claim of authenticated/persisted ownership in
those books. Tests cover shared nonzero postings, mixed 0.00/0.01 movements,
all-zero groups, exact units/basis omitted by a tempting money-only check,
duplicate identities, source command/revision/date/period/hash mismatches,
missing/duplicated posting IDs, wrong signs/amounts/units/basis/currencies,
same-length dimension substitutions, deterministic member order, bounded aggregate
sources, and immutable output. No quantity-only BookCommand, durable outcome or
restart claim is inferred from these assembly tests.

Final `bun run check` exits 0: 286 kernel tests / 57,569 assertions;
416 ledger tests / 23,082 assertions; 100% kernel line/function coverage across
14 production sources; 105 model requirements partitioned into 94 executable
bindings, 8 boundary dispositions and 3 design-pending entries. Licensed SysIDE
0.10.3 exits 0 with zero diagnostics for both models and their workspace, including
negative controls. The actual kernel release command exits 1 on exactly the three
pending inventory requirements. No fresh mutation certification, ledger coverage
percentage or capacity improvement is claimed. Logs:
`/tmp/rastrata-inventory-movement-assembly-focused.log`,
`/tmp/rastrata-inventory-movement-assembly-check.log`,
`/tmp/rastrata-inventory-movement-assembly-syside.log`,
`/tmp/rastrata-inventory-movement-assembly-release-control.log`.

SHA-256: ownership implementation
`f8c96d1fe6602426e72495eeb5847e7c72c99b90293e804bdf775fcfd83ff3e4`;
focused tests `1e151d4813b8f1234b5aacba627d0daeeca0678b9c74ded11809c83e2bb2f2a8`;
kernel model `8b16bbf567ce5cf3d771d1122912c5385db078f9c45ac5031b889c34446b238d`.
The evaluator remains `a80611a013c6b50f937a123cd2e688fc92ae7e8329c68a1280e79311dbe9b2c1`.
No historical fixtures were regenerated, and no commits, pushes, cloud resources,
deployments or live books were changed. Source authentication, whole-effect/command
assembly, inbound/adoption/value-adjustment paths, strict codecs, projection,
atomic persistence and replay remain open. The full production goal remains active.

### Whole reduction effects, internal after-images and cross-group ownership

`prepareInventoryReductionEffect` now constructs a reduction-only
`InventoryReductionOwnershipEffect` from original touched sources and ordered
operations. The effect retains complete hashed monetary and quantity-only movement
arrays, with final holding/position projections returned separately. This producer
creates no new anchors, adopts no legacy state and is still outside `BookCommand`.
It does not create an executable committed transition or change the old evaluator.

Original holding/position/anchor inputs are supplied once per touched holding and
must predate the candidate financial revision. The constructor maintains its own
map of computed after-images. Later operations therefore consume the earlier
operation's exact remaining quantity/basis/allowance and cumulative posted position,
not a caller-supplied overlay or another copy of the original state. Artifact
ordinals are contiguous across canonical operation order, with group members sorted
by canonical holding ID. Unused original sources and missing selected sources reject.

Checks now span the whole supplied effect: local allocation/movement IDs cannot be
reused; one posting or reference identity cannot be independently claimed by two
groups; and one journal ID/effect locator must keep identical canonical journal
content and command/revision/period metadata across operations. A valid early
operation followed by failure yields only diagnostics, never a partial effect or
mutated original rows. Work bounds include initial source populations, all journal
traversals and repeated source verification, not just distinct map entries.

Seven added tests bring the focused suite to 25 tests / 2,951 assertions. Three
same-holding reductions inside one candidate effect produce 2.67/2.66/2.67 and bind
each before-position to the previous computed after-position. An independently
rounded 2.67/2.67/2.67 journal is rejected. A penny sequence retains quantity-only
ordinals 1 and 3 around the sole money movement at ordinal 2; free inventory can
produce an entirely quantity-only reduction effect. Tests cover cross-group posting
reuse that each isolated group could otherwise accept, duplicate identities,
foreign/current-revision or unused sources, missing holdings, late overdraw,
conflicting journal variants, source-order independence, meaningful operation
ordering, work limits and immutable/hash-bound output. Their money journals are
admitted by actual canonical commands; original ownership rows are still
prospective fixtures, not proof of durable source authentication.

The SysML now explicitly requires internally computed same-command after-images,
whole-effect source/identity consistency and discard of the entire candidate on
failure. Rechecked reference behavior: hledger `Lots.hs:2124` folds updated source
state through successive transfer operations; Beancount `booking_full.py:607`
copies a source balance into local working state before reducing it. These reinforce
sequential local state and non-mutation, not a claim that either reference certifies
the new Rastrata posted-budget algorithm.

Final `bun run check` exits 0: 293 kernel tests / 57,728 assertions,
416 ledger tests / 23,082 assertions, 100% kernel line/function coverage across
14 production sources, and the unchanged 94 executable / 8 boundary / 3 pending
partition of 105 model requirements. Licensed SysIDE 0.10.3 exits 0 with zero
diagnostics for both models and their workspace, including negative controls.
The actual kernel release entrypoint exits 1 on exactly ACC-039.7/8/9. No fresh
mutation score, ledger coverage percentage or capacity improvement is claimed.
Evidence: `/tmp/rastrata-inventory-reduction-effect-focused.log`,
`/tmp/rastrata-inventory-reduction-effect-check.log`,
`/tmp/rastrata-inventory-reduction-effect-syside.log`,
`/tmp/rastrata-inventory-reduction-effect-release-control.log`.

SHA-256: ownership implementation
`80e25e55f4846ef609511a2e4b96b4be3a0e6e0762d97be30a2a5f2e296c5737`;
focused tests `9bd53c54136bdac5b3dcfd2e314e726af8a599cb24cdac3000e99f768cd6102f`;
kernel model `8bf2c6bb0eefde5b2081f618bfd35f61fafcfb7d79eb47f1d5899ff3f0a376b8`.
The evaluator remains `a80611a013c6b50f937a123cd2e688fc92ae7e8329c68a1280e79311dbe9b2c1`.
Historical source authenticity/currentness, full costing selection, permanent-ID
absence, policy/period/authorization admission, other ownership transition kinds,
strict codecs, application to BookState, durable publication and replay remain
open. No existing fixture bytes, commits, remote refs, cloud resources, deployments
or live books changed. The full production-ledger goal remains active.

## Strict prospective ownership artifact transport

Added a separate `rastrata-inventory-ownership-artifact-v1` envelope for anchors,
positions, reduction movements and reduction-only effects. This shares the existing
tagged exact-value encoding rather than adding another numeric format. The complete
UTF-8 envelope is limited to 1 MiB, with the existing nesting and collection bounds.
Both encoder and decoder inspect closed schemas and full content hashes; decoding
also requires exact canonical re-encoding and returns immutable exact-value objects.
The encoder validates the copied serialized value, not a second read of caller data.

Intrinsic validation checks signs, representable posted budgets, reference ordering,
canonical dimension sets, allocation conservation, recomputed cumulative rounding
proofs, containing-movement/after-position consistency and complete internal ordinal
chains. Quantity-only records forbid posting fields. A reduction effect cannot add
anchors or reorder its stored monetary/quantity arrays inconsistently.

Six additional tests bring the focused suite to 31 tests / 3,114 assertions. Hostile
packets are constructed independently of the new encoder and re-checksummed; tests
also recompute artifact hashes to distinguish semantic checks from checksum failure.
Cases cover forged internal predecessors, unknown fields and variants, duplicate
references, future/foreign origins, negative and incoherent exact amounts, altered
rounding proofs, malformed numeric tags, duplicate JSON fields, noncanonical aliases,
excess nesting and both character and UTF-8 size limits. Source-order and complete
effect tests continue to exercise the production constructors with real admitted
money journals.

Two explicit counterexamples prevent overclaiming: a standalone position can name
an excessive consumed budget that only the real anchor disproves, and a locally
coherent effect can claim a false external predecessor. Both may pass source-free
transport inspection. Authentication, currentness, complete command membership,
costing/policy/period admission and replay cannot be established from a self-hashed
packet. Existing aggregate/outcome/row decoders reject these new envelopes; no new
BookState collections or executable command variants were enabled. ACC-039.7/8/9
remain pending. Canonical ownership persistence, other transition families,
quantity-only command integration and historical compatibility remain open.

The initial coverage run found unexecuted incoming-reference validation callbacks;
positive and hostile reference tests closed that gap. The kernel coverage gate now
reports 100% lines and functions across 14 sources. This is not branch proof, a new
mutation certification, ledger-wide coverage or a production-readiness claim.
Licensed SysIDE 0.10.3 passes both unchanged models and workspace controls with zero
diagnostics. The kernel release entrypoint still fails on exactly ACC-039.7/8/9,
before its later slow/mutation stages. Evidence logs:
`/tmp/rastrata-ownership-codec-focused.log`,
`/tmp/rastrata-ownership-coverage-gate.log`,
`/tmp/rastrata-ownership-codec-syside.log`,
`/tmp/rastrata-ownership-codec-release.log`.

The full repository `bun run check` exits 0: 299 kernel tests / 57,891 assertions,
416 ledger tests / 23,082 assertions, and the unchanged trace partition of
94 executable bindings, 8 boundary dispositions and 3 pending requirements.
Typechecking, lint/boundaries, formatting, tooling, structural model checks and
the kernel coverage gate pass. Log: `/tmp/rastrata-ownership-codec-check.log`.

SHA-256: ownership implementation
`2e89f8f872d2b6f8906c12b54d12d001a0cab7a352bb7198eac1fe0f530bff95`;
codec `c8819d133b52f229c3263a7204c74ff559cab5e0f661e51a5276784e605bba41`;
focused tests `90db346bfd193eb9caf35a73ccff5fa646bb1278df6bf2ad5da95327d0a4442b`.
The evaluator remains
`a80611a013c6b50f937a123cd2e688fc92ae7e8329c68a1280e79311dbe9b2c1`.
No historical fixture bytes, commits, remote refs, cloud resources, deployments or
live books changed. The production-ledger goal remains active.

## Pinned ownership source resolution and reduction evaluation

Implemented `InventoryOwnershipReadContext`, `resolveInventoryOwnershipSources`
and `prepareInventoryReductionEffectFromReadContext`. The resolver reads current
holding/position projections, the exact referenced anchor and the complete immutable
after-image at the position's origin. It compares hashes and complete content,
coordinates and origin metadata, exact remaining quantities, separate economic
basis/allowance/carrying balances, and cumulative posted consumption under the
anchor's retained quantizer. Depleted rows remain resolvable but cannot retain
economic balances; positive-quantity zero-cost holdings are allowed.

The effect wrapper snapshots the supplied candidate before source callbacks,
resolves each original touched holding once and invokes the existing whole-effect
constructor, which computes same-command successors internally. Distinct IDs,
operation populations and combined source-verification work are bounded. Resolved
rows are immutable and canonically ordered. Each source read and the completed
candidate are guarded against head invalidation; storage exceptions propagate
instead of becoming retained accounting rejections. Review caught a scope-change
edge on the source-rejection path: the wrapper now checks its candidate scope after
resolution regardless of disposition and again after evaluation. A regression
changes scope immediately before a missing-position result and requires an error.

Six additional tests bring the focused suite to 37 tests / 3,237 assertions.
They show that rehashed projection substitutions accepted by the standalone codec
fail against independent historical after-images; cover wrong anchor versions,
missing/foreign sources, forged origins, excessive consumption and stale economic
balances; and inject failures and invalidation at every source-read boundary and
the final candidate guard. The penny sequence still yields quantity-only ordinals
1 and 3 around its sole money movement, with the exact same complete result as the
direct constructor. Candidate mutation during callbacks cannot change that result.
The read wrapper retains the constructor's separate allocation and journal work
caps rather than introducing a smaller combined cap. A boundary control proves
one allocation plus a full-size journal population reaches source resolution,
while one extra journal entry rejects before any source I/O; it deliberately
stops on a missing position and does not claim that its repeated posting IDs form
an admissible journal.

The trusted read-contract double stores independent current rows and immutable
after-images. It is explicitly NOT a durable membership implementation. The
storage owner must prove current projections and origin effect membership at one
pinned head, including outcome-only head changes. A user-supplied implementation
of the context would supply arbitrary authority and must never be accepted at the
command boundary. These helpers neither create acquisition origins nor register
new canonical collections, authorize policy/periods, select complete costing pools,
adopt legacy state or publish a BookCommitIntent. The same-head CAS and full
historical replay remain required. ACC-039.7/8/9 therefore remain pending.

The SysML now explicitly states same-head source reads, exact historical anchor
resolution, immutable original rows, outcome-only invalidation and non-retention
of infrastructure failures. Licensed SysIDE 0.10.3 passes both models and workspace
with zero diagnostics and successful negative controls. The actual kernel release
entrypoint exits 1 on exactly ACC-039.7/8/9 before later release stages. Evidence:
`/tmp/rastrata-ownership-source-focused.log`,
`/tmp/rastrata-ownership-source-syside.log`,
`/tmp/rastrata-ownership-source-release.log`.

Final `bun run check` exits 0: 305 kernel tests / 58,014 assertions,
416 ledger tests / 23,082 assertions, 100% kernel lines and functions across
14 production sources, and the unchanged 94 executable / 8 boundary / 3 pending
trace partition. Typechecking, lint/boundaries, formatting, tooling and structural
model checks pass. Log: `/tmp/rastrata-ownership-source-final-check.log`.
No fresh mutation score, ledger-wide coverage or capacity improvement is claimed.

SHA-256: ownership implementation
`02af3befab3557884f5a963da2466dfca337caa665c940e74aadb1d634e0ef13`;
focused tests `f127c2a11b69210f8020ad469659b76ef007a9cd0e3348b2288d302561e64dd1`;
kernel model `e5045b5cb3548a2ab6b604b2b8e893be0e08ecbc3e65564ac3538e76a3de9fb8`.
The evaluator remains `a80611a013c6b50f937a123cd2e688fc92ae7e8329c68a1280e79311dbe9b2c1`.
No deployment, cloud provisioning, real-book mutation, historical fixture rewrite,
commit or push was performed. Capacity, authenticated durable ownership storage,
command integration, recovery and release-readiness work remain open.

## First inventory ownership anchors and acquisition attribution

Implemented a complete acquisition-group candidate constructor and a strict
acquisition movement variant. New lots and holdings must have matching positive
quantities, coherent separate historical basis/allowance/carrying values, one
inventory coordinate, distinct local IDs and complete evidence identities. A
money-bearing group verifies the actual admitted journal's full hash and candidate
origin/date/period, then matches one positive inventory posting's complete units,
historical basis and dimensions. It does not substitute a rounded economic balance
for that posting's actual money.

The group apportions actual posted money by cumulative exact carrying-value
weights in canonical holding-ID order. Cumulative quantized differences conserve
the entire source posting. A zero-weight member gets zero money; positive posted
money with zero total weight is rejected as ambiguous. A no-posting group requires
explicit evidence and a zero aggregate quantized carrying target. Zero total
carrying uses quantity weights to construct deterministic zero-money proofs.
This covers free inventory, rounded-zero costs and coherent fully allowed-for
acquisitions, subject to later policy/evidence admission.

Anchors are ordered before acquisition movements, each phase in holding-ID order.
Each anchor retains its own actual posted share, complete quantizer, inventory
policy reference and evidence. Its origin movement retains the common-total
allocation proof and an initial zero-consumption after-position. Zero-money
movements have no posting field, even when their anchors retain provenance from a
real shared posting. This preserves the acyclic anchor-to-position-to-movement
hash construction. The strict artifact codec checks acquisition kind, origins,
zero initial consumption, complete proof arithmetic, monetary variant and full
hashes; it rejects reduction-only fields and unsupported transition kinds.

Five tests bring the focused suite to 42 tests / 3,431 assertions. A one-cent
acquisition split across three equal exact carrying amounts yields 0.00/0.01/0.00;
resolving the resulting origin after-images and consuming all three holdings
produces one -0.01 inventory credit and no remaining quantity or carrying value.
Both money journals are actually committed in one book at revisions 2 and 3 through
the existing evaluator, with real IDs and source metadata. The ownership artifacts
are candidate data served by the read-contract double, NOT committed effects in
that book. Tests must not be read as durable ownership integration evidence.

Independent cent-coefficient answers cover unequal cumulative weights under all
five supported rounding modes, plus a zero-weight member in a money-bearing group.
Other cases cover free/rounded-zero groups, missing evidence, identity and economic
substitution, missing/forged/wrong-sign/nonrepresentable postings, changed source
metadata, resource bounds, input-order independence and immutable outputs. Hostile
transport cases recompute hashes while altering origins, consumption and proofs.
The full-check type gate caught two assertion typing errors during development;
the test expectations were corrected without weakening the gate.

SysML now explicitly models the acquisition proof, attribution rule and dependency
phases. Licensed SysIDE 0.10.3 passes both models/workspace with zero diagnostics
and successful negative controls. The actual kernel release entrypoint still exits
1 on ACC-039.7/8/9 before slow/mutation stages. Evidence logs:
`/tmp/rastrata-acquisition-focused.log`, `/tmp/rastrata-acquisition-syside.log`,
`/tmp/rastrata-acquisition-release.log`.

Final `bun run check` exits 0: 310 kernel tests / 58,208 assertions,
416 ledger tests / 23,082 assertions, 100% kernel lines/functions across 14 sources,
and the unchanged 94 executable / 8 boundary / 3 pending trace partition. Types,
lint/boundaries, formatting, tooling and structural model checks pass. Evidence:
`/tmp/rastrata-acquisition-final-check.log`. No fresh mutation score or ledger-wide
coverage percentage is claimed.

SHA-256: ownership implementation
`4d912f89eee584b752523379ed4248db5392445ed9bd9abb7150f4b4c64e81f1`;
codec `7cf92d2c9472d7c4bfde557fc7a443550b1d559ad99a6b3e7f47215bd5d275b0`;
focused tests `f37b927f52494e5df399f6eded06235e03e472315a8763f1449555b1eddd3432`;
kernel model `9337f4d38637c23397cf625154807b9912f1e2f7f1d02dc2d17ca41bf32362f2`.
Whole-command policy/capability and evidence admission, fresh permanent-ID proofs,
complete operation membership, combined transition effects, transfer-in/coalescing,
value/policy reanchoring, legacy adoption, canonical rows, durable publication and
replay remain open. No new BookCommand profile was enabled and no historical bytes,
commits, remotes, cloud resources or live books were changed. The full goal remains
active; this does not establish a production capacity or readiness claim.

## Mixed acquisition/reduction ownership candidates

Generalized whole-effect assembly into `prepareInventoryOwnershipEffect` and
`prepareInventoryOwnershipEffectFromReadContext`. Acquisition and reduction groups
now share one candidate, ordinal sequence, original/current working map and
cross-kind identity/posting/reference checks. An acquisition creates new anchors,
lots, holdings and origin positions internally; a later reduction consumes those
computed positions. Reversing the order cannot borrow future state. Original rows
must predate the revision and be used. Same-command acquisition IDs cannot overwrite
original or earlier new rows, and a failure returns no partial effect or new lots.

Resource bounds span all operations, acquisition evidence, journal traversals and
repeated anchor verification. Same-ID journals and effect locators must retain
identical source metadata across acquisition and reduction groups. New lots are
returned separately from the ownership effect and must be included with final
holdings in the same complete canonical commit; the ownership hash alone does not
commit those separate rows. Zero final inventory does not erase its intermediate
acquisition or quantity-only history.

The mixed read wrapper resolves external originals only, snapshots the candidate
before callbacks, and uses same-command creations internally. Skipping a current
row read is not proof of permanent-ID absence; complete identity admission remains
required. Review corrected a compatibility-wrapper preflight that could otherwise
return a semantic rejection before checking an expired read context. The regression
requires infrastructure invalidation to propagate even for oversized input. The
reduction-only APIs delegate to the shared engine, preserve their old effect/hash
and result shapes, and reject attempts to return acquisition effects.

Added a strict `ownershipEffect` artifact envelope using the existing versioned
transport. It verifies mixed ordinal populations, new-anchor/origin references,
same-command after-image chains, exact consumption against new anchor budgets,
matching quantizers and monetary variants. It rejects gaps, orphan/duplicate anchors,
changed origins and reordered arrays even after outer hashes are recomputed.
It does not prove external source membership, complete operation selection or
the missing canonical command admission.

Five tests bring the focused suite to 47 tests / 3,561 assertions. A real admitted
four-posting journal supplies both sides of an acquisition/depletion batch, whose
candidate retains three anchors, six movements, three new lots and three depleted
holdings. Tests cover cross-kind identity/posting reuse, inconsistent journal
sources, late overdraw, future-source use, all-zero batches, repeated partial
reductions, original/new source mixtures, exact reduction-only hash compatibility,
immutable decoded data and hostile rehashed envelopes. The mixed read tests use
the explicit trusted-contract double; neither it nor the combined journal makes
these ownership artifacts committed BookState records.

SysML now explicitly requires ordered mixed assembly, no same-command storage
stand-ins, separate permanent-ID admission and complete atomic lot/ownership
publication. Licensed SysIDE 0.10.3 passes both models/workspace with zero
diagnostics and successful negative controls. The actual release entrypoint still
fails on ACC-039.7/8/9 before slow/mutation stages. Evidence:
`/tmp/rastrata-mixed-ownership-focused.log`,
`/tmp/rastrata-mixed-ownership-syside.log`,
`/tmp/rastrata-mixed-ownership-release.log`.

Final `bun run check` exits 0: 315 kernel tests / 58,338 assertions,
416 ledger tests / 23,082 assertions, 100% kernel lines/functions across 14 sources,
and the unchanged 94 executable / 8 boundary / 3 pending trace partition. Types,
lint/boundaries, formatting, tooling and structural model checks pass. Log:
`/tmp/rastrata-mixed-ownership-final-check.log`. No fresh mutation score,
ledger-wide coverage percentage or capacity improvement is claimed.

SHA-256: ownership implementation
`e8efa3cba19f70ef7746437b7ff800af1af135f420b0b8393b2806f8d6609c6b`;
codec `712f2d5146219987d4f0892e7ca3b64e48e0df7a952ea40aafbf85e81eae9cdd`;
focused tests `0285c22ac6b20882817d848eab01e044afe160c150354f1e8c2d720ecc93c20e`;
kernel model `34bf12e2c6f0f5032c1408b0adb5b77fcdf88606d0fdde6c0ff67df1b75fb1ee`.
Incoming transfers/coalescing, adjustment/reanchoring, legacy adoption, full
policy/evidence/identity admission, canonical rows and commands, durable source
authentication, publication and replay remain open. No historical fixture bytes,
commits, remotes, cloud resources, deployments or live books changed. The full
production-ledger goal remains active.

## Canonical-pool costing selection for prospective ownership

Added `prepareInventoryOwnershipSelection` to compile exact economic allocations
from a complete canonical policy pool rather than caller-supplied allocation
amounts. It builds costing layers from matched holdings/lots, selects one dated
policy with supported method/capability metadata, validates pool artifact hashes
and matching approved derivation metadata, and requires stable allocation/movement
identities to exactly cover the computed selected holdings. It currently supports
costing algorithm 1.0.0; this does not enable a cumulative BookCommand profile.

For weighted average, quantities consume an equal fraction of each source holding,
but each allocation keeps that source's own historical basis and allowance. The
aggregate equals the calculator's ordinary basis; averaging each individual lot's
basis would detach it from its own authoritative history. Free live holdings and
depleted rows are distinguished. Ordinary and provisional quantities must sum to
the request, and provisional quantity/basis are returned explicitly for separate
admission rather than discarded or represented by a fabricated ordinary anchor.

Exposed `hashAccountingPolicy`, the exact individual hash already used inside the
accounting policy snapshot. Snapshot construction delegates to it without changing
the hash domain or payload. The selection result uses that full policy-content
reference. Existing book/evaluator semantics and codec shapes are unchanged.

Five tests bring the focused suite to 52 tests / 3,686 assertions. Independent
expected allocations cover FIFO, LIFO, HIFO, specific identification and weighted
average, including separate write-down allowance. A selected weighted-average
allocation feeds a mixed ownership candidate using one real admitted four-posting
journal: posted anchors 3.00/9.00 are consumed by 1.50/4.50 while retaining exact
remaining source basis 3/6 and allowances -1.5/-1.5. Tests also cover input-order
independence, policy/date/capability/hash substitution, conflicting lot records,
scope/economic errors, identity omissions, free/depleted rows, explicit provisional
remainders, resource bounds and unchanged policy-snapshot hash construction.

One additional verification within those tests is deliberately dependency fault
injection: a scoped spy supplies an inconsistent costing result, and the production
conservation guard must refuse it. The spy is restored in a finally block and a
subsequent real calculation must succeed. This exercises defense against a faulty
calculator; it is not presented as a real business fixture or mutation score.

The canonical pool and policy inputs remain trusted read-side data. Neither their
completeness nor approval authority is established by this function. Permanent-ID
absence, ownership source authentication, full period/policy/profile admission,
provisional effects and durable publication remain required. The combined example
commits the source journal, not the prospective ownership effect.

Reference review identified chronology as a separate admission obligation:
Beancount `loader.py:602` sorts entries before booking and `booking_full.py:161`
updates running balances in that order; hledger `Lots.hs:9` documents date-ordered
lot processing. Checked reference commits remain
`9747213802acb733ce53acc6e963f5961f47d6cd` and
`d06affcbb692bae849b7f33eb52b2958dc39243d`. These are evidence for chronological
processing, not certification of a Rastrata backdating algorithm. An append-only
ledger cannot silently rewrite original outcomes to imitate a reordered file.
Current-pool selection is not historical availability/as-of reconstruction;
backdated inventory needs explicit chronology, provisional recosting or restatement
source closure before the prospective command profile is enabled. The SysML now
states that distinction alongside source-preserving weighted-average allocation.

Licensed SysIDE 0.10.3 passes both models/workspace with zero diagnostics and
successful negative controls. The kernel release entrypoint still exits 1 on
ACC-039.7/8/9 before its later stages. Evidence:
`/tmp/rastrata-ownership-selection-focused.log`,
`/tmp/rastrata-ownership-selection-syside.log`,
`/tmp/rastrata-ownership-selection-release.log`.

Final `bun run check` exits 0: 320 kernel tests / 58,463 assertions,
416 ledger tests / 23,082 assertions, 100% kernel line/function coverage across
14 sources, and the unchanged 94 executable / 8 boundary / 3 pending trace
partition. Types, lint/boundaries, formatting, tooling and structural model checks
pass. Log: `/tmp/rastrata-ownership-selection-check.log`. No fresh mutation score,
ledger-wide coverage percentage, capacity improvement or readiness is claimed.

SHA-256: ownership implementation
`9ad2438daec079c8000ee13342b3d8990393022639a9e1364bd298358f98742b`;
accounting implementation `9287a5b4ca2f83db6ac88100cbe9054a6425e0a9788039ed145098cd9e156fb1`;
focused tests `30cd9dc20341833d04f13fa28ff976a1e5fc9e2253888dd5a109d61fedfb423e`;
kernel model `3a69c95a204afd619d16e6b40b6132d0de3942daa0abc5ae0e45f5d5ddacf32f`.
Evaluator remains `a80611a013c6b50f937a123cd2e688fc92ae7e8329c68a1280e79311dbe9b2c1`.
No historical bytes, commits, remote refs, deployments, cloud resources or live
books changed. Full canonical integration and production-ledger readiness remain
open; the goal remains active.

### Economic quantity chronology in the recovered inventory audit

The read-only posted-attribution audit now checks an additional necessary source
condition. Ordinary committed histories can have a nonnegative final quantity and
fully attributable money while an issue economically precedes its acquisition or
transfer source. The previous audit did not inspect economic quantity prefixes.
Persisted public-command probes confirmed this in both supported legacy storage
formats; admission/replay behavior itself is deliberately unchanged.

The audit derives signed quantities from recovered acquisitions and canonical
disposal/transfer allocations. It inspects events by economic instant, then
financial revision, netting each holding's changes within one journal. A negative
prefix yields `negative_economic_quantity` with the exact quantity, holding and
offending revision. Movements earlier than their lot's acquisition instant yield
`movement_precedes_lot_acquisition`. Either suppresses all usable audit balances
and movements. Decimal-share proposals cannot suppress these findings. UTC offsets
and arbitrary supplied fractional-second precision are preserved; truncating to
milliseconds would miss the reproduced 0.0001-second shortage.

An initial overbroad transfer expectation was corrected during review: a transfer
entered later but economically earlier may legitimately supply the destination.
The final tests assert that a two-unit backdated destination issue is covered by
such a transfer, while a five-unit issue before its supplies requires review.
This is not a blanket backdating prohibition. Beancount `loader.py:602` sorts
entries before booking, and hledger `Lots.hs:9` documents date-ordered processing.
Rastrata uses ordering here only for a read-only audit; it does not reorder
outcomes, recalculate historical costing or imitate a mutable-file rewrite.

Sixteen persisted chronology tests (194 assertions) cover acquisition/source/
destination shortages, legitimate backdating, equal instants, equivalent offsets,
sub-millisecond ordering, ineffective proposal overrides, restart and unchanged
encoded aggregates and heads. Focused evidence:
`/tmp/rastrata-inventory-chronology-focused.log`. Licensed SysIDE validates both
models/workspace and negative controls with zero diagnostics:
`/tmp/rastrata-inventory-chronology-syside.log`.

The release entrypoint still exits 1 on ACC-039.7/.8/.9 before later release
stages (`/tmp/rastrata-inventory-chronology-release.log`). This check is not a
costing/as-of valuation proof, automatic adoption, backdated-command implementation,
bounded indexed audit, new mutation certification or production-readiness claim.
The existing full-recovery limits and all canonical ownership integration gates
remain. No kernel implementation, historical fixture, cloud resource or live book
was changed for this increment.

SHA-256: audit implementation
`2df873209812dd5f2fd8f28f939755451ae52c3e2ddcb562526bb9913cbc0cd5`;
ledger tests `c4cc0ac9af729c94c41eaf4b63dece3a60cb5dd414b8d631c5cb0eb22e202d64`;
ledger model `63710fa666ba45608d45338adc1c3c64d27b1f3f2e99d32198858f045489b4d5`.

Final `bun run check` exits 0: 320 kernel tests / 58,463 assertions and 432 ledger
tests / 23,276 assertions, plus tooling; types, lint/boundaries, formatting,
structural model checks and the unchanged trace partition pass. Kernel coverage
remains 100% lines/functions across 14 production sources; this is not a ledger
coverage percentage. Evidence: `/tmp/rastrata-inventory-chronology-check.log`.
Final formatting and `git diff --check` also pass. The production goal remains active.

### R2 object transport implementation

The archive critical path had four executable provider-primitive tests but no
reusable runtime adapter. `R2ArchiveObjectStore` now implements bounded immutable
object storage and conditional control replacement on the actual Workers binding
API, scoped to complete book identity and `COMPACT_FORMAT_IDENTITY`. This is a
transport increment toward PL-014–PL-016, not completion of those requirements.

Immutable references bind object key, raw-byte SHA-256 and byte count. Uploads
copy input before asynchronous I/O, use create-only conditions and provider
checksum verification, then independently fetch and verify exact stored bytes.
Create-only conflicts resolve only to matching content; missing or corrupt bytes
fail without overwrite. Reads check metadata before allocation and independently
bound streamed bytes. The 1 MiB bound applies to each object, not a book's history.
Raw object digests remain separate from canonical outcome/content hash domains.

Mutable control uses a closed version/scope-bound envelope containing the exact
opaque body and fresh random storage nonce. Full expected body, nonce and ETag
are checked before conditional replacement; only one concurrent writer wins.
The nonce changes even when body bytes return to an earlier value, preventing
adapter-mediated ABA through reused content ETags. It is outside canonical kernel
content. Lost PUT responses raise `archive_write_uncertain`; a real stored object
is preserved and a conflicting later payload is not substituted. A missing
control read, immutable upload or successful control CAS is not command-commit,
manifest-membership, fence or abandonment evidence by itself.

The implementation was checked against Cloudflare's
[Workers R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [consistency contract](https://developers.cloudflare.com/r2/reference/consistency/).
Conditional PUT returning null is a conflict, not success; access uses direct
bucket bindings rather than a cache/CDN path. These provider contracts do not give
an atomic transaction with SQLite or prove recovery from loss of both stores.

Twelve tests / 85 assertions exercise native binary streams, concurrent control
CAS, full expected-body comparison, ABA, scoped references, corruption, bounds,
input snapshots and injected post-write reply loss. A bundled adapter also runs
inside workerd with native R2 streams. Two runtime replacements use a disposable
persisted local R2 store; each first performs a read before any re-upload and
matches the exact previous payload and control version. This is a clean local
runtime-replacement test, not process-kill, remote network, account-loss or
independent backup certification. The host fault harness has a documented byte
bridge because Bun cannot transfer the Miniflare RPC ReadableStream; the separate
workerd integration test bypasses that bridge. Evidence:
`/tmp/rastrata-r2-transport-focused.log`.

Typed genesis/commit manifest verification, selected-candidate SQL reservation,
catalog/anchor fencing, publication, exact SQL finalization/reconciliation and
full restore remain required. No public route, application R2 binding, bucket,
deployment, retention deletion or changed acknowledgement policy is introduced.
Key custody/encryption and independent-backup placement remain open. The default
ledger's kernel semantics, stored histories and capacity limits are unchanged.

SHA-256: adapter `a6a802b5b480c9c4bdb4d86cc24a1fec2c8fee0f4bb5417eb5a0f699e4664ba1`;
tests `a8b48a41126b0d66f55f4b98581b8238d14fcae2f0e501f6b19b4e4b80e8c4ae`;
worker fixture `e38b145587c96b2095e7ccec479f1e37d90f00a87e8f8740e62a5fa5f490bea9`;
ledger model `e4c9d6c999b54527a6872a6b5aa83f0728d5ea46906d2e4f91dda557f012be3c`.

Final `bun run check` exits 0: 440 ledger tests / 23,349 assertions, 320 kernel
tests / 58,463 assertions, tooling, types, lint/boundaries, formatting and structural
model checks. Kernel coverage remains 100% lines/functions across 14 sources;
this does not measure archive/ledger coverage. Licensed SysIDE validates both
models/workspace with zero diagnostics and passing negative controls. Evidence:
`/tmp/rastrata-r2-transport-check.log`, `/tmp/rastrata-r2-transport-syside.log`.
The release entrypoint still exits 1 at ACC-039.7/.8/.9, before later release stages
(`/tmp/rastrata-r2-transport-release.log`). No gate was bypassed, no new mutation or
capacity claim is made, and the goal remains active.

### Typed archive manifests and exact chain replay

The next recovery dependency now has an implementation: closed genesis/commit
manifest and anchor codecs, pure record preparation, and `recoverArchiveChain`.
The codec version is `rastrata-archive-record-v1`. A durability policy is hashed
and pinned through genesis and every manifest; the API does not choose the launch
policy. Bounded JSON byte counts are hashed as exact integers using the unchanged
kernel canonical encoder, not by admitting JS-number accounting amounts.

Design review found a missing link: canonical manifest hashes are not raw-byte
R2 object addresses. The SysML now gives each anchor an explicit manifest object
reference, and each commit a predecessor object reference in addition to its
predecessor's canonical hash. Both identities are verified; the predecessor
reference is included in the successor manifest hash. This permits direct chain
traversal without listing a bucket or inventing a digest-to-location mapping.
Raw payload references remain scope/format-addressed and verify exact byte counts
and SHA-256. `referenceArchivePayload` is pure locator construction, not evidence
that an object exists or was published.

Genesis preparation requires the exact zero-revision, zero-retained-outcome
aggregate. Commit preparation checks the complete prior financial/protocol head,
reexecutes the original receipt and reconstructs the exact compact outcome frame.
The candidate hash binds identity, format, policy, prior manifest locator/hash,
candidate ID, fence and complete outcome. Replayed or unretained commands cannot
manufacture a new archive outcome. `completeFinancialHead` was exported from the
existing compact framing module; its implementation and legacy hash domains did
not change.

Recovery requires an independently expected full anchor and pinned policy from
trusted owner/restore authority. It first matches exact control bytes, then walks
every manifest back to genesis with full-head, identity, format, policy, hash,
sequence and fence checks. It reads and reexecutes every original payload forward,
including rejection receipts. Missing middle objects and self-consistent but
semantically forged records fail closed. Valid uploaded candidates not linked
from the expected anchor are ignored. Historical manifest fences can be lower
than a later maintenance fence without rewriting their bytes. The returned
snapshot/control version is historical, not a current catalog or readiness proof.

Eleven record tests / 75 assertions plus twelve transport tests / 85 assertions
pass (23 / 160 combined). They cover exact committed/rejected recovery, retries
that create no new outcome, valid unpublished candidates, zero-outcome genesis,
forged rejection explanations, prior protocol/financial head substitution,
missing middle manifests/payloads, forged candidate/result/fence/chain data,
closed canonical encodings and policy/format/bound checks. A native workerd test
replaces its runtime and restores three original receipts before any new upload.
It compares the exact full aggregate bytes and literal outcome/revision counts.
These are local runtime and injected-corruption tests, not remote failure drills.
The shared `r2-fixtures.ts` only consolidates the already documented host byte
bridge; native workerd verification bypasses it. Evidence:
`/tmp/rastrata-archive-records-focused.log`.

Still open: durably selected SQL candidates, full catalog/anchor fence authority,
canonical publication, exact SQL reconciliation and public acknowledgement/restore
integration. Preparation is not selection evidence, and test fixture control
writes are not a production publication protocol. The full-history implementation
retains the existing 1,000-outcome and per-record bounds; it does not resolve large
book capacity or indexed recovery. No stronger receipt policy, deployment binding,
cloud resource, historical fixture or kernel accounting behavior was changed.

SHA-256: archive records
`0bad90315292d2c8d6a21ae1d49ddbbb9e8dae8fbeda69b6040afd50716d0f4b`;
record tests `6b3c88e3b4a6459370912cdfb23876a85668cdb72c54d2c03f04ca7d6a304f77`;
native worker fixture `44a033f429ec73f55dd174a833f15079b976edafd02d4765c57ae1e430c549ed`;
ledger model `aab336441043717441c5d9af960f605b549195d48d32bc798adc958b5f948097`.

Final `bun run check` exits 0: 451 ledger tests / 23,424 assertions, 320 kernel
tests / 58,463 assertions, tooling, types, lint/boundaries, formatting, structural
models and trace checks. Kernel coverage remains 100% lines/functions across 14
production sources; this is not ledger/archive coverage. Licensed SysIDE passes
both models/workspace with zero diagnostics and successful negative controls.
Logs: `/tmp/rastrata-archive-records-check.log` and
`/tmp/rastrata-archive-records-syside.log`. The kernel release entrypoint still exits
1 on ACC-039.7/.8/.9 before later stages
(`/tmp/rastrata-archive-records-release.log`). Final formatting and
`git diff --check` pass. Production readiness remains unproven and the goal is active.

### Durable archive candidate reservation

`SqliteArchiveSelection` implements the local reservation portion of
`SelectArchiveCandidate`, under the explicit new-book profile
`rastrata-sqlite-archive-selection-v1`. It is not a `BookStorageAdapter` or a public
receipt/read path. Existing SQL-only or indexed books cannot be silently adopted;
stranded ledger tables also prevent new-book reservation. The prototype pins an
archive-required policy internally without changing the product's launch policy.

Genesis, ownership tables and sticky canonical metadata markers are created in
one synchronous SQL transaction. Ordinary adapter loads, commits (including
same-port transaction participation) and bounded source reads reject these books.
Either ownership tables or metadata markers suffice to prevent fallback after
partial damage. The archive reader itself requires both and fails closed on
disagreement. Its internal canonical read requires an active same-port transaction
token and does not grant permission to publish an outcome.

Selection verifies the complete expected R2 predecessor chain and full local
receipt history using the existing replay/frame functions. Inside the reservation
transaction it compares full heads and exact recovered aggregates, stores bounded
outcome chunks, the immutable commit manifest, exact predecessor manifest, full
expected anchor and observed ETag/nonce, and binds that envelope with an independent
reservation hash in both owner and canonical metadata. The original candidate
hash alone does not bind the transport nonce. The SysML now makes those storage
commitments explicit. No canonical outcome, balance, financial head or R2 anchor
advances during reservation; no selected payload is uploaded by this component.

Selection returns only after `storage.sync()`. An uncertain response preserves
the exact reservation. Restart verifies original receipt bytes, not a replacement
command at another head. Identical retries return the same reservation even if R2
is then unavailable; different candidates cannot replace it. There is deliberately
no clear/abandon operation before a complete publication/reconciliation protocol.
The returned reservation is not proof that its observed external anchor remains
current. Future publication must conditionally compare that exact control version
and enforce catalog/fence authority. Local redundant markers are corruption checks,
not independent evidence against a coherent rollback of the entire database.

The byte audit found and fixed a decoding defect in the shared SQLite reader:
default UTF-8 decoding silently strips a leading BOM. Both canonical and reservation
readers now preserve it so exact-byte/codec checks reject the changed content.
Three negative-control tests fail when BOM stripping is temporarily restored,
including both unchanged legacy snapshot and compact storage formats, even with
recomputed physical chunk checksums. All three pass with the fix. No historical
fixture, financial hash domain or accounting calculation changed. Evidence:
`/tmp/rastrata-archive-selection-bom-negative.log` (expected exit 1, three failures).

Focused evidence: 33 tests / 188 assertions, exit 0 in
`/tmp/rastrata-archive-selection-focused.log`. Coverage includes committed and
retained-rejected reservations, exact retries and competing owners, initial and
selection transaction rollback, lost durability responses, mismatched genesis,
missing R2 predecessor objects, ordinary-owner bypass attempts, damaged markers,
altered/missing payloads, and an exact 903,360-byte receipt split into four chunks.
A native workerd test persists both SQLite Durable Objects and R2, replaces the
runtime and recovers committed/rejected reservations before any new upload. It
verifies unchanged canonical heads, zero published SQL outcomes, the exact prior
R2 control version and ordinary-owner refusal. These are local tests and clean
runtime replacement, not process-kill-at-selection or remote outage certification.

Still open: production catalog initialization/activation, authoritative fences,
archive publication, uncertain-CAS reconciliation, exact same-transaction SQL
materialization and reservation clearing, public receipt/read integration, and
hard-kill/live failure drills. PL-014/015 and production readiness are not closed
by local reservation. The existing 1,000-outcome and record/aggregate bounds and
full-history verification remain unchanged; scalable indexed evaluation/recovery
and the three pending inventory ownership requirements remain separate open work.

SHA-256: reservation source
`1bdac0f1d04865320baf3b8cfc85243732db48eed92fb754ee3627454baaf8aa`;
shared SQLite adapter
`548b827e4ad02729c44161b692b8ec1f2a3bcbeca8e07d0df963dbd4b48f9255`;
reservation tests
`fda9de435fdb733297c0a16b4ed1e013cb35045311fd9ac8ace794c5a71e24ae`;
native worker fixture
`0109dcec232d4ff8f1c6f9c105738ca38641d9227a45c6a811d251c574376365`;
ledger model
`d15106ad3c764222b765bfd4bb69fb6433a4d23293952339436eb5d4d4bf6061`.

Final `bun run check` exits 0: 484 ledger tests / 23,612 assertions, 320 kernel
tests / 58,463 assertions, tooling, types, lint/boundaries, formatting, structural
model and trace checks. Kernel coverage remains 100% lines/functions across 14
production sources; no ledger coverage or readiness claim follows from that.
Licensed SysIDE passes both models/workspace with zero diagnostics and successful
negative controls. Logs: `/tmp/rastrata-archive-selection-check.log` and
`/tmp/rastrata-archive-selection-syside.log`. Kernel `check:release` still exits 1
on exactly ACC-039.7/.8/.9 before later stages
(`/tmp/rastrata-archive-selection-release.log`). No cloud resources, deployment
bindings, launch durability promise, historical fixture or accounting calculation
changed. Production readiness remains unproven and the goal remains active.

### Canonical archive publication and exact SQL materialization

`SqliteArchiveSelection.publishPending` and `reconcilePublished` now implement the
normal selected-candidate publication/materialization path. They remain internal
components, not a public ledger, receipt API or service-readiness decision.

The new `ArchiveCatalogAuthority` is a trusted control-plane read dependency outside
the book restore set, not an implementation of that service. Its closed entry binds
version, complete identity, full format, pinned durability policy, original genesis,
status and canonical fence counter. Unknown fields, accessors, identity/profile
substitution and invalid counters fail closed. The SysML now includes these full
catalog bindings. Pre-evaluation actor/command admission and the actual external
catalog service still need application/control-plane integration; a request must
never supply an authority object or an adapter that echoes caller assertions.

Publication fully verifies the prior archive, creates/verifies the immutable
payload and commit manifest, rechecks active catalog admission after uploads, and
conditionally replaces the exact reserved prior control body/ETag/nonce. It then
reads back and replays the complete canonical chain. Lost PUT responses retain the
selection; retries may only recover/publish that same candidate. Payload existence
or matching financial heads without the exact selected manifest never suffices.
SQL state remains at the prior head until materialization.

The external maintenance race has both legal outcomes. If anchor rotation wins,
the old conditional publisher loses and its reservation stays pending. If an
already-admitted publisher wins first, maintenance retains its resulting head and
may reconcile it at the newer matching catalog/anchor fence. The historical commit
manifest retains its original fence. Partial catalog/anchor rotation blocks
reconciliation; these methods do not rotate or release maintenance themselves.

Reconciliation independently verifies exact canonical membership, full receipt
replay and matching catalog/anchor generations. One SQL transaction writes the
original outcome/chunks, advances the complete head, retains the last selected
envelope and clears the pending envelope/chunks/marker. Only then does it confirm
durability. Lost sync responses recover as already materialized without another
SQL write. Concurrent reconcilers append once, and a delayed reconciler cannot
clear the next selection. Subsequent selection also binds the locally retained
last manifest to the archive predecessor, not merely its financial heads.

The experimental owner schema now requires last-materialization columns; an older
incomplete physical schema fails closed, with no implicit migration. Canonical
ledger/archive formats and historical bytes are unchanged. Last-envelope evidence
serves normal local restart recovery, not full archive bootstrap: historical
transport ETags/nonces are deliberately absent from canonical manifests. The
SysML requires full restore to create fresh local restore evidence under an
external permit, never fabricate those old transport values. That controlled
restore implementation remains open.

Focused tests: 71 / 501 assertions, exit 0 in
`/tmp/rastrata-archive-publication-focused.log`. They include four exact outcome
cycles (Oseq 4/book revision 3), committed/rejected receipts, response loss before
and after payload/manifest/control PUTs, SQL rollback at six materialization
boundaries, lost final sync, both maintenance races, partial rotation, stale and
concurrent reconcilers, damaged last evidence, missing canonical bytes, invalid
catalog snapshots and a different candidate with identical financial heads.
Native workerd tests replace runtimes between reservation, publication,
materialization and idempotent restart recovery using actual local SQLite/R2.
Their catalog is an explicit synthetic authority fixture. These are not deployed
catalog, process-kill-at-publication, remote outage or full archive restore proofs.

Final `bun run check` exits 0: 522 ledger tests / 23,925 assertions and 320 kernel
tests / 58,463 assertions, plus tooling, types, lint/boundaries, formatting, model
and trace checks (`/tmp/rastrata-archive-publication-check.log`). Kernel-only coverage
remains 100% lines/functions across 14 sources. Licensed SysIDE passes both models
and workspace with zero diagnostics and successful negative controls
(`/tmp/rastrata-archive-publication-syside.log`). Release still exits 1 on exactly
ACC-039.7/.8/.9 before later stages (`/tmp/rastrata-archive-publication-release.log`).

SHA-256: selection/publication source
`20b9db57ad80c9a46a6be22a06285261cefe301ed18908bac386d14635cb9dfe`;
authority source `ddd9b330a082c5a364f4abfce17d7f6d84f010a3e77d986da42e3c7e7c89ff9c`;
tests `57bcd5bda3536c5589d7769c3fe0c9016e5de4723d1c3db35e9be5a40215b4e8`;
native fixture `e8fa04f5fb3d6aa39734c0f1b2e1fafd8095d8ff474910bf764ca6f2c0cd1365`;
ledger model `3c7ce08782f2eac7ca850dd9dfdafbba495664befeb509bdc9a13ec24c8d3ff5`.

Still open: external catalog/maintenance/restore implementation, public admission,
read/receipt integration, hard-kill and approved remote drills, scalable indexed
execution/recovery, workload/SLO acceptance and the pending inventory ownership
requirements. The existing 1,000-outcome and record/aggregate limits remain. No
cloud resources, deployment bindings, launch policy, accounting calculations or
historical fixtures changed. Production readiness is unproven; the goal stays active.

### Separate durable catalog and coordinated maintenance fencing

`SqliteArchiveCatalog` now implements the catalog authority port using a separate
SQLite-backed object per book. It rejects the book's object ID and co-located
ledger tables; the ordinary book adapter also refuses catalog storage. The current
record pins complete identity, original genesis, format and durability policy,
catalog revision, lifecycle/fence, sealed archive observation and last mutation.
Closed bounded decoding verifies its exact canonical encoding and content hash.
Missing/damaged existing rows do not become new-book allocation or automatic repair.
Privileged allocation can repeat the same genesis without resetting actual status.

This is mutable control-plane authority, not a second accounting outcome journal.
Mutation identity is `(expected full catalog hash, operation ID)`. Full-record CAS
advances the catalog revision; only an immediate identical retry returns the
retained current result. A reused operation with another intent fails, and obsolete
expected revisions cannot run again after subsequent mutations. SQL return alone
does not confirm durability. The record stays applied after a lost sync response.
After 500 superseding maintenance operations, reads still use two bounded SQL
queries and one current record; this is not a financial capacity/latency benchmark.

Activation independently recovers the actual R2 genesis and asks the other book
object to verify its durable SQL state at the same full head/control version.
`verifyArchiveHead` rejects unresolved selections, replays complete SQL and R2
history, compares exact aggregates and manifest identity, confirms durability and
rechecks the observed control. Evidence comes from this trusted reader, not an
echoed head or readiness Boolean. Archive recovery now returns its already-verified
original genesis manifest so catalog identity checks do not invent a root digest.

Maintenance first durably advances the catalog fence and clears its sealed cutoff.
Sealing fully verifies the archive and conditionally advances only its fence. If an
already-admitted publisher wins first, the bounded retry follows and retains that
canonical head. A newer archive fence is never lowered. An uncertain R2 response or
failed catalog CAS leaves resumable maintenance, not an active book. Only readback
of the matching generation can be sealed in the same expected catalog revision.
Finish requires the sealed control version, real book verification without pending
selection, and a successful CAS of that exact catalog revision. A newer maintenance
request defeats an older finish even after book verification completed.

The SysML now models typed catalog control snapshots/mutation kinds, book-head
evidence and allocation/activation/begin/seal/finish actions. Licensed validation
caught a reserved-word field name in the first draft; it was corrected to
`catalogEntry` and both models/workspace were revalidated with zero diagnostics.

Focused evidence: 23 tests / 141 assertions, exit 0
(`/tmp/rastrata-archive-catalog-focused.log`). Tests cover actual publication through
the durable catalog, catalog survival after disposable book-data loss, pending
selection gating, an admitted publisher winning during fence replacement, concurrent
CAS, stale release after verification, uncertain SQL/R2 responses, bounded conflicts,
archive-ahead rejection, constant catalog read work and malformed/missing records.
Native workerd runs the catalog and book in DIFFERENT SQLite Durable Objects with
real cross-object reads and R2, replacing runtimes between maintenance, sealing,
reconciliation and finish. Genesis object creation remains explicit synthetic
fixture setup; this is not a deployed privileged provisioning endpoint or a remote
failure drill. Separate objects do not establish separate-account disaster recovery
or protection against compromise/rollback of the entire control plane.

Final `bun run check` exits 0: 545 ledger tests / 24,066 assertions, 320 kernel
tests / 58,463 assertions, tooling, types, lint/boundaries, formatting, model and
trace checks (`/tmp/rastrata-archive-catalog-final-check.log`). Kernel-only coverage
remains 100% lines/functions across 14 sources. Licensed SysIDE passes both models
and workspace with successful negative controls
(`/tmp/rastrata-archive-catalog-syside.log`); the ledger structural gate also passes
18 tooling tests (`/tmp/rastrata-archive-catalog-spec.log`). Release still exits 1 on
ACC-039.7/.8/.9 before later stages (`/tmp/rastrata-archive-catalog-release.log`).

SHA-256: catalog source
`951bed3d8cd68b6efc0827665a46bbe21bb46af03e4e59a5b216ca633fe7b5a4`;
authority contracts `850e6aa35d63dd072c128fbe7c5f7de6b3da88b15e25327069a59b7c524d24d5`;
book owner `339f49eecf65e4168c6b827dd0e291567e51dce62e8d30bb8810535cbab53a54`;
archive replay `efd76b1677e70effb451152c26593417599d73f3c0324fbefc61dfcb48830a1c`;
catalog tests `5256a8c049e7e83011b641e59984dc1394624e314b378e7618641934cc33e085`;
native fixture `a0c5af9026bffbf4bfddafc4e239648e54d665bf945546a03d492a8eb2b9dcb9`;
ledger model `8167f34d8cb4001ec3c174b24a6f200a360deaaf8f625e6e3e9a3c8eee52cbdf`.

Still open: safe abandonment of an unpublished candidate after its publisher is
excluded, durable restore permits/full archive bootstrap, privileged production
routing and command admission, public readiness/receipt integration, hard-kill and
approved remote drills, scalable indexed execution/recovery, workload/SLO acceptance
and the pending inventory ownership requirements. The 1,000-outcome and existing
record/aggregate bounds are unchanged. No cloud resource, deployment binding,
launch policy, accounting calculation or historical fixture changed. Production
readiness remains unproven and the goal stays active.

### Fenced unpublished-selection abandonment

`SqliteArchiveSelection.abandonUnpublished` now completes the unpublished recovery
branch. It reads the actual separate catalog through a configured reader, validates
the closed complete snapshot and expected revision hash, and requires maintenance
with a durably sealed strictly newer fence. The sealed full prior head and manifest
must match the selection exactly. Complete R2 replay, control body/ETag/nonce and
the final catalog recheck precede the local exact-selection CAS. A canonical member
cannot use this branch: it must materialize its original outcome.

The local transaction retains a separate bounded, hash-verified abandonment receipt
and clears only that selection, its chunks and selection marker. It changes no
financial/protocol head, retained outcome or Oseq. The latest receipt survives lost
durability responses, restarts and later selection/materialization. Exact retries
report historical completion; older superseded requests fail closed. They are not
public absence/readiness evidence. Maintenance is not released by this operation.
Cross-object observations are not an atomic transaction; exclusion of the old
publisher rests on the newer R2 fence, even after maintenance is later released.
The unreleased experimental owner schema adds receipt columns; incomplete older
schemas fail closed, without an implicit migration or canonical format change.

Focused tests pass: 117 tests / 782 assertions across catalog and selection suites
(`/tmp/rastrata-archive-abandonment-focused.log`). Coverage includes a real admitted
publisher delayed until after abandonment/reopening, published-member refusal,
strict fence boundaries, stale/forged/unsealed authority, changed control, missing
manifest, concurrent/late recovery, three SQL rollback points, lost sync response,
damaged receipt, nonzero heads and actual separate workerd SQLite objects/R2 across
runtime replacements. Initial test-harness issues were corrected: the parked
publisher uses an explicit promise handler, and object deletion uses the actual
`objectKey` with pre/post existence assertions. No production behavior was weakened.

Two individually executed negative controls fail as intended: weakening `>` to
`>=` admits a same-fence abandonment, and omitting the final catalog reread admits
a superseded revision. The tests catch both; the exact source hash was restored
after each (`/tmp/rastrata-archive-abandonment-negative-fence.log` and
`/tmp/rastrata-archive-abandonment-negative-catalog.log`). These are not a full
mutation score or a production crash drill.

`bun run check` exits 0: 568 ledger tests / 24,206 assertions; 320 kernel tests /
58,463 assertions; tooling, types, lint/boundaries, formatting, model and trace gates
(`/tmp/rastrata-archive-abandonment-check.log`). Kernel-only coverage remains 100%
lines/functions across 14 sources, not ledger coverage. Licensed SysIDE passes both
models/workspace and negative controls (`/tmp/rastrata-archive-abandonment-syside.log`).
Release still exits 1 on ACC-039.7/.8/.9 before later stages
(`/tmp/rastrata-archive-abandonment-release.log`).

SHA-256: catalog `b20f93082cc51f78d04da9ea9b9f9603e1fb72041378854c18c848781820b56b`;
selection owner `156e0df4a432fecea3815b5742afec1b2c7a3f54dc22774e739a5f620f544b5f`;
catalog tests `f38c31d65153aa94d5c517389343e83a5f7e93c4612c33de7a0d99dc1347e8f3`;
native fixture `37ff9209c89145ae4a6a03b393bba4ebeecc8e5e49cc847121b3e93feb9ed329`;
ledger model `9c2d6be502cd79db888633943d3437c48f4c65f18b7b7539b975e883a0e36bd0`.

Still open: permit-based full restore/bootstrap, privileged production admission,
public reads/receipts, hard-kill and approved remote drills, scalable execution and
recovery, workload/SLO acceptance, and pending inventory ownership requirements.
The 1,000-outcome and record/aggregate bounds remain unchanged. No cloud resources,
deployment bindings, accounting calculations or historical fixtures changed.

### Durable restore authorization and exact reconstruction input

The catalog now persists `ArchiveRestorePermit` by full-record CAS after sealed
maintenance and full R2 verification/readback. The closed hash-bound permit records
complete identity/genesis/profile, full anchor and control version, authorizing
catalog revision/hash, operation ID and approver provenance. Its backup source is
the canonical cutoff manifest hash. Provenance is not authentication: a privileged
caller still must authorize the approver. Lost responses retain one exact permit;
retry cannot silently change approver or intent.

Superseding maintenance preserves an outstanding restore obligation. Its old permit
cannot authorize work at the newer fence; explicit reauthorization after sealing
must replace it. Finish additionally requires actual book evidence identifying
durable installation under the exact current permit. A matching financial head or
prepared image alone cannot reopen the book. No positive installation/finish claim
is made yet: the current book owner deliberately supplies no fabricated restore
evidence. A completed permit will remain historical until a new maintenance cycle.

`prepareArchiveRestoreImage` reads actual external authority, replays the complete
canonical chain and retains exact original genesis/outcome/frame bytes and heads,
including retained rejections. It checks the independent genesis, full control and
catalog again. The ordinary archive read path does not retain this extra copy of
history. This is read-only materialization input, not overwrite authority. No
historical publisher ETag/nonce is reconstructed. Tests compare all reconstructed
records with independently persisted SQL records, then remove the five disposable
book tables and reconstruct the identical four-outcome image from catalog/R2 alone.
The database remains empty and maintenance remains closed.

Evidence: 148 focused tests / 978 assertions, exit 0
(`/tmp/rastrata-restore-permit-final-focused.log`), including real separate workerd
catalog/book objects and R2 across runtime replacement. Tests cover conflicting
approvers, SQL rollback/lost sync, stale/unsealed/forged permits, newer-fence
reauthorization, control/catalog races, missing payload, nested permit corruption
with a recomputed outer hash, and approver coercion refusal. Two individually run
negative controls fail as intended: skipping permit-bound release verification and
dropping the restore obligation during maintenance. Exact source was restored
(`/tmp/rastrata-restore-permit-negative-release.log`,
`/tmp/rastrata-restore-permit-negative-obligation.log`). These are not a mutation score.

Final `bun run check` exits 0: 588 ledger tests / 24,327 assertions; 320 kernel tests /
58,463 assertions; tooling, types, lint/boundaries, formatting, model/trace gates
(`/tmp/rastrata-restore-permit-final-check.log`). Kernel-only coverage is 100%
lines/functions across 14 sources, not ledger coverage. Licensed SysIDE validates
both models/workspace and negative controls (`/tmp/rastrata-restore-permit-syside.log`).
Release still exits 1 on ACC-039.7/.8/.9 before later stages
(`/tmp/rastrata-restore-permit-release.log`).

SHA-256: catalog `16b50e2941dba91c704dbeda621a654308086d953461b91af1c60c3922de0450`;
permit codec `96d3271099f8e77bc10077abe758a2c050f80f360821d510d0bc427a9b392935`;
restore preparation `9a0dc86d9f521860221ee9a87e0ebea9a56e35c0b21d80c19006d1d3ccf5ff8f`;
archive replay `872d2496b7e8b0701bb6aff34e6f2c42a12af230a61db1c2126acb09f7b70c45`;
catalog tests `f3617b7f3c9ee67521c207b488a1be97541433bde6e811783f9985889183f4f2`;
native fixture `bc59dbd2d60751bcb1d06b270789d6f55cf4c9073c5986b10de0d607600dd6d0`;
ledger model `9ae729eabe041de62f59044c011ac83e6d7708869fccca28dfa40afa0fab7cee`.

Next: permit-governed atomic installation, late-installer exclusion, durable local
restore evidence and retry/restart recovery without invented historical transport
metadata. Full restore is NOT complete. Public admission/read/receipt integration,
scaling, hard-kill/approved remote recovery drills, workload acceptance and pending
inventory requirements remain open. The existing capacity bounds and accounting
history are unchanged. No cloud resources or production book data were changed.

### Atomic permit-bound restore installation and late-installer exclusion

`restoreFromArchive` now reads actual catalog authority, durably selects a local
restore reservation, reconstructs exact archive history and atomically installs it.
The reservation is preserved outside the five replaced canonical tables. Its
full-record CAS excludes older work; newer reservations require a strictly newer
authorized fence. Exact installed retries are historical and read-only, including
after subsequent postings. Installation does not release catalog maintenance.

Installed state retains the original cutoff manifest and predecessor, not invented
publisher ETags/nonces. Full local history replay reconstructs and verifies the
cutoff candidate; a matching metadata hash makes loss of the restore-state table
detectable even at genesis. Actual book verification now returns this persisted
permit hash, enabling separate catalog finish. A selected/corrupt reservation
blocks ordinary owner paths and cannot become a fresh SQL-only book. Lost sync
responses resume selected or installed work without adding financial outcomes.

Absent books and damaged canonical financial records are replaceable in place.
Unverified/foreign identity, unknown ledger tables and intact newer heads are
quarantined. Audit found that a table-name allowlist alone did not bound destructive
effects: dropping an owned table could cascade into unrelated data. Preflight now
also rejects incoming external foreign keys and custom triggers on owned tables,
both before selection and inside installation. Exact allowed table names are the
only DROP targets. Rollback restores the original tables and leaves the durable
selected reservation for retry. No deployed book or cloud resource was touched.

Focused evidence: 179 tests / 1,192 assertions, exit 0
(`/tmp/rastrata-restore-install-final-focused.log`). Tests cover absent/damaged/
unchanged books, exact committed/rejected history, five installation rollback
points, lost selection/installation durability responses, late reservation and
installation after same/newer-permit completion plus subsequent posting, missing/
corrupt restore state, sticky metadata proof at genesis/nonzero heads, and scope/
dependency/rollback refusal. Actual separate workerd catalog/book objects and R2
exercise install, runtime replacement, exact retry, verified finish and later
publication. These are local runtime replacements and injected SQL faults, not
restore-specific SIGKILL, remote power-loss or account-loss certification.

Two targeted negative controls failed as intended: permitting a newer local head
and disabling the inbound-cascade guard let disallowed restores resolve. The exact
source hash was restored and the final focused/root suites rerun
(`/tmp/rastrata-restore-install-negative-head.log`,
`/tmp/rastrata-restore-install-negative-cascade.log`). This is not a mutation score.

Final `bun run check` exits 0: 619 ledger tests / 24,541 assertions; 320 kernel tests /
58,463 assertions; tooling, types, lint/boundaries, formatting and model/trace gates
(`/tmp/rastrata-restore-install-final-check.log`). Kernel-only coverage remains 100%
lines/functions across 14 sources, not ledger coverage. Licensed SysIDE passes
both models/workspace and negative controls (`/tmp/rastrata-restore-install-syside.log`).
Release still exits 1 on ACC-039.7/.8/.9 before later stages
(`/tmp/rastrata-restore-install-release.log`).

SHA-256: owner `da78627d20c408873586732d03d57051f0f7ec13e25ee87f014edb12a3c419a9`;
restore state `36139903b943b57772b6a96c627363517c8bc099aef207269ac0a326d6f2b20e`;
archive replay `1dbead265758979e5a4c75fff028e18ab7c575b55ce0a3fad179425d093efed7`;
shared SQLite `ad3c0b315b4e3ab30723c1af324f28c99e7596be5dd975858be68de3a8015883`;
catalog tests `5ffc42bcbf1dc8d785ecafaafbfad5610f4e3138f0e07deaae2816f762b945c6`;
native fixture `5d58bffc14eff50f6b456c711ae0454ba33fad2a164b39fff2a1557b11680f02`;
ledger model `9656a513ccc7feb5d11349877236fc5e08899ef8c5305e3ffa716d54494d5e15`.

Next: restore-specific process interruption and recovery drills, then remaining
production admission/read/receipt integration and scalable execution/recovery.
Provider rollback still requires external fencing, abort/drain and coordination;
unverified identity/control evidence remains quarantined. Existing capacity bounds,
workload/SLO acceptance, remote backup/security verification and pending inventory
requirements remain open. No accounting calculations or historical fixtures changed.

### Restore-specific process interruption evidence

`test/restore-crash.test.ts` adds 19 actual SIGKILL runs over absent/damaged books:
selection before/after commit, table removal, schema creation, partial genesis and
multi-chunk outcome installation, retained-rejection header, installed marker
before commit, installation after commit and lost response. The worker reports
actual SQL row/table counts at the reached boundary before killing itself. The
parent separately checks the terminating signal and rejects watchdog timeouts.
Reopening verifies SQLite integrity and exact old canonical contents before commit,
or the complete original stored book after commit. A fresh process retries the same
permit, preserves all original committed/rejected records and does not release
maintenance. Only separate verified catalog finish reopens the book; another fresh
retry remains historical and read-only.

The independent local catalog and Miniflare R2 service survive outside the killed
process. The child has a read-only catalog connection, a scoped GET-only loopback
archive bridge, no inherited credentials and disabled automatic environment-file
loading. Tests use disposable synthetic files only. Additional cases remove an
exact local archive payload after interruption (retry refuses partial completion)
and reject unsafe worker arguments/symlink targets before SQLite opens.

Focused suite: 21 tests / 591 assertions, exit 0
(`/tmp/rastrata-restore-crash-focused.log`). A targeted negative control replaced
SIGKILL with an ordinary exception; the test correctly failed on the missing signal
(`/tmp/rastrata-restore-crash-negative-signal.log`). The worker was restored before
the full repository run. This is harness validation, not a mutation score.

These tests use local SQLite WAL with synchronous=FULL. They do not emulate or
certify Cloudflare replication/storage.sync, disk power loss, account loss,
production-scale recovery or public ingress. L14 remains not closed; its model
documentation now explicitly distinguishes process-kill evidence from those wider
obligations. Production implementation and historical accounting bytes are unchanged.

SHA-256: fixture `86e5bb9026bf64d758b721ab8144849be87140633279602191cf21ed25b01672`;
worker `f7bea49ab9e1197762f423c6f9c36fe46c8cd3b1234adf3e0ffb323394c95b50`;
tests `02c055fa931bc4ef31c55efe82dd27178294c98e8d1b211030d80c17150c6fc4`;
ledger model `946631dadcb8751301ac1dbad309241ab832cc734018bacf8436ab3742780a8f`.

Final `bun run check` exits 0: 640 ledger tests / 25,132 assertions; 320 kernel
tests / 58,463 assertions; types, lint/boundaries, formatting, tooling and model/
trace gates (`/tmp/rastrata-restore-crash-check.log`). Kernel-only coverage is 100%
lines/functions across 14 sources; this is not ledger coverage. Licensed SysIDE
passes both models/workspace and negative controls
(`/tmp/rastrata-restore-crash-syside.log`). Kernel release exits 1 on ACC-039.7/.8/.9
before its later stages (`/tmp/rastrata-restore-crash-release.log`). No release
closure or production-readiness claim follows. Next work remains public production
admission/read/receipt integration, scalable execution and recovery, pending
inventory enforcement, workload acceptance and approved remote recovery/security
verification.

### Book-scoped archive command and financial-read coordination

`ArchiveLedger` now joins active catalog admission, pending-candidate recovery,
kernel evaluation, canonical archive publication, local materialization and receipt
verification. Constructor-bound dependencies are trusted infrastructure; no network
decoder, caller authorization or deployed route is implied. Inputs are captured
before queueing. New outcomes and exact retries return verified original results
and Oseq; identity conflicts/unretained rejections add nothing. Financial snapshots
and receipts carry the verified manifest at their full head and archive-required
policy. A no-write result must retain its evaluated full head. Every returned
snapshot is immutable; complete SQL/archive replay and active catalog rechecks
remain mandatory. Full-history costs and capacity limits are unchanged.

The coordinator refuses maintenance before resuming pending work. Explicit
control-plane reconciliation can still materialize an already-published candidate
during maintenance; command entry cannot substitute for it. A negative control
allowing maintenance admission correctly failed on unexpected SQL writes
(`/tmp/rastrata-archive-coordinator-negative-admission.log`); the guard was restored.
This is one targeted control, not a new mutation score. Initial tests also found and
fixed ordinary JSON comparison of exact-integer receipts; comparison now uses the
kernel's complete canonical value/hash representation.

Tests compare all receipt fields against the existing compact SQL ledger for
commits, retained rejections, old retries, conflicting identities and reusable
unretained identities. They cover selected/published/materialized recovery, lost
selection sync, upload failure, lost successful control response, lost
materialization sync, catalog changes during verification, withheld receipts during
maintenance, missing original payloads, input capture and concurrent owners. Native
workerd tests now call the coordinator through actual separate catalog/book objects
and R2 after restoration, subsequent posting and runtime replacement, including a
retained rejection and exact retry. These are local provider-runtime tests, not
remote power-loss, account-loss or production-scale certification.

Final `bun run check` exits 0: 655 ledger tests / 25,325 assertions; 320 kernel
tests / 58,463 assertions; types, lint/boundaries, formatting, tooling and model/
trace gates (`/tmp/rastrata-archive-coordinator-final-check.log`). The final
concurrent-owner case also passes five repetitions / 65 assertions
(`/tmp/rastrata-archive-coordinator-concurrency-repeat.log`). Licensed SysIDE passes
both models/workspace and negative controls
(`/tmp/rastrata-archive-coordinator-syside.log`); the bounded model checker and its
18 tests pass (`/tmp/rastrata-archive-coordinator-spec.log`). Kernel-only coverage
remains 100% lines/functions across 14 sources, not ledger coverage. Kernel release
still exits 1 on ACC-039.7/.8/.9 before later stages
(`/tmp/rastrata-archive-coordinator-release.log`).

SHA-256: coordinator `30a94845f6351ccb576b7ef13e1f391394d96baf68641aa939dce85dc69d739c`;
owner `ad1debc22ef8679b79cbfb9930fbc603367dee55f215d108d4b22a78942d1892`;
tests `9f463a18c936a4e17eb5e63cb5c45c2d64c9ab43aa09dc6b8bcb0499685cd203`;
native fixture `b4c91899dd573b55fe3b546c30c59157c544743d8afd684c6df1788c60271cc0`;
ledger model `ca6aac31411db46c1f17a01b560ff5ea2daa0312cb33e14d79d79c6cceb6ef27`.

Next remains scalable command execution/recovery (the 1,000-outcome/full-history
limit is unchanged), pending inventory enforcement, authenticated application
entry and approved workload/remote recovery/security evidence. No accounting
mathematics, old outcome bytes or historical fixtures were changed. No cloud
resources or production books were provisioned, deployed or altered.

### Shared immutable commit records for incremental publication

Capacity inspection confirms that the existing state commitment still hashes
historical collections and that startup still requires full replay. No limit was
raised and no partial state was rehashed to masquerade as a complete book. The
owner decision on checkpoint-based startup versus complete historical-payload
verification is pending; current recovery obligations remain unchanged.

`prepareBookCommitRecords` separates revision/retained-result/response construction
from whole-state effect application. It consumes the admitted intent and a same-book
financial predecessor (revision plus complete chain hash), not a historical state
or protocol array. It checks context and command/intent content, uses the existing
canonical command ownership procedure, and preserves all original record/hash
preimages. The canonical `commitBookIntent` now uses it after unchanged authoritative
reevaluation/topology checks and still applies the complete state atomically. A
correctly hashed but economically inadmissible intent can produce mathematical
record candidates, but the canonical commit rejects it without state/protocol
mutation. The constructor is not a new admission or publication API. Its work still
depends on command/effect size; legacy lot-state effects remain whole-population.

Four direct tests / 41 assertions preserve fixed activation/posting record and
state hashes captured from the engine before extraction, distinguish a retained
rejection from the financial predecessor, reject incomplete/foreign/hash-conflicting
context, and prove copied ownership and unchanged forged-intent refusal
(`/tmp/rastrata-commit-record-context-focused.log`). The indexed-reader conformance
case uses actual pinned source-backed predecessor rows at Oseq 2 and 18 (financial
revision 2 in both), constructs identical next records without more SQL reads,
and publishes nothing (`/tmp/rastrata-commit-record-context-indexed.log`). Full
command admission remains the materialized oracle in that case, not an indexed
evaluator. A build-valid negative control dropping the predecessor hash failed
three fixed-record tests; exact source was restored and direct tests rerun
(`/tmp/rastrata-commit-record-context-negative-build.log`,
`/tmp/rastrata-commit-record-context-negative-predecessor.log`). No mutation score
or capacity improvement is claimed by this extraction.

Final `bun run check` exits 0: 655 ledger tests / 25,417 assertions; 324 kernel
tests / 58,504 assertions; types, lint/boundaries, formatting, tooling and model/
trace gates (`/tmp/rastrata-commit-record-context-final-check.log`). Kernel-only
coverage remains 100% functions/lines across 14 sources, not ledger coverage.
Licensed SysIDE validates both models/workspace and negative controls
(`/tmp/rastrata-commit-record-context-syside.log`). Kernel release still exits 1
on ACC-039.7/.8/.9 before later stages
(`/tmp/rastrata-commit-record-context-release.log`). Captured inventory/transfer
fixture checksums are unchanged. No cloud resources or production data changed.

SHA-256: book `d265ed3a28e790ed3ae5848290b6233bfbfea44a3314c2d0c8d7d9e4b38ffbd6`;
direct tests `da746a8e1a11eea8e950447b032f1740f281e525237e499935fe5a04fb173fbe`;
indexed test `151232840a9a2122b887602d49028b9dcc52618d4356a875732cee5e164febbb`;
kernel model `37598526b1b4a10ca95d7c0dadf3924cd6ba6b1fccbe4bfdae483b64075d50e9`;
ledger model `65e578e923820fa0eabbb48ebfec733ef52a6fd0284f9f3a81a2f63545444d30`.

Next: the explicit indexed state/head representation, complete command evaluation
and atomic logical deltas, with the original codec/evaluator retained for historical
authenticity. Whole-population lot effects and complete-history state hashes remain
real scaling constraints. Bounded startup needs the separate reviewed verification
policy decision, not a caller-supplied integrity Boolean. This step does not close
PL-021, workload acceptance, pending inventory enforcement or production readiness.

## Explicit indexed state and head framing

Implemented the separate `rastrata-indexed-book-state-v1` and
`rastrata-indexed-book-head-v1` framing candidates. The kernel's new closed scalar
header codec preserves exact legacy tagged field encodings without including a
legacy whole-state hash or pretending to be a sparse `BookState`. The complete
sorted 24-collection catalog binds profile, financial identity, canonical ordinal
root, population and row codec; declared counters and ordinal endpoints must agree.
Physical scope belongs in the new full head, not economic collection domains.
Retained rejections change protocol commitment independently of financial state.
Both SysML models and the state-access contract describe these boundaries.

`projectLegacyIndexedBook` is a bounded bridge-input oracle: decode/revalidate the
whole original aggregate and build new roots from unchanged row encodings. It does
not install a profile, migrate a book or declare old/new hashes equivalent. Current
configuration aliases must later resolve from the actual selected configuration
row. Root framing, necessary count checks and hash metadata cannot certify
reachable payloads, source authenticity, configuration/ordinal closure, accounting
admission or nonzero outcome-chain membership. Tests deliberately demonstrate this.

Verification: 11 focused tests / 974 assertions compare every root and canonical
row commitment with independent full rebuilds, including actual allocation/tax
commands and the preserved inventory-adjustment history. Small-book path-copy
appends match full new projections for a retained rejection and a journal commit.
Hostile cases cover malformed/legacy/noncanonical wire, incomplete/foreign catalogs,
counts/endpoints, missing child nodes, scope/generation, full-head hash binding,
independent Oseq/revision and frozen ownership. Kernel header tests cover exact
integers above 2^53, counter boundaries and UTF-8 limits. A build-valid negative
control omitting all protocol collection commitments failed two tests; exact source
was restored and focused tests passed again. This is not a mutation score.

`bun run check` passes: 662 ledger tests / 26,349 assertions; 328 kernel tests /
58,546 assertions; types, lint/boundaries, formatting, tooling, model and trace
checks. Kernel-only coverage is 100% functions/lines across 14 sources. Licensed
SysIDE 0.10.3 passes both models/workspace and negative controls. Kernel release
still refuses closure on ACC-039.7/.8/.9 before later release stages. All seven
preserved inventory/transfer/allocation fixture checksums remain unchanged.
Evidence logs: `/tmp/rastrata-indexed-state-framing-{check,syside,focused,release}.log`
and `/tmp/rastrata-indexed-state-framing-negative-{build,protocol}.log`.

SHA-256: kernel codec `176915bb00b1eff6c21ff19a6b26bb7d03c812ddd48c2b970b9585171e73fb9e`;
header tests `0d077424ac92789ef34f1c629e2d35aaf6a9177bcb24946ad870d2671eb5424f`;
indexed codec `d005d0c49586fcf8149d7177a5a4bc679279af686990bbe3662b5c6b905f991c`;
indexed tests `a9e953775548f5c33db254e1f09696fd5d9e55ef720f1bb15e842913b4ee9387`;
kernel model `7139784400ed481b4fbda1f137f62e9f859c7b8ace11413783f554f99f5ce092`;
ledger model `a509ae25c3824551a94ca184fa3fcc0758dfe255c4e0d87a7e6a9c2a62c2cbfd`.

No storage adapter, enabled execution profile, recovery policy, cloud resources or
production data changed. The 1,000-outcome limit and whole-history hashing/replay
remain. Next is complete indexed command evaluation and atomic logical deltas/new
record publication, not a capacity claim from codec bounds or small append tests.
Checkpoint-based startup still requires the separate unresolved policy decision.
PL-021, inventory enforcement, migration, workload acceptance and release remain open.

## Indexed canonical outcome change candidates

`indexed-book-change.ts` now prepares one separately admitted new outcome as a
complete immutable state catalog, ordered canonical row writes and reachable new
logical nodes. It performs no storage writes. Commits use the shared kernel record
constructor and authenticate the supplied full financial predecessor row against
its revision-root leaf. Typed effect projection is exhaustive across all 20 current
effect variants. Configuration/boundary/header behavior follows the existing engine;
legacy lots, holdings and allocations explicitly replace their current populations.
Other effect rows, financial revisions and retained results append in original
order. Rejection leaves financial state untouched. Unchanged roots are retained,
missing nodes throw, inputs are captured before asynchronous reads, and unreachable
intermediate COW nodes are omitted from the returned candidate.

These are preparation mechanics, not proof of admission. A well-framed intent or
retained rejection can still be economically wrong; full evaluation, complete source
and configuration closure, permanent identity admission, full scope/head/fence CAS,
all physical projections and durable outcome publication remain owner obligations.
The compiler cannot classify retries or certify rejection diagnostics/result hashes.
No enabled adapter or public API uses it. Preparation limits (10,000 rows per legacy
replacement, 30,000 row changes, 16 MiB staged nodes and the outcome codec limit)
are not a measured production capacity and do not produce accounting rejections.

Seven tests / 2,682 assertions compare exact outcome bytes, all 24 final roots,
complete reachable map content and retained-row bytes with the existing engine and
independent full projections. Actual command streams cover **12 of 20** effect
families: activation, configuration, journal, lotState, periodTransition,
closePackage, remeasurementResult, remeasurementReversal, allocationSchedule,
allocationRecognition, allocationScheduleRevision and taxDetermination. The captured
inventory-adjustment history is replayed byte-for-byte. Every source-read position
in the ordinary-posting case is failed in turn; no partial candidate escapes.
Predecessor substitution, malformed rejection context and caller mutation are tested.
At 130 retained outcomes, an ordinary candidate uses at most 16 source-node reads;
128 preceding rejected candidates each use at most nine. This measures only candidate
path reads, not startup, full admission, storage latency, throughput or recovery.

A build-valid control changing lot-holding replacement to append fails the lifecycle
test. Exact source was restored and all seven focused tests passed again. Root
`bun run check` passes: 669 ledger tests / 29,031 assertions; 328 kernel tests /
58,546 assertions; all type/lint/format/tooling/model/trace checks. Kernel-only
coverage remains 100% functions/lines across 14 sources; this is not ledger coverage.
Licensed SysIDE validates both models/workspace and negative controls. Kernel release
still stops on ACC-039.7/.8/.9 before later release stages. Logs are
`/tmp/rastrata-indexed-change-{check,syside,focused,release}.log` and
`/tmp/rastrata-indexed-change-negative-{build,lots}.log`.

SHA-256: compiler `a6f9da11898777d78a67d32677f5cab9d8b86844e94843ae7ecf280bd1a6bd6f`;
tests `c48b0d321870c2e2f34f6661b5607eadc104963e6723a0f4cc7339c4159e5149`;
ledger model `e3c7a2de5c1012d731bc68e7850eaf2874639074bf3474b7bd653473553e50f9`.
Kernel source and all legacy wire formats are unchanged in this step.

Next verification must cover correction, provisionalInventoryLayer,
inventoryRecosting, inventoryValueAdjustment, openItem, settlement,
settlementAllocation and consolidationCompilation through actual command streams,
plus replacement deletion and resource-limit boundaries. Then complete indexed
evaluation and atomic projection/record publication; do not certify the whole path
from this component. Existing capacity/recovery limits, sparse inventory ownership,
startup-policy approval, migration and quantitative deployment acceptance remain open.

## Complete effect-family conformance and preparation budgets

The indexed change compiler now has real admitted-command conformance for all
**20 current effect families**. A type-exhaustive `Record<BookEffect["type"], ...>`
assigns each family to a tested workflow; assertions require the real kernel to emit
each assigned effect. This is execution evidence, not file-name/string-search
coverage. `commercial-workflow.ts` uses public kernel APIs to add shortage/recosting,
inventory value adjustment, receivable/payment allocation, correction and
consolidation cases. Exact postings and source relationships are asserted alongside
the independent complete-state/root comparisons. This verifies projection of these
streams, not every possible accounting case or an independent accounting-policy signoff.

Every ordered candidate row write is now independently folded over exact legacy
wire subtrees. Tests verify old/new commitments at each ordinal and all 24 final row
populations byte-for-byte, including unchanged rows. Thus correctly calculated
roots cannot hide an omitted row write. Candidate node reachability is still fully
checked against independent final trees. Raw replacement deletion exercises branch
collapse and empty roots; the deliberately fabricated, correctly hashed deletion
intent is separately refused by canonical `commitBookIntent`, with the original
financial state unchanged. Low-level projection is not accounting authority.

Added copied owner-narrowed work budgets under the unchanged hard profile caps.
They cannot raise the limits, execute accessor fields or change during asynchronous
reads. Exact row/node thresholds pass and one below fails without returning a partial
candidate. Replacement tests cover both prior and resulting counts and reject a
declared 10,001-row source before traversing it. These are operational work limits,
not accounting rejections, measured book capacity or total process-memory guarantees.
SysML and the state-access contract describe this separate work-budget boundary.

Twelve focused tests pass with 6,097 assertions. Two build-valid negative controls
fail as intended: omitting the settlement-allocation row write while retaining its
computed root, and changing the node budget comparison from inclusive to exclusive.
Exact source was restored before the full checks. Logs:
`/tmp/rastrata-indexed-change-conformance-focused.log` and the corresponding
`negative-{build,rows,budget-build,budget}.log` files.

Root `bun run check` passes: 674 ledger tests / 32,446 assertions; 328 kernel tests /
58,546 assertions; types, lint/boundaries, formatting, tooling, models and trace.
Kernel-only coverage remains 100% functions/lines across 14 sources. Licensed
SysIDE passes both models/workspace and controls. Kernel release still stops on
ACC-039.7/.8/.9 before later stages. Evidence:
`/tmp/rastrata-indexed-change-conformance-{check,syside,release}.log`.
All seven preserved inventory/transfer/allocation fixture checksums are unchanged.

SHA-256: compiler `50b9a009c9a23a9c2e9fca1320de75bbbe99cdaf9c91abe6d54ba66389a771fc`;
conformance tests `0314afea6e276cfa013adcc0ef4d487d71e32a49dd1bb15fc792d86dd0c125e3`;
commercial fixture `d37e9cf9ba59bc4e72e4ccbc51c61a26b047b13eb9680694b43902057cb87d56`;
ledger model `814b35e498e5ecd758494ad4be6d0c393300832a7b583e74d5a3e37d34a3ac29`.

Next: the explicit indexed outcome/full-head chain envelope and atomic publication,
without reusing `compactOutcomeRecord` as an apparent shortcut: it still computes
whole-aggregate financial/protocol heads. Complete indexed command admission, all
physical identity/source projections, full-head/fence CAS and durable confirmation
must remain one owner-controlled path. No adapter/profile adoption, cloud change,
startup-policy relaxation, capacity increase or production-readiness closure occurred.

## Explicit indexed outcome chain and projection replay

2026-09-06 — Added `indexed-outcome-record.ts`, a new closed versioned envelope,
without changing or adopting the existing compact/archive codecs. It carries exact
original outcome bytes, the prior/resulting full scoped heads, resulting indexed
state and explicit payload/envelope hashes. The chain preimage includes the prior
head, new state commitment and full payload hash, not the resulting head containing
that chain. UTF-8 envelope size is bounded to 4 MiB; underlying outcome codec and
existing storage limits are not raised.

Framing rechecks command input and original result hashes with complete metadata,
independent Oseq/financial/posting/configuration continuity, rejection's unchanged
financial root, and canonical revision/result bytes through the shared constructor.
The kernel only exports its existing unchanged result-hash function for reuse;
historical preimages are not replaced. Exact decoder regeneration binds an
independently supplied expected prior head/state and complete physical scope.

`replayIndexedOutcomeProjection` derives the immutable intent or retained rejection,
authenticates a commit's complete financial predecessor and applies the existing
row-change compiler to the prior roots. It compares the complete resulting state
and original outcome bytes, not merely a new row or counters. It performs no writes.
This is not command admission: correctly hashed inadmissible effects or rejection
reasons still require the evaluator. It does not establish permanent-ID absence,
active ownership, physical projection closure, durability or complete recovery.

Nine focused tests (635 assertions) cover independent counters and explicit hash
preimages, actual commercial/allocation/configuration streams, complete scope and
prior-head binding, forged revision/result hashes, noncanonical/oversized wire,
wrong payload/state pairing, rewritten earlier retention and failure at every
source-path read. Deliberate wrong state pairings pass framing and fail projection
replay, explicitly exercising the distinction between these two guarantees.

Licensed SysIDE passed both models and workspace with syntax/reference negative
controls after fixing the new declaration's hash namespace and reserved identifier.
Kernel release remains blocked by ACC-039.7/.8/.9 before later stages. All seven
preserved inventory/transfer/allocation fixture checksums and the old outcome codec
source checksum remain unchanged.

Verification completed: root `bun run check` exited 0, including 683 ledger tests /
33,081 assertions, 328 kernel tests / 58,546 assertions, types, lint, boundaries,
format, tooling, design and trace checks. The existing kernel-only coverage gate
reports 100% functions/lines across 14 production sources; it does not measure
ledger coverage. Root `check:syside` exited 0. Logs:
`/tmp/rastrata-indexed-outcome-chain-{check,syside,focused,release}.log`.

Negative control: removed only the resulting-state equality check from projection
replay. The mutated source passed ledger typecheck, and both wrong-pairing and
rewritten-earlier-result tests failed because replay wrongly resolved. This is a
build-valid two-test control, not a complete mutation campaign. Restored source
SHA-256 exactly matches the pre-control value:
`5c1e303081191ee1f4701c3f4de083934a058b1a7783af5868eca26cd384c109`.
Logs: `/tmp/rastrata-indexed-outcome-chain-negative{,-build}.log`.
Test SHA-256: `c819fa4d3785c32df3324ce233a397f3ee404e8e91c20596bc92d3e599ad56d7`;
ledger model: `db801e2377a4e435287a7b5b644cb17e68ec43cb524e1fc8541eb023061ba240`;
kernel book source: `0521fb6045a427f89acd5943bf7dde33d6fe75dbf574d173c9bfff444cdaeabb`.

Next: owner-controlled indexed publication must combine the admitted command's
complete read evidence, canonical rows/nodes, outcome/head chain, permanent-ID and
source projections, full-head/fence CAS and durable confirmation. This record is
not yet enabled in any adapter. Startup policy, historical migration, accounting
admission completion and measured business-scale capacity remain open.

## Indexed canonical row-source resolution

2026-09-06 — Storage-path review found that the existing physical source catalog
still consumes `OutcomeRecord`/compact heads and reconstructs the full legacy
projection during preparation. Passing the new chain through a fabricated compact
head would preserve the whole-state dependency and mix distinct commitments.
This change removes that prerequisite from single-outcome row extraction; it does
not claim that the existing physical catalog or owner is now indexed-format-ready.

`outcome-source.ts` retains the compact wrapper's checks and delegates its exact
tagged-wire row mapping to one private function. The new indexed wrapper first
validates the exact indexed chain against independently supplied prior state/head,
complete scope/actual object and expected source commitment. It reconstructs the
retained commit-intent hash with the kernel function and full indexed configuration
hash metadata. It extracts all twenty effect families, revision and original
retained result without a legacy aggregate or synthetic compact hash. Rejection
rows contain no commit-intent hash; lot snapshots retain all three replacement
groups, including empty ones. Unknown global append ordinals remain unknown.

Indexed row resolution checks exact kind-specific selector, collection, positive
uint64 ordinal and the independent indexed row commitment. Canonical source and
locator membership, live pin/fence, complete accounting admission and effect replay
remain owner obligations; hashes supplied by a caller do not confer that authority.
Neither new helper writes rows or installs a source catalog. Existing codecs and
enabled profiles retain their exact historical semantics and limits.

Tests compare source groups across formats AND fold them against independent full
legacy codec row subtrees for all 24 collections. A type-exhaustive requirement set
requires all twenty effect families to occur in actual committed core, commercial,
lot, allocation/tax and FX streams. Explicit group assertions catch omission of
empty replacement groups even when final arrays would look unchanged. A real
two-journal settlement verifies one financial revision with two posting-sequence
increments and distinct selectors. Retained rejections, complete scope/head/hash
substitutions, wrong selectors/ordinals, legacy-authority refusal and two frozen
inventory/allocation books are covered. The configuration test initially used a
non-prospective effective date and correctly failed admission; its fixture date
was corrected without weakening the committed-result assertion.

Verification: 13 focused tests / 4,507 assertions passed across old/new source tests.
Root `bun run check` exited 0: 689 ledger tests / 36,515 assertions, 328 kernel
tests / 58,546 assertions, types, lint, boundaries, format, tooling, design and
trace gates. The existing kernel-only gate reports 100% functions/lines across
14 production sources, not ledger coverage. Licensed SysIDE passed both models
and workspace with negative controls. Kernel `check:release` still fails exactly
on ACC-039.7/.8/.9 before later stages. Logs:
`/tmp/rastrata-indexed-outcome-source-{check,focused,syside,release}.log`.

Two isolated build-valid controls were killed: omitting settlement-allocation rows
from the shared mapper failed the independent full-row comparison despite both
formats agreeing; omitting empty replacement groups failed their explicit presence
assertion despite the prior collection also being empty. Each mutated source passed
ledger typecheck first, and each was restored to the exact pre-control checksum.
This is not a complete mutation campaign. Logs:
`/tmp/rastrata-indexed-outcome-source-negative-{row,empty}{,-build}.log`.
Restored source SHA-256:
`1274f3724a3bb6ab99f36dd1b06ee17612ed9236b65031f6aa6da8a563e555dd`;
new tests `75199b6b46c5de660de171ecc1689f8bf016bbd6363f0e0ec8729fb4e5fc2d5d`;
ledger model `1404934b76a3da861a3361e045f68ba7c34d921ad5ff462ecf824ee29632f942`.
All seven preserved inventory/transfer/allocation fixture checksums and the kernel
book/codec source checksums remain unchanged from the preceding chain review.

Next storage dependency: derive and authenticate new-format locator roots from
these exact rows and the verified row-change candidate, preserving current source
locators for unchanged rows. Then publish the complete source/permanent-ID/group
projections with canonical rows/nodes/outcome/head under one full-head/fence CAS and
durability boundary. Complete command admission, migration, startup policy and
business-scale capacity remain open; the production goal is not closed.

## Explicit source-profile adoption and historical outcome preservation

2026-09-07 — Extended the source-identity repair to existing books through the
existing `replaceConfiguration` command, not a second posting engine or separate
migration log. The optional `executionProfileAdoption` payload names `from` and
`to`, pins the exact previous configuration hash, and records a nonblank reason
(at most 4,096 Unicode code points) plus 1..64 distinct canonical evidence IDs.
The enclosing command supplies actor, times and both revision expectations.
External authorization and evidence custody remain application responsibilities;
the kernel does not treat supplied evidence IDs as proof of external approval.

Only legacy to `structural-source-identity-v1` is admitted. The configuration
effect, book revision, configuration revision and retained outcome publish as the
existing one atomic transition; posting sequence and journal amounts do not change.
Ordinary configuration commands preserve the selected marker. Repeated fresh
adoption, downgrade, unsupported names, stale prior hash and incomplete or excessive
evidence reject. Requested names remain wire strings so unsupported-name rejections
can be serialized and retried; committed configuration markers remain a closed
enum. This payload's allowed transition is permanent. A future target must use a
new explicitly versioned payload shape, not silently expand the meaning of this
one and reinterpret its earlier unsupported-target rejections.

Configuration history may now contain one explicit forward profile transition.
Fresh admission and restoration authenticate snapshot hashes and bind a changed
marker to exactly one canonical configuration command/effect with the correct old
hash, new snapshot and hashed adoption payload. A rehashed marker alone, missing or
duplicated origin, altered command or substituted configuration effect is not
authority. Earlier revisions use their earlier configuration during validation;
full ledger replay still starts at the original genesis. Exact retained retries
precede fresh evaluation and retain original outcome/diagnostics/hash/Oseq. The
cutover is command order, not an economic-date rewrite; permitted backdated fresh
commands use the current profile while retaining normal period and policy rules.
Inventory ownership, rounding and legacy inventory adoption are not changed.

Tests cover configuration history before adoption, full adoption-input hashing,
reason/evidence limits including supplementary Unicode characters, unsupported
name rejection round trips, repeated adoption, and illegal history substitutions.
Two intents evaluated at one head cannot both publish. The existing intent API
reports an obsolete configuration topology as `ordered_history_violation` without
retention; re-evaluation through the command API produces the retained
`stale_book_revision` result. This test preserves the existing API distinction.

The actual indexed-owner SQLite test starts with the frozen alias book: the
original allocation rejection remains Oseq 4 / financial revision 3. Adoption is
Oseq 5 / revision 4 / configuration revision 1, with two original journals and
posting sequence 2. A fresh command then creates the 100-unit schedule at Oseq 6 /
revision 5 without a new journal. Every original retained row remains byte-identical.
The owner reconstructs the entire sequence from original genesis, reopens, reads
the source journals and retries all six outcomes at original Oseq and result hashes.
This is source-only adoption, not conversion of a previously booked amount.

Targeted sensitivity checks run only in an isolated source copy: removing the
prior-configuration hash comparison admits a wrong-hash transition; removing the
origin command-hash check admits altered history; allowing profile changes without
the explicit payload admits an ungoverned marker change. Each variant builds and
fails the relevant test assertions. Each prior mutation is restored before the
next one, and the restored copy matches production bytes and passes six tests /
227 assertions. Logs: `/tmp/rastrata-adoption-prior-hash-control.log`,
`/tmp/rastrata-adoption-origin-hash-control.log`,
`/tmp/rastrata-adoption-payload-control.log`, their corresponding `-build.log`
files and `/tmp/rastrata-adoption-control-restored.log`. These targeted checks do
not supply a new whole-kernel mutation score.

Final verification: `bun run check` exits zero, including 351 kernel tests /
59,278 assertions and 767 ledger tests / 86,234 assertions (one pre-existing
crash-child driver skip). The kernel-only coverage gate enforces 100% functions
and lines across 14 production sources. Licensed SysIDE checks both models and
the workspace with zero diagnostics and passing negative controls; the initial
reserved `from`/`to` names were corrected to quoted SysML names before this result.
The release gate still exits one at ACC-038 and ACC-039.7–.9, before later release
stages. All eight frozen historical fixtures retain their recorded SHA-256 values.
Logs: `/tmp/rastrata-profile-adoption-check.log`,
`/tmp/rastrata-profile-adoption-syside-final.log` and
`/tmp/rastrata-profile-adoption-release.log`. Verified source SHA-256:
`book.ts` = `67fafb20bb045ee466dc2b4564363860b9fd50f8b1b2d856664fe5986dd78a5e`;
`codec.ts` = `b89592e9dbeab88e67740cfcc8f1defe97b2eb1c555ec80d9b988d4da8344034`;
kernel SysML = `d9ff2b0bbf191bbebb630881cf21456b7adb4b92cfea8acbb306f2a1d3d9900c`.
The suite's local runtime and process-crash evidence does not establish cloud
capacity, power-loss durability, independent-account recovery or production readiness.

The genesis-only restriction in the earlier section is historical; this explicit
payload supersedes it. ACC-038 remains release-pending for complete source-family
and indexed-admission verification and current release recertification. The three
posted-inventory requirements remain pending independently. No new cloud resource,
deployment, permanent-history rewrite or performance claim is introduced here.

## Genesis-selected structural source identity

2026-09-07 — Implemented a prospective source-resolution repair using the existing
configuration snapshot, without adding another outcome store or command variant.
`createBookState` accepts the closed `structural-source-identity-v1` marker at
genesis. Its presence is included in `BookConfigurationSnapshot` hashing and the
shared strict configuration-row/aggregate codec; absence contributes no new hash
field and retains the original encoded bytes and resolver. The seven-field state
header already authenticates the configuration hash; no header or storage-framing
field is repurposed as execution authority.

The marker selects `(book ID, journal ID, effect key)` structural tuple keys, then
the same exact posting-ID and complete posting-hash checks. It does not change
accounting policies, quantization, inventory arithmetic or inventory ownership.
The name denotes this precise source-resolution behavior, not a generic kernel
upgrade or certification of all accounting requirements. Ordinary configuration
replacement carries the original marker forward; topology validation rejects
adding/removing it even in a rehashed candidate snapshot. Activation and close
retain the selected configuration. The command schema rejects a caller override.

Fresh-command admission verifies supported selection, active snapshot hash,
configuration-hash binding and agreement with every retained configuration back
to genesis. Restoration checks the same rule. Exact retained retries are still
resolved before fresh evaluation, with no recomputation of original decisions.
This validation is whole-book work, not the future bounded indexed read set.
Unknown markers, missing genesis snapshots, unilateral snapshot edits and damaged
content fail closed. Rehashing all state under a different genesis is not a valid
upgrade: the ledger must still verify the original trusted genesis and outcome
chain. No existing-book adoption command or default production-profile switch is
introduced here.

Tests exercise both journal orders under legacy and structural genesis; the legacy
counterexample still rejects, while structural genesis admits the actual 100-unit
allocation source. A same-command open-item source is verified against an earlier
alias journal, with wrong effect/journal/posting IDs, altered booked value and all
full-hash components rejected without financial mutation. Configuration and close
round trips preserve selection. Actual indexed-owner SQLite provision, execution,
reopening and retries cover both the frozen legacy book and the explicitly selected
new book, including a retained rejection. The new integration comparison uses the
kernel as accounting oracle and separately asserts dispositions, revision, journal
count, schedule count and source basis; it is not an independent accounting engine.

The existing accounting-command capability suite also runs against both genesis
profiles, including every custom genesis constructor in that suite: 30 tests /
868 assertions pass. This covers unchanged inventory, FX, settlement, allocation,
tax, consolidation, configuration and malformed-policy paths in addition to the
specific alias tests. Log: `/tmp/rastrata-source-profile-matrix-final.log`.

Three isolated negative controls compile successfully and fail the relevant tests:
restoring delimiter lookup in the structural branch, omitting the marker from the
configuration hash, and removing the configuration-transition equality check.
The last control confirms the rehashed illegal-transition test fails specifically
when that guard is absent. Each control starts from the restored source, not an
accumulated mutation; the first two restored controls pass eight tests / 178
assertions, and the third is restored byte-for-byte afterward. The real production
resolver was never mutated by these controls. Logs:
`/tmp/rastrata-source-profile-negative.log`,
`/tmp/rastrata-source-profile-negative-hash.log`,
`/tmp/rastrata-source-profile-negative-transition.log` and their `-build` logs;
`/tmp/rastrata-source-profile-control-restored.log`. These are targeted sensitivity
checks, not a new mutation score or independent human audit.

Final verification: `bun run check` exits zero. The complete ledger suite passes
766 tests / 86,171 assertions (one pre-existing crash-child driver skip); the
final kernel coverage run passes 347 tests / 59,116 assertions and enforces 100%
functions and lines across 14 production sources. The initial fast kernel run in
that invocation preceded the added two-profile matrix; the final coverage run
includes it. Type checks for the final matrix pass separately. Licensed SysIDE
checks both models/workspace with zero diagnostics and passing negative controls.
Trace remains 105 requirements: 93 executable, eight boundary and four pending.
The kernel release gate exits one at those four pending requirements, before its
later release stages. Logs: `/tmp/rastrata-source-profile-check.log`,
`/tmp/rastrata-source-profile-matrix-types-final.log`,
`/tmp/rastrata-source-profile-syside.log` and
`/tmp/rastrata-source-profile-release.log`. All eight frozen inventory, allocation
and source-alias fixtures match their previously recorded SHA-256 digests.
Production `book.ts` SHA-256 is
`cb124b11214e71f2b07bd3f0948472571aea8ee802db176bef8bc902de57717d`;
`codec.ts` is `be2d581a60d103974a2cb17499fa9b06624b486a60f962c2c1f3406fabb02e6f`.
Local runtime/crash checks in this suite do not establish cloud capacity, power-loss
durability, independent-account recovery or production readiness.

ACC-038 remains release-pending: governed adoption of existing books and complete
source-family/indexed-admission verification are not supplied by these tests.
ACC-039.7–.9 remain pending independently. No historical fixture was regenerated,
no cloud resources were changed and no performance/SLO claim follows from this work.

## Canonical posting reference delimiter alias and replay compatibility

2026-09-07 — **Open P1 accounting-admission defect, ACC-038.** While tracing
`resolveCanonicalPosting` for indexed execution, reproduced a dependency absent
from the intended read contract. Its deduplication map concatenates journal ID,
colon and effect key. The valid raw pairs `("a", "b:c:journal:0")` and
`("a:b", "c:journal:0")` both become `a:b:c:journal:0`. These are distinct admitted
journal and command identities, with distinct posting IDs; there is no hash
collision or forged source. The later journal replaces the earlier map entry
before the exact book/journal/effect/posting/hash checks run.

Actual-kernel controls use activation, two ordinary postings and one cumulative
allocation-schedule command over the first posting's 100-unit booked source:

| Second journal / order | Schedule command | Retained outcomes / financial revision |
|---|---|---|
| Nonalias `not-colliding`, source first | Committed | 4 / 4 |
| Alias `a:b`, source first | Rejected at `intent.effects[0].source` | 4 / 3 |
| Alias `a:b`, source last | Committed | 4 / 4 |

The failure is source availability/admission, not observed misbinding to another
posting or silent monetary loss: the subsequent exact checks prevent accepting
the replacement journal as the requested source. Nevertheless, an unrelated
admitted journal prevents a valid accounting workflow. The new indexed reader
correctly resolves both raw journal identities from their authentic source rows;
substituting that reader for the legacy resolver would change command semantics.

Captured the rejected book before any repair in
`test/data/posting-reference-collision-legacy.json`, SHA-256
`0636ddb716c7a5c34e0542dc6b66eb01cd7991d9c6c24025f6c76a1cd28cb1e2`.
It is excluded from formatting, like the other frozen canonical histories.
The test reconstructs genesis from the stored configuration, reexecutes all four
stored commands through the actual indexed owner, compares original results and
the entire durable book, reopens and reads both source journals, and retries all
committed/rejected commands at their original Oseq without changing the book.
This is characterization/compatibility evidence, **not a passing repair test**.

A temporary, build-valid replacement of the joined map key with
`JSON.stringify([journalId, effectKey])` removes the observed false rejection but
changes the frozen final result digest from
`c9c000f022ea5f53cbf93f871c7e91ee7a6e4aa7d3da351ae08128ec90e5f158`
to `127ff1c8f18891dc30e2a164483582656a323c87992bbc3af7007b8e3ec4ce2f`.
Both characterization and retained-result assertions fail under that experiment.
The production file was restored exactly to SHA-256
`0521fb6045a427f89acd5943bf7dde33d6fe75dbf574d173c9bfff444cdaeabb`.
Logs: `/tmp/rastrata-reference-collision-control-build.log` and
`/tmp/rastrata-reference-collision-control.log`. This is a compatibility experiment,
not a mutation score or an installed fix.

Reference cross-check: Beancount at
`9747213802acb733ce53acc6e963f5961f47d6cd` uses the structural key
`(units.currency, cost)` in `beancount/core/inventory.py:428`; tuple equality keeps
the fields separate. This supports structural identity composition as a design
choice. It does not establish Rastrata posting-reference or replay conformance.

Required repair direction:

1. Preserve separate raw source coordinates and overlay only an exact tuple;
   never ban valid colon-bearing IDs or infer a unique source from a digest alone.
2. Bind prospective semantics explicitly to durable execution provenance. A
   storage-format switch, ambient deployment version or caller-supplied validity
   flag must not silently change accounting. The execution-profile mechanism and
   governed transition still need design and implementation; no new profile is
   enabled by this investigation.
3. Replay old committed **and rejected** outcomes under their original selected
   semantics, preserving all hashes/times/Oseq. Exact retries still return the
   original result. Do not rewrite or regenerate the frozen history to pass.
4. Prove new-profile positive/negative cases for prior and same-command sources,
   raw coordinate aliases, full posting hashes, phase/ordering, transitions and
   restart/restore. Only then use indexed reads for authoritative source closure.

The existing ACC-038 requirement is clarified, not replaced with another feature
or requirement ID. Its release trace is reopened as design-pending. Model checks
now require the exact union of reopened parent and pending atomic requirements;
a negative control proves that dropping the reopened parent cannot pass. Current
trace: 105 IDs, 93 executable bindings, eight boundary dispositions and four
design-pending requirements (ACC-038 and ACC-039.7–.9). PL-021 and the state-access
contract now explicitly retain this compatibility obligation. Kernel baseline
documentation no longer claims the complete Ring A/B contract is implemented.

Final scoped verification after restoring the production resolver: both new tests
pass (71 assertions), including exact frozen replay and retries. All 328 kernel
tests pass (58,546 assertions); the kernel-only coverage gate reports 100% lines
and functions across 14 production sources. Root typecheck, lint, formatting,
repository tooling (25 tests / 97 assertions), both specification checks, trace
validation and licensed SysIDE checks pass. SysIDE reports no model diagnostics.
The kernel release gate intentionally fails on all four pending requirements;
it does not reach or certify subsequent release gates. No full ledger-suite,
current mutation campaign or deployed capacity claim is made for this change.
Final logs: `/tmp/rastrata-reference-collision-tests-final.log`,
`/tmp/rastrata-reference-collision-coverage.log`,
`/tmp/rastrata-reference-collision-syside.log` and
`/tmp/rastrata-reference-collision-release.log`. The frozen fixture and production
resolver hashes were rechecked unchanged. These results preserve and gate the
defect; they do not close it.

## Shared current-head reader for compact and indexed owners

2026-09-07 — Connected `IndexedLedgerOwner.openCurrentRowReader()` to the actual
new canonical/source/group/identity stores after its complete accounting replay
and catalog audits. Extracted the compact owner's existing row, command,
activation, journal/posting, accounting, current-lot and group/fact algorithms into
`book-row-reader.ts`; its original type exports remain available. Both owners now
use that implementation with profile-specific ports, not copied admission logic.

The factory serializes each whole read and cursor operation, confirms authority
before and after delivery, and retires the complete context on failure. Explicit
close is idempotent and releases the capture/pin; uncertain cleanup preserves the
original error and relies on durable expiry. The indexed owner supplies its actual
full head, verified source-prefix hashes, both permanent-ID partitions and current
source/group captures. Publication, including a retained rejection with unchanged
financial revision, invalidates the reader. It never silently reopens a new head.

`readPinnedIndexedBookBasis` validates the indexed state/head framing and compares
the explicit closed scalar header with the recovered kernel state. The shared
basis checks still source-verify configuration revision + 1, original opening
boundary and latest financial revision, with explicit absence at revision zero.
The basis's kernel `contentHash`, indexed state commitment and physical head hash
remain distinct; no fake legacy `LedgerHead` or hash-domain equivalence is used.
The initial integration incorrectly passed a whole `BookState` to the closed
header codec; tests rejected it. The implementation now selects exactly the seven
declared scalar fields. Those initial failed runs are not counted as evidence.

Focused evidence after correction:

- Existing compact-owner suite: 109 tests / 5,195 assertions, including reader
  identity, group, source failure, concurrency and retirement cases. Log:
  `/tmp/rastrata-shared-reader-legacy.log`.
- Four actual admitted business streams (commercial, lots, allocation/tax, FX)
  now check all 24 typed collections and absent next rows against an independently
  executed full kernel book, every command and emitted journal/posting/accounting
  identity, original lot creation sequence with current rows, and all populated
  semantic groups in one-row pages. Expected group membership is built from
  independent raw predicates, not the production group projector. Together with
  inventory fact conformance: five tests / 1,208 assertions, 239.18 seconds. Log:
  `/tmp/rastrata-shared-reader-workflows-fixed.log`. This is a correctness-suite
  duration, not service latency or capacity evidence.
- New-reader chronology and ten failure cases: two tests / 63 assertions.
  Covered committed/rejected head changes, lost source chunks, identity pages,
  group metadata, pending maintenance, fence change, expiry, authority loss
  during source I/O and invalid collection. Every failed reader and its existing
  cursor retire without adding a canonical outcome. Log:
  `/tmp/rastrata-shared-reader-boundaries.log`.
- FX guard: first canonical overdue result across policy groups, equality at
  the effective date and original-result reversal exception; one test / nine
  assertions. Log: `/tmp/rastrata-shared-reader-fx.log`.
- Isolated basis boundary: two tests / 21 assertions for original vs indexed
  hash framing, three source coordinates, mismatched heads/headers, missing rows,
  coordinate substitution and final authority loss. Its artificial chain/ports
  are explicitly unit-test inputs, not owner authority. Log:
  `/tmp/rastrata-shared-reader-basis.log`.
- A build-valid unchecked-head control made the basis rejection test fail on a
  resolved promise. Source was restored byte-for-byte before full validation:
  `book-basis.ts` SHA-256
  `8d65990dc0fe608e5254ec2d529da8451ee5852f13ab4ec1c11366de65219450`.
  Logs: `/tmp/rastrata-shared-reader-negative-build.log` and
  `/tmp/rastrata-shared-reader-negative.log`. This scoped control is not a
  current whole-ledger mutation score.

Licensed SysIDE validates both models/workspace with zero diagnostics and controls;
the ledger specification checks and 18 checker tests pass. Logs:
`/tmp/rastrata-shared-reader-syside.log`, `/tmp/rastrata-shared-reader-spec.log`.
Kernel release still fails at the complete-trace prerequisite on ACC-039.7/.8/.9,
before its later stages: `/tmp/rastrata-shared-reader-release.log`.

Scoped coverage review exposed two unexercised malformed-command paths in the
shared reader. Added real compact-owner tests for both fact methods: caller
accessors are not invoked, invalid commands retire the context, captures/pins are
released and no outcome is created. After these additions, the selected 62-test
reader/basis campaign passes 2,699 assertions and measures 100% functions/lines
in both `book-row-reader.ts` and `book-basis.ts`:
`/tmp/rastrata-shared-reader-coverage-final.log`. The coverage command itself exits
1 because coverage across **all imported files** is 65.99% functions / 62.76%
lines under the global 100% threshold. This is scoped evidence, not whole-ledger
coverage or release acceptance. The earlier 51/60-test subset measurements are
superseded.

Final `bun run check` after the test additions exits 0: 763 ledger tests /
86,051 assertions (one preexisting subprocess-only driver skipped in the parent),
328 kernel tests / 58,546 assertions, plus tooling checks. Types, lint, dependency
boundaries, formatting, specification checks and semantic trace pass. The separate
kernel-only coverage gate remains 100% functions/lines across 14 sources. Log:
`/tmp/rastrata-shared-reader-check-final.log`. The earlier full run also passed but
predates the two malformed-input tests; it is not the final snapshot evidence.
Production source and test hashes were rechecked after the final run; no code
changed afterward. Preserved historical-fixture hashes match the prior review.

Remaining boundary: opening this reader still performs full-history recovery and
holds a bounded recovered state. It is not sparse state, a complete indexed
command evaluator, historical MVCC, migration, archive-required acknowledgement,
independent rollback protection or an enabled application profile. Neither the
1,000-outcome owner cap nor the current kernel collection/aggregate limits changed.
Complete command read sets, admission and measured business-scale storage/recovery
remain production blockers. No kernel accounting semantics, preserved historical
fixtures, deployment or cloud resources changed in this tranche.

## New indexed owner: native runtime and process-interruption evidence

2026-09-07 — Added dedicated local platform tests for the actual
`IndexedLedgerOwner`, not only its component stores or the older compact adapter.
No production source changed. The tests do not enable the new profile or deploy
resources. Fixed test clocks/authority are explicit harness inputs, not a claimed
persistent production control plane.

Six actual SIGKILL scenarios cover root selection, pin consumption and completed
SQLite commit before a receipt, separately for committed and retained rejected
commands. Each child opens only a validated, newly created temporary SQLite target
with WAL and synchronous FULL. Synchronous reached-boundary markers and the real
signal distinguish the intended kill from an unrelated failure or watchdog.
Reopening through the owner verifies complete accounting, source/group catalogs
and both identity partitions. Pre-commit interruption preserves the old head;
post-commit interruption preserves the complete new outcome. Repeated retries
return the exact original result and Oseq without duplicate financial effects.
Invalid target/hook arguments are rejected before opening SQLite. Result: 3 tests,
150 assertions, `/tmp/rastrata-indexed-platform-crash.log`.

A separate Miniflare/workerd test uses native DO SQLite transactions and actual
`storage.sync()`, retaining the bundle's native `node:crypto` import. It verifies
rejection before activation without advancing the financial clock; activation;
concurrent exact command retries; later retained rejection; native transaction
rollback after canonical-head update; a lost reply after actual durable root
publication; and maintenance admitted immediately after that durable publication.
Maintenance withholds the receipt and blocks reads until explicit harness release.
After complete runtime disposal/recreation over persisted local DO data, every
committed/rejected/lost-reply command retains its exact result and Oseq. A required
source corruption prevents both reads and retries without appending outcomes.
Exact snapshots and canonical result bytes are compared with independent kernel
execution. Result: 1 test, 44 assertions, 48.28 s in the focused local run:
`/tmp/rastrata-indexed-platform-runtime.log`. This duration includes many requests,
full recoveries, runtime lifecycle and oracle checks; it is not per-command latency.

A build-valid harness control deliberately moved the claimed pre-commit root kill
to after commit while keeping its original marker. The parent rejected it because
recovered Oseq was 2 instead of 1. Thus a marker plus SIGKILL alone cannot satisfy
the recovery assertion. The driver was restored to its exact hash. Logs:
`/tmp/rastrata-indexed-platform-negative-{build,boundary}.log`. This is a harness
negative control, not a production mutation score.

Snapshot SHA-256: runtime test
`f335395a5d30e5fe2e15949077df1ffd2f8b8923a67cdfee2b38362b30ee80c8`;
runtime harness `084ec85135d229d8199e2dc2fd3ea58d3cb1b0c264825d45c593b5ca815abb25`;
process driver `a799926711765b24347577c536cadf473af819329ee8d61ebfe643a0e81f670a`;
crash test `e4e570eb32913183787745d38c99ba260268543ed0b001a26cd0de487fa9d8f0`;
ledger model `bf7cd80586baffed396a2237dff05506eeaef8cd75d3a2bd5c48a082b5b7fb71`.
All temporary runtime/SQLite targets are disposable test data and were removed
after their successful runs. No configured book, cloud resource, credential,
production binding or external account was changed.

Full root `bun run check` exited 0 on these final test/harness/model hashes:
755 ledger tests / 84,800 assertions (one preexisting subprocess-only driver
skipped in the parent), 328 kernel tests / 58,546 assertions. Types, lint,
boundaries, format, tooling, design and trace passed. Log:
`/tmp/rastrata-indexed-platform-check.log`. Licensed SysIDE passes both models and
workspace with zero diagnostics and successful controls:
`/tmp/rastrata-indexed-platform-syside.log`. The kernel-only coverage gate remains
100% functions/lines across 14 sources; no new ledger-wide coverage claim is made.
Kernel release still exits 1 at complete trace on ACC-039.7/.8/.9 before later
release stages: `/tmp/rastrata-indexed-platform-release.log`.
The new owner remains `181d0e9ccb462ec891a94fc56523045f81c489118ade38dbfdd75bb00bfc34f8`;
no production implementation or preserved historical fixture was changed here.

These results narrow the platform-correctness uncertainty; they do not establish
power-loss/provider replication, account-loss recovery, archive-required receipt
durability, migration safety, business-scale performance or complete ledger-wide
coverage. The expensive full-history bridge and ACC-039.7/.8/.9 remain blockers.
The next data-path work remains complete indexed admission and verified-view
integration, not merely changing SQLite flags or raising the current capacity cap.

## Internal indexed owner: accounting, identity and fenced publication

2026-09-07 — `IndexedLedgerOwner` now connects the actual new canonical store,
source/group catalogs and permanent-ID page/control store. This remains an internal
class, not an exported/enabled service profile. It uses the complete existing
kernel state/evaluator as its bounded admission bridge; it does not manufacture a
sparse state or claim the indexed command read-set design is implemented. The
existing default adapters, kernel semantics and historical fixtures are unchanged.

Before reads/execution, reconcile storage uncertainty and take a live exact-head
reader pin. Stream canonical records, rerun the kernel's original command/result/
revision, and compare every resulting indexed state with an independent full
projection of that rebuilt aggregate. Source reads are tied to hashes collected
from this replay-verified prefix and fresh durable bytes. Audit all source/group
rows and both permanent-ID partitions against the exact canonical identity set,
including first-creation Oseq for lot snapshots and command IDs for rejections.
The identity oracle now exposes shared exact entries independently of legacy head
framing; its existing legacy population/hash wrapper is unchanged. No fake legacy
head over indexed hashes is required.

Actual retained outcomes prepare canonical/source/group candidates, authenticate
both identity partitions and original source identities, and retain the complete
COW insertion chain under one construction pin. The final root registration binds
the exact next head/fence. Canonical records, source/group catalogs, identity root
selection and construction-pin consumption share the same synchronous controlled
transaction. The owner rechecks trusted authority and construction expiry inside
publication, then confirms durability and repeats complete accounting/index
recovery before returning a receipt. Lost acknowledgements return no receipt;
restart/retry returns the original retained result and Oseq. Exact replay and
unretained rejection reserve no new identity. Queue input is copied before yielding.
Concurrent head conflicts retry the same command at most three times; integrity,
maintenance, fence and durability failures are not accounting rejections.

Provisioning atomically includes all canonical/control/page/source/group schemas,
rejects conflicting genesis and does not adopt legacy tables. An existing complete
matching genesis can reconcile a lost provisioning response without resetting
indexes. Cleanup preserves the original error while retaining uncertain protection;
successful cleanup and final fence confirmation precede exposed success.

Targeted evidence: eight publication SQL boundaries roll back the complete selected
accounting/catalog/control state, with a successful reopened retry; lost publication
acknowledgement; maintenance/fence/expiry changes during construction and publication;
two independent owners racing duplicate and competing financial commands; missing
identity/source evidence never becoming absence; atomic initialization/lost genesis
reply; queued input mutation and unretained bad-hash rejection. Fault subset:
5 tests / 89 assertions, `/tmp/rastrata-indexed-owner-faults.log`; provisioning/input
subset: 2 tests / 26 assertions, `/tmp/rastrata-indexed-owner-inputs.log`.
The initial owner run exposed a bigint receipt-comparison bug; comparison now uses
the actual canonical outcome codec, not ordinary JSON over a kernel result.

Build-valid controls bypassing complete source/group recovery and omitting the
final publication expiry check both fail the targeted tests. Restored owner source
SHA-256 `181d0e9ccb462ec891a94fc56523045f81c489118ade38dbfdd75bb00bfc34f8`.
Logs: `/tmp/rastrata-indexed-owner-negative-{audit,expiry}{,-build}.log`. These are
two targeted controls, not a complete mutation score or ledger-wide coverage claim.

Full root `bun run check` exited 0 on the final source/test/model snapshot:
751 ledger tests / 84,606 assertions (one existing subprocess-only driver skipped
in the parent), 328 kernel tests / 58,546 assertions; types, lint, boundaries,
format, tooling, design and trace passed. All 12 new owner tests passed in this
run. Log: `/tmp/rastrata-indexed-owner-check.log`. The kernel-only coverage gate
remains 100% functions/lines across 14 production sources; it is not ledger coverage.
Licensed SysIDE passes both models/workspace with zero diagnostics and controls:
`/tmp/rastrata-indexed-owner-syside.log`. Kernel release still exits 1 at complete
trace on ACC-039.7/.8/.9, before later stages:
`/tmp/rastrata-indexed-owner-release.log`.
Snapshot SHA-256: identity oracle
`23692bab2c78054dea48712c1d61fd2615ee06a5bb3b825c853db59a510bb079`;
owner test `ccaa733d83ec3b2edb220ecd0bb6275a9856086cea56419ac432b511b6f7d0e7`;
ledger model `4a4669d9b7c7fd21207132646907f85f065d086bfbe02383cdc7d17fff56022d`.
Kernel, default indexed owner and all seven preserved historical fixture checksums
remain unchanged. Workflow conformance runtimes in this local run were 67.27 s
(commercial), 34.59 s (lots), 37.26 s (allocation/tax), and 21.31 s (FX). These
include repeated complete recovery and oracle comparisons; they are neither
per-command latency measurements nor Cloudflare acceptance results.

The scoped coverage diagnostic (eight owner publication/fault/input tests, excluding
the four long workflow tests) passes 8 tests / 130 assertions. It measures 96.77%
functions and 99.60% lines for the new owner; the defensive genesis-only previous-row
callback is not exercised. The imported-module totals are 61.75% / 56.68%, so the
global-threshold diagnostic exits 1. This is explicitly not 100% owner or ledger
coverage and not a release pass. Log: `/tmp/rastrata-indexed-owner-coverage.log`.

The first combined commercial/lot/allocation/tax/FX test run was stopped after its
work exceeded the nominal 60-second test budget; it is not counted as a passing
run. The same full-state/result assertions are now separate workflow tests with
explicit 180-second correctness-test budgets. Those budgets are not service SLOs.
The bridge still fully projects/replays history and is expensive even on small
books. It retains the 1,000-outcome/1 MiB owner bounds and kernel aggregate limits.
Its full evaluator also inherits the open ACC-039.7/.8/.9 requirements. Complete
indexed admission, scaled integrity/recovery, archive-required acknowledgement,
external rollback evidence, migration and Cloudflare/business-scale verification
remain open. No new-profile process-crash or Workers-runtime certification is
inferred from older component/default-owner tests. No cloud changes or push occurred.

## Indexed canonical SQLite persistence and streamed chain audit

2026-09-06 — The new indexed source/group catalogs previously depended on a
synthetic canonical table. `SqliteIndexedCanonicalStore` now supplies a real
canonical persistence component: exact versioned genesis/outcome bytes, bounded
manifests and 256 KiB immutable chunks, closed full-anchor metadata, opaque
store-instance preparation and same-port transactional full-anchor CAS. New-book
initialization refuses all preexisting ledger tables; no legacy adoption occurs.
Plans survive rollback; publication reads back bytes and final metadata. This is
not an enabled adapter, accounting evaluator, live-fence owner or receipt boundary.

The structural audit starts from an independently expected genesis/full head and
streams consecutive outcomes without retaining a historical array. It verifies
framing against each actual preceding state/head, exact final anchor, and complete
manifest/chunk populations (including extras). Live authority and current anchor
are confirmed around callbacks and at final completion, even for empty books.
Observer callbacks remain provisional. This audit alone does not prove accounting
admission, effect projection or derived-index completeness. The final owner must
compose complete accounting replay and index audits before readiness. Targeted
source lookup requires an independently authenticated expected record hash and
validates the predecessor state/full head; stored metadata alone does not prove
canonical-prefix membership. A targeted non-genesis source uses two record reads
and no complete-population count. Genesis source resolution remains bounded full
genesis projection, not a constant-cost claim independent of genesis size.

The composed tests use real canonical, source and group storage in one SQLite
transaction with actual kernel-generated committed/rejected outcomes. Independent
full kernel replay reproduces the exact durable book. All genesis schema and
composed publication write failures roll back, permit the genuine plan to retry,
and reject later stale/forged/cross-store/expired-transaction publication. Tests
cover gaps, missing/corrupt/extra chunks and manifests, split UTF-8, oversized or
incorrectly typed stored values, scope/hash mismatch, callback failure, owner
revocation and publication races. Five actual SIGKILL child processes terminate at
canonical chunk, canonical head, source catalog, group catalog and committed
boundaries in temporary WAL/FULL SQLite databases. Restart obtains exactly the
old or complete new history; full accounting replay and source/group audits pass.
Temporary databases were removed after verification. This is local process-crash
evidence, not power-loss, Cloudflare runtime or disaster/account-loss certification.

Focused result: 9 tests / 368 assertions, with one child-only driver skipped in the
parent and executed explicitly by the process tests. Log:
`/tmp/rastrata-indexed-canonical-focused.log`. The same suite's diagnostic reports
100% functions/lines for `indexed-canonical-store.ts`; imported-module totals are
57.52% / 54.87%, so the global-threshold diagnostic exits 1. This is not a passing
ledger-wide coverage gate. Log: `/tmp/rastrata-indexed-canonical-coverage.log`.
Build-valid controls bypassing expected source-hash equality and accepting extra
manifest/chunk populations both fail their targeted tests. Production source was
restored exactly; these are two controls, not a complete mutation campaign. Logs:
`/tmp/rastrata-indexed-canonical-negative-{hash,population}{,-build}.log`.

Source SHA-256 `193afe5c8241e6f493194c4d5b35a9b2b09d008026a69ec0460856b8f281578d`;
test `7a9038cca3334dd1a424f4a7eec0ef07f5d8ddb2c959284da1d5c4ca88cb7b94`;
ledger model `4c5dc1d838e3f849b97e21420d2ba59b7af950b139df600351c443ab08a62ad2`.
Full root `bun run check` exited 0 on these final source/test/model hashes:
739 ledger tests / 84,416 assertions (one child-only driver skipped in the parent),
328 kernel tests / 58,546 assertions; types, lint, boundaries, format, tooling,
design and trace passed. The kernel-only coverage gate remains 100% functions and
lines across 14 production sources. Log: `/tmp/rastrata-indexed-canonical-check.log`.
Licensed SysIDE passes both models/workspace with zero diagnostics and diagnostic
controls: `/tmp/rastrata-indexed-canonical-syside.log`. Kernel release still stops
at incomplete ACC-039.7/.8/.9 trace, before later release stages:
`/tmp/rastrata-indexed-canonical-release.log`.
The existing compact owner, kernel semantics, preserved historical fixtures and
capacity limits remain unchanged. Final new-format owner integration still needs
permanent-ID root publication, complete admission/read sets, live fences, durable
acknowledgement and full accounting recovery. Archival/MVCC/reclamation, safe
adoption, business-scale performance and release blockers remain open. No cloud
deployment, provisioning, push or spending occurred.

## Compact indexed owner: incremental retention integration

2026-09-06 — The existing `SqliteIndexedBookStorage` compact-format owner now
chains `retainInsertion` for every entry produced by its actual canonical identity
delta, then calls `registerRetainedAppend` for the final chain. Retained rejections
reserve command IDs too; an empty delta cannot authorize publication. The existing
canonical outcome, enabled source/group catalogs, root selection and pin consumption
still publish under the same transaction and full-view/fence checks. No kernel
arithmetic, durable format, historical fixture, startup audit or capacity limit
changes. This integrates the physical component described in the historical section
below; it does not enable the separate indexed financial-state/source/group profile.

The real-owner test creates 412 permanent identities through five bounded balanced
journals and activation. It then publishes a journal and a retained rejection,
asserts all five new identities use genuine insertion retention, and counts exactly
the new proof pages read in each retention operation. A guard refuses the old
whole-index retention API. The reopened complete durable book matches independent
kernel command execution; group catalogs and original committed/rejected retry
receipts remain exact. A single 400-posting test command exceeded the existing
10,000-node command-copy bound, so the fixture uses five 80-posting commands without
relaxing that bound. This is not a demonstrated increase in book capacity.

Real-owner descriptor-insert rollback and lost-sync tests verify no accounting or
selected-root publication, successful reopened recovery, and exactly-once retries.
Existing canonical/root/pin rollback tests also pass. Focused result: 3 tests,
109 assertions, `/tmp/rastrata-owner-retention-faults.log`. A build-valid negative
control replaced final incremental registration with the old whole-index retention
API; the new owner test failed at its explicit guard. Typecheck passed first, and
the production source was restored to SHA-256
`33c2e330a7343ce95be6e56e79557e6faae4d06e054b13deb16444529abf5b8d`.
Logs: `/tmp/rastrata-owner-retention-negative{,-build}.log`.

Full root `bun run check` exited 0 on the final production/test/model sources:
730 ledger tests / 84,048 assertions, 328 kernel tests / 58,546 assertions, plus
types, lint, boundaries, format, tooling, design and semantic trace checks. Log:
`/tmp/rastrata-owner-retention-check.log`. The coverage gate is kernel-only:
100% functions and lines across 14 sources, not a ledger-wide coverage claim.
Licensed SysIDE validated both models/workspace with zero diagnostics and passed
its diagnostic controls: `/tmp/rastrata-owner-retention-syside.log`. Kernel release
still exits 1 at complete trace on ACC-039.7/.8/.9, before later release stages:
`/tmp/rastrata-owner-retention-release.log`. No cloud deployment or capacity
campaign was run, and the kernel/historical fixture checksums are unchanged.
Final owner test SHA-256:
`18c704f4a32e2e642f6eec761a0bd58e2e919b3ffd551db8b893863b57544c95`;
ledger model:
`ba8e7a788db7bda1230c922ff3553aaecb400c78cfffbe7c79164e66ba5b6946`.

Each intermediate insertion now retains a descriptor and confirms durability.
This can add work for small books. Only retention-phase page-read boundedness is
established, not end-to-end speedup or Cloudflare throughput. Full-history startup
and post-publication re-verification remain; complete indexed admission, safe
adoption/recovery, storage growth and the approved workload campaign remain open.

## Bounded physical COW index retention

2026-09-06 — Physical-publication integration exposed another history-dependent
operation: `retainPreparedRoot` walks the entire hot index. That legacy path remains
available for audit/adoption; a new opt-in path retains actual COW insertion chains
using an inductive preservation proof instead of rescanning unchanged pages.

The insertion builder privately records immutable before/after roots, entry and
new page references under the original plan object. Structural copies cannot claim
that provenance. The page store requires the first base to equal the selected hot
root, or a subsequent base to match its own same-pin retained certificate. Nonempty
bases need exact retained descriptors; each inserted identity is for the next
Oseq. Under genuine same-port construction authority, verify globally allocated
ownership and exact expected bytes for every new page, insert/read back the new
descriptor and confirm durability before issuing an ephemeral certificate. The
unchanged immutable base remains protected by the current view/construction pin;
its prior integrity and canonical completeness are owner obligations, not inferred
from a descriptor alone. This API does not permit old-page mutation or reclamation.

The final registration requires the same store certificate, exact pin/view and
expected population increment, and reuses the existing durable root registration.
Certificates cannot be reconstructed from caller digests or reused across pins or
store instances. Lost replies leave no successful certificate and require explicit
control/page-store uncertainty reconciliation. Final canonical/index selection and
pin consumption still use the existing atomic full-view/fence transaction. No
accounting/source/group binding or cross-partition ID absence is inferred by this
physical-layout component, and no enabled owner switches to it in this change.

The quantitative test publishes through incremental retention/registration FIRST;
only afterward does it measure the full-scan baseline and independently enumerate
every resulting key/Oseq. This order prevents the full-scan baseline from supplying
missing retention work to the path under test. Measured physical page reads:

| Prior identities | Full-scan retention | Incremental retention | Registration |
| ---: | ---: | ---: | ---: |
| 400 | 3 | 2 | 0 |
| 4,000 | 21 | 2 | 0 |
| 16,000 | 83 | 3 | 0 |

These are real local Bun SQLite page-read counts with a synthetic canonical anchor,
not end-to-end ledger throughput/latency, Cloudflare certification or capacity
acceptance. Total append work still includes path reads, allocations, page writes
and durability operations. The production owner must opt into this path after its
remaining semantic/publication integration; the old enabled path is unchanged.

Tests cover genuine-plan provenance, retained chain continuation, forged/copied
certificates, cross-store/pin misuse, same-pin allocated-page ownership, missing
base/new pages, substituted but rehashed valid page bytes, SQL rollback, lost sync,
explicit reconciliation, stale fences and atomic canonical-write rollback/retry.
Two build-valid controls were killed: skipping comparison with the planned page
hash (accepted substituted bytes) and adding a whole-page-store scan (page reads
exceeded the path-sized bound). Sources were restored to exact checksums. Logs:
`/tmp/rastrata-index-append-negative-{bytes,scan}{,-build}.log`.
These are targeted correctness/performance controls, not a complete mutation score.

Final focused page/layout/retention tests pass: 27 tests / 42,297 assertions, after
moving baseline measurement after publication. Typecheck and Biome check pass on
the final files. Evidence: `/tmp/rastrata-index-append-focused-final.log`.
The broader selected diagnostic passes 76 tests / 42,779 assertions; file coverage
is 98.77% functions / 99.16% lines for the page store and 95.92% / 79.49% for page
algorithms. It is not 100% file or ledger coverage; the overall imported-module
34.58% / 40.84% totals cause exit 1 under the global threshold. This diagnostic
predates the baseline-order test hardening (production sources are unchanged).
Log: `/tmp/rastrata-index-append-coverage.log`.

Root `bun run check` exited 0: 728 ledger tests / 83,975 assertions, 328 kernel
tests / 58,546 assertions; types, lint, boundaries, format, tooling, design and
trace passed. This run began before the final baseline-order test hardening;
unchanged production sources are covered by the full run, and the hardened final
test plus related page tests/typecheck/Biome check passed separately as recorded
above. Log: `/tmp/rastrata-index-append-check.log`. The kernel-only coverage gate
remains 100% functions/lines across 14 production sources; it does not certify
ledger coverage. Licensed SysIDE passes both models/workspace and diagnostic
controls: `/tmp/rastrata-index-append-syside.log`. Kernel release still fails at
complete trace on ACC-039.7/.8/.9 before later release stages:
`/tmp/rastrata-index-append-release.log`.

Snapshot SHA-256: page algorithms
`f0ea98531e5a091424522b5650da4771e4295eb8792ca18587a0072ab4f621e1`;
page store `6be7dadd20a465fdfc9e374683dc2110dab323512a157eb53d3a11610c41771d`;
final test `f50bde662b06c79c6c7944b8dcc2163b00e0fb35e0051b4bed2b2e7c54a88e07`;
ledger model `7fd048a921a76ca68d52a554d61b131134c35334ce6f1b5702126b90458c8e64`.
Production owner integration, full identity/source/group outcome atomicity,
complete indexed admission/recovery and the production workload campaign remain
open. This physical-retention proof is not a production-readiness declaration.

## Indexed outcome-bound permanent-identity projection

2026-09-06 — Added an indexed entry point around the existing permanent-identity
rules. The legacy payload projection and key schema are unchanged. The new entry
point takes the source instance's opaque prepared candidate and exact indexed
outcome bytes. It rejects genesis, decodes against the prior full scoped head/state,
and requires byte-exact resulting state/head agreement with the source candidate.
This prevents a valid outcome B from supplying identities for prepared outcome A.

Each touched identity requires authenticated absence across both owner partitions
or original source evidence from the pinned canonical prefix. Returned evidence
must have closed own data fields; copy/decode its sequence, indexed bytes and
authority before yielding again. Validate older positive Oseq, complete physical
scope/actual object, strict indexed framing and exact expected record commitment.
Only then feed the original payload into the unchanged raw book/family/ID checks.
Retained rejections contribute command IDs; repeated lot snapshots keep original
creation locators. Ordinary ID conflicts remain forbidden. Version-scoped
configuration IDs are not incorrectly made globally single-use.

The live owner and source candidate are checked around each lookup and at return.
Review removed repeated serialization of the complete prepared row set per ID:
the source instance already owns immutable row arrays and validates its current
prior catalog/full anchor. Recheck its prior/resulting commitments and immutable
row-array identity instead. This is an avoided local repeated-work cost, not a
capacity benchmark. Missing storage and revoked authority never become absence;
the helper makes no writes and does not issue durable receipts.

Seven new tests compare every accumulated identity with the independent complete
historical identity oracle across real commercial, lots, allocation/tax and FX
workflows, using genuine legacy oracle framing alongside the new indexed records.
They test original lot locators after depletion, independent rejected-outcome
sequences, swapped valid candidates, forged handles, racing publication, complete
scope/source substitutions, malformed/accessor evidence, unavailable storage,
revoked pins, evidence mutation during confirmation and uninstalled genesis.
Historical-evidence fault tests use a genuinely matching old lot identity so an
unrelated raw-ID mismatch cannot hide missing scope/hash validation. The owner
fixture is synthetic; these tests do not implement physical identity indexes.

Three build-valid negative controls were killed: removing exact candidate binding,
ignoring the source's actual object ID, and ignoring the expected source record
hash. The strengthened tests failed by accepting the deliberately invalid evidence
in each case. Restore checksum after each control:
`55d49da54cab91b06dd75af8ee2d9ff04239d240474cd816159e02cb7d7bf6d3`.
Logs: `/tmp/rastrata-indexed-identities-negative-{candidate,object,hash}{,-build}.log`.
These controls are not a full mutation campaign.

The combined new/legacy identity suite passes 17 tests / 383 assertions. Focused
coverage reports 96.43% functions / 93.11% lines for `outcome-identities.ts`, not
100%; the report lists uncovered legacy activation/close-package/exhaustive-guard
code. Overall imported-module coverage is 73.77% functions / 69.48% lines and the
diagnostic command exits 1 under the global threshold despite all selected tests
passing. No exclusions or artificial impossible-effect calls were added to raise
the number. Evidence: `/tmp/rastrata-indexed-identities-{focused,coverage}.log`.
Licensed SysIDE passes both models/workspace and its valid/syntax-error/unresolved
reference controls with zero diagnostics: `/tmp/rastrata-indexed-identities-syside.log`.
Kernel release still fails at complete trace on ACC-039.7/.8/.9, before later gates:
`/tmp/rastrata-indexed-identities-release.log`.

Snapshot SHA-256: identity source
`55d49da54cab91b06dd75af8ee2d9ff04239d240474cd816159e02cb7d7bf6d3`;
new tests `53985bc217a6052533d4d08e808c7947428beea3b2e7c7d1b77f61f7a0902727`;
ledger model `43b5facdc9cb43532ee5d99b2359f93c3f7b457958508645bd71b50d80971212`.
Kernel book/codec/model hashes match the preceding review. The new helper reuses
the existing framed outcome codec and does not rewrite historical payloads.

Final root `bun run check` exited 0: 724 ledger tests / 43,120 assertions and
328 kernel tests / 58,546 assertions. Types, lint, boundaries, format, tooling,
both design checks and trace passed; the existing kernel-only coverage gate remains
100% functions/lines across 14 production sources. Evidence:
`/tmp/rastrata-indexed-identities-check.log`. This result is not closure of the
remaining physical identity-root, indexed-owner, capacity or release obligations.

The production owner still must authenticate original-prefix membership and
first-creation index completeness, construct and audit physical identity roots,
publish those roots with the exact associated source/group candidate under the
same full-head/fence transaction, and confirm durability. Complete indexed
accounting admission, recovery, archive/MVCC integration and quantitative capacity
evidence remain open. No enabled storage profile or legacy history changed.

## Complete reachable indexed-catalog audits

2026-09-06 — Added read-only source and group audit APIs for the new indexed
format. The production owner must supply a separately verified full canonical
anchor, selected catalog commitments and a live-pin source reader that authenticates
canonical-prefix membership. These inputs are obligations, not proof produced by
the APIs. Neither API is a readiness token, accounting replay or durable receipt.

The source audit snapshots the expected genesis/state/head before asynchronous
work and requires exact catalog agreement. It audits all reachable financial and
locator nodes in all 24 closed collections, checks dense ordinals and equal complete
populations, and resolves every canonical row through the existing authenticated
source reader. Owner confirmation surrounds node reads and follows row-consumer
callbacks; it provides cancellation/work-budget refusal. Internal captures are
released on success or failure. Callbacks can already have received provisional
rows when a later error occurs; callers must not infer whole-book validity or
publish readiness from a callback. Only successful completion returns the summary.

The group audit binds physical identity, full indexed head, source/group digests
and the closed collection-domain directory. While source audit streams canonical
rows, it checks all expected memberships against the stored directory/member maps.
It then walks the entire directory and all member trees, checking exact raw keys,
domains, populations, source hashes and each member's actual predicate. The two
inclusions establish equality of the complete sets; canonical logical-tree
validation supplies the deterministic shape. This avoids constructing full-book
arrays or rebuilding every group in memory. It does not waive complete canonical
accounting-history replay. Final source catalog validation is explicit even when
the group directory is empty, after the source pass has released its own capture.

The audits inspect reachable current index content only. Unreachable historical
nodes/origins/descriptors are neither adopted nor repaired; reclaiming them remains
a separate retention/MVCC responsibility. These routines make no writes and never
turn an operational cancellation or missing byte into a retained accounting result.
Their total work grows with the current populations; no latency/capacity SLO or
Cloudflare CPU-limit claim follows from a successful local test.

Tests independently compare every streamed row with complete kernel wire arrays
for actual commercial, lot, allocation/tax and FX/reversal workflows, and count
members from accounting-state predicates rather than the production projector.
Separate close/reopen tests cover the seventh predicate. Adversarial fixtures
recompute valid node, descriptor and catalog hashes around missing groups/members,
stale hashes, wrong lot IDs, absent source rows, depleted holdings incorrectly
classified as nonzero, and wrong collection domains. Structural consistency is not
accepted as semantic correctness. Other cases cover genesis/empty directories,
retained rejections, stale anchors, owner cancellation, observer failures,
publication races, late missing/corrupt evidence, post-source-pass substitution and
unreachable garbage. The SQLite owner is still a synthetic canonical harness, not
the production indexed adapter or a process/power-loss/cloud recovery proof.

Two build-valid negative controls were killed: skipping retained-result history
in the source audit, and omitting final source validation for an empty group
directory. Each caused the intended corruption test to accept invalid evidence;
both sources were restored to their exact checksums. Logs:
`/tmp/rastrata-indexed-catalog-audit-negative-{history,final}{,-build}.log`.
This is targeted test-strength evidence, not a complete mutation certification.

Licensed SysIDE passed both models and the complete workspace with zero
diagnostics and its valid/syntax-error/unresolved-reference controls:
`/tmp/rastrata-indexed-catalog-audit-syside.log`. The selected combined coverage
run passed 80 tests / 8,929 assertions and reports 100% functions/lines for both
catalog source files. Overall imported-module coverage is only 70.77% functions /
68.78% lines, so that diagnostic command exits 1 under the global threshold. It
is not a passing aggregate coverage gate or ledger-wide certification. Evidence:
`/tmp/rastrata-indexed-catalog-audit-coverage.log`. The kernel release gate still
fails at complete trace on ACC-039.7/.8/.9, before later release stages:
`/tmp/rastrata-indexed-catalog-audit-release.log`.

Snapshot SHA-256: source catalog
`f8a5fb4d4e74dc057d869292ccd5610366b83acc6617d9b4a8add1acedc5ae80`;
group catalog `d109d60a5971f3ad5e5cd0d08c80876ee150677df6a1dd207ea9e6a713d98868`;
audit tests `629af67d0fdcf0ab2a6d1663de146b239dcce74ee8a0f6dd5782b555cbb6f2a8`;
ledger model `c323b9f68622fa2a0f5533f23ec755ec471fe8c3289566d2947785dec798827f`.
Neither the enabled owner/profile nor the kernel or historical fixtures changed.

The final root `bun run check` exited 0: 717 ledger tests / 42,856 assertions;
328 kernel tests / 58,546 assertions; types, lint, boundaries, format, tooling,
both design checks and trace passed. The kernel-only coverage gate remains 100%
functions/lines across 14 production sources. Log:
`/tmp/rastrata-indexed-catalog-audit-check.log`. All seven preserved historical
fixture checksums and kernel book/codec/model checksums match the preceding review.
Full indexed owner integration, canonical accounting replay, permanent identities,
admission completeness, durable confirmation, report snapshots, archive/reclamation
and the approved quantitative production workload campaign remain open.

## Indexed semantic-group transactional companion

2026-09-06 — The group catalog now has an explicit, separately persisted
`rastrata-indexed-group-catalog-v1` profile. The legacy candidate-v2 profile, tables,
hash preimages and full-projection/rebuild API remain separate. Indexed preparation
accepts only the source catalog instance's prepared row sequence, authenticates
first-touch previous rows against their exact source/head/domain/ordinal/hash, and
applies repeated changes at one ordinal in their original order. It derives all
seven closed predicates, updates changed row hashes even when membership stays the
same, and removes obsolete members without removing depleted holdings from the
all-holdings groups. Directory/member updates share the existing authenticated map
implementation. Preparation caps staged nodes/descriptors at 32 MiB and prunes only
new intermediate content; no old-node garbage collection is enabled.

New metadata binds the complete indexed head and exact resulting source digest.
Publication requires both the active same-port transaction and exact source
candidate publication, immutable-content readback, prior-group CAS, and final
source/group/anchor checks. Rollback must leave source and group handles retryable.
The synthetic SQLite owner fixture now composes canonical, source and group writes
in one transaction; it is not a production adapter, fence/admission implementation,
process-recovery test or durability receipt.

An independent test oracle enumerates groups from actual accounting-state arrays,
without calling the production membership projector or delta builder. It compares
complete ordered populations and row hashes, including one-row pagination and
source-row authentication after every commercial, lots, allocation/tax, FX and
close/reopen command. Tests also exercise unchanged groups under rejections,
component reconstruction, each SQL-write/DDL rollback, forged/foreign authority,
wrong old-row fields, revoked pins, publication races, post-write substitutions,
damaged member/directory bytes and stale captures. The first old-row fault tests
incorrectly selected an acquisition that only appended rows; their rejection
assertions failed. They now select an actual transfer and require an old-row read,
so an unexercised callback cannot pass as fault evidence.

Three build-valid negative controls were killed: skipping a required member
removal, retaining a stale member hash when membership is unchanged, and consuming
the group handle before the owner could roll back. The independent tests failed
on wrong population, wrong row hash, and failed exact retry respectively. Sources
were restored to exact checksums after each control. These are targeted controls,
not a complete mutation score. Logs:
`/tmp/rastrata-indexed-group-negative-{removal,hash,retry}{,-build}.log`.

The publication-order review found an additional issue before final validation:
matching stored source bytes alone did not prove publication occurred in the same
transaction. A build-verified new test reproduced acceptance after deliberately
committing canonical/source data separately. Source publication now records the
exact candidate under a weak transaction-local key; companion assertions require
that marker as well as the genuine active same-port token and exact stored data.
Expired or rolled-back transactions cannot confer authority on another transaction.
This prevents split publication from masquerading as atomicity; it cannot prevent
an incorrectly implemented owner from committing source-only data in the first
place. The production owner remains responsible for composing all required writes.
The split test now passes, together with rollback/retry tests. Evidence:
`/tmp/rastrata-indexed-group-negative-split{,-build}.log` (pre-fix reproduction),
`/tmp/rastrata-indexed-group-focused-final.log` (20 tests, 5,917 assertions).

Snapshot SHA-256: group source
`b26ea97c564f7ee6c041aad2493e1609183c817e9d4f430657eef7921c27b4ff`;
source catalog `0cda23df8c8679b68d8d52b13d91956cc5b431fd1f83f38568a2f511a8e2480d`;
group tests `d14e8474a56757a72e6e6b598fcd4975695b2f9494bdad8e0887ccab22a92f1a`;
shared synthetic owner fixture
`77b2d9cf53c1ec365e7bc7ccd832b719cffe710d7f328b5a1e8dab6c1255ba3e`;
source tests `8e397ef1d2c72f596fb6b11b28fd261212f20fe90138e2ee1c89244853102f49`;
ledger model `4e01d86a6cff20d04a50335344d37d80ffe1ea99eaca6cc66b669665f208ffe9`.
Kernel book, codec and model hashes remain unchanged from the preceding component
review. The three deliberately broken group sources were restored to the group
hash above after each control. No archive fixture or legacy codec was regenerated.

Final licensed SysIDE checks passed both models and the combined workspace with
zero diagnostics, including valid/syntax-error/unresolved-reference controls:
`/tmp/rastrata-indexed-group-syside-final.log`. The kernel release command still
exits 1 at the complete-trace prerequisite on ACC-039.7/.8/.9, before later gates:
`/tmp/rastrata-indexed-group-release.log`. Storage component tests do not close
those accounting design requirements.

Focused source/group coverage (20 passing tests) reports 100% functions/lines for
the source catalog, but 87.80% functions/88.95% lines for the shared group module
because it omits the legacy full-projection path. A combined selected run including
legacy catalog/group/owner tests reports 68 passing tests / 8,339 assertions and
**100% functions and lines for both catalog source files**. Its overall imported
module totals are 70.24% functions / 68.61% lines; therefore the diagnostic command
exits 1 under the global 100% threshold despite every selected test passing.
This is file-scoped coverage evidence, not a passing aggregate gate, complete
branch/mutation coverage or ledger-wide certification. Logs:
`/tmp/rastrata-indexed-group-coverage.log` and
`/tmp/rastrata-indexed-group-coverage-combined.log`.

The final root `bun run check` exited 0 against the transaction-binding fix:
709 ledger tests / 42,432 assertions and 328 kernel tests / 58,546 assertions;
types, lint, boundaries, format, tooling, both design checks and trace passed.
The existing kernel-only coverage gate remains 100% functions/lines across 14
production sources. Evidence: `/tmp/rastrata-indexed-group-check-final.log`.
The earlier `/tmp/rastrata-indexed-group-check.log` also passed, but predates the
split-transaction regression and must not be used as evidence for that fix.
All seven preserved historical fixture checksums match the preceding record.

No enabled owner adopts this new profile. Complete indexed historical/adoption
verification, permanent-ID indexes, complete command read sets/admission, full-head
and fence CAS, durable acknowledgement, archival/MVCC/reclamation integration and
quantitative capacity tests remain open. The legacy recovery requirement is not
relaxed by an incremental group update or by synthetic full-state test comparisons.

## Indexed source-catalog transactional component

2026-09-06 — `SqliteIndexedSourceCatalog` now prepares and publishes new-format
row-source metadata without the legacy full-projection dependency on each outcome.
It is an internal component, not an enabled `BookStorageAdapter`. A new-book genesis
may use the existing bounded aggregate decoder; a transition uses the exact indexed
outcome's projection replay against stored authenticated nodes and the actual full
financial predecessor. Source selectors come from the exact outcome and prior
collection populations. Unchanged rows retain their original origins; changed rows
update financial/locator commitments together. No automatic old-book adoption occurs.

The catalog commits the complete scoped indexed head/state, canonical genesis
commitment and closed sorted set of all 24 locator roots. Roots must match canonical
populations and ordinal endpoints. Bounded nodes/origins are content addressed.
Preparation is read-only, bounds staged node/origin bytes at 32 MiB in addition to
the row compiler caps, and prunes newly created intermediate nodes without scanning
or reclaiming old nodes. Catalog wire is bounded to 512 KiB, node/origin wire to
2 KiB and genesis input to the existing 16 MiB aggregate limit. These are operational
bounds, not business-capacity evidence or permission to raise existing adapter limits.

Publication requires an instance-local prepared handle and a genuine active
same-port SQLite transaction. It binds the resulting canonical anchor/genesis,
checks the exact prior catalog, writes and reads back immutable content, CAS-updates
the catalog and rechecks stored catalog/full anchor. A prepared handle remains
usable after rollback; committed publication cannot repeat against the old catalog.
This method does not sync or return a receipt. The real owner must still include
canonical outcome/chunks, permanent-ID/group projections, complete admission,
full-head/fence CAS and durable confirmation in one publication protocol.

Owner-issued row captures verify financial/locator paths and presence agreement,
origin bytes, exact canonical source content and indexed row commitments. Only
out-of-population absence with both paths absent is a successful missing-row result.
The owner source port must independently establish canonical-prefix membership.
Current catalog/head and the owner's live-pin confirmation are rechecked after I/O;
failure retires the capture. No complete startup, historic snapshot, archive or
account-loss recovery obligation is discharged by these component reads.

Ten focused real-SQLite tests (3,215 assertions) cover actual commercial, lots,
allocation/tax, FX, configuration and close/reopen streams; exact full-book row
comparisons; retained rejections; unchanged origin retention; same-database component
reconstruction; read-only preparation and missing predecessors; every publication
write and genesis schema step rolling back with the synthetic canonical owner;
post-write catalog/head substitutions; foreign/forged transaction authority;
independent catalog and owner head CAS; missing nodes/origins/sources; scope and
publication races; and capture revocation. The harness uses an explicitly synthetic
canonical owner and real synchronous SQLite transactions. It is not production
owner integration, actual process termination, power-loss or Cloudflare certification.
The initial combined workflow invocation exceeded Bun's default five-second test
timeout; it passed with the ledger suite's configured 60-second timeout.

Build-valid controls were killed after removing the final canonical-anchor check
and after prematurely consuming a prepared handle before a possible owner rollback.
Both sources passed typecheck first; each source was restored to its exact original
checksum. These two controls are not a complete mutation campaign. Evidence:
`/tmp/rastrata-indexed-source-catalog-negative-{head,retry}{,-build}.log`.
Source SHA-256 `297124321acb943ddbe471fe203dde5ffa7eb37aba055f03d168101d0c8de042`;
tests `c9b35929b11878f9e8d28c6dd39581f194d78ee68471660bb8deeaf15d8155fb`;
ledger model `d1ebd0192c9b457a535d44d53632ff0c682fffeff5c8e42f0301c095718edd18`.

Licensed SysIDE passed both models/workspace and negative controls after correcting
a reserved identifier in the new declaration. Kernel release still fails on
ACC-039.7/.8/.9 before later stages. Root `bun run check` passed the complete
ten-test snapshot: 699 ledger tests / 39,730 assertions, 328 kernel tests / 58,546
assertions, types, lint, boundaries, format, tooling, design and trace. The existing
kernel-only coverage gate reports 100% functions/lines across 14 production sources.
It does not certify ledger coverage. Logs:
`/tmp/rastrata-indexed-source-catalog-{check-final,focused,syside,release}.log`.
Focused coverage was measured separately. It initially reported 100% lines and
97.37% functions; LCOV showed 37 of 38 functions covered without per-function
locations. The redundant empty-reader closure used only for insertion into an empty
genesis locator tree was replaced by the existing authenticated genesis node reader.
No artificial callback-invocation test or coverage exclusion was added. Final focused
measurement reports **100% functions and lines for this new catalog file**; all ten
tests still pass. Both build-valid controls were repeated against the final source
and restored to the checksum above. Log:
`/tmp/rastrata-indexed-source-catalog-coverage-final.log`.
The diagnostic command itself exited 1 because the focused suite also imports
kernel modules without their complete test suite, under the global 100% coverage
threshold. This is not a passing aggregate coverage gate or ledger-wide coverage
claim; complete ledger coverage and branch/fault/mutation closure remain required.
Kernel book/codec/model, the preceding source/chain/compiler modules and all seven
preserved historical fixture checksums remain unchanged.

Next: replace `SqliteSemanticGroupCatalog.prepare`'s old/new full legacy projections
with authenticated new-format row/group deltas, then combine these source/group
catalogs with the existing permanent-ID control's prepared publication and a new
canonical indexed owner. Its accounting admission, fencing, durability, full startup
verification and migration must remain explicit. No production-readiness or capacity
closure, deployment, provisioning, push or external spending occurred here.

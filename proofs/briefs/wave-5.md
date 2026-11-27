# Wave 5: the book (`book.ts`, `codec.ts`, `projection.ts`, `current-journal.ts`)

Read `proofs/README.md` first and follow it to the letter, then `proofs/briefs/wave-3.md` (what a modelled type and
function are, the five kinds of law, what a report holds) and the head and style of the finished files you import.
`book.ts` is 5,360 lines and is the heart of the kernel: the state of a book, the eighteen commands, the revision
chain, replay. It is modelled in modules of 200 to 450 lines of TypeScript each; a module builds before anything that
imports it is started.

## The module plan

| Order | Module | `book.ts` | What is in it |
|---|---|---|---|
| 1 | `Book/Types.lean` | 251 to 700 | `CorrectionLink`, `BookedLotAllocation`, `LotOperation`, `LotStateEffect`, `LotChangesEffect`, `ClosePackage`, `PeriodTransition`, `BookEffect`, `RevisionRecord`, `BookState`, the commands (`CommandCore` to `UnsealedBookCommand`, `BookCommand`), `BookCommitIntent`, `RetainedCommandResult`, `BookProtocolState`, `BookCommandResult`, `AtomicBookCommit`, `Evaluation`, and the tiny pure functions that need nothing else (`inventoryDisposalSelectionMatches`, `applyLotChanges`) |
| 2 | `Book/Hashing.lean` | 678 to 1094 | the canonical values of the book (`resolvedValue`, `lotValue`, `commandValue`, ...), `hashBookConfiguration`, `hashBookConfigurationSnapshot`, `createBookConfigurationSnapshot`, `hashChainHeadStateCommitment`, `hashBookState`, `commandInputHash`, `sealCommand`, `hashLotChanges` |
| 3a | `Book/Create.lean` | 1095 to 1534 | `createBookState`, `createBookProtocolState`, `commandTimelineIsValid`, `periodIsClosed`, `validatePeriods`, the profile validators, `validateStateHashAtAdmission`, `validateRetainedConfigurationSnapshots`, `validateConfiguration` |
| 3b | `Book/Periods.lean` | 1535 to 1900 | `resolveRecostingPeriod`, `resolveBookAccountingPeriod`, `hashBookLedgerCutoff`, `hashChart`, `admissionForPolicy`, the `immutable*` copies (`Object.freeze`: identity in the model, say so) |
| 4a | `Book/Journal.lean` | 2638 to 2905 | `prepareOrdinaryBookJournal`, **`prepareBookJournal` (the one place a journal is admitted)**, `exactReversal`, `hashLotState`, `prepareLotState` |
| 4b | `Book/Prepare.lean` | 1902 to 2330 | `inventoryCostJournalDraft`, `resolvePreparedJournal`, `prepareAccountingCalculation`, `prepareGeneratedAccountingJournals`, and the currency, tax, consolidation, open item, settlement and allocation preparation |
| 4c | `Book/Sources.lean` | 2324 to 2640 | source validation: `validateAllocationPostingPlan`, `validateAllocationSource`, `resolveCanonicalPosting*`, `validateOpenItemSource`, `validateSettlementSource`, `validateRemeasurementSource`, `validateAccountingSourceClosure` |
| 4d | `Book/OwnedInventory.lean` | 2906 to 3131 | `prepareBookOwnedInventory`, `prepareOwnedInventoryFromReads`, `prepareOwnedInventoryCommandEffects` |
| 5 | `Book/Effects.lean` | 3132 to 3372 | `canonicalBookEffectValue`, `resultHash`, `rejectEvaluation`, `hashCommitIntent`, `makeIntent`, `prepareBookIntent` |
| 6 | `Book/Evaluate.lean` | 3373 to 3858 | `evaluateBookCommandProtocol`, `validateBookFinancialIdentity`, `validateBookGlobalAdmission`, `evaluateBookCommandAdmission`, **`evaluateBookCommand`** (the switch over the commands) |
| 7 | `Book/Lifecycle.lean` | 3859 to 4278 | `prepareBookClose`, `prepareFullBookReopen`, `prepareBookReopen`, `prepareBookConfigurationChange`, `prepareBookCorrection` |
| 8 | `Book/Apply.lean` | 4279 to 4695 | **`applyEffects`**, `validateIntentEffects`, `latestBookAccountingDate`, `validateBookEffectTopology` |
| 9 | `Book/Validate.lean` | 4696 to 5137 | **`validateBookState`**, `validateBookProtocol`, `commitBookIntent`, `prepareBookCommitRecords` |
| 10 | `Book/Execute.lean` | 5138 to 5360 | **`executeBookCommand`**, `applyRecordedRevision`, `applyRecordedOutcome` and the recorded-step machinery |
| 11 | `Book/Theorems.lean` | | the theorems about every reachable book (below) |
| 12 | `Codec.lean`, `CurrentJournal.lean`, `Projection.lean` | `codec.ts`, `current-journal.ts`, `projection.ts` | the durable codec, the current-journal evaluator, the account balance projection |

`BookHistory.lean` already proves that the append-only log is a list (its `toList`); the model of `BookState` here uses
lists for `journals`, `revisions` and the retained results and says so: that is the bridge, and `applyEffects` appends
to them exactly as `Log.append_toList` says.

## The theorems the whole work is for (`Book/Theorems.lean`, written last)

Over every state reachable from `createBookState` by `executeBookCommand` (define `Reachable` as the inductive
closure, with the activation command first; a rejected command leaves the state unchanged):

1. **Every booked journal balances**: for every `booked ∈ state.journals`, the book values of `booked.journal` add up
   to exactly zero. The proof is by induction on the commands: every `journal` effect an accepted intent contains was
   produced by `prepareBookJournal` (so by `admitJournal`, `admitted_journal_balances`); show that for each of the
   commands, one lemma per command.
2. **The history is gap-free and append-only**: `bookRevision = revisions.length`, `latestPostingSequence =
   journals.length`, posting sequences run 1, 2, 3, ...; a command either is refused with the state unchanged, or the
   new state's `revisions` are the old ones with exactly one more at the end and its `journals` the old ones with the
   new journals at the end (nothing earlier changed).
3. **The revision chain links**: each revision's `previousHash` is the previous one's `chainHash` and its `chainHash`
   is the hash of its book, number, `previousHash` and `effectsHash`; two reachable books with equal chain heads have
   equal histories, or a `HashCollision` is in hand.
4. **A reachable state replays**: `validateBookState state = []`.
5. **A command identity is settled once**: executing a command whose id was already used returns the retained result
   when the input hash is the same, and refuses with `command_identity_conflict` otherwise, in both cases without
   changing the state.
6. **A closed period takes no ordinary posting**: an ordinary journal dated in a period that is closed is refused.
7. **The ledger balances as a whole** (with `Projection.lean`): the account balances rebuilt from the revisions add up
   to zero, in every commodity, for every reachable state.

Each theorem is stated once, plainly, with a one-sentence doc comment a bookkeeper would recognise.

## Rules for every module worker

- The model is typed: a run-time check of something TypeScript's types already guarantee is modelled as passing
  (list where). A check the types do not guarantee is modelled. A function that throws is `.error`.
- A function that collects diagnostics returns the same diagnostics in the same order (code, path, requirement ids,
  message). A read context (an object of functions) is a structure of functions.
- `Object.freeze`, copies and object identity are not modelled; a `Map`, `Set` or `Record` is an ordered list; a loop
  is structural recursion or a fold with the same bound.
- Two kinds of law for every function: soundness (what an accepted input guarantees) and completeness (what is
  accepted), so that the conditions are exactly the function's; plus the conservation, hash and order laws of
  `wave-3.md`.
- For the modules that PRODUCE effects (4a, 4b, 4d, 6, 7): the law "every `journal` effect it produces carries a
  journal that `admitJournal` admitted, or one built from such" is stated as a named predicate over the effect list
  (`AllJournalsAdmitted`) in `Book/Types.lean` or the first module that needs it, and proved for each producing
  function; module 11 combines them.
- A law that is false for what the TypeScript does is not bent: the strongest true version is proved and the gap is
  reported (file, line, input, result).

## Reports

As in `wave-3.md`: the files; what is modelled and left out; each law with its theorem name; the exact result of the
final build (errors and `sorry` warnings); every `sorry` left and why; every place the model and the TypeScript can
differ; every place the TypeScript does something a law did not expect.

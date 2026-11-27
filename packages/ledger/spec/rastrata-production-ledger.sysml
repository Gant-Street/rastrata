package RastrataProductionLedger {
    private import ScalarValues::*;
    private import RastrataAccountingBackend::*;

    package Domain {
        attribute def Identifier :> Semantics::Identifier;
        attribute def Digest :> String;
        attribute def FormatVersion :> String;

        enum def ServiceFailure {
            unauthorized; identityMismatch; malformedEnvelope; unsupportedVersion;
            capacityExceeded; overloaded; contentionExceeded; unavailable;
            uncertainWrite; historyGap; corruptRecord; headMismatch;
            restoreAuthorityMissing; restoreCutoffMismatch; incompatibleMigration;
        }
        enum def RetentionDecision { retainCommit; retainRejection; replay; unretained; }
        enum def CatalogStatus { reserved; active; maintenance; retired; }
        enum def CatalogMutationKind { reserve; activate; beginMaintenance; sealFence; authorizeRestore; finishMaintenance; }
        enum def RestoreInstallPhase { selected; installed; }
        enum def RestoreInstallDisposition { installed; alreadyInstalled; }
        enum def NativeIdentityObservation { present; absent; }
        enum def NativeRestorePhase { scan; replay; replayed; verified; prepared; active; }
        enum def NativeArchiveProgressStatus { caughtUp; pending; }

        item def NativeJournalInputs {
            item header : RastrataAccountingBackend::Domain::BookStateHeader;
            item configuration : RastrataAccountingBackend::Domain::BookConfigurationSnapshot;
            item opening : RastrataAccountingBackend::Domain::OpeningBoundary[0..1];
            item previousRevision : RastrataAccountingBackend::Domain::RevisionRecord[0..1];
            attribute activationIdentity : Semantics::ContentHash[0..1];
            doc /* New current-state kernel boundary, never a sparse BookStateSnapshot.
            Supply exact retained-command, journal-ID, posting-ID, period-status,
            overdue-remeasurement and managed-inventory-scope observations in the
            same synchronous SQL transaction. Unknown evidence is not absence.
            Configuration lineage is admitted by storage, then the kernel verifies
            full configuration contents/hash, financial identity, protocol ordering,
            opening, journal policy, periods, topology and managed-scope protection.
            The native-book-commands-owned-inventory-v1 candidate permits new-zero activation,
            ordinary/adjustment journals, exact corrections, period close/reopen and
            prospective complete configuration changes, taxed transactions and
            allocation schedule creation, recognition and revision, open-item recognition
            and settlement recognition plus dated later applications of retained
            payments against retained open items, monetary classification and
            currency remeasurement with exact retained-result reversals, and
            compilation into a distinct consolidation target book, and owned
            inventory version 1.2.0 acquisition, issue and transfer.
            Legacy lot commands, adoption and other specialized policies remain unsupported. One command
            may produce multiple journals within the repository's fact-count and
            byte limits; their publication order is posting sequence,
            not lexical journal identity order.
            Prior native-ordinary-journal-v1, native-book-commands-v1 and
            native-book-commands-money-scopes-v1 layouts are not adopted implicitly:
            absent balances or permanent source-reference indexes cannot be treated
            as zero/absence. Verified explicit replay/migration is required.
            Every journal projects exact signed functional amounts by the raw tuple
            (book, account, functional commodity, canonically sorted dimension members).
            A bounded hash indexes that tuple, which is retained and checked in each
            immutable scope identity and mutable exact-rational balance. Both publish
            atomically with the outcome. An existing identity without its balance
            fails closed; a new scope requires absence of all three rows including
            its managed-inventory marker. The immutable managed marker, when created
            from an admitted ownership effect, survives depletion and zero balance.
            Money-scope observations use the same transaction and batched journal
            identity reads. This projection does not itself admit inventory commands
            or replace canonical-history verification. Overdue-FX and active monetary
            positions likewise require actual SQL evidence. Unsupported requests are
            unretained service failures, not invented accounting outcomes. */
        }
        item def NativeInventoryInputs {
            item activeHolding : RastrataAccountingBackend::Domain::LotHolding[0..*];
            item sourceLot : RastrataAccountingBackend::Domain::Lot[0..*];
            item currentPosition : RastrataAccountingBackend::Domain::InventoryPostedPosition[0..*];
            item sourceAnchor : RastrataAccountingBackend::Domain::InventoryPostedAnchor[0..*];
            item originMovement : RastrataAccountingBackend::Domain::InventoryPostedMovement[0..*];
            attribute activePoolCount : Natural[0..*];
            doc /* Read complete active account/commodity pools through the native
            partial SQL index, reconcile permanent pool identities and exact live
            counts, then authenticate holdings, lots, full anchor references and
            immutable movement after-images at the same publication head. A missing
            row/count/index is an unretained storage failure, never empty stock.
            Retain depleted positions and all permanent operation, lot, holding,
            anchor, movement, allocation and posting-reference identities. Excluding
            depleted rows from selection does not permit identity reuse. Posting
            reference membership includes canonical accounting effects outside inventory.
            Admission uses shared kernel rules and command-local working overlays;
            lot deltas, ownership artifacts, current positions, pool counts and
            money-scope updates publish with outcome/head in one SQL transaction.
            New-zero provisioning rejects existing lots/holdings and this profile
            cannot publish unowned holdings, so legacy stock absence follows from
            its closed write contract, not from accepting a caller assertion.
            Pool reads remain bounded by 10000 active rows and 1 MiB per result;
            larger active pools fail explicitly. These are implementation bounds,
            not tested enterprise capacity or any history-retention cutoff. */
        }
        item def NativeAllocationInputs {
            item schedules : RastrataAccountingBackend::Domain::AllocationSchedule[0..*];
            item recognitions : RastrataAccountingBackend::Domain::AllocationRecognition[0..*];
            item revisions : RastrataAccountingBackend::Domain::AllocationScheduleRevision[0..*];
            item sourceCandidates : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..*];
            attribute scheduleIdentity : NativeIdentityObservation;
            attribute recognitionCount : Natural[0..1];
            doc /* Complete command-scoped observations, not a partial BookState.
            Include global conflicting lifecycle identities even if they belong to
            another schedule. Recognition needs its requested ordinal; revision
            needs all original-schedule recognitions and their checked count.
            Source candidates exhaust possible configured identity aliases in
            posting order. Missing required evidence fails before admission. */
        }
        item def NativeOpenItemInputs {
            attribute openItemIdentity : NativeIdentityObservation;
            attribute financialSourceOwner : NativeIdentityObservation;
            item sourceCandidates : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..*];
            doc /* Complete retained source candidates in publication order;
            preparation also considers the same-command journal. One canonical
            posting has at most one financial source owner across open items and
            settlements. The immutable ownership index and open-item fact publish
            with the journal and outcome in one transaction. Unknown observations
            fail closed; neither reference IDs nor hashes create another budget. */
        }
        item def NativeOpenItemAllocatedTotals {
            attribute openItemId : String;
            attribute allocatedBookValue : Semantics::ExactRational;
            attribute allocatedQuantity : Semantics::ExactRational;
            attribute allocationCount : Natural;
            doc /* Exact complete prior allocation totals, atomically maintained
            with immutable allocation edges. Initialize at recognition, never infer
            zero from a missing counter on an existing open item. */
        }
        item def NativeSettlementInputs {
            item retainedSettlement : RastrataAccountingBackend::Domain::Settlement[0..1];
            attribute paymentAllocatedBookValue : Semantics::ExactRational;
            attribute paymentAllocatedQuantity : Semantics::ExactRational;
            attribute paymentAllocationCount : Natural;
            item openItems : RastrataAccountingBackend::Domain::OpenItem[0..*];
            item allocatedTotals : NativeOpenItemAllocatedTotals[0..*];
            item sourceCandidates : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..*];
            attribute settlementIdentity : NativeIdentityObservation;
            attribute allocationIdentities : NativeIdentityObservation[0..*];
            attribute financialSourceOwner : NativeIdentityObservation;
            doc /* Actual command-scoped records, global identity observations and
            complete source candidates, batched under one transaction/head. Shared
            kernel rules derive exact conservation, source direction and journals.
            Actual active-source remeasurement observations are required when
            applying payment or open-item sources governed by currency policies.
            Initialize exact payment totals at recognition, including an unallocated
            payment. Later allocations require the immutable original payment,
            its source owner and complete prior payment totals; absence never means
            zero. Atomically publish new immutable edges and both payment/open-item
            totals. Later allocation has its own open-period application date and
            advances the configuration date watermark even without a journal;
            it neither creates a second payment nor changes original payment facts.
            Fresh legacy allocations must also resolve an open payment period
            through shared kernel preparation; retain the same closed-period
            rejection as full-state evaluation. Missing period evidence throws
            instead of becoming an open period. Historical validation uses the
            pre-revision period state. Exact retries retain their original result
            after close or reopen. */
        }
        item def NativeCurrencyInputs {
            item original : RastrataAccountingBackend::Domain::RemeasurementResult[0..1];
            item reversal : RastrataAccountingBackend::Domain::RemeasurementReversal[0..1];
            item originalJournal : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..1];
            item sourceCandidates : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..*];
            attribute effectIdentity : NativeIdentityObservation;
            attribute allocatedBookValue : Semantics::ExactRational;
            attribute allocatedQuantity : Semantics::ExactRational;
            attribute sourceHasActiveRemeasurement : Boolean;
            doc /* Command-scoped current evidence consumed by the same kernel FX
            preparer as full-book execution. Source allocation totals are the exact
            authenticated payment or open-item counters, not a second accounting
            balance. Verify each active-position projection against its immutable
            result and absence of a linked canonical reversal. Select the first due
            position in publication order under the first currently selected policy
            for each ID. Explicit reversals discharge overdue obligations one at a
            time without admitting ordinary work early. Permanent result/reversal
            identities, linked journals, reversal-by-result identities and mutable
            active positions publish with the outcome atomically. Native SQL indexes
            bound healthy due/source reads; settlement batches its source lookups.
            Missing indexes fail closed instead of falling back to history scans.
            Idempotent provisioning installs these additive derived indexes;
            canonical accounting facts are never reconstructed from index fields. */
        }
        item def NativeConsolidationInputs {
            item request : RastrataAccountingBackend::Domain::ConsolidationRequest;
            attribute compilationIdentity : NativeIdentityObservation;
            doc /* Sources are supplied complete pinned cross-book observations,
            not target-book state and not permission to mutate a subsidiary. The
            shared kernel checks source revision/population pins, relationships,
            mappings, valuation paths, eliminations and exact ownership/NCI amounts.
            Target storage resolves permanent compilation and generated posting
            identities in its one transaction, applies normal period and managed
            scope guards, and atomically publishes the immutable compilation,
            journal and outcome. Unknown identity evidence cannot become absence.
            Refreshing a previously posted full snapshot requires an explicit
            correction of its old compilation journal before a replacement; the
            compilation operation does not silently replace prior booked balances. */
        }
        item def NativeBookCommandInputs :> NativeJournalInputs {
            item inventoryInputs : NativeInventoryInputs[0..1];
            item consolidationInputs : NativeConsolidationInputs[0..1];
            item currencyInputs : NativeCurrencyInputs[0..1];
            item settlementInputs : NativeSettlementInputs[0..1];
            item openItemInputs : NativeOpenItemInputs[0..1];
            item allocationInputs : NativeAllocationInputs[0..1];
            attribute latestAccountingDate : Semantics::LocalDate[0..1];
            item originalJournal : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..1];
            attribute originalAlreadyCorrected : Boolean;
            attribute originalCurrencySource : Boolean;
            attribute originalManagedSource : Boolean;
            attribute previousCloseCount : Natural[0..1];
            item currentClosePackages : RastrataAccountingBackend::Domain::ClosePackage[0..*];
            item closingJournal : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..1];
            attribute taxDeterminationIdentity : NativeIdentityObservation[0..1];
            doc /* Required observations depend on the command, not on defaults.
            Configuration uses the maximum date of ALL canonical journals,
            owned inventory movements including quantity-only movements, and dated
            settlement applications,
            including corrected journals; absence means verified empty population.
            Persist that maximum with every committed journal, never lower it for
            backdated input. Configuration evolution retains immutable snapshots,
            exact predecessor hashes and revisions; existing period status survives
            calendar replacement. Corrections resolve the exact original raw identity,
            its originating canonical outcome, currency lifecycle ownership,
            permanent correction identity and original period even when that
            period is absent from the active calendar. Unknown is never open;
            currency journals cannot be corrected outside their typed lifecycle.
            Close streams the complete journal cutoff in posting sequence order,
            with exact count and hash validation; ordinary saves never scan it.
            Period lifecycle reads reconcile retained close packages with the
            cumulative close counter. Reopen resolves current packages in publication
            order and the exact optional closing journal; missing evidence fails
            closed. A nonmonetary later close can be superseded without opening
            its period; a monetary dependent close must first be explicitly
            reopened with its exact reversal through shared kernel admission.
            Tax preparation uses the shared complete policy snapshot, tax calculator,
            generated journal quantization/dimensions and immutable effect admission.
            Resolve the determination identity and batch the actual generated posting
            identities within this same transaction. Unknown evidence fails closed.
            Tax owns its newly generated source journal; it has no historical-source
            posting dependency. The determination, journal, identities and outcome
            publish atomically; retries do not allocate another determination.
            Allocation uses a command-specific complete schedule observation,
            a globally conflicting recognition/revision identity, and permanent
            ordinal indexes. Recognition reads one selected ordinal; revision
            reads the bounded complete installment population and reconciles its
            count with the schedule lifecycle counter. A missing index, recognition,
            required revision or lifecycle record is an unretained storage failure.
            Canonical source lookup preserves the configured structural identity
            or legacy delimiter winner by indexed reads of possible split keys,
            never a full-book scan. Source resolution, cumulative posted plans,
            exact disposal clearing and effect admission use shared kernel rules.
            Outcome, all journals, accounting records and lifecycle indexes publish
            atomically. Facts use at most 1 MiB per escaped SQL batch and 4 MiB
            total escaped projection per transaction; ordinary saves use one batch.
            Managed money scopes use actual permanent markers; generic corrections
            also authenticate whether the original journal came from an owned
            inventory command and cannot bypass that ownership lifecycle. */
        }
        item def NativeJournalEvidence {
            attribute acknowledged : Boolean;
            attribute profileSupported : Boolean;
            attribute completeCurrentInputs : Boolean;
            attribute permanentIdentities : Boolean;
            attribute headAndAuthorityMatch : Boolean;
            attribute singleAtomicPublication : Boolean;
            attribute platformDurabilityConfirmed : Boolean;
        }

        item def DurabilityPolicy {
            attribute archiveRequired : Boolean;
            attribute version : FormatVersion;
            attribute contentHash : Digest;
            doc /* Pinned at genesis and disclosed with receipts. False promises
            SQLite durability only, not zero loss on primary-store destruction.
            True additionally requires independently recoverable canonical archive
            membership before acknowledgement. The launch policy is not selected
            by this type declaration. No silent downgrade or in-place policy edit. */
        }

        item def BookIdentity {
            attribute tenantId : Identifier;
            attribute bookId : Identifier;
            attribute objectId : Identifier;
            attribute namespaceId : Identifier;
            attribute generation : Natural;
        }
        item def AuthorizationContext {
            doc /* Trusted gateway decision, never accepted from caller JSON. Checked
            for every request, including retries and reads. Authorization is checked
            again on dequeue; policy revocation after this admission does not undo
            a serialized command. actorId must agree with the supplied kernel command.
            The native boundary verifies a short-lived book capability with pinned
            issuer, audience, ES256 public keys and explicit capability token type;
            no remote key URL or caller-supplied authorization object is trusted.
            Integer-second issuance/not-before claims allow at most one second
            of clock skew between issuer and verifier. Not-before equals issuance;
            the signed lifetime stays bounded and expiration has no grace period.
            Its signed identity binds all five BookIdentity fields and a mandatory
            writerFence, independent of stable book identity. Expiry,
            permission, writer fence and persisted authorizationRevision are checked inside the
            serialized SQLite transaction after asynchronous durability waits,
            before any financial read, including original-outcome lookup.
            Revocation monotonically advances an independent durable control
            revision and immutable idempotency event atomically. It never advances
            accounting outcomeSequence. A lost control acknowledgement is retried
            with current authority; an old revoked capability cannot read the event.
            Existing books without access metadata require explicit verified
            migration, never implicit revision-zero initialization. Restoring a
            financial archive alone does not restore or authorize access state.
            Writer-incarnation retirement serializes with commands and
            atomically records its actual stopped accounting head and incremented
            fence in durable control state, without an accounting outcome. It is
            permanent: after restart, writes, reads, activation and retained retries
            remain refused. Maintenance may retrieve the same retirement receipt
            and finish archiving the stopped source using its original writer fence;
            it cannot reactivate that writer. Approved restore preserves the full
            BookIdentity and canonical history while installing a higher-fenced
            writer. Its capabilities must carry the new fence; old read, execute,
            provision and maintenance capabilities remain refused even if an
            authorization revision value is reused. No missing fence defaults to zero.
            Ordinary authorization and writer checks share one bounded SQL read.
            Public blank initialization is restricted to generation zero AND writer
            fence zero; a higher-fenced empty store requires restoration. Restoration
            requires independently authorized verified recovery, not blank provisioning. Local
            retirement alone is not a restore permit or protection against rewind
            of the whole object and its control state. */
            item identity : BookIdentity;
            attribute actorId : Identifier;
            attribute authorizationRevision : Natural;
            attribute writerFence : Natural;
            attribute mayRead : Boolean;
            attribute mayExecute : Boolean;
            attribute mayProvision : Boolean;
            attribute mayMaintain : Boolean;
        }
        item def NativeCommandTransport {
            doc /* Command-only HTTP framing uses rastrata-book-command-v1, a
            bounded subtree of the kernel exact-value codec, never a supplied
            outcome or effect as authority. This transport version does not change
            the retained outcome codec or accounting algorithm version. Verify
            capability before reading a body; cap concurrent uploads at sixteen
            and command bytes at 1048576 with a ten-second upload deadline.
            Upload abort/timeout occurs before accounting admission. It does not
            cancel an already admitted command or establish non-commit after a
            lost response. Clients retry the same identity with current authority.
            Serialize receipt observedBookRevision explicitly as a decimal string;
            retain exact command/effect envelopes for paged outcome reads.
            Malformed input is a service rejection, not an accounting outcome.
            An owning Worker still supplies trusted physical routing and current
            fenced writer authority; a transport implementation alone is not that
            production integration or disaster-recovery proof. */
            attribute version : String;
            attribute encodedCommand : String;
        }
        item def FormatIdentity {
            attribute ledgerVersion : FormatVersion;
            attribute commandCodecVersion : FormatVersion;
            attribute kernelSemanticVersion : Semantics::SemanticVersion;
            attribute kernelCodecVersion : FormatVersion;
            attribute hashAlgorithm : String;
            attribute canonicalizationVersion : Semantics::SemanticVersion;
        }
        item def DurableHead {
            attribute outcomeSequence : Natural;
            attribute outcomeHash : Digest;
            attribute bookRevision : Natural;
            attribute revisionHash : Digest;
            attribute postingSequence : Natural;
            attribute configurationRevision : Natural;
            attribute configurationHash : Digest;
            attribute stateHash : Digest;
            attribute protocolHash : Digest;
        }
        item def CommandEnvelope {
            doc /* Exact versioned JSON record decoded before retention. Accounting
            counters use canonical unsigned decimal strings on the wire; monetary
            values use the kernel's exact tagged encoding. Reject duplicate keys,
            unknown fields, unsupported tags, noncanonical counters and trailing
            data. Validate every kernel variant, not a generic dictionary. Freeze
            command identity, expected revision and all timestamps before queueing. */
            item identity : BookIdentity;
            item format : FormatIdentity;
            item command : RastrataAccountingBackend::Domain::BookCommand;
            attribute encodedBytes : Natural;
        }
        item def KernelRepresentationProfile {
            attribute profileId : FormatVersion;
            attribute stateLayoutVersion : FormatVersion;
            attribute rowCodecVersion : FormatVersion;
            attribute effectCodecVersion : FormatVersion;
            attribute intentCodecVersion : FormatVersion;
            attribute revisionCodecVersion : FormatVersion;
            attribute receiptCodecVersion : FormatVersion;
            attribute hashAlgorithm : String;
            attribute canonicalizationVersion : FormatVersion;
            attribute kernelSemanticVersion : Semantics::SemanticVersion;
            doc /* Proposed indexed execution boundary, not an enabled format.
            Select an exact supported combination at new-book genesis. Legacy
            formats retain their original hashes, codecs and evaluators. A later
            existing-book transition needs a separately versioned durable bridge
            at an independently authorized exact old full head, never an in-place
            reinterpretation of stateHash or an automatic storage upgrade. */
        }
        item def LogicalCollectionCommitment {
            attribute financialIdentityHash : Digest;
            attribute collectionName : Identifier;
            attribute keyOrderSchema : FormatVersion;
            attribute population : Natural;
            attribute logicalRoot : Digest;
            doc /* Commits complete canonical row content, raw identity and required
            order, including explicit emptiness, under financial identity/profile/
            collection domain. Namespace, object ID, restore generation and fence
            bind the execution view separately and do not change this economic root.
            Independent of physical page locations, allocation and hot/cold layout.
            The existing physical IndexRoot hash is NOT this financial commitment.
            Require a closed complete catalog; missing roots are not empty roots. */
        }
        enum def SourceLocatorKind { genesis; retained; revision; effect; lotState; }
        item def SourceRowLocator {
            attribute collectionName : Identifier;
            attribute insertionOrdinal : Natural;
            attribute sourceKind : SourceLocatorKind;
            attribute sourceCommitment : Digest;
            attribute outcomeSequence : Natural[0..1];
            attribute effectIndex : Natural[0..1];
            attribute lotMember : Identifier[0..1];
            attribute memberIndex : Natural[0..1];
            doc /* Select original tagged row bytes, never a substitute accounting
            value. Genesis binds its exact stored digest; other kinds bind the
            complete canonical outcome including before/after heads. Admit only
            kind-specific selector fields. Verify the independent collection,
            insertion ordinal and row-content commitment after source resolution.
            Derive otherwise unavailable append ordinals from authenticated prior
            population. Lot-state snapshots replace rather than append arrays. */
        }
        item def CurrentRowRead {
            attribute catalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute collectionName : Identifier;
            attribute insertionOrdinal : Natural;
            attribute present : Boolean;
            attribute rowCommitment : Digest[0..1];
            attribute encodedRow : String[0..1];
            doc /* Internal immutable result from an owner-issued current-view
            context, not caller-supplied proof or a public request envelope. Present
            rows carry exact tagged bytes and their independent commitment. Absence
            requires both row and locator paths absent outside the authenticated
            dense collection population; missing required storage is an error.
            A typed form reuses the exact durable aggregate subtree schema for
            this collection, rejects noncanonical bytes and freezes decoded data.
            Schema decoding alone never proves source authenticity, local content
            hashes, cross-row closure or accounting admission. */
        }
        item def CurrentCommandRead {
            attribute catalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute commandId : Identifier;
            attribute present : Boolean;
            attribute outcomeSequence : Natural[0..1];
            item retainedRow : CurrentRowRead[0..1];
            doc /* Owner-issued semantic lookup in the captured book, not a retry
            decision. Presence binds the permanent command identity's first Oseq
            to the authenticated retained-result row at that ordinal. Verify raw
            retained command ID, embedded command ID and embedded book ID after
            digest lookup. Absence requires authenticated absence in both identity
            partitions; missing pages/sources and conflicting pointers are errors.
            Unlike mutable lot state, a command's first Oseq identifies its one
            immutable retained result, including retained accounting rejections. */
        }
        item def CurrentJournalIdentityRead {
            attribute catalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute identityFamily : Identifier;
            attribute rawId : Identifier;
            attribute present : Boolean;
            attribute outcomeSequence : Natural[0..1];
            item journalRow : CurrentRowRead[0..1];
            doc /* Identity family is exactly journal or posting. Both permanent
            partitions must establish absence; damaged storage is not absence.
            For a hit, first Oseq selects a committed retained result, whose
            observed financial revision selects the authenticated revision. Find
            exactly one matching raw journal/posting identity among its effects,
            cross-bind book/command/revision, then verify the exact booked journal
            bytes at its posting-sequence ordinal in the current journal collection.
            Never equate Oseq, financial revision and journal posting sequence.
            A posting result includes its immutable parent journal/effect lineage.
            Multiple journals in one command remain individually addressable. */
        }
        item def CurrentAccountingIdentityRead {
            attribute catalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute identityFamily : Identifier;
            attribute rawId : Identifier;
            attribute present : Boolean;
            attribute outcomeSequence : Natural[0..1];
            attribute financialRevision : Natural[0..1];
            attribute sourceRevisionRowCommitment : Digest[0..1];
            doc /* The family belongs to the closed thirteen immutable accounting
            effect types. Positive results include the precisely typed immutable
            effect selected from its authenticated creating revision. The source
            commitment is to that revision row, not an inferred effect collection
            ordinal or a claim about current balances/lifecycle status. Require
            both identity partitions, committed retained result, creating revision,
            exact raw family/ID, unique effect occurrence and book/command binding.
            This relies on verified append-only canonical effect semantics; never
            apply it to whole-snapshot mutable lots or configuration aliases. */
        }
        enum def InventoryIdentityKind { operation; anchor; movement; quantityAllocation; postingReference; }
        item def CurrentInventoryIdentityRead {
            attribute catalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute identityKind : InventoryIdentityKind;
            attribute rawId : Identifier;
            attribute present : Boolean;
            attribute outcomeSequence : Natural[0..1];
            attribute financialRevision : Natural[0..1];
            attribute sourceRevisionRowCommitment : Digest[0..1];
            doc /* Select the precisely typed immutable operation, anchor, movement,
            quantity allocation or posting reference from an authenticated creating
            retained-result/revision pair. Quantities use the same permanent allocation
            ID namespace as legacy posting-linked allocations, but never their row shape.
            Other kinds use inventoryOperation, inventoryAnchor, inventoryMovement and
            inventoryPostingReference namespaces. Exactly one matching raw ID of the
            selected kind is required. Repeated identical references within one funding
            group collapse once; same-ID references with different complete contents
            reject. Positive results bind both original Oseq and financial revision,
            never assume they are equal. Absence requires absence in both identity
            partitions at the selected head. Failure retires the whole reader. These
            are immutable origin reads, not latest positions or complete costing pools. */
        }
        enum def InventoryPositionDisposition { absent; unowned; owned; }
        item def CurrentInventoryPositionRead {
            attribute disposition : InventoryPositionDisposition;
            attribute holdingId : Identifier;
            attribute catalogCommitment : Digest;
            attribute headCommitment : Digest;
            item currentHolding : CurrentRowRead[0..1];
            attribute originRevision : Natural[0..1];
            attribute originRevisionRowCommitment : Digest[0..1];
            attribute groupMemberCommitment : Digest[0..1];
            attribute groupPopulation : Natural;
            doc /* Owned results include the immutable latest movement after-position
            and exact original anchor. Greatest financial revision is selected through
            the authenticated inventoryRevisionsByHolding right spine; within that
            revision choose greatest artifact ordinal, not monetary-array order, Oseq,
            recording time or acquisition order. Join the current holding and verify
            full origin/anchor identities, exact quantity/basis and cumulative posted
            balances. Depletion retains ownership. Absent means no holding and no
            group; unowned means a present holding with proven group absence, never
            implicit legacy adoption. Missing required evidence is an error. */
        }
        enum def OwnedPoolDisposition { resolved; unresolvedPolicy; }
        enum def OwnedPoolPolicyFailure { missing; ambiguous; hashMismatch; }
        item def OwnedPoolAccountEvidence {
            attribute accountId : Identifier;
            attribute memberCommitment : Digest[0..1];
            attribute population : Natural;
            attribute matchingPopulation : Natural;
        }
        item def OwnedPoolEntry {
            item holding : CurrentRowRead;
            item lot : CurrentRowRead;
        }
        item def CurrentOwnedInventoryPoolRead {
            attribute disposition : OwnedPoolDisposition;
            attribute policyFailure : OwnedPoolPolicyFailure[0..1];
            attribute operationIndices : Natural[1..*];
            attribute policyId : Identifier;
            attribute policyVersion : Identifier;
            attribute policyContentHash : Semantics::ContentHash;
            attribute inventoryCommodityId : Identifier;
            item selectedPolicy : RastrataAccountingBackend::Domain::InventoryCostPolicy[0..1];
            item account : OwnedPoolAccountEvidence[0..*];
            item poolEntry : OwnedPoolEntry[0..*];
            doc /* Distinguish unresolved policy from a proven empty resolved pool.
            Missing, ambiguous or full-content-hash mismatched policies supply no
            entries or account evidence. Resolved proves identity/hash, not policy
            temporal/capability admission. Include depleted holdings: the existing
            owned algorithm validates and budgets all source rows before selecting
            nonzero layers. Entries retain global canonical holding-ordinal order. */
        }
        item def CurrentOwnedInventoryPoolsRead {
            attribute commandId : Identifier;
            attribute computedCommandInputHash : Semantics::ContentHash;
            item basis : PinnedBookBasis;
            item pool : CurrentOwnedInventoryPoolRead[0..*];
            attribute scannedHoldings : Natural;
            attribute sourceRowBytes : Natural;
        }
        item def CurrentLotIdentityRead {
            attribute catalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute identityFamily : Identifier;
            attribute rawId : Identifier;
            attribute present : Boolean;
            attribute creationOutcomeSequence : Natural[0..1];
            item currentRow : CurrentRowRead[0..1];
            doc /* Family is exactly lot, lotHolding or lotAllocation. The legacy
            profile preserves identity insertion positions when replacing complete
            lot-state snapshots, but holding values can change. Use first creation
            Oseq only to authenticate a creating retained result/revision and locate
            one raw identity's position. Resolve that position from the CURRENT
            catalog and verify its raw ID/book after decoding. Never return the
            creating snapshot's holding quantity/basis as current. Depleted holdings
            remain present. Missing/reordered/ambiguous identities fail closed. */
            doc /* Owned quantity allocations use CurrentInventoryIdentityRead;
            selecting them through this legacy row reader fails rather than inventing
            a journal posting or returning false absence for an existing identity. */
        }
        item def PreparedOwnedInventoryCommandRead {
            attribute commandId : Identifier;
            attribute commandInputHash : Digest;
            item basis : PinnedBookBasis;
            item journals : RastrataAccountingBackend::Domain::ValidatedBookedJournal[0..*];
            item ownership : RastrataAccountingBackend::Domain::InventoryOwnershipEffect;
            item newLots : RastrataAccountingBackend::Domain::Lot[0..*];
            item afterHoldings : RastrataAccountingBackend::Domain::LotHolding[0..*];
            attribute resultingPostingSequence : Natural;
            doc /* A command-specific candidate only, not a BookCommitIntent. */
        }
        enum def SemanticGroupKind {
            holdingsByLot; holdingsByAccount;
            nonzeroHoldingsByAccountCommodity; recognitionsBySchedule;
            transitionsByPeriod; unrealizedByPolicy; reversalsByOriginalResult;
            inventoryRevisionsByHolding; inventoryRevisionsByMoneyScope;
            inventoryRevisionsBySourceJournal; journalsByMoneyScope;
            postingReferenceRevisionsById;
        }
        item def SemanticGroupKey {
            attribute kind : SemanticGroupKind;
            attribute rawValues : Identifier[1..10003];
            doc /* Ordered raw tuple: lot ID, account ID, account/commodity IDs,
            schedule ID, period ID, currency-policy ID, original-result ID, holding ID
            inventory source-journal ID or canonical posting-reference ID respectively. Monetary-scope kinds use
            book/account/functional-commodity followed by canonically sorted unique
            analytic member IDs, never units commodity. Their typed scope-input
            adapter explicitly normalizes analytic set order; raw group keys reject
            unsorted/duplicate members. Money keys enforce a 1 MiB UTF-8 budget
            incrementally before sorting/hashing and on the final encoded key.
            Directory identity includes the financial
            collection domain and query kind. A digest lookup must verify the raw
            tuple to detect conflicting group identities; delimiter concatenation
            and implicit key normalization are forbidden. */
        }
        item def SemanticGroupRoot {
            item key : SemanticGroupKey;
            attribute collectionName : Identifier;
            attribute memberDomain : Digest;
            attribute memberRootCommitment : Digest;
            attribute population : Natural;
            attribute postedBalance : Semantics::ExactRational[0..1];
            doc /* Members are canonical insertion ordinal to CURRENT canonical
            row commitment. Depleted holdings remain in lot/account groups but leave
            the nonzero account/commodity group. Value changes update member hashes
            even if the grouping key does not change. Recognition groups retain all
            historical recognitions of that schedule, not only a current total.
            Period groups retain all ordered transitions. Unrealized-policy groups
            retain unrealized results even after reversal; realized results are
            excluded. Reversal groups retain all reversals of the original result.
            Current-policy reversal requirements are resolved at read time, not
            frozen into group membership when a result is originally posted.
            Ownership groups retain each complete immutable revision touching that
            holding once, even if several movements occur in the same revision.
            Money-scope ownership groups retain each revision with a matching
            movement once, including zero-money and depleted after-positions.
            Source-journal groups retain revisions referencing a journal through
            an anchor source or journal-linked movement, independently of live stock.
            Journal money-scope groups retain each matching journal once even when
            several postings match or their net amount is zero. Only these groups
            carry postedBalance: the exact sum of all matching posted decimal money,
            not quantity, basis or carrying estimates. Descriptor hashes commit both
            the membership root/population and canonical rational sum. Updates add
            exact new contributions minus old contributions in the same publication;
            a removed last member must leave zero. Never drop a nonempty zero sum.
            The owner must commit complete group-directory membership and each
            root atomically with canonical/source-catalog publication. Projection
            alone is not a durable directory or a complete indexed read context. */
        }
        item def InventoryMoneyScope {
            attribute bookId : Identifier;
            attribute accountId : Identifier;
            attribute functionalCommodityId : Identifier;
            attribute dimensionMemberIds : Identifier[0..10000];
        }
        item def CanonicalRevisionWitness {
            attribute revisionOrdinal : Natural;
            attribute revisionRowCommitment : Digest;
            attribute memberRootCommitment : Digest;
            attribute population : Natural;
        }
        item def InventoryRevisionWitness :> CanonicalRevisionWitness;
        enum def PostingReferenceUsageStatus { used; unused; }
        item def PinnedPostingReferenceUsage {
            attribute referenceId : Identifier;
            attribute headCommitment : Digest;
            attribute sourceCatalogDigest : Digest;
            attribute disposition : PostingReferenceUsageStatus;
            item witness : CanonicalRevisionWitness[0..1];
            doc /* Latest immutable use, not a first-creation locator or a unique
            reference-value definition. Inventory-only identity absence is not
            evidence that an ID is unused in other canonical accounting features. */
        }
        enum def InventoryMoneyScopeStatus { managed; unmanaged; }
        item def PinnedInventoryMoneyScope {
            item scope : InventoryMoneyScope;
            attribute headCommitment : Digest;
            attribute catalogCommitment : Digest;
            attribute ownership : InventoryMoneyScopeStatus;
            item ownershipWitness : InventoryRevisionWitness[0..1];
            attribute postedBalance : Semantics::ExactRational;
            attribute journalDescriptorCommitment : Digest[0..1];
            attribute journalMemberCommitment : Digest[0..1];
            attribute journalPopulation : Natural;
            doc /* Unmanaged is proven ownership-group absence, not zero balance or
            no live holdings. Nonempty zero posted balance retains its descriptor
            and population. These are original-source facts, not account admission,
            verified legacy adoption, same-command overlay or publication authority. */
        }
        item def LogicalRangePage {
            attribute rootCommitment : Digest;
            attribute domainCommitment : Digest;
            attribute fromInclusive : Digest[0..1];
            attribute throughExclusive : Digest[0..1];
            attribute returnedKeys : Digest[0..256];
            attribute returnedValues : Digest[0..256];
            attribute complete : Boolean;
            attribute nextFromInclusive : Digest[0..1];
            doc /* Ordered bounded prefix of one explicit half-open range. Verify
            required paths and one extra matching leaf before declaring truncation;
            nextFromInclusive is that first unreturned key. Missing required bytes
            fail the whole page. Exact final pages are complete, not ambiguously
            full. A page does not prove consumption of earlier pages or possession
            of owner authority: the owner must bind all continuations to the same
            verified group directory, raw key, complete head and live pin. */
        }
        item def DerivedSemanticGroupCatalog {
            item identity : BookIdentity;
            item head : DurableHead;
            attribute storageProfile : FormatVersion;
            attribute directoryDomain : Digest;
            attribute directoryCommitment : Digest;
            attribute groupPopulation : Natural;
            item group : SemanticGroupRoot[*];
            doc /* Companion to the source catalog, not a replacement for its
            financial collection commitments. Directory keys are full-width group
            identities; values commit canonical raw-key/member-root/population
            descriptors. Member keys are canonical row ordinals. Empty groups have
            authenticated directory absence; missing directory/member evidence is
            an error, not an empty result. Metadata binds physical identity and
            complete head separately from financial collection/group domains.
            Adoption of new persisted fields requires an explicit owner profile;
            do not reinterpret or silently upgrade older row-only owners. */
        }
        item def PinnedSemanticGroupPage {
            item key : SemanticGroupKey;
            attribute sourceCatalogCommitment : Digest;
            attribute groupCatalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute memberRootCommitment : Digest[0..1];
            attribute population : Natural;
            attribute deliveredThrough : Natural;
            attribute complete : Boolean;
            attribute encodedRowBytes : Natural;
            item member : CurrentRowRead[0..256];
            doc /* Source-verified ordered prefix from an owner-local forward-only
            cursor. Every row matches the current source collection/hash/ordinal,
            raw group predicate and full captured head. complete means this cursor
            reached its authenticated population; the final page alone is not the
            complete row set and does not prove an external consumer processed
            previous pages. No caller-authored resume position is admitted. */
        }
        item def PinnedBookBasis {
            attribute sourceCatalogCommitment : Digest;
            attribute headCommitment : Digest;
            attribute financialIdentityCommitment : Digest;
            attribute canonicalStateCommitment : Digest;
            attribute bookRevision : Natural;
            attribute postingSequence : Natural;
            attribute configurationRevision : Natural;
            attribute configurationCommitment : Digest;
            item configuration : CurrentRowRead;
            item openingBoundary : CurrentRowRead[0..1];
            item financialRevision : CurrentRowRead[0..1];
            doc /* Common inputs, not complete accounting admission. Header
            identity/status/scalars come from complete verified recovery at the
            captured full head. canonicalStateCommitment commits the entire original
            kernel state, not merely this header. The indexed state and physical
            head retain their distinct hash domains; a legacy head must not be
            fabricated to connect a new-format read context. Current configuration, opening boundary and
            latest committed financial revision are separately source-verified
            current rows. Boundary configuration remains the activation snapshot,
            not a substitution of today's configuration. Retained rejections may
            advance durable outcomes without changing the financial revision/time.
            Current period closure and book-wide FX obligations remain separate
            required reads before any indexed command may be evaluated. */
        }
        item def PinnedAdmissionFacts {
            attribute commandId : Identifier;
            attribute recomputedCommandCommitment : Digest;
            item basis : PinnedBookBasis;
            attribute periodId : Identifier[*];
            attribute periodClosed : Boolean[*];
            attribute transitionPopulation : Natural[*];
            item overdueRemeasurement : CurrentRowRead[0..1];
            doc /* Factual inputs, not an admission decision or complete read set.
            Periods correspond exactly to current configuration order and closure
            folds every matching transition in canonical insertion order. Close
            package supersession is a different predicate. The overdue result is
            the first canonical unrealized result before the command issued-date,
            under the first matching current currency policy requiring reversal,
            excluding an original explicitly being reversed by this command and
            results with any retained reversal. Preserve raw IDs and current policy
            array order; neither policy-version sorting nor retained policy flags
            are substitutes for these legacy semantics. */
        }
        item def DerivedSourceCatalog {
            item identity : BookIdentity;
            item head : DurableHead;
            attribute storageProfile : FormatVersion;
            attribute headerCommitment : Digest;
            attribute stateCommitment : Digest;
            attribute protocolCommitment : Digest;
            item collection : LogicalCollectionCommitment[1..*];
            attribute locatorRoot : Digest[1..*];
            doc /* Closed one-to-one collection and locator-root catalogs, including
            empty roots. Locator commitments are derived storage authority, not
            financial state hashes. A source-catalog storage profile is separate
            from an indexed kernel representation profile and does not authorize
            sparse evaluation, lazy recovery or a change to historical receipts. */
        }
        item def IndexedStateWireProfile {
            attribute profileId : FormatVersion;
            attribute headerCodec : FormatVersion;
            attribute rowCodec : FormatVersion;
            attribute outcomeCodec : FormatVersion;
            attribute logicalMapCodec : FormatVersion;
            attribute commandProtocol : Semantics::SemanticVersion;
            attribute hashAlgorithm : String;
            attribute canonicalizationVersion : FormatVersion;
            doc /* Closed framing profile rastrata-indexed-book-state-v1. Pins
            header-v1, existing row-v1/outcome-v1 and logical-map-candidate-v1
            codecs plus exact command/hash versions. This is not the full future
            KernelRepresentationProfile and does not enable indexed execution. */
        }
        item def IndexedBookStateRecord {
            item profile : IndexedStateWireProfile;
            item header : RastrataAccountingBackend::Domain::BookStateHeader;
            item collection : LogicalCollectionCommitment[24];
            attribute stateCommitment : Digest;
            attribute protocolCommitment : Digest;
            attribute contentHash : Digest;
            doc /* Explicit versioned wire record, maximum 262144 UTF-8 bytes.
            Exactly one sorted descriptor per closed 24-collection catalog,
            including the complete immutable revision rows. Inventory ownership
            effects remain inside their containing revision, not a twenty-fifth
            independently authoritative collection. The optional full-state
            inventoryOwnershipEffects materialization must exactly reproduce those
            revision effects before a snapshot is projected. Current ownership
            positions and economic allocations are derived from that authenticated
            prefix. An ownership effect therefore adds no duplicate standalone row,
            but omitting or altering it changes the revision-row commitment and
            shall fail source or accounting replay. This representation preserves
            existing profile tags and all old rows/roots without inventing an
            ownership balance or rewriting a historical receipt.
            including empty roots. Each descriptor retains canonical encoded root,
            root hash and canonical decimal population. Domains bind the entire
            wire profile, full financial identity hash, collection and one-based
            256-bit ordinal key schema. Populations and row ordinals are uint64;
            nonempty roots declare min=1 and max=count. These are necessary framing
            checks, not proof of reachable child/row closure or authenticity.
            Catalog covers configuration history, opening boundary, lots, journals,
            corrections, period transitions, close packages, revisions, all thirteen
            accounting-effect families and retained results. Revisions equal book
            revision, journals equal posting sequence, configuration count equals
            configuration revision plus one, retained count is at least revision,
            and opening-boundary count is zero if configuring, otherwise one.
            State root binds encoded header and complete state collection roots;
            protocol root binds retained results independently. A retained rejection
            leaves the state root unchanged. Do not relabel legacy state hashes.
            Current configuration aliases must be derived from the authenticated
            selected configuration row; hashes alone do not supply its contents. */
        }
        item def IndexedBookHeadRecord {
            item identity : BookIdentity;
            attribute profileId : FormatVersion;
            attribute stateContentHash : Digest;
            attribute stateRoot : Digest;
            attribute protocolRoot : Digest;
            attribute outcomeSequence : Natural;
            attribute bookRevision : Natural;
            attribute postingSequence : Natural;
            attribute configurationRevision : Natural;
            attribute configurationHash : Semantics::ContentHash;
            attribute revisionHash : Semantics::ContentHash[0..1];
            attribute chainHash : Semantics::ContentHash;
            attribute contentHash : Digest;
            doc /* rastrata-indexed-book-head-v1 is separate from DurableHead,
            limited to 131072 UTF-8 bytes, with exact closed canonical JSON.
            Bind full tenant/book/object/namespace/generation scope, actual object
            ID and the complete IndexedBookStateRecord. At zero Oseq derive a
            domain-separated genesis chain hash from scope and state content hash;
            otherwise require a full outcome chain hash. Financial revision hash
            is absent exactly when book revision is zero, independently of Oseq.
            Nonzero chain hashes still require canonical record verification.
            Framing does not authorize publication, profile adoption, migration or
            relaxed startup verification. Physical relocation changes head identity,
            not financial state/protocol roots. Existing adapters keep old codecs. */
        }
        item def IndexedKernelState {
            item identity : BookIdentity;
            item profile : KernelRepresentationProfile;
            item canonicalHead : IndexedBookHeadRecord;
            item stateRecord : IndexedBookStateRecord;
            doc /* Proposed complete execution boundary. The implemented state/head
            framing and bounded legacy projection oracle do not establish complete
            indexed evaluation, atomic deltas or durable profile activation. */
        }
        item def IndexedCanonicalRowWrite {
            attribute collectionName : Identifier;
            attribute ordinal : Natural;
            attribute previousCommitment : Digest[0..1];
            attribute nextCommitment : Digest[0..1];
            attribute encodedNextRow : String[0..1];
            doc /* Ordered candidate writes, including multiple writes to a row
            within one outcome. Absence is distinct from an unresolved read. A
            deletion changes the current logical row map, never permanent outcome
            identities or original source bytes. Preserve exact tagged row codec. */
        }
        item def IndexedCandidateNode {
            attribute digest : Digest;
            attribute encodedNode : String;
        }
        item def IndexedChangeWorkBudget {
            attribute replacementRows : Natural;
            attribute changedRows : Natural;
            attribute nodeBytes : Natural;
            doc /* Optional trusted owner budget, copied before source reads.
            Closed exact three-field record of finite nonnegative integers. May
            narrow, never increase, the hard caps 10000/30000/16777216 respectively.
            Omission selects those hard caps. Reject unknown/accessor fields and
            invalid limits before reading source nodes. Equal usage is admitted;
            exceeding a bound returns no candidate. A zero work budget may refuse
            every outcome. This is operational preparation, not a way to change
            accounting decisions, permit a larger profile or bypass admission. */
        }
        item def IndexedOutcomeChangeCandidate {
            attribute beforeStateContentHash : Digest;
            item resultingState : IndexedBookStateRecord;
            item outcome : OutcomePayload;
            item rowWrite : IndexedCanonicalRowWrite[1..*];
            item newNode : IndexedCandidateNode[0..*];
            doc /* One complete immutable preparation result, not a selected or
            durable outcome. Preserve all unchanged catalog roots explicitly.
            Retain only new COW nodes reachable from final roots; unchanged old
            nodes need not be traversed to eliminate intermediate candidate nodes.
            The current compiler bounds legacy replacements to 10000 rows each,
            total changed rows to 30000 and staged ASCII node bytes to 16 MiB.
            Outcome codec limits still apply. These preparation limits are not a
            production-capacity guarantee or an accounting rejection. Failure
            returns no candidate and performs no writes. */
        }
        item def IndexedOutcomeChainRecord {
            attribute version : String;
            item priorHead : IndexedBookHeadRecord;
            item resultingHead : IndexedBookHeadRecord;
            attribute encodedResultingState : String;
            item outcome : OutcomePayload;
            attribute payloadHash : Semantics::ContentHash;
            attribute contentHash : Digest;
            doc /* Explicit rastrata-indexed-outcome-v1 wire, bounded to 4 MiB
            UTF-8 including escaping and framing. Preserve exact original outcome
            codec bytes, diagnostic order, times and complete hash metadata.
            Payload hash binds the version-specific payload domain and exact bytes.
            Acyclic chain preimage binds version-specific chain domain, exact prior
            full-head bytes, resulting state content hash and full payload hash;
            it excludes the resulting head that contains the chain hash. Envelope
            hash binds the fixed-order body excluding its own contentHash field.
            Old compact/archive versions and whole-state hashes remain unchanged.
            No physical row/node bytes or implied publication authority are embedded.
            Framing is distinct from effect projection and accounting admission. */
        }
        item def ProjectedOutcomeSourceRow {
            attribute encodedRow : String;
            attribute knownInsertionOrdinal : Natural[0..1];
            attribute sourceKind : SourceLocatorKind;
            attribute effectIndex : Natural[0..1];
            attribute lotMember : Identifier[0..1];
            attribute memberIndex : Natural[0..1];
            doc /* Exact original tagged row subtree and closed kind-specific
            selector. An absent ordinal means the source does not supply the
            collection's global position, not zero or an inferred outcome number.
            Resolve it using authenticated prior population/current locator. */
        }
        item def ProjectedOutcomeSourceGroup {
            attribute collectionName : Identifier;
            attribute replacesCollection : Boolean;
            item row : ProjectedOutcomeSourceRow[0..*];
            doc /* Ordered effect group. Empty replacement is significant and
            must be retained; it is not an absent collection or append operation.
            Several groups may address one collection within the same outcome. */
        }
        item def IndexedOutcomeSourceProjection {
            attribute profileId : FormatVersion;
            attribute sourceCommitment : Digest;
            attribute outcomeSequence : Natural;
            item group : ProjectedOutcomeSourceGroup[1..*];
            doc /* rastrata-indexed-outcome-source-v1 derives rows from one exact
            indexed outcome, without synthesizing a compact or whole-state head.
            Original retained commit-intent hash uses complete configuration hash
            metadata and the real prior/resulting counters. Rejected rows contain
            no commit-intent hash. This is content projection, not authentication
            of a caller's claimed canonical prefix or authorization to publish. */
        }
        item def IndexedSourceCatalogRecord {
            attribute version : FormatVersion;
            attribute canonicalGenesisCommitment : Digest;
            item indexedState : IndexedBookStateRecord;
            item head : IndexedBookHeadRecord;
            attribute collectionName : Identifier[24];
            attribute locatorRoot : String[24];
            attribute locatorCommitment : Digest[24];
            doc /* Closed rastrata-indexed-source-catalog-v1, at most 524288 UTF-8
            bytes. Sorted complete one-to-one catalog matching all 24 state roots.
            Locator domains bind the complete physical scope and economic indexed
            collection domain. Root populations and ordinal endpoints agree with
            canonical collections. Financial rows/nodes retain their own domains.
            Origins bind either exact new-book genesis or an original outcome's
            sequence/complete record commitment/kind-specific row selector.
            Origins and logical nodes are individually bounded to 2048 bytes.
            Genesis input remains bounded by the existing 16 MiB aggregate codec;
            genesis has configuration row one and no other rows. No old-book
            adoption, sparse genesis, receipt or recovery exemption is implied. */
        }
        item def PreparedIndexedSourceCatalog {
            attribute digest : Digest;
            doc /* Opaque owner-instance-local handle, not a caller digest or
            serialized verification flag. Private staged bytes bind exact prior
            catalog and complete resulting head/state. Retain handle after a
            rolled-back transaction so retry does not require rebuilding; a
            committed candidate cannot republish against its old catalog CAS. */
        }
        item def IndexedSemanticGroupCatalogRecord {
            attribute version : FormatVersion;
            item identity : BookIdentity;
            item head : IndexedBookHeadRecord;
            attribute sourceCatalogCommitment : Digest;
            attribute directoryDomain : Digest;
            attribute directoryCommitment : Digest;
            attribute groupPopulation : Natural;
            item group : SemanticGroupRoot[*];
            doc /* Closed rastrata-indexed-group-catalog-v1 uses separate tables
            and hashing from the legacy candidate-v2 catalog. Metadata (8192
            UTF-8 bytes maximum) commits the source catalog and full indexed head;
            group collection domains use the indexed financial identity/profile.
            Nodes are at most 2048 bytes, descriptors at most 1 MiB plus 2048.
            Raw group keys, member domains and populations are verified on reads.
            Empty-group absence requires an authenticated directory lookup, not a
            missing node. Query results are ordinal/hash evidence; the owner must
            independently authenticate source rows and pin the matching full head.
            The explicit rastrata-indexed-ownership-group-catalog-v1 profile adds
            state.revisions membership and a distinct directory/hash domain; the
            canonical 24-collection roots and old profile bytes remain unchanged.
            Old profiles reject ownership queries rather than return false absence.
            New books may explicitly select the profile in the internal owner;
            switching an existing catalog fails without rewriting it. Migration
            requires a separately verified rebuild/publication, not automatic upgrade.
            The distinct rastrata-indexed-money-group-catalog-v1 profile adds three
            predicates: inventoryRevisionsByMoneyScope, inventoryRevisionsBySourceJournal
            and journalsByMoneyScope. It commits exact posted-balance summaries in
            journal-group descriptors and includes state.journals in its directory
            domain. All older profiles retain exactly their prior predicates/bytes
            and reject new queries. A complete indexed source audit independently
            recomputes each summary from every matched canonical posting and verifies
            exact membership/counts, rejecting even fully rehashed false summaries.
            The explicit rastrata-indexed-reference-group-catalog-v1 profile extends
            money coverage with postingReferenceRevisionsById over state.revisions.
            Derive one member per committed revision and raw ID from all thirteen
            append-only accounting effect values and ownership anchor/movement
            references. Never derive occupancy from command inputs or rejected
            outcomes. Repeated use has multiple revision witnesses, not conflicting
            identity definitions. Full bidirectional source audit establishes
            completeness before queries; all older profiles reject this predicate.
            Adding or changing an accounting effect requires reviewing this closed
            projection against the kernel's canonical reference-occupancy rule.
            This component is not enabled in the deployed application. */
        }
        item def PreparedIndexedSemanticGroupCatalog {
            attribute digest : Digest;
            item sourceCandidate : PreparedIndexedSourceCatalog;
            doc /* Instance-local opaque staged authority. The associated exact
            source candidate and prior group catalog cannot be substituted by
            caller-supplied digests. Its wire digest alone cannot authorize writes.
            Retain prepared authority after rollback for exact retry. */
        }
        item def IndexedCatalogAuditSummary {
            attribute sourceCatalogCommitment : Digest;
            attribute groupCatalogCommitment : Digest[0..1];
            attribute headCommitment : Digest;
            attribute sourceRowCount : Natural;
            attribute groupCount : Natural[0..1];
            attribute membershipCount : Natural[0..1];
            doc /* Returned only after complete read-only reachable-index audit
            against an independently verified canonical anchor and live owner pin.
            An immutable report, not a durable receipt or reusable authority token.
            Does not establish accounting replay, canonical-prefix membership,
            permanent-identity closure, full recovery or readiness by itself. */
        }
        item def IndexedKernelReadEvidence {
            item indexedState : IndexedKernelState;
            attribute evaluated : Boolean;
            attribute profileSupported : Boolean;
            attribute completeCatalog : Boolean;
            attribute projectionVerified : Boolean;
            attribute completeReadSet : Boolean;
            attribute sourceRowsVerified : Boolean;
            attribute absenceAndRangesVerified : Boolean;
            attribute pinnedHeadMatches : Boolean;
            attribute publicationFenceMatches : Boolean;
            attribute requiredEvidenceAvailable : Boolean;
            doc /* Facts established by trusted verification, never caller flags.
            Complete read set is command-specific across all eighteen variants,
            including global negative/range dependencies and original retry lookup.
            Failure is unavailable/corrupt context before accounting evaluation,
            not a retained rejection asserting nonexistent economic sources.
            Admission does not replace final full-head/fence CAS or durability.
            Source-verified configuration, identity lookups and period facts may feed
            the kernel's shared journal-preparation primitive. That primitive's output
            is a candidate only: it does not establish completeReadSet, evaluated or
            publication authority, and a comparison harness must not publish it.
            Authenticated retained-command identity and latest financial revision may
            feed the shared protocol prefix. Retry results precede current admission;
            a later rejected outcome is not a financial commit. Neither a finished
            prefix result nor a continue result bypasses owner durability or proves
            complete indexed accounting evaluation. Source-backed opening-boundary
            identity lookup resolves the original committed activation revision and
            its financial identity hash, never a rehash of today's identity. Absence
            for one requested boundary ID does not prove absence of all activations.
            Financial/configuration semantic validators require complete authenticated
            inputs and do not substitute for canonical-state integrity or admission.
            Indexed FX fact selection and the full-state evaluator share eligibility
            semantics. Complete policy selection and source-verified reversal absence
            remain required; shared book-wide guards do not authenticate caller facts
            or independently establish complete indexed command evaluation.
            Inventory costing facts exhaust each selected policy account's nonzero
            holding group for the requested commodity, join current authenticated
            lots, and retain exact layer values with source ordinals/hashes. Missing
            lots or pages and populations exceeding the executable kernel layer
            limit fail without partial facts. A small submitted layer list does not
            bound canonical population reads. This is only the pool read dependency,
            not complete inventory command admission or atomic lot publication.
            Owned inventory has a distinct pool dependency: exhaust holdingsByAccount
            for all selected policy accounts, including zero holdings and unrelated
            commodities before filtering. Join current lots, preserve canonical row
            order and prove full-account and matching-commodity populations. Removing
            depleted rows would change current validation/resource semantics. This
            read does not prove ownership adoption, managed money scopes or complete
            owned-command admission. Its retained-population cost remains explicit. */
            doc /* The kernel's shared commit-record constructor needs only the
            admitted intent and authenticated financial predecessor book/revision/
            full hash identity. It preserves canonical revision and original-result
            preimages without copying historical arrays. Its record candidates do
            not establish completeReadSet or projectionVerified, compute a new
            indexed state root, apply effects, authorize publication or relax full
            recovery. A retained rejection must never substitute for the latest
            financial predecessor. */
        }
        item def IndexPageReference {
            attribute location : Identifier;
            attribute digest : Digest;
            attribute byteCount : Natural;
            attribute representationVersion : FormatVersion;
            doc /* Rebuildable index bytes only, in a namespace disjoint from canonical
            payloads/manifests. Verify exact bytes, ordering, fences and population.
            Location is not merely a reusable content hash: after retirement it cannot
            be resurrected. Identical new bytes need a fresh physical location. */
        }
        item def IndexRoot {
            attribute contentHash : Digest;
            attribute keySchemaVersion : FormatVersion;
            attribute population : Natural;
            item page : IndexPageReference[0..1];
            doc /* Hash the complete versioned root descriptor, including the explicit
            empty-root representation. No page iff population is zero. Namespaced logical identities bind
            book, family and original raw ID. A digest locator must resolve and verify
            original identity/content, not silently treat collisions as the same ID.
            Counts/hashes alone do not prove canonical population completeness. */
        }
        item def IndexedView {
            item identity : BookIdentity;
            item canonicalHead : DurableHead;
            attribute viewRevision : Natural;
            attribute fenceGeneration : Natural;
            attribute coldThrough : Natural;
            attribute hotFrom : Natural;
            attribute hotThrough : Natural;
            item cold : IndexRoot;
            item hot : IndexRoot;
            doc /* Cold covers the canonical prefix through coldThrough; hot covers
            exactly coldThrough+1 through canonicalHead.outcomeSequence. An empty hot
            interval uses from=through+1 and population zero. All permanent identity
            families, including retained rejections, participate. Appends atomically
            update hot state and viewRevision with canonical publication. Roots are
            verified derived projections, not alternate accounting authority. */
        }
        item def FrozenIndexPrefix {
            item identity : BookIdentity;
            attribute maintenanceId : Identifier;
            attribute baseColdDigest : Digest;
            attribute frozenThrough : Natural;
            attribute frozenPopulationDigest : Digest;
            attribute fenceGeneration : Natural;
            item constructionView : IndexedView;
            doc /* Durably pins the complete old cold root and exact frozen hot prefix.
            Later canonical appends remain in a tail. Reconstruction uses canonical
            outcomes and original identities; no accounting command is re-evaluated
            merely to merge an index. Incomplete builds are not visible views. */
        }
        item def IndexReaderPin {
            attribute pinId : Identifier;
            attribute expiresAt : Natural;
            item indexedView : IndexedView;
            item queryCutoff : DurableHead;
            attribute active : Boolean;
            doc /* Authority-owned durable reader/construction pin. Query cutoff must
            be verified in the view's canonical prefix. Page cursors name this pin;
            renewal requires a still-active pin, never caller-asserted liveness.
            Expiry/retirement is irreversible for this pin ID. An expired cursor
            fails explicitly; reconstructing a historical view creates a fresh pin. */
        }
        item def IndexKeyRange {
            attribute lowerInclusive : Digest[0..1];
            attribute upperExclusive : Digest[0..1];
            doc /* Half-open interval in the selected index's bytewise key order;
            missing endpoints are unbounded. Equal endpoints are the empty set.
            Permanent-identity hash order is not accounting date/account order:
            semantic predicates need separately specified canonical key schemas. */
        }
        item def IndexRangeMatch {
            attribute key : Digest;
            attribute outcomeSequence : Natural;
        }
        item def IndexRangeBatch {
            item pin : IndexReaderPin;
            item query : IndexKeyRange;
            item matches : IndexRangeMatch[0..*];
            attribute matchedThrough : Natural;
            attribute complete : Boolean;
            doc /* Bounded immutable batch from one captured live pin. Complete is
            produced only after every required hot/cold subtree has been verified
            and exhausted for this interval. Prior batches, cancellation and read
            failure are not a complete population. Counts do not substitute for
            exact entries. This does not attest to unvisited-subtree health or
            original raw-identity/content resolution, nor grant posting authority. */
        }
        item def IndexPinRegistry {
            attribute issuedSequence : Natural;
            attribute lastObservedTime : Natural;
            item pins : IndexReaderPin[0..*];
            doc /* The owner allocates strictly increasing pin IDs from issuedSequence,
            retained even after released/expired rows are removed. No caller chooses
            or revives an old ID. Pin expiry and lastObservedTime use trusted epoch
            milliseconds, never request time. Every admitted operation or ordinary
            expired/conflicting response durably preserves a nondecreasing clock
            floor before returning. Clock regression rejects use rather than reviving
            an expired pin. Renewal retains the exact immutable view/cutoff, requires
            an active stored lease and is replayable after a lost response. Expiry
            removal is bounded; this does not authorize page reclamation. */
        }
        item def ConstructionLocationHead {
            attribute constructionPinId : Identifier;
            attribute identityHash : Digest;
            attribute fenceGeneration : Natural;
            attribute locationCount : Natural;
            attribute terminalHash : Digest;
            doc /* Created atomically with every construction pin, including an
            authenticated zero-count genesis. Each reserved physical location joins
            an ordered hash chain atomically with reservation and allocator high-water
            advancement, before page writes. Unwritten, abandoned and materialized
            locations all remain in this chain. Missing metadata is not an empty set.
            Checksums do not detect coordinated rollback of an entire local store;
            restored construction requires a fresh independently established fence. */
        }
        item def ConstructionLocationBatch {
            item capturedHead : ConstructionLocationHead;
            attribute allocationEpoch : Natural;
            attribute allocationHighWater : Natural;
            attribute throughOrdinal : Natural;
            attribute cursorHash : Digest;
            attribute locations : Identifier[0..*];
            attribute complete : Boolean;
            doc /* Capture head and allocator watermark in one live-pin transaction.
            Stream bounded contiguous ordinal batches, verifying scope, indexed
            columns and chained hashes through the captured terminal count/hash.
            No missing row, gap or extra row at an unchanged terminal head may yield
            complete. Later allocations are outside this captured prefix/watermark.
            Every batch requires the same live pin. This is one construction's exact
            prefix, not proof of global protected-root closure or a reference barrier. */
        }
        item def ConstructionCleanupJob {
            item retiredHead : ConstructionLocationHead;
            attribute throughOrdinal : Natural;
            attribute cursorHash : Digest;
            doc /* Pin release, expiry or successful publication atomically queues
            this job while consuming the pin. Verify owner absence, the exact retired
            head, contiguous remaining rows and no skipped extant prefix before
            bounded tracking/reservation cleanup. Cursor advancement/deletions share
            one transaction; lost replies recover its actual durable position.
            Never delete page bytes, roots or canonical history or lower allocation
            high-water. This is metadata cleanup, not derived-page reclamation. */
        }
        item def IndexRetirement {
            item identity : BookIdentity;
            attribute retirementId : Identifier;
            attribute collectionEpoch : Natural;
            attribute fenceGeneration : Natural;
            attribute protectedRootSetDigest : Digest;
            attribute selectedLocationsDigest : Digest;
            doc /* Durable exact-set retirement after verified reachability closure
            against current views, active readers and all pending constructions or
            publications. During marking, new references may use pinned input graphs
            or fresh locations in the collection epoch, never resurrect unprotected
            older locations. This barrier remains through retirement selection.
            No protected location is selected. New reference admission and retirement
            serialize, and retired locations cannot be reused. Remote
            deletion is resumable only for this exact set; unknown status never grants
            permission to delete canonical evidence or expand the set. */
        }
        item def RetainedIndexAppend {
            item resultingRoot : IndexRoot;
            attribute addedIdentityCount : Natural;
            item constructionPin : IndexReaderPin;
            doc /* Ephemeral instance-local authority for a durably retained COW
            insertion chain, not a serialized caller flag. The first base is the
            current pinned hot root; subsequent bases require the same store's
            exact same-pin certificate. Every entry is for the next Oseq. The
            original COW builder privately attests before/after roots and changed
            page references; all new pages require durable exact-byte verification
            and globally fresh same-construction allocation. No accounting identity
            completeness, cross-partition absence, publication or service readiness
            is implied. Certificates cannot be recreated from a root digest after
            restart; restart retains full recovery/audit obligations. */
        }
        item def PreparedIndexPublication {
            attribute contentHash : Digest;
            attribute constructionPinId : Identifier;
            item inputView : IndexedView;
            item targetHead : DurableHead;
            item hotRoot : IndexRoot;
            doc /* One immutable final candidate per construction pin. Bind complete
            identity/fence, exact input view including viewRevision, complete target
            canonical head and verified hot-root descriptor. Registration does not
            select a view. Lease renewal preserves candidate identity; release or
            expiry removes eligibility. The target head advances exactly one Oseq,
            including retained rejection. A digest/count alone is not evidence of
            canonical population membership or original-identity resolution. */
        }
        item def IndexCoverageEvidence {
            attribute usable : Boolean;
            attribute coldThrough : Natural;
            attribute hotFrom : Natural;
            attribute hotThrough : Natural;
            attribute committedThrough : Natural;
            attribute coldCount : Natural;
            attribute hotCount : Natural;
            attribute expectedCount : Natural;
            attribute exactPopulationsVerified : Boolean;
        }
        item def IndexCutoverEvidence {
            attribute installed : Boolean;
            attribute expectedViewRevision : Natural;
            attribute currentViewRevision : Natural;
            attribute resultingViewRevision : Natural;
            attribute expectedColdDigest : Digest;
            attribute currentColdDigest : Digest;
            attribute currentColdThrough : Natural;
            attribute frozenThrough : Natural;
            attribute resultingColdThrough : Natural;
            attribute currentThrough : Natural;
            attribute resultingHotFrom : Natural;
            attribute resultingHotThrough : Natural;
            attribute expectedHeadDigest : Digest;
            attribute beforeHeadDigest : Digest;
            attribute afterHeadDigest : Digest;
            attribute identityAndFenceVerified : Boolean;
            attribute frozenPrefixVerified : Boolean;
            attribute replacementVerified : Boolean;
            attribute tailPreserved : Boolean;
            attribute postingResolved : Boolean;
            attribute transactionDurable : Boolean;
        }
        item def IndexPinEvidence {
            attribute admitted : Boolean;
            attribute authorityCurrent : Boolean;
            attribute contextAndCutoffVerified : Boolean;
            attribute currentView : Boolean;
            attribute existingPinActive : Boolean;
            attribute pinRetired : Boolean;
            attribute retirementSelected : Boolean;
        }
        item def IndexReclamationEvidence {
            attribute deleted : Boolean;
            attribute derivedOnly : Boolean;
            attribute retiredDurably : Boolean;
            attribute closureVerified : Boolean;
            attribute referenceBarrierHeld : Boolean;
            attribute replacementVerified : Boolean;
            attribute noProtectedReferences : Boolean;
            attribute identityAndFenceVerified : Boolean;
            attribute locationReusable : Boolean;
            attribute deletionMatchesRetirement : Boolean;
        }
        item def Genesis {
            item identity : BookIdentity;
            item format : FormatIdentity;
            item durabilityPolicy : DurabilityPolicy;
            item initialState : RastrataAccountingBackend::Domain::BookStateSnapshot;
            item head : DurableHead;
            attribute payloadHash : Digest;
            attribute payloadBytes : Natural;
            doc /* Exact initial kernel durable aggregate, including its empty retained
            protocol. Book and outcome revisions are zero. Explicit configuration
            may exist; activation is a subsequent ordinary command. */
        }
        item def PayloadChunk {
            attribute parentId : Identifier;
            attribute ordinal : Natural;
            attribute byteCount : Natural;
            attribute digest : Digest;
            attribute bytes : Natural[0..*];
            doc /* Each byte is 0..255. Hash raw bytes, not independently decoded
            fragments; UTF-8 code points may cross chunk boundaries. */
        }
        item def OutcomePayload {
            item command : RastrataAccountingBackend::Domain::BookCommand;
            item originalResult : RastrataAccountingBackend::Domain::BookCommandResult;
            item revision : RastrataAccountingBackend::Domain::RevisionRecord[0..1];
            doc /* One canonical command and exact original kernel result per newly
            retained outcome. No repeated full-history snapshot. Replay rebuilds
            protocol retention from these ordered records. Optional revision means
            an actual book-revision advance; never invent one for rejection. */
        }
        item def OutcomeRecord {
            item identity : BookIdentity;
            item format : FormatIdentity;
            item before : DurableHead;
            item resulting : DurableHead;
            item payload : OutcomePayload;
            item chunk : PayloadChunk[1..*];
            attribute commandId : Identifier;
            attribute commandHash : Digest;
            attribute resultHash : Digest;
            attribute payloadHash : Digest;
            attribute payloadBytes : Natural;
            attribute chunkCount : Natural;
            doc /* Hash preimage: domain, complete format and identity, complete prior
            head, next outcome sequence, next financial/configuration/state/protocol
            heads, command ID/hash, result hash, payload byte count/hash and ordered
            chunk manifest. Exclude the new outcomeHash itself. Persist exact bytes.
            Full ContentHash algorithm/version/digest identity is retained in payload. */
        }
        item def LedgerReceipt {
            item head : DurableHead;
            item durabilityPolicy : DurabilityPolicy;
            item result : RastrataAccountingBackend::Domain::BookCommandResult;
            item originalResult : RastrataAccountingBackend::Domain::BookCommandResult[0..1];
            attribute originalOutcomeSequence : Natural[0..1];
            attribute durabilityConfirmed : Boolean;
            doc /* Replay returns the kernel replay marker plus the exact retained
            original result and Oseq. Current head may be newer than original head.
            Kernel supplied times are not renamed server durability timestamps. */
        }
        item def SelectedArchiveCandidate {
            item outcome : OutcomeRecord;
            item manifest : ArchiveCommitManifest;
            item expectedAnchor : ArchiveAnchor;
            attribute expectedControlNonce : String;
            attribute priorManifestBytes : String;
            attribute reservationHash : Digest;
            attribute candidateId : Identifier;
            attribute candidateHash : Digest;
            attribute fenceGeneration : Natural;
            doc /* One durably reserved candidate per book. Contains exact command,
            original result and effects at the prior complete head, including a
            retained rejection. Reservation is not visible financial publication.
            No following candidate or ready read may bypass unresolved selection.
            Persist the exact predecessor manifest and observed full anchor control
            body, ETag and nonce for later conditional publication. The reservation
            hash binds this storage envelope independently of the canonical candidate
            hash; a candidate hash alone does not bind its observed transport nonce.
            New archive-owned storage must reject ordinary SQL-only reads/commits,
            even before the first candidate. A missing ownership table or marker,
            incomplete chunks or disagreement between reservation markers is damage,
            never an idle state or permission to downgrade the receipt policy. */
        }
        item def ArchivePayloadReference {
            attribute objectKey : Identifier;
            attribute payloadHash : Digest;
            attribute payloadBytes : Natural;
            doc /* Immutable exact bytes, addressed within book identity and format.
            Presence alone does not prove canonical membership; orphans are possible.
            The R2 transport reference hashes raw stored bytes with SHA-256; this
            is distinct from an outcome's domain-separated payload digest. Keys
            bind complete identity and format plus the raw digest. Create-only PUT
            must never overwrite an existing object; verify its full bounded body
            and length even after a create-only conflict. Missing or corrupt bytes
            fail closed and cannot be repaired by replacing the object. */
        }
        item def ArchiveCommitManifest {
            attribute version : FormatVersion;
            item identity : BookIdentity;
            item format : FormatIdentity;
            item durabilityPolicy : DurabilityPolicy;
            item before : DurableHead;
            item resulting : DurableHead;
            item payload : ArchivePayloadReference;
            attribute candidateId : Identifier;
            attribute candidateHash : Digest;
            item priorManifest : ArchivePayloadReference;
            attribute priorManifestHash : Digest;
            attribute fenceGeneration : Natural;
            attribute contentHash : Digest;
            doc /* The predecessor locator binds exact encoded bytes and their
            scoped object address independently of the predecessor's canonical
            manifest hash. Both are committed by this manifest hash. Recovery
            follows these explicit links, never bucket listing or an implicit
            mapping from a canonical digest to a raw-byte object address. Candidate
            hashes bind complete identity/format/policy, predecessor locator/hash,
            candidate ID, fence and the exact outcome frame rebuilt by replay.
            Structural decoding and reproducible hashes alone do not prove
            selection, accounting validity or canonical publication. */
        }
        item def ArchiveGenesisManifest {
            attribute version : FormatVersion;
            item identity : BookIdentity;
            item format : FormatIdentity;
            item durabilityPolicy : DurabilityPolicy;
            item initialHead : DurableHead;
            item payload : ArchivePayloadReference;
            attribute genesisHash : Digest;
            attribute contentHash : Digest;
            doc /* Archive root at Oseq zero. Provisioning is not a retained command
            and cannot fabricate a predecessor outcome. Bind exact genesis, identity,
            format and policy before the catalog becomes active. */
        }
        item def ArchiveAnchor {
            attribute version : FormatVersion;
            item identity : BookIdentity;
            item format : FormatIdentity;
            item head : DurableHead;
            item manifest : ArchivePayloadReference;
            attribute manifestHash : Digest;
            attribute fenceGeneration : Natural;
            attribute storageRevision : String;
            doc /* Conditional replacement compares the verified full prior anchor,
            including fence generation, using the storage revision/ETag. Canonical
            publication is this successful comparison-and-swap, not a payload PUT.
            Fence-only replacement keeps the same full head/manifest while advancing
            generation. A delayed publisher using the old revision must then fail.
            Anchor is mutable control data, not an immutable payload lock target.
            The R2 transport stores control bytes in a closed versioned envelope
            binding scope/format and a fresh unpredictable storage nonce. Even a
            same-body replacement changes the storage ETag; A-to-B-to-A writes
            through the adapter cannot revive a stale ETag. Nonces are storage
            metadata, not canonical accounting content. Compare the complete
            expected body, nonce and ETag before conditional replacement. Transport
            CAS does not itself verify financial heads, manifest membership or
            catalog fences. A lost response is uncertain; observe and reconcile
            the exact selected candidate, never infer failure or abandon from a
            missing body alone. No control mutation can acknowledge a command
            without the archive publication and SQLite reconciliation protocol. */
            doc /* Typed archive recovery begins at an independently expected full
            anchor and pinned durability policy. Verify exact current control bytes,
            each raw manifest/payload reference, canonical manifest hash, identity,
            format, policy and complete predecessor head. Oseq decreases exactly
            one per predecessor; genesis is zero, never a retained command. Replay
            every original committed and rejected receipt forward from genesis and
            reconstruct the complete outcome frame and candidate hash. Missing
            middle sources cannot be replaced by a shorter successful prefix, and
            uploaded but unlinked candidates are not members. Historical manifest
            fences may be lower than the current anchor fence after maintenance;
            they remain nondecreasing in publication order. The recovered snapshot
            is historical at its observed control version, not current catalog,
            service-readiness or independent-backup certification. */
        }
        item def ServiceResponse {
            item receipt : LedgerReceipt[0..1];
            attribute failure : ServiceFailure[0..1];
            doc /* Exactly one branch. Storage, transport and authorization failures
            never become fictional retained accounting rejections. Unknown commit
            outcome instructs retry with the identical command, not a new identity. */
        }
        item def ProvisionReceipt {
            item identity : BookIdentity;
            item head : DurableHead;
            item durabilityPolicy : DurabilityPolicy;
            attribute genesisHash : Digest;
            attribute durabilityConfirmed : Boolean;
            doc /* Confirms only durable genesis, not an accounting command result
            or service readiness. Trusted provisioning workflow next activates the
            reserved catalog entry by identity/genesis CAS. Failed activation leaves
            a resumable reserved book, not an automatically writable one. Archive-
            required genesis acknowledgement also needs the verified independent
            genesis manifest/anchor, not merely a local SQL sync. */
        }
        item def ProvisionResponse {
            item receipt : ProvisionReceipt[0..1];
            attribute failure : ServiceFailure[0..1];
            doc /* Exactly one branch. Provisioning does not invent a kernel outcome
            and does not advance Oseq. Activation remains a real kernel command. */
        }
        item def CapacityProfile {
            attribute commandBytes : Natural;
            attribute outcomeBytes : Natural;
            attribute chunkBytes : Natural;
            attribute checkpointBytes : Natural;
            attribute historyBytes : Natural;
            attribute outcomes : Natural;
            attribute queueDepth : Natural;
            attribute decodeDepth : Natural;
            attribute decodeNodes : Natural;
            attribute recoveryPageBytes : Natural;
            attribute recoveryPageRecords : Natural;
            attribute maximumCasAttempts : Natural;
            doc /* All positive, versioned and enforced before publication. Effective
            limits are the minimum of profile, kernel codec and platform limits.
            Recovery paging alone does not bound full kernel aggregate execution.
            Workload/SLA approval is a deployment prerequisite, not a model claim. */
        }
        item def CatalogEntry {
            attribute version : FormatVersion;
            item identity : BookIdentity;
            item format : FormatIdentity;
            item durabilityPolicy : DurabilityPolicy;
            attribute genesisHash : Digest;
            attribute status : CatalogStatus;
            attribute fenceGeneration : Natural;
            doc /* Externally owned provisioning/maintenance authority, outside the
            book's restore set. Reserve identity and genesis before provisioning;
            activate only after durable genesis. A reserved operation resumes only
            with identical genesis. Active identity plus empty storage quarantines.
            No ordinary command recreates, retires or reassigns a book. The archive
            owner consumes a closed complete entry from trusted control-plane
            infrastructure, not request-supplied authority or a verified Boolean.
            Identity, genesis, format and durability policy must all match the
            reserved book. Status and exact fence admission are operation-specific;
            schema validity alone does not authorize publication or service readiness. */
        }
        item def CheckpointManifest {
            item identity : BookIdentity;
            item format : FormatIdentity;
            item cutoff : DurableHead;
            item chunk : PayloadChunk[1..*];
            attribute aggregateHash : Digest;
            attribute aggregateBytes : Natural;
            attribute complete : Boolean;
            doc /* Derived complete kernel state AND retained protocol at one cutoff.
            Stage bounded chunks, decode/verify, then atomically expose a manifest
            at a matching canonical cutoff. Retain genesis and the entire outcome
            log in this scope. Checkpoints accelerate recovery, not authorize pruning. */
        }
        item def NativeLedgerHead {
            attribute sequence : Natural;
            attribute bookRevision : Natural;
            attribute chainHash : Digest;
        }
        item def NativeWriterRetirement {
            attribute requestId : Identifier;
            attribute actorId : Identifier;
            attribute previousFence : Natural;
            attribute fence : Natural;
            item head : NativeLedgerHead;
            attribute contentHash : Digest;
            doc /* Exact durable source-owner evidence. Fence is previousFence + 1;
            head is read during the serialized retirement, not supplied by a caller.
            Bind the full source identity in the content hash. A hash alone does
            not establish provenance: the coordinator calls its configured trusted
            book-object port. Lost replies retry the same source request identity. */
        }
        item def NativeArchiveControlVersion {
            attribute body : String;
            attribute nonce : String;
            attribute storageRevision : String;
        }
        item def NativeArchiveProgress {
            attribute writerFence : Natural;
            attribute archivedSequence : Natural;
            attribute observedSequence : Natural;
            attribute pendingOutcomes : Natural;
            attribute status : NativeArchiveProgressStatus;
            doc /* Read-only sample for PL-012/014, not restoration authority.
            pendingOutcomes = observedSequence - archivedSequence; status is caughtUp iff
            pendingOutcomes is zero. Both sequences belong to the same verified
            source and active archive fence. A later append can follow the sampled
            head. This count is not elapsed-time lag or a full historical payload
            audit. Missing/corrupt/changing evidence produces service failure,
            never a zero-backlog default. */
        }
        item def NativeArchiveSeal {
            item scope : BookIdentity;
            attribute genesisHash : Digest;
            item head : NativeLedgerHead;
            attribute fence : Natural;
            item control : NativeArchiveControlVersion;
            doc /* Exact R2 control bytes, nonce and storage revision selected at
            the retired source head. Native control must be sealed at that fence,
            identity and genesis. This binds the selected archive frontier, not
            proof that every historical payload is still present or that accounting
            has been replayed. Full inspection with this expected seal checks its
            exact control version before and after walking every edge to genesis;
            even a same-body control rewrite invalidates the old selection. */
        }
        item def NativeCatalogControlSnapshot {
            attribute version : FormatVersion;
            attribute catalogObjectId : Identifier;
            attribute revision : Natural;
            item identity : BookIdentity;
            attribute genesisHash : Digest;
            attribute status : CatalogStatus;
            attribute fence : Natural;
            item retirement : NativeWriterRetirement[0..1];
            item sealed : NativeArchiveSeal[0..1];
            attribute mutationId : Identifier;
            attribute expectedCatalogHash : Digest[0..1];
            attribute contentHash : Digest;
            attribute recoveryEvidenceId : Identifier[0..1];
            attribute recoverySourceCatalogHash : Digest[0..1];
            doc /* Native platform-confirmed authority in a distinct physical
            object outside the book restore set. One bounded current record, not
            another accounting history. Compare complete prior record content and
            advance control revision atomically. Immediate identical retries return
            the current retained mutation; obsolete prior revisions cannot reapply.
            Reserve exact generation-zero identity/genesis explicitly. Repeat
            reservation never resets lifecycle state. Missing rows in an existing
            catalog, corrupt data or co-located book storage cannot auto-initialize.
            Activation requires the configured book reader to verify actual sole
            committed activation, matching genesis and reserved writer fence, durable archive initialization
            and archived activation at an unchanged head. Caller-provided readiness
            or hash fields are not authority. Missing archive control is not repaired
            by activation. Gateway/issuer integration and verified replacement
            activation remain separate obligations; this record is not a permit. */
        }
        item def NativeRecoveryEvidence {
            item scope : BookIdentity;
            attribute requestId : Identifier;
            attribute expectedCatalogHash : Digest;
            attribute evidenceId : Identifier;
            attribute approvedBy : Identifier;
            attribute genesisHash : Digest;
            item head : NativeLedgerHead;
            item projection : NativeProjectionFingerprint;
            attribute authorizationRevision : Natural;
            doc /* Trusted incident-authority evidence, not a caller-selected
            archive prefix or a target-computed fingerprint. Independently
            authenticate the operator and reconcile the complete acknowledged
            history including retained rejections, source projection and latest
            access revision from surviving evidence. Bind the original active
            catalog revision, stable scope, genesis and incident request. A
            surviving snapshot must be proved complete, not merely self-consistent.
            Reauthorize after the physical writer quarantine barrier, covering
            in-flight acknowledgements. Inability to prove completeness or current
            operator authorization refuses recovery. The application owns this
            signing authority. A pinned public-key configuration verifies short-
            lived purpose-separated incident and recovery credentials locally;
            signing keys never enter the ledger. An absent configuration leaves
            disaster approval disabled. Signatures attest operator reconciliation,
            not automatic proof of completeness of a surviving snapshot. */
        }
        item def CatalogControlSnapshot {
            attribute version : FormatVersion;
            attribute catalogObjectId : Identifier;
            attribute revision : Natural;
            item catalogEntry : CatalogEntry;
            item sealedAnchor : ArchiveAnchor[0..1];
            attribute sealedControlNonce : String[0..1];
            item restorePermit : RestorePermit[0..1];
            attribute mutationId : Identifier;
            attribute mutationKind : CatalogMutationKind;
            attribute expectedCatalogHash : Digest[0..1];
            attribute contentHash : Digest;
            doc /* One current mutable control-plane record per book, in a separate
            SQLite-backed object outside the book restore set. The catalog object
            cannot be the book object or share its physical ledger tables. This is
            not another accounting outcome history. Full-record CAS increments an
            independent revision; mutation identity is the expected full record
            hash plus operation ID. An immediate identical retry returns the retained
            current result; an obsolete expected revision cannot be reapplied after
            later mutations. Reservation never resets an existing lifecycle status.
            A sealed anchor is a usable maintenance cutoff only while this exact
            revision remains in maintenance; when active it is historical evidence,
            not the latest financial head. Missing/damaged existing records cannot
            be repaired by normal reads, postings or automatic new-book creation. */
        }
        item def VerifiedArchiveBookHead {
            item identity : BookIdentity;
            attribute genesisHash : Digest;
            item head : DurableHead;
            attribute manifestHash : Digest;
            attribute archiveControlBody : String;
            attribute archiveStorageRevision : String;
            attribute archiveControlNonce : String;
            attribute restoredUnderPermitHash : Digest[0..1];
            doc /* Evidence from the trusted book-object reader after complete SQL
            and archive replay, no unresolved selection, durability confirmation,
            matching full heads/manifest and unchanged observed control version.
            Not an echo of request fields and not public readiness. The caller must
            retain its external fence and conditionally change the same catalog
            revision before allowing ingress. */
        }
        item def ArchiveAbandonmentReceipt {
            attribute version : FormatVersion;
            attribute selectionHash : Digest;
            item priorAnchor : ArchiveAnchor;
            item sealedCatalog : CatalogControlSnapshot;
            attribute contentHash : Digest;
            doc /* Historical recovery result, not a financial outcome, absence
            barrier or present readiness claim. Bind the discarded exact local
            selection hash to its unchanged full prior anchor and the strictly
            newer sealed catalog fence. Persist with the atomic selection clear;
            a lost durability response must retry this same result. Retain the
            latest receipt across later selection/materialization, separately from
            canonical materialization evidence. Superseded older abandonment
            requests fail closed; no unbounded second outcome history is created. */
        }
        item def NativeRestoreHandoff {
            item identity : BookIdentity;
            attribute approvalHash : Digest;
            attribute writerFence : Natural;
            attribute authorizationRevision : Natural;
            item expectedHead : DurableHead;
            item projection : NativeProjectionFingerprint;
            attribute phase : NativeRestorePhase;
            doc /* Controlled native recovery preserves the stable identity and
            original financial head. After full archive replay/projection verification
            or bounded native-snapshot chain/projection verification,
            create prepared access at the approved higher writer fence and source
            authorization revision in the same local transaction as prepared
            restore evidence. Prepared access rejects public reads, writes,
            retries and revocations, even if routing is stale. The coordinator
            verifies actual prepared book evidence, conditionally resumes only
            the exact sealed archive frontier, then CAS-activates the independent
            catalog. Only observing that durable matching catalog state permits
            the book to atomically activate local access. No financial outcome is
            appended by these transitions; prior capabilities retain the old
            fence and cannot revive. Lost replies reconcile the same prepared,
            archive, catalog or local transition. A completed local activation
            retry returns its historical cutoff without overwriting newer books,
            authorization revisions or archive progress. */
            doc /* Native snapshots require the same independently approved exact
            cutoff and complete projection fingerprint as archive recovery. Verify
            every canonical outcome hash/link and all fact bodies without replay
            or rewriting financial rows. The restored authorization revision must
            equal the approved source revision; access must belong to the retired
            incarnation (active previous fence or matching retirement). Preserve
            revocation event records when preparing the higher fence. A shorter
            snapshot is not permission to drop acknowledged outcomes. */
        }
        item def NativeProjectionFingerprint {
            attribute version : FormatVersion;
            item identity : BookIdentity;
            item expectedHead : DurableHead;
            attribute factCount : Natural;
            attribute digest : Digest;
            doc /* Native recovery compares the complete persisted fact projection,
            not just journal totals or retained receipts. Scan raw tuple identity
            order and hash each exact body, mutability and originating outcome
            sequence using a domain-separated chain seeded by identity and head.
            The retired source remains unavailable while a durable bounded cursor
            scans at most 32 rows and one MiB of fact bodies per call. A short
            byte-limited page is not completion; only the empty indexed suffix is.
            Persist its completed fingerprint in the separate approving catalog
            before source storage is lost or replaced. Replayed target facts must
            reproduce that independent count/digest before writer activation.
            A target-computed fingerprint alone is not recovery authority. This
            source observation is for controlled exact-head recovery; it does not
            invent unavailable source evidence after an unplanned primary loss. */
        }
        item def RestorePermit {
            attribute version : FormatVersion;
            item identity : BookIdentity;
            item expectedHead : DurableHead;
            attribute fenceGeneration : Natural;
            attribute sourceBackupId : Identifier;
            attribute approvedBy : Identifier;
            attribute permitId : Identifier;
            attribute catalogObjectId : Identifier;
            attribute catalogRevision : Natural;
            attribute catalogHash : Digest;
            item catalogAuthority : CatalogEntry;
            item sealedAnchor : ArchiveAnchor;
            attribute sealedControlNonce : String;
            attribute contentHash : Digest;
            item expectedNativeProjection : NativeProjectionFingerprint[0..1];
            doc /* Mandatory for the native controlled restore path. Its identity
            and expectedHead must agree with this permit; incomplete source scans
            cannot authorize restoration. This is derived-state completeness
            evidence, not a replacement for canonical outcome validation or the
            sealed cutoff. Archive installation additionally replays commands;
            native snapshot adoption verifies the original chain and projection. */
            doc /* Capture after ingress is fenced, queue drained and storage synced;
            persist externally before changing the book database. Restore in place
            under the same identity, verify snapshot and full tail to expectedHead.
            If that head cannot be recovered, stay unavailable: no silent acceptance
            of data loss, no alternate writable fork, no rewriting expectedHead.
            Canonical archive manifests do not retain transport ETags/nonces from
            prior selected envelopes. A full archive restore must build new local
            restore/materialization evidence under the external permit, without
            inventing those historical transport values or rewriting original
            outcomes, candidate manifests or financial hashes. Normal selected-
            candidate reconciliation is not a substitute for that restore workflow. */
            doc /* Bind the complete sealed anchor/control, identity, original
            genesis and pinned policy/format to the approving catalog revision.
            sourceBackupId is the canonical manifest content hash at that cutoff.
            approvedBy records provenance; the caller must separately authenticate
            and authorize the approver. A prepared or decoded permit is not current
            authority: persist by catalog CAS and confirm durability first. */
        }
        item def ArchiveRestoreImage {
            attribute catalogHash : Digest;
            item permit : RestorePermit;
            item genesis : Genesis;
            item outcome : OutcomeRecord[0..*];
            item genesisManifest : ArchiveGenesisManifest;
            item lastManifest : ArchiveCommitManifest[0..1];
            item predecessorGenesis : ArchiveGenesisManifest[0..1];
            item predecessorCommit : ArchiveCommitManifest[0..1];
            doc /* Read-only exact materialization input from full canonical replay
            under the currently retained external permit. Preserve original genesis
            and every committed/rejected outcome body, frame and complete head.
            This image grants no overwrite authority and does not certify local
            restoration; an installer must recheck authority and persist separate
            restore evidence. Do not invent historical publisher ETags/nonces. */
        }
        item def LocalRestoreReservation {
            attribute version : FormatVersion;
            attribute phase : RestoreInstallPhase;
            item catalog : CatalogControlSnapshot;
            item installedGenesis : ArchiveGenesisManifest[0..1];
            item installedCommit : ArchiveCommitManifest[0..1];
            item predecessorGenesis : ArchiveGenesisManifest[0..1];
            item predecessorCommit : ArchiveCommitManifest[0..1];
            attribute contentHash : Digest;
            doc /* One bounded local record outside canonical replacement tables.
            Selected phase contains the exact externally retained permit and no
            installed manifests. Installed phase retains either the exact genesis
            or commit cutoff manifest, plus its predecessor when nonzero, allowing
            cold verification without invented old publisher control metadata.
            Canonical replacement and installed evidence commit together. Normal
            owner operations fail closed while selected or if this record is corrupt.
            New reservations require a strictly newer authorized fence; exact
            installed retries are read-only even after subsequent postings. This
            local row does not replace the external catalog or protect against an
            uncoordinated provider rollback of the whole book object. */
        }
        item def ArchiveRestoreReceipt {
            attribute disposition : RestoreInstallDisposition;
            attribute permitHash : Digest;
            item restoredHead : DurableHead;
            attribute restoreStateHash : Digest;
            doc /* Historical installation receipt, not current public readiness
            or an absence barrier. RestoredHead remains the original permit cutoff
            even if later postings have advanced the book. */
        }
        item def ReadRequest {
            item identity : BookIdentity;
            item authorization : AuthorizationContext;
            item minimumHead : DurableHead[0..1];
            attribute pageLimit : Natural;
            attribute afterOutcomeSequence : Natural;
        }
        item def ReadPage {
            item snapshotHead : DurableHead;
            item outcome : OutcomeRecord[0..*];
            attribute afterOutcomeSequence : Natural;
            attribute nextOutcomeSequence : Natural;
            doc /* Freeze snapshotHead on first page; subsequent cursor binds identity,
            format, generation and that head. Return only rows within its cutoff,
            including rejections. Consumer deduplication key is book/generation/Oseq.
            No delivery acknowledgement or external side effect is a book commit. */
        }
        enum def InventoryPostedAuditDisposition { attributed; proposedAttribution; requiresReview; }
        enum def InventoryPostedAttribution { canonical; proposed; }
        item def InventoryPostedWitnessShare {
            attribute holdingId : Identifier;
            attribute postedAmount : String;
        }
        item def InventoryPostedWitnessPosting {
            attribute postingId : Identifier;
            attribute postingHash : Semantics::ContentHash;
            item share : InventoryPostedWitnessShare[1..10000];
        }
        item def InventoryPostedWitness {
            attribute version : String;
            attribute sourceHash : Semantics::ContentHash;
            item posting : InventoryPostedWitnessPosting[1..10000];
            doc /* Optional bounded JSON proposal, not an authenticated historical
            assertion or command. Version legacy-inventory-posted-attribution-v1
            requires exact envelope fields, at most 1 MiB UTF-8 and 10000 total
            shares, unique posting IDs and per-posting holding IDs, canonical
            decimal strings and complete valid content hashes. Decode and copy
            before ledger I/O. Bind sourceHash to the complete recovered scope and
            durable head, including retained rejections and storage generation.
            Posting hashes bind actual canonical postings; eligible holding IDs
            and exact carrying weights come from recovered canonical allocations,
            never caller-supplied weights. In canonical holding-ID order allocate
            absolute actual posted total P by Q(P*cumulativeWeight/totalWeight)
            differences under the posting's full historical quantization policy,
            then restore its sign. Every supplied amount must equal that exact
            share, and the shares must sum to the actual posted total. Nonzero
            posted total with zero multi-target weight requires review. Transfer
            destinations inherit the opposite accepted source shares; do not
            independently reround by destination order. Mixed-sign net value
            adjustments remain unresolved. Any stale source, wrong posting hash,
            incomplete or inconsistent shares, or unused witness row requires
            review. An accepted proposal remains proposed attribution, never
            retroactively canonical evidence or authority to mutate a book. */
        }
        item def InventoryPostedAuditFinding {
            attribute code : String;
            attribute reference : String;
            attribute observedAmount : String[0..1];
            attribute bookRevision : Natural[0..1];
            doc /* Diagnostic amounts are exact rational strings, not authority to
            initialize a new balance. Revision identifies an earlier completed
            defect even when later activity would hide it in the current balance.
            For negative_economic_quantity, observedAmount is the exact quantity
            of the referenced holding, not functional-currency money. */
        }
        item def InventoryPostedBalance {
            attribute holdingId : Identifier;
            attribute accountId : Identifier;
            attribute commodityId : Identifier;
            attribute functionalCommodityId : Identifier;
            attribute dimensionMemberIds : Identifier[0..*];
            attribute postedCarryingAmount : Semantics::ExactRational;
        }
        item def InventoryPostedMovement {
            attribute holdingId : Identifier;
            attribute postingId : Identifier;
            attribute journalId : Identifier;
            attribute effectKey : String;
            attribute bookRevision : Natural;
            attribute postingHash : Semantics::ContentHash;
            attribute quantizationPolicyHash : Semantics::ContentHash;
            attribute postedAmount : Semantics::ExactRational;
            attribute attribution : InventoryPostedAttribution;
        }
        item def InventoryPostedAudit {
            item identity : BookIdentity;
            item snapshotHead : DurableHead;
            attribute sourceHash : Semantics::ContentHash;
            attribute witnessHash : Semantics::ContentHash[0..1];
            attribute disposition : InventoryPostedAuditDisposition;
            item balance : InventoryPostedBalance[0..*];
            item movement : InventoryPostedMovement[0..*];
            item finding : InventoryPostedAuditFinding[0..*];
            doc /* Read-only legacy attribution through one fully recovered head,
            subject to the same trusted read authorization. No new outcome,
            anchor, policy, correction or migration is created. Attribute actual
            canonical posting values only where the holding share is unique;
            never reconstruct a posted budget by rounding exact remaining cost.
            Multiple-holding posting shares without an explicit validated
            attribution proposal, missing sources, conflicting coordinates,
            transfer-value/sign mismatches, relevant unsupported corrections,
            unclassified postings in tracked accounts, negative posted balances,
            depleted or zero-carrying residuals, movements before the referenced
            lot acquisition instant, and negative economic quantity prefixes
            require review. Derive quantity changes from recovered acquisitions
            and exact canonical disposal/transfer allocations, not allocation
            proposals or posted currency amounts. Inspect them in economic-instant
            order, preserving UTC offsets and all supplied fractional-second
            precision, with book revision breaking equal-instant ties; net each
            holding's changes within a journal atomically. A later-entered inflow
            with an earlier economic instant may legitimately cover an issue;
            an economically later inflow cannot hide an earlier shortage.
            Sorting these read-only audit events must not reorder or rewrite
            canonical history, recompute costing, or imply full as-of valuation
            and restatement support. Any finding
            suppresses the entire usable balance/movement set. An attributed
            result proves this scoped attribution only, not correct valuation or
            migration eligibility. A result depending on a proposal must instead
            be proposedAttribution with a normalized witness hash and per-movement
            canonical/proposed provenance. It is historical at snapshotHead, not a promise
            that publication has not advanced. This legacy audit uses complete
            verified history and is not a bounded indexed migration algorithm. */
        }
        item def TransitionEvidence {
            item before : DurableHead;
            item resulting : DurableHead;
            attribute decision : RetentionDecision;
            attribute retained : Boolean;
            attribute revisionPresent : Boolean;
            attribute identityMatches : Boolean;
            attribute authorized : Boolean;
            attribute decoded : Boolean;
            attribute sameCommand : Boolean;
            attribute fullHeadMatches : Boolean;
            attribute transactionCommitted : Boolean;
            attribute durable : Boolean;
            attribute acknowledged : Boolean;
            attribute serviceFailure : Boolean;
            attribute withinCapacity : Boolean;
        }
        item def RecoveryEvidence {
            attribute ready : Boolean;
            attribute identityMatches : Boolean;
            attribute versionsSupported : Boolean;
            attribute completeReplay : Boolean;
            attribute expectedHeadMatches : Boolean;
            attribute protocolMatches : Boolean;
            attribute catalogActive : Boolean;
            attribute fenceMatches : Boolean;
            attribute sessionReused : Boolean;
            attribute verifiedBase : Boolean;
            attribute exactCurrentView : Boolean;
            attribute exactCatalogs : Boolean;
            attribute authorityLive : Boolean;
            attribute noUncertainWrite : Boolean;
            attribute confirmedDelta : Boolean;
        }
        item def CheckpointEvidence {
            attribute visible : Boolean;
            attribute chunksComplete : Boolean;
            attribute decoded : Boolean;
            attribute cutoffMatches : Boolean;
        }
        item def RestoreEvidence {
            attribute ready : Boolean;
            attribute fenced : Boolean;
            attribute independentPermit : Boolean;
            attribute expectedHeadMatches : Boolean;
            attribute completeReplay : Boolean;
            doc /* fenced means ingress remained fenced throughout capture/restore;
            reopening additionally requires successful current-generation catalog CAS. */
        }
        item def ArchiveAcknowledgementEvidence {
            item policy : DurabilityPolicy;
            attribute acknowledged : Boolean;
            attribute publicReady : Boolean;
            attribute archivePhase : String;
            attribute pendingSelection : Boolean;
            attribute sqliteDurable : Boolean;
            attribute archiveCanonical : Boolean;
            attribute payloadVerified : Boolean;
            attribute membershipVerified : Boolean;
            attribute fenceVerified : Boolean;
        }
        item def ArchivePublicationEvidence {
            attribute published : Boolean;
            attribute selectedDurably : Boolean;
            attribute priorHeadMatches : Boolean;
            attribute fenceMatches : Boolean;
            attribute conditionalWriteSucceeded : Boolean;
            attribute candidateMatches : Boolean;
            attribute expectedPayloadHash : Digest;
            attribute observedPayloadHash : Digest;
        }
        item def ArchiveReconciliationEvidence {
            attribute abandoned : Boolean;
            attribute canonicalCommit : Boolean;
            attribute priorHeadMatches : Boolean;
            attribute fenceReplacementConfirmed : Boolean;
            attribute catalogFenceMatches : Boolean;
            attribute previousFence : Natural;
            attribute resultingFence : Natural;
            attribute selectionClearedDurably : Boolean;
            attribute recovered : Boolean;
            attribute payloadVerified : Boolean;
            attribute membershipVerified : Boolean;
            attribute expectedCandidateHash : Digest;
            attribute observedCandidateHash : Digest;
            attribute expectedOutcomeSequence : Natural;
            attribute observedOutcomeSequence : Natural;
        }
    }

    package Invariants {
        constraint def IndexedCoverage {
            in usable : Boolean; in coldThrough : Natural; in hotFrom : Natural;
            in hotThrough : Natural; in committedThrough : Natural;
            in coldCount : Natural; in hotCount : Natural; in expectedCount : Natural;
            in exactPopulationsVerified : Boolean;
            not usable or (coldThrough <= hotThrough and hotFrom == coldThrough + 1 and hotThrough == committedThrough and coldThrough <= coldCount and hotThrough <= coldThrough + hotCount and coldCount + hotCount == expectedCount and exactPopulationsVerified and ((coldThrough == hotThrough and hotCount == 0) or (hotFrom <= hotThrough and 1 <= hotCount)))
        }
        constraint def IndexCutover {
            in installed : Boolean;
            in expectedViewRevision : Natural; in currentViewRevision : Natural; in resultingViewRevision : Natural;
            in expectedColdDigest : String; in currentColdDigest : String;
            in currentColdThrough : Natural; in frozenThrough : Natural; in resultingColdThrough : Natural;
            in currentThrough : Natural; in resultingHotFrom : Natural; in resultingHotThrough : Natural;
            in expectedHeadDigest : String; in beforeHeadDigest : String; in afterHeadDigest : String;
            in identityAndFenceVerified : Boolean; in frozenPrefixVerified : Boolean;
            in replacementVerified : Boolean; in tailPreserved : Boolean;
            in postingResolved : Boolean; in transactionDurable : Boolean;
            not installed or (expectedViewRevision == currentViewRevision and resultingViewRevision == currentViewRevision + 1 and expectedColdDigest == currentColdDigest and currentColdThrough <= frozenThrough and frozenThrough <= currentThrough and resultingColdThrough == frozenThrough and resultingHotFrom == frozenThrough + 1 and resultingHotThrough == currentThrough and expectedHeadDigest == beforeHeadDigest and beforeHeadDigest == afterHeadDigest and identityAndFenceVerified and frozenPrefixVerified and replacementVerified and tailPreserved and postingResolved and transactionDurable)
        }
        constraint def IndexPinAdmission {
            in admitted : Boolean; in authorityCurrent : Boolean; in contextAndCutoffVerified : Boolean;
            in currentView : Boolean; in existingPinActive : Boolean;
            in pinRetired : Boolean; in retirementSelected : Boolean;
            not admitted or (authorityCurrent and contextAndCutoffVerified and (currentView or existingPinActive) and not pinRetired and not retirementSelected)
        }
        constraint def IndexReclamation {
            in deleted : Boolean; in derivedOnly : Boolean; in retiredDurably : Boolean;
            in closureVerified : Boolean; in referenceBarrierHeld : Boolean; in replacementVerified : Boolean; in noProtectedReferences : Boolean;
            in identityAndFenceVerified : Boolean; in locationReusable : Boolean; in deletionMatchesRetirement : Boolean;
            not deleted or (derivedOnly and retiredDurably and closureVerified and referenceBarrierHeld and replacementVerified and noProtectedReferences and identityAndFenceVerified and not locationReusable and deletionMatchesRetirement)
        }
        constraint def OutcomeAdvance {
            in retained : Boolean; in before : Natural; in resulting : Natural;
            (retained and resulting == before + 1) or (not retained and resulting == before)
        }
        constraint def RevisionAdvance {
            in committed : Boolean; in before : Natural; in resulting : Natural;
            (committed and resulting == before + 1) or (not committed and resulting == before)
        }
        constraint def RetentionClassification {
            in retained : Boolean; in revisionPresent : Boolean;
            in committed : Boolean; in rejected : Boolean;
            retained == (committed or rejected) and revisionPresent == committed and not (committed and rejected)
        }
        constraint def Acknowledgement {
            in acknowledged : Boolean; in durable : Boolean;
            not acknowledged or durable
        }
        constraint def Admission {
            in retained : Boolean; in identityMatches : Boolean;
            in authorized : Boolean; in decoded : Boolean; in withinCapacity : Boolean;
            not retained or (identityMatches and authorized and decoded and withinCapacity)
        }
        constraint def IndexedKernelAdmission {
            in evaluated : Boolean; in profileSupported : Boolean;
            in completeCatalog : Boolean; in projectionVerified : Boolean;
            in completeReadSet : Boolean; in sourceRowsVerified : Boolean;
            in absenceAndRangesVerified : Boolean; in pinnedHeadMatches : Boolean;
            in publicationFenceMatches : Boolean; in requiredEvidenceAvailable : Boolean;
            not evaluated or (profileSupported and completeCatalog and projectionVerified and
            completeReadSet and sourceRowsVerified and absenceAndRangesVerified and
            pinnedHeadMatches and publicationFenceMatches and requiredEvidenceAvailable)
        }
        constraint def Publication {
            in published : Boolean; in fullHeadMatches : Boolean;
            in transactionCommitted : Boolean;
            not published or (fullHeadMatches and transactionCommitted)
        }
        constraint def NoServiceRetention {
            in serviceFailure : Boolean; in retained : Boolean;
            not serviceFailure or not retained
        }
        constraint def RejectionFinancialIdentity {
            in rejected : Boolean; in before : String; in resulting : String;
            not rejected or before == resulting
        }
        constraint def RestoreReadiness {
            in ready : Boolean; in fenced : Boolean; in independentPermit : Boolean;
            in expectedHeadMatches : Boolean; in completeReplay : Boolean;
            not ready or (fenced and independentPermit and expectedHeadMatches and completeReplay)
        }
        constraint def CheckpointVisibility {
            in visible : Boolean; in chunksComplete : Boolean; in decoded : Boolean;
            in cutoffMatches : Boolean;
            not visible or (chunksComplete and decoded and cutoffMatches)
        }
        constraint def PageCutoff {
            in cursor : Natural; in next : Natural; in cutoff : Natural;
            cursor <= next and next <= cutoff
        }
        constraint def RecoveryReadiness {
            in ready : Boolean; in identityMatches : Boolean; in versionsSupported : Boolean;
            in completeReplay : Boolean; in expectedHeadMatches : Boolean; in protocolMatches : Boolean;
            in catalogActive : Boolean; in fenceMatches : Boolean;
            not ready or (identityMatches and versionsSupported and completeReplay and expectedHeadMatches and protocolMatches and catalogActive and fenceMatches)
        }
        constraint def WarmSessionIntegrity {
            in sessionReused : Boolean; in verifiedBase : Boolean;
            in exactCurrentView : Boolean; in exactCatalogs : Boolean;
            in authorityLive : Boolean; in noUncertainWrite : Boolean;
            in confirmedDelta : Boolean;
            not sessionReused or (verifiedBase and exactCurrentView and exactCatalogs and authorityLive and noUncertainWrite and confirmedDelta)
        }
        constraint def NativeJournalPublication {
            in acknowledged : Boolean; in profileSupported : Boolean;
            in completeCurrentInputs : Boolean; in permanentIdentities : Boolean;
            in headAndAuthorityMatch : Boolean; in singleAtomicPublication : Boolean;
            in platformDurabilityConfirmed : Boolean;
            not acknowledged or (profileSupported and completeCurrentInputs and permanentIdentities and headAndAuthorityMatch and singleAtomicPublication and platformDurabilityConfirmed)
        }
        constraint def ArchiveAcknowledgement {
            in acknowledged : Boolean; in archiveRequired : Boolean;
            in sqliteDurable : Boolean; in archiveCanonical : Boolean;
            in payloadVerified : Boolean; in membershipVerified : Boolean; in fenceVerified : Boolean;
            not acknowledged or (sqliteDurable and (not archiveRequired or (archiveCanonical and payloadVerified and membershipVerified and fenceVerified)))
        }
        constraint def ArchiveServiceReadiness {
            in publicReady : Boolean; in archiveRequired : Boolean;
            in archivePhase : String; in pendingSelection : Boolean;
            not publicReady or not archiveRequired or (archivePhase == "idle" and not pendingSelection)
        }
        constraint def ArchivePublication {
            in published : Boolean; in selectedDurably : Boolean;
            in priorHeadMatches : Boolean; in fenceMatches : Boolean;
            in conditionalWriteSucceeded : Boolean; in candidateMatches : Boolean;
            in expectedPayloadHash : String; in observedPayloadHash : String;
            not published or (selectedDurably and priorHeadMatches and fenceMatches and conditionalWriteSucceeded and candidateMatches and expectedPayloadHash == observedPayloadHash)
        }
        constraint def ArchiveAbandonment {
            in abandoned : Boolean; in canonicalCommit : Boolean;
            in priorHeadMatches : Boolean; in fenceReplacementConfirmed : Boolean;
            in catalogFenceMatches : Boolean;
            in previousFence : Natural; in resultingFence : Natural;
            in selectionClearedDurably : Boolean;
            not abandoned or (not canonicalCommit and priorHeadMatches and fenceReplacementConfirmed and catalogFenceMatches and previousFence + 1 <= resultingFence and selectionClearedDurably)
        }
        constraint def ArchiveRecoveryIdentity {
            in recovered : Boolean; in canonicalCommit : Boolean;
            in payloadVerified : Boolean; in membershipVerified : Boolean;
            in expectedCandidateHash : String; in observedCandidateHash : String;
            in expectedOutcomeSequence : Natural; in observedOutcomeSequence : Natural;
            not recovered or (canonicalCommit and payloadVerified and membershipVerified and expectedCandidateHash == observedCandidateHash and expectedOutcomeSequence == observedOutcomeSequence)
        }
    }

    package Lifecycle {
        attribute def EmptyReserved;
        attribute def HistoryVerified;
        attribute def BeginProvision;
        attribute def ProvisionDurable;
        attribute def BeginCommand;
        attribute def ExistingOutcome;
        attribute def NotRetained;
        attribute def CandidateReady;
        attribute def SqlCommitted;
        attribute def DurabilityConfirmed;
        attribute def HeadConflict;
        attribute def StorageUncertain;
        attribute def StorageUnavailable;
        attribute def Recover;
        attribute def DamageDetected;
        attribute def FenceForMaintenance;
        attribute def RestoreRequested;

        state def BookLifecycle {
            doc /* Events are verified internal outcomes, never caller assertions.
            Unlisted events are forbidden. Reads/replays are served only from ready
            after admission and durability checks, under the same queue as writes.
            Any runtime restart discards memory and enters recovering. Retry and
            maintenance flags bound loops and survive via external maintenance state. */
            attribute reserveVerified : Boolean;
            attribute recoveryVerified : Boolean;
            attribute provisionAuthorized : Boolean;
            attribute genesisDurable : Boolean;
            attribute commandAdmitted : Boolean;
            attribute replayVerified : Boolean;
            attribute unretainedConfirmed : Boolean;
            attribute candidateValidated : Boolean;
            attribute atomicCommitConfirmed : Boolean;
            attribute durabilityConfirmed : Boolean;
            attribute maintenanceAuthorized : Boolean;
            attribute restorePermitted : Boolean;
            entry; then recovering;
            state recovering;
            state unprovisioned;
            state provisioning;
            state ready;
            state evaluating;
            state committing;
            state awaitingDurability;
            state uncertain;
            state quarantined;
            state maintenance;

            transition empty first recovering accept EmptyReserved if reserveVerified then unprovisioned;
            transition verified first recovering accept HistoryVerified if recoveryVerified then ready;
            transition create first unprovisioned accept BeginProvision if provisionAuthorized then provisioning;
            transition created first provisioning accept ProvisionDurable if genesisDurable then recovering;
            transition execute first ready accept BeginCommand if commandAdmitted then evaluating;
            transition replay first evaluating accept ExistingOutcome if replayVerified then ready;
            transition unclaimed first evaluating accept NotRetained if unretainedConfirmed then ready;
            transition candidate first evaluating accept CandidateReady if candidateValidated then committing;
            transition committed first committing accept SqlCommitted if atomicCommitConfirmed then awaitingDurability;
            transition acknowledged first awaitingDurability accept DurabilityConfirmed if durabilityConfirmed then ready;
            transition conflict first committing accept HeadConflict then recovering;
            transition provisionUnknown first provisioning accept StorageUncertain then uncertain;
            transition commitUnknown first committing accept StorageUncertain then uncertain;
            transition durabilityUnknown first awaitingDurability accept StorageUncertain then uncertain;
            transition readUnavailable first ready accept StorageUnavailable then uncertain;
            transition evaluationUnavailable first evaluating accept StorageUnavailable then uncertain;
            transition recoveryUnavailable first recovering accept StorageUnavailable then uncertain;
            transition reread first uncertain accept Recover then recovering;
            transition damaged first recovering accept DamageDetected then quarantined;
            transition readDamaged first ready accept DamageDetected then quarantined;
            transition evaluationDamaged first evaluating accept DamageDetected then quarantined;
            transition fence first ready accept FenceForMaintenance if maintenanceAuthorized then maintenance;
            transition restore first maintenance accept RestoreRequested if restorePermitted then recovering;
            transition repair first quarantined accept FenceForMaintenance if maintenanceAuthorized then maintenance;
        }
    }

    package Behavior {
        action def ReadCurrentPinnedRow {
            in item pin : Domain::IndexReaderPin;
            in collectionName : Domain::Identifier;
            in insertionOrdinal : Natural;
            out item result : Domain::CurrentRowRead[0..1];
            doc /* Open only after full canonical and source-catalog verification.
            Capture the verified catalog/head in an opaque owner-issued context.
            Resolve both authenticated tree paths and the exact bounded genesis or
            outcome source. Recheck catalog/head and live durable pin authority
            before returning row bytes or proven absence. Publication invalidates
            this current-view context; this is not historical MVCC, lazy startup,
            semantic-key range proof or a complete accounting command read set.
            Serialize reads and close. Explicit close releases the lease; any
            failed or uncertain read retires the handle, with durable expiry for
            an uncertain release. Never silently reopen under a different head.
            Legacy and indexed owners may share the read/identity/group algorithm,
            but each supplies its own fully verified physical head, canonical
            source-prefix authority and collection domains. Opening a shared
            reader is not itself a recovery or admission authorization. */
        }
        action def ReadCurrentPinnedCommand {
            in item pin : Domain::IndexReaderPin;
            in commandId : Domain::Identifier;
            out item result : Domain::CurrentCommandRead[0..1];
            doc /* Reuse the fully verified current-view context and its serialized
            failure/retirement boundary. Verify both permanent identity partitions,
            partition sequence bounds and unique membership. Resolve positive hits
            through the authenticated retained collection and exact source bytes;
            compare raw identity, not only digests. Recheck live pin authority and
            captured catalog/head during traversal and before either disposition.
            This does not compare retry input hashes, execute a command, establish
            other command read sets, change startup verification, or make negative
            reads safe for later publication without complete-head CAS. */
        }
        action def ReadCurrentPinnedJournalIdentity {
            in item pin : Domain::IndexReaderPin;
            in identityFamily : Domain::Identifier;
            in rawId : Domain::Identifier;
            out item result : Domain::CurrentJournalIdentityRead[0..1];
            doc /* Use the same verified, serialized, current-head context as
            command-ID reads. Authenticate retained, revision and journal source
            rows separately; cross-check their raw identities and sequence roles.
            Recheck pin/catalog/head through each stage and before returning.
            Positive identity without its required source rows is an error, never
            absence. No complete read-set claim, historical MVCC, retry decision,
            source-reference admission or changed accounting hash is implied. */
        }
        action def ReadCurrentPinnedAccountingIdentity {
            in item pin : Domain::IndexReaderPin;
            in identityFamily : Domain::Identifier;
            in rawId : Domain::Identifier;
            out item result : Domain::CurrentAccountingIdentityRead[0..1];
            doc /* Reuse the fully verified canonical population/source catalog
            and live current-view context. A positive ID locator resolves a retained
            committed outcome and its financial revision, not an accounting row
            ordinal. Cross-bind the source rows before selecting one immutable
            effect with exact family and raw ID. Check explicit book identity where
            carried by the effect; existing verified source closure binds other
            effects through canonical references. Reject missing or ambiguous
            sources, unsupported/mutable families, stale heads and expired authority.
            An immutable source lookup does not prove a complete recognition set,
            current open balance, supersession status or any derived range query.
            Complete-head CAS remains required before later publication. */
        }
        action def ReadCurrentPinnedInventoryIdentity {
            in item pin : Domain::IndexReaderPin;
            in identityKind : Domain::InventoryIdentityKind;
            in rawId : Domain::Identifier;
            out item result : Domain::CurrentInventoryIdentityRead[0..1];
            doc /* Resolve the first creation Oseq through both authenticated
            identity partitions, then bind its retained committed command to the
            exact financial revision row. Select the requested raw typed artifact
            from that owned command and its unique ownership effect. Never treat
            an allocation's creation Oseq as a legacy allocation-row ordinal.
            Reconfirm the full head and source authority before and after I/O;
            rejection-only changes also invalidate the view. Unknown kind, absent
            source, conflicting matches or lost authority retire the reader.
            This is not current-position or complete-pool admission authority. */
        }
        action def ReadCurrentPinnedInventoryPosition {
            in item pin : Domain::IndexReaderPin;
            in holdingId : Domain::Identifier;
            out item result : Domain::CurrentInventoryPositionRead[0..1];
            doc /* Require explicit ownership-group coverage before proving absence.
            Authenticate the greatest member by loading and checking every node on
            the right spine, then independently verify its complete canonical revision
            row and raw holding predicate. Select the greatest matching artifact and
            authenticate its exact anchor through the permanent identity and creating
            retained-result/revision pair. Join the CURRENT holding, not its creation
            snapshot; check quantity, carrying and cumulative posted arithmetic.
            Reconfirm the full live head before/after I/O and synchronous validation;
            any failure retires the reader. A latest-member proof does not enumerate
            history, prove a complete policy pool or authorize a command/publication.
            The map proof loads at most 257 nodes for its 256-bit keys; original row,
            canonical source and owner startup costs are separate. */
        }
        action def ReadCurrentPinnedPostingReferenceUsage {
            in item pin : Domain::IndexReaderPin;
            in referenceId : Domain::Identifier;
            out item result : Domain::PinnedPostingReferenceUsage[0..1];
            doc /* Require explicit reference-profile coverage before proving unused.
            Authenticate the greatest member, its complete canonical revision row,
            book/revision identity and exact raw reference predicate at one live head.
            Mixed accounting command kinds are permitted for this predicate only;
            inventory-specific witnesses retain their owned-command restriction.
            Reconfirm authority before/after I/O and retire on failure, including a
            retained rejection changing Oseq without changing financial revision.
            This fact supplies cross-feature occupancy, not complete admission or
            a new permission to redefine an existing reference's posting source. */
        }
        action def ReadCurrentPinnedInventoryMoneyScope {
            in item pin : Domain::IndexReaderPin;
            in item scope : Domain::InventoryMoneyScope;
            out item result : Domain::PinnedInventoryMoneyScope[0..1];
            doc /* Snapshot exact typed coordinates before yielding; reject accessors,
            extra fields, duplicate members and foreign book/functional identity.
            Require money-profile coverage before proving absence. Authenticate the
            latest ownership-scope revision member and its complete canonical source
            row/raw predicate. Resolve the journal-scope descriptor by its full raw
            key at the SAME source-verified head. Its sum is trusted only after the
            owner has verified complete source closure and independently rebuilt it;
            a valid descriptor digest alone is not accounting authority. Summary reads
            traverse the bounded directory path and fetch no historical journal rows.
            Source audit/startup still has separate full-history costs. Reconfirm live
            head and authority before/after all I/O; any failure retires the reader.
            Presence survives depletion; zero balance does not mean absent history.
            These facts do not compose complete indexed admission by themselves. */
        }
        action def ReadCurrentPinnedInventorySourceJournal {
            in item pin : Domain::IndexReaderPin;
            in journalId : Domain::Identifier;
            out item witness : Domain::InventoryRevisionWitness[0..1];
            doc /* Require source-journal group coverage. Authenticate greatest
            revision membership, its original row and exact anchor/movement journal
            predicate at the selected head. A reference survives depletion and does
            not expire after a later movement. Proven unreferenced means no inventory
            dependency, not that the requested journal exists or is absent. Source
            corrections still require separate command/topology admission. */
        }
        action def PrepareCurrentPinnedOwnedInventory {
            in item pin : Domain::IndexReaderPin;
            in item command : RastrataAccountingBackend::Domain::BookCommand;
            out item candidate : Domain::PreparedOwnedInventoryCommandRead[0..1];
            out item diagnostics : RastrataAccountingBackend::Domain::SemanticDiagnostic[0..*];
            out item finishedCommonResult : RastrataAccountingBackend::Domain::BookCommandResult[0..1];
            doc /* Internal preparation, not a commit intent, durable receipt or
            publication capability. First run the SAME complete common admission
            prefix as EvaluateBookCommand against the owner's full recovered state
            and retained protocol: retry/input/scope/version/financial chronology,
            financial identity, execution-profile history, complete state integrity,
            expected revision, configuration and global accounting obligations, in
            that order. This is a full-state bridge, not sparse admission. Never
            hash a partial header in place of the original canonical state. Snapshot
            the command before awaiting and confirm the live full head before and
            after common admission, including a replay or semantic rejection.
            A finished common result returns immediately, with no command-specific
            indexed inventory reads, candidate, partial effects, or durable
            publication. Full-state integrity checking still traverses canonical
            state. Otherwise compose
            current configuration/period facts, complete original pools, positions
            and origin dates, all seven identity namespaces, journal/posting IDs,
            managed money scopes and acquisition-account live unowned stock.
            Snapshot the command before awaiting; bind every fact to its exact
            command and full source-verified head. Eagerly read original pool rows,
            including depleted ones; same-command successors belong only to the
            shared kernel compiler. Do not trust request-supplied balances/anchors.
            Global posting-reference usage must not use inventory-only absence.
            Quantity-allocation identity checks authenticate their original retained
            result and creating revision, selecting owned or legacy source shape
            without changing their shared permanent namespace. Missing evidence
            never becomes an unoccupied identity or an empty pool.
            Execute the SAME shared kernel preparation as the full-state wrapper:
            profile/opening/period/journal checks, zero newly managed money balance,
            no live unowned stock, exact ownership accounting and pending identities.
            Confirm the full live head immediately before and after synchronous
            preparation; retire the local callback context and throw on any failure.
            An Oseq-only retained rejection also invalidates the candidate.
            Current candidate bounds: 80000 explicit point reads, 10000 scanned
            acquisition holdings and 32 MiB retained source payload budget, with
            conservative duplicate charging. These are not capacity guarantees or
            a peak heap bound. The owner still needs full recovery/admission;
            legacy serialization still emits complete lotState replacements.
            No indexed result from this action alone can authorize publication. */
            doc /* Exactly one common finished result OR command-specific outcome
            may be returned. Command-specific success returns one candidate and no
            diagnostics; semantic failure returns diagnostics without a candidate.
            Infrastructure failure throws without either accounting disposition. */
        }
        action def ReadCurrentPinnedOwnedInventoryPools {
            in item pin : Domain::IndexReaderPin;
            in item command : RastrataAccountingBackend::Domain::BookCommand;
            out item result : Domain::CurrentOwnedInventoryPoolsRead[0..1];
            doc /* Snapshot an owned command before awaiting; recompute its input
            hash. For issue operations only, deduplicate original-source reads by
            policy ID/version/full content hash and units commodity, retaining array
            positions rather than admitting supplied ordinals. Resolve the policy
            from the pinned current configuration; unresolved is not empty stock.
            Exhaust authenticated holdingsByAccount groups for every distinct policy
            account, checking head, catalog, raw predicate, strict source ordinals,
            stable member commitment, complete population and consumed count. Cache
            each account and lot source once. Filter commodity only after exhaustion,
            retain depleted rows and join current authenticated lots by exact raw ID,
            book and both commodities. Sort by canonical holding ordinal, not policy
            account order. Confirm authority after I/O; any failed reader operation
            retires the context without returning partial facts. The candidate has
            a 10000-row scan/output limit and 32 MiB unique encoded-source budget;
            these are local read bounds, not business capacity or retention policy.
            Repeated operation work still needs kernel accounting despite read reuse.
            This uses an existing group predicate under all indexed group profiles;
            no new profile, current positions/anchors, same-command overlay, managed
            money-scope proof, command intent or publication authority is supplied. */
        }
        action def ReadCurrentPinnedLotIdentity {
            in item pin : Domain::IndexReaderPin;
            in identityFamily : Domain::Identifier;
            in rawId : Domain::Identifier;
            out item result : Domain::CurrentLotIdentityRead[0..1];
            doc /* Reuse the fully verified current catalog, permanent identity
            population and live pin. Both identity partitions must prove absence.
            A positive creation locator is not current-value evidence: authenticate
            the current row/content/source separately at the stable legacy ordinal,
            then cross-check raw identity. Recheck catalog/head/authority throughout;
            failed reads retire the context. A future profile that reorders/removes
            these rows needs an explicit current-ID mapping, not silent reuse of
            this rule. This lookup does not prove complete pool/holding ranges or
            remove whole-snapshot lot-effect and complete-evaluation limits. */
        }
        action def PrepareSemanticGroupMemberships {
            in item prior : Domain::CurrentRowRead[0..1];
            in item next : Domain::CurrentRowRead[0..1];
            out item affectedGroups : Domain::SemanticGroupKey[*];
            doc /* Enumerate every old/new membership from complete canonical row
            bytes; conditional changes bind old/new row commitments. Remove a
            depleted holding only from the nonzero group, retain it in all-holding
            groups, and update hashes in groups whose membership is unchanged.
            Unknown predicates cannot silently produce empty groups. Rebuild and
            compare complete groups against canonical state before adoption.
            Membership projection alone does not provide owner cursors or
            source-verified grouped reads. */
        }
        action def PublishDerivedSemanticGroupCatalog {
            in item expected : Domain::DerivedSemanticGroupCatalog[0..1];
            in item next : Domain::DerivedSemanticGroupCatalog;
            in item outcome : Domain::OutcomeRecord[0..1];
            doc /* Initial provisioning or retained-outcome publication only.
            Prepare conditional member and directory changes from verified prior
            and next canonical rows, retaining depleted holdings in all-holding
            groups and deleting only genuinely empty directory entries. Compare
            the resulting complete directory with a fresh canonical rebuild.
            Publish staged nodes, raw-key descriptors and metadata CAS in the same
            live owner transaction as canonical head, source catalog and identity
            roots. Reject same-digest/different-byte content and stale authority;
            never acknowledge partial publication. Ordinary journals/rejections
            advance metadata head without rewriting unchanged group members.
            Recovery verifies complete canonical history, group projection and
            all required stored nodes before readiness. No lazy startup, obsolete
            node garbage collection or source-verified query API is implied. */
        }
        action def ReadPinnedSemanticGroupPage {
            in item pin : Domain::IndexReaderPin;
            in item group : Domain::SemanticGroupKey;
            in maximumMembers : Natural;
            in maximumRowBytes : Natural;
            out item result : Domain::PinnedSemanticGroupPage[0..1];
            doc /* The owner snapshots raw tuple inputs, captures both fully
            verified catalogs and derives the collection domain from the source
            capture. Serialize cursor operations with all reads/close operations
            on that owner context. Query the authenticated directory and member
            range; resolve each delivered ordinal/hash through current canonical
            source evidence and verify raw grouping predicates after typed decode.
            Recheck head/catalog/pin through I/O and before returning the whole page.
            Limits are 1..256 members and 1..1048576 UTF-8 canonical row bytes per
            page; raw key JSON is separately limited to 1048576 bytes. These are
            bounded internal payloads, not an HTTP wire-size specification.
            If a further row exceeds the remaining byte budget, retain its exact
            ordinal as the next position; if no row fits, fail explicitly instead
            of yielding empty incomplete pages. Advance only after full-page
            verification. Closing early does not prove population completion;
            publication, expiry, authority changes or any failed read retire the
            whole context. No complete indexed command evaluator, historical MVCC
            or bounded startup follows from this query primitive. */
        }
        action def ReadPinnedBookBasis {
            in item pin : Domain::IndexReaderPin;
            out item result : Domain::PinnedBookBasis[0..1];
            doc /* Use only the owner's fully recovered scalar state under the
            same captured full head and verified source catalog. Check financial
            identity and head scalar/hash agreement. Authenticate configuration
            row at configurationRevision + 1, boundary row at 1, and financial
            revision at bookRevision (or prove row 1 absent for revision zero).
            Check raw canonical row bytes against the recovered selected values,
            configuration revision/scope/hash and financial revision/chain head.
            Recheck the live context before returning; any failure retires it.
            A configuration revision may precede activation. Never use latest
            retained outcome as the last financial revision or treat initial
            fiscal configuration as proof of current period closure. Complete
            startup verification remains mandatory; this is a common read basis,
            not a trusted caller flag or a complete command read context. */
        }
        action def ReadPinnedAdmissionFacts {
            in item pin : Domain::IndexReaderPin;
            in item command : RastrataAccountingBackend::Domain::BookCommand;
            out item result : Domain::PinnedAdmissionFacts[0..1];
            doc /* Snapshot the bounded typed command and bind facts to recomputed
            canonical command content. In one serialized owner operation, read the
            common basis, exhaust each current period's transition group, and fold
            unrealized-result and reversal groups under the first applicable
            current policy ID. Choose the minimum canonical result ordinal across
            policy groups. Verify every consumed page/source and the final live
            view. Inner cursors run inside this operation, never enqueue behind it
            or escape to callers. Failure emits no partial facts or accounting
            rejection. Retained-command lookup and input/version/timeline checks
            must still precede this guard in actual evaluation. Group traversal
            can scale with its complete populations; this is not constant-cost
            admission or an enabled indexed evaluator. */
        }
        action def ReadLogicalRangePage {
            in rootCommitment : Domain::Digest;
            in domainCommitment : Domain::Digest;
            in fromInclusive : Domain::Digest[0..1];
            in throughExclusive : Domain::Digest[0..1];
            in limit : Natural;
            out item result : Domain::LogicalRangePage[0..1];
            doc /* Require limit 1..256 and ordered range bounds. Authenticate the
            root even for empty ranges. Prune only by authenticated subtree fences,
            traverse matching leaves in canonical key order, and propagate missing
            bytes/corrupt nodes instead of issuing a successful partial proof.
            This primitive neither authenticates owner authority nor validates a
            complete semantic group directory, source rows or command read set. */
        }
        action def PublishDerivedSourceCatalog {
            in item expected : Domain::DerivedSourceCatalog;
            in item next : Domain::DerivedSourceCatalog;
            in item outcome : Domain::OutcomeRecord;
            doc /* Prepare immutable content nodes and source locators under the
            exact verified prior catalog and live construction pin. Compare every
            resulting collection root/population with the verified accounting
            transition. Publish canonical outcome, full head, identity-index root,
            source nodes/locators and catalog in one same-store transaction under
            the existing full-head/fence CAS. Confirm durability before receipt.
            The current opt-in new-book profile fully verifies catalogs/sources
            during recovery, retains old nodes and has no automatic adoption or
            reclamation. First provisioning is atomic; concurrent same-genesis
            requests reconcile the verified winner, never replace it. */
        }
        action def ReadPinnedIdentityRange {
            in item pin : Domain::IndexReaderPin;
            in item query : Domain::IndexKeyRange;
            in maximumMatches : Natural;
            out item batch : Domain::IndexRangeBatch;
            doc /* Traverse only intersecting authenticated child fences, checking
            required page bytes, descriptor populations and exact child bounds.
            Merge hot/cold entries in key order without duplicate keys; each Oseq
            must belong to its captured partition. Recheck the pin through I/O and
            across batch continuation. Missing storage cannot become an empty set.
            Memory is bounded by traversal depth/pages and batches, not history;
            total work still follows the selected range. Consumers must drain the
            internally owned traversal to its terminal completion before using an
            exact population. Request-supplied completion flags are not evidence. */
        }
        action def ProvisionIndexedBook {
            in item genesis : Domain::Genesis;
            out item initialHead : Domain::DurableHead[0..1];
            doc /* Only an explicitly authorized fresh compact book may initialize
            indexed ownership. Provision canonical genesis/chunks, index control,
            empty hot/cold roots, pin/construction registry, page allocation state
            and owner identity marker in one same-store synchronous transaction.
            Failure rolls all components back. Confirm durability before use; an
            unknown reply reconciles the exact existing complete book rather than
            reinitializing or adopting a bare/older-format canonical store. This is
            the local-storage substep of ProvisionBook, not a retained command or
            permission to bypass its authorization, catalog or archive obligations. */
        }
        action def ValidateRecoveredIndexedBook {
            in item recoveredHead : Domain::DurableHead;
            in item selectedView : Domain::IndexedView;
            out item admittedView : Domain::IndexedView[0..1];
            doc /* The ledger first verifies canonical history through the current
            head, even for historical-cutoff reads. The indexed owner's recovery
            hook then checks full scope/head and exact hot/cold populations against
            canonical identities under a live pin, rejecting missing, substituted,
            duplicate or wrongly dated entries. A source/head race cannot authorize
            stale publication; execution retries only a recognized full-head conflict.
            This current full-scan implementation is not the future bounded recovery
            protocol. No verified boolean supplied by a request substitutes for
            canonical replay, population validation or publication CAS. */
        }
        action def PrepareIndexedOutcomeChanges {
            in item before : Domain::IndexedBookStateRecord;
            in item intent : RastrataAccountingBackend::Domain::BookCommitIntent[0..1];
            in item retainedRejection : RastrataAccountingBackend::Domain::BookCommandResult[0..1];
            in item previousRevision : RastrataAccountingBackend::Domain::RevisionRecord[0..1];
            in item workBudget : Domain::IndexedChangeWorkBudget[0..1];
            out item candidate : Domain::IndexedOutcomeChangeCandidate[0..1];
            doc /* Exactly one separately admitted new decision: commit intent or
            retained rejection. Capture all inputs before asynchronous source reads.
            For a commit, construct canonical records with the shared kernel
            constructor and authenticate the supplied complete financial predecessor
            row against its current revision root. Retained rejection changes only
            the protocol collection and preserves financial header/root exactly.
            Map every immutable effect to canonical collections in effect order.
            Activation replaces the boundary singleton and opens status;
            configuration appends its snapshot and advances matching scalar fields;
            lotState explicitly replaces all three legacy lot populations. Other
            effects append their typed rows. Append the new revision and retained
            result in the same candidate. Verify present/absent prior commitments
            along every changed path. Missing nodes cannot become empty rows.
            Recompute the complete resulting catalog and count relationships.
            This action is projection, not complete command evaluation, permanent
            identity admission, configuration/source semantic closure or a storage
            write. A well-framed rejection is not proof of a valid economic reason.
            Publication must also bind trusted full scope/head/fence, complete read
            evidence, all identity/source projections and original outcome bytes in
            one atomic durable transaction. No current adapter adopts this profile. */
        }
        action def FrameIndexedOutcomeChain {
            in item beforeState : Domain::IndexedBookStateRecord;
            in item expectedBeforeHead : Domain::IndexedBookHeadRecord;
            in item afterState : Domain::IndexedBookStateRecord;
            in item outcome : Domain::OutcomePayload;
            out item record : Domain::IndexedOutcomeChainRecord[0..1];
            doc /* Strict closed canonical decoding against independently supplied
            prior state/head, full expected physical scope and actual object ID.
            Advance Oseq exactly once. Recompute original command/result hashes.
            Rejection preserves the exact financial root and financial revision
            hash, with observed revision equal to prior revision. Commit advances
            financial revision once, posting sequence by journal-effect count and
            configuration revision by configuration-effect count (at most one).
            Check activation status, configuration predecessor/hash and exact
            canonical revision/result bytes through the shared kernel constructor.
            Bind the new head to the acyclic chain and resulting state commitment.
            Reject unknown versions/fields, noncanonical bytes and changed hashes.
            This does not establish row availability, complete effect projection,
            valid rejection reasons, accounting admission or durable publication. */
        }
        action def ReplayIndexedOutcomeProjection {
            in item beforeState : Domain::IndexedBookStateRecord;
            in item expectedBeforeHead : Domain::IndexedBookHeadRecord;
            in item record : Domain::IndexedOutcomeChainRecord;
            in item previousRevision : RastrataAccountingBackend::Domain::RevisionRecord[0..1];
            out item candidate : Domain::IndexedOutcomeChangeCandidate[0..1];
            doc /* First validate framing against the exact expected head and
            scope. Derive the immutable intent from original commit effects and
            headers, or the original retained rejection. Authenticate a commit's
            complete financial predecessor against prior revision-root membership;
            rejection requires no predecessor. Replay every ordered row change
            through PrepareIndexedOutcomeChanges against prior authenticated nodes.
            Require byte-exact resulting complete state and original outcome, not
            just new-row membership or scalar equality. Missing source paths fail
            without a partial result or writes. This is projection verification,
            not reexecution of accounting admission or full historical verification.
            Active ownership, permanent identity absence, atomic physical indexes,
            full-head/fence CAS and durable confirmation remain separate obligations.
            No enabled adapter or migration adopts this record yet. */
        }
        action def ProjectIndexedOutcomeSource {
            in item beforeState : Domain::IndexedBookStateRecord;
            in item expectedBeforeHead : Domain::IndexedBookHeadRecord;
            in item record : Domain::IndexedOutcomeChainRecord;
            in expectedSourceCommitment : Domain::Digest;
            out item projection : Domain::IndexedOutcomeSourceProjection[0..1];
            doc /* Verify exact indexed framing, full scope/actual object and the
            independently supplied expected source commitment. Extract retained,
            revision and all twenty separately projected effect-family rows through the same private
            tagged-wire mapper as the unchanged compact format. Do not convert
            ownership into a new mutable row family: its complete effect, anchors,
            movements and allocations are in the authenticated revision row. All
            twenty-one effect variants are therefore represented, including this
            revision-only ownership representation. Do not convert
            amounts or hash metadata, reinterpret legacy hashes, or create a
            fabricated full BookState. Known positions use independent outcome,
            financial and posting counters, configuration revision plus one, or
            singleton/lot member position. Preserve all append/replacement groups.
            When resolving a requested selector, require exactly one matching row,
            a positive uint64 insertion ordinal and its independently authenticated
            indexed collection-domain/ordinal/content commitment. The owner must
            separately prove locator membership, live pinned authority, canonical
            source membership, complete effect projection and accounting admission.
            This action does not install a source catalog or publish an outcome. */
        }
        action def PrepareIndexedSourceCatalog {
            in item prior : Domain::IndexedSourceCatalogRecord[0..1];
            in item outcome : Domain::IndexedOutcomeChainRecord[0..1];
            in item previousRevision : RastrataAccountingBackend::Domain::RevisionRecord[0..1];
            out item candidate : Domain::PreparedIndexedSourceCatalog[0..1];
            doc /* New-book genesis only, or exactly one outcome under the verified
            prior catalog/full canonical anchor. Replay the complete indexed row
            projection from stored authenticated nodes; derive selectors from exact
            original source bytes and authenticated prior collection counts. Change
            locator roots for changed rows only, preserving origins of unchanged
            rows even when a later snapshot repeats them. Check prior row/locator
            presence agreement and old origin bytes before each change. Delete a
            locator when the current canonical row is deleted, never its permanent
            identity/history. Bound staged node/origin bytes to 32 MiB in addition
            to the existing row compiler limits. Discard new intermediate nodes
            unreachable from final financial/locator roots, without traversing or
            reclaiming old nodes. Recheck prior catalog and full anchor after reads.
            Preparation writes nothing and does not perform accounting admission. */
        }
        action def PublishIndexedSourceCatalog {
            in item candidate : Domain::PreparedIndexedSourceCatalog;
            doc /* Internal component of an owner-controlled synchronous SQLite
            transaction, not an independent ledger publication. Require a genuine
            active same-port transaction and instance-local prepared handle. Verify
            resulting complete canonical anchor/genesis, compare exact prior catalog,
            insert immutable node/origin bytes with collision readback and publish
            all roots together by catalog CAS. Verify stored catalog and canonical
            anchor again before returning. A failure rolls back canonical owner
            writes and every source-catalog write together. No sync or receipt is
            issued here: owner must additionally include permanent-ID/group indexes,
            full-head/fence CAS, accounting admission and durable confirmation.
            No enabled BookStorageAdapter adopts this component yet. */
        }
        action def PrepareIndexedSemanticGroupCatalog {
            in item sourceCandidate : Domain::PreparedIndexedSourceCatalog;
            in item prior : Domain::IndexedSemanticGroupCatalogRecord[0..1];
            out item candidate : Domain::PreparedIndexedSemanticGroupCatalog[0..1];
            doc /* Separate new-format component, not an upgrade of the legacy
            full-projection group catalog. Obtain the exact ordered row changes
            from the source instance's opaque prepared handle; a digest alone is
            not authority. Bind physical book identity and prior complete indexed
            head/source/group catalogs. Resolve first-touch old rows through an
            authenticated source capture and verify collection, ordinal, old hash,
            exact bytes and prior head/source digest. Subsequent changes to the
            same row use its intermediate value in original effect order. Derive
            every old/new closed predicate; update hashes even for unchanged group
            membership and remove only obsolete members or truly empty groups.
            Bound newly staged node/descriptor bytes to 32 MiB and prune only new
            intermediate content unreachable from final directory/member roots.
            Reconfirm owner authority and unchanged source plan/prior group catalog
            after reads. No writes, admission, adoption or recovery are performed.
            Before production adoption, independently audit complete groups against
            verified canonical history. AuditIndexedSemanticGroupCatalog checks
            both inclusions and complete reachable trees without an in-memory
            rebuild. Successful incremental preparation alone is insufficient. */
        }
        action def PublishIndexedSemanticGroupCatalog {
            in item candidate : Domain::PreparedIndexedSemanticGroupCatalog;
            doc /* Require instance-local prepared authority and the genuine
            active same-port SQLite transaction. The exact associated source
            candidate must already be published in that transaction, with matching
            stored bytes, digest and complete canonical anchor. CAS the prior
            group catalog, collision-check immutable nodes/descriptors and read
            back the resulting metadata, source publication and full anchor.
            Failure rolls back canonical, source and group writes together. Keep
            both prepared handles retryable after rollback; after commit the old
            catalog CAS cannot be reused. No sync or durable receipt is issued.
            A production owner must still include permanent identities, complete
            admission and full-head/fence CAS. Legacy profiles are unchanged. */
        }
        action def AuditIndexedSourceCatalog {
            in item expected : Domain::IndexedSourceCatalogRecord;
            in item pin : Domain::IndexReaderPin;
            out item summary : Domain::IndexedCatalogAuditSummary[0..1];
            doc /* Snapshot the independently verified canonical genesis, complete
            state and indexed head before asynchronous work. Require the selected
            source catalog to match exactly. Audit every reachable financial and
            locator node in all 24 closed collections, requiring dense one-based
            financial ordinals and matching complete populations. Resolve every
            financial row through the source catalog's authenticated row reader;
            the owner must independently authenticate its canonical-prefix source.
            Stream at most one row to the optional consumer at a time. Reconfirm
            current catalog/head and owner authority around node reads and after
            consumer callbacks; cancellation/work-budget errors are operational
            failures, never partial success or retained accounting rejections.
            Release internal captures on success or failure. Do not repair bytes,
            traverse historical unreachable index garbage, issue durable receipts
            or claim complete accounting-history replay. */
        }
        action def AuditIndexedSemanticGroupCatalog {
            in item source : Domain::IndexedSourceCatalogRecord;
            in item groups : Domain::IndexedSemanticGroupCatalogRecord;
            in item pin : Domain::IndexReaderPin;
            out item summary : Domain::IndexedCatalogAuditSummary[0..1];
            doc /* Bind source/group commitments, full canonical head, physical
            identity and the closed indexed collection-domain directory. During
            complete source audit, project all predicates governed by the selected
            profile (seven original predicates, plus ownership revisions and money
            scope/source-journal predicates with exact summaries when opted in)
            and require every expected member's exact ordinal/hash in the stored
            group. Then audit the entire directory and every member tree: verify
            raw keys, domains, populations, each source row/hash and its predicate
            membership. These two inclusions prove exact set equality; a canonical
            authenticated tree makes a full in-memory root rebuild unnecessary.
            Compare complete counts and recheck both catalogs and owner authority
            after all reads, even for an empty directory. Hold no full-book arrays
            or rebuilt directory; owner confirmation supplies cancellation/budget.
            Missing, extra, stale or self-consistently rehashed wrong groups fail
            without repair or partial success. This derived-index proof complements,
            and never replaces, mandatory canonical accounting-history replay. */
        }
        action def ReadIndexedSourceCatalogRow {
            in item catalog : Domain::IndexedSourceCatalogRecord;
            in item locator : Domain::SourceRowLocator;
            out item row : Domain::CurrentRowRead[0..1];
            doc /* Use an owner-issued capture matching independently verified
            catalog commitment and complete canonical anchor. Verify financial and
            locator paths, exact origin bytes and canonical source row. The owner
            source port must verify source membership in the captured prefix; a
            locator hash alone is not historical authentication. Only an ordinal
            beyond the authenticated population with absent financial and locator
            paths yields absence. Missing nodes/sources or in-range gaps fail closed.
            Recheck catalog/head and owner's live-pin confirmation after all I/O;
            failure retires the capture. Released/foreign captures are invalid.
            This does not replace complete startup verification or stable report
            snapshot design. */
        }
        action def DeriveIndexedOutcomeIdentityDelta {
            in item sourceCandidate : Domain::PreparedIndexedSourceCatalog;
            in item outcome : Domain::IndexedOutcomeChainRecord;
            in item pin : Domain::IndexReaderPin;
            out newIdentityCount : Natural;
            doc /* Bind the existing identity projection rules to one exact
            source-instance prepared indexed outcome, not a payload paired with
            caller-supplied counters. Require a non-genesis prior catalog, strict
            indexed framing and byte-exact resulting complete state/head match.
            Reconfirm the live owner and unchanged prepared source before/after
            each lookup and before returning. Both partitions must authenticate
            absence. A hit supplies an older positive Oseq and canonical indexed
            source bytes, expected record commitment and complete prior authority;
            verify full physical scope/actual object, record framing and sequence.
            Snapshot data fields and decode prior evidence before yielding again;
            accessors or malformed evidence cannot masquerade as absence. Feed
            only the verified original payload to the existing raw-identity rules.
            Retained rejections reserve their command ID; repeated lot snapshots
            retain original creation locators. The owner must separately prove
            canonical-prefix membership and first-creation index completeness.
            This action writes nothing and does not establish accounting admission,
            physical index roots, publication/fence CAS or durable acknowledgement.
            Publish identity roots with the exact associated source/group candidate
            in the owner transaction; no production profile is enabled here. */
        }
        action def DeriveOutcomeIdentityDelta {
            in item pin : Domain::IndexReaderPin;
            in item outcome : Domain::OutcomeRecord;
            out newIdentityCount : Natural;
            doc /* Project identities from the actual replay/evaluation-verified
            canonical outcome, not a fixture list or caller-supplied delta. Retained
            rejection contributes its command identity only. Version-scoped
            configuration IDs are not globally single-use financial object IDs.
            Every candidate requires authenticated prior absence across both hot
            and cold partitions, or resolution of its existing locator to original
            canonical bytes under this exact pin/head. Compare raw book/family/id,
            not just a hash or count. Only repeated lot-state snapshot identities
            may already exist; preserve their first creation Oseq.
            Owned operations, anchors, movements and posting references reserve
            their typed permanent identities; ownership quantities share the legacy
            allocation namespace. A legacy snapshot may repeat only an identity
            originally created as a legacy snapshot row, never an owned allocation.
            Deduplicate repeated identical posting references within one funding
            group, not across distinct commands. Missing storage,
            wrong scope/locator/identity and uncertainty cannot become absence.
            A structurally valid payload/checksum does not authenticate accounting
            truth or the original source's membership in this canonical prefix.
            Complete source admission precedes page allocation and registration. */
        }
        action def TrackConstructionLocations {
            in item pin : Domain::IndexReaderPin;
            in requestedCount : Natural;
            out item captured : Domain::ConstructionLocationHead;
            doc /* Under exact live construction/fence authority, atomically reserve
            fresh locations, append every location to the authenticated chain and
            advance allocation high-water. Wait for durability; unknown confirmation
            never permits reuse. A materialized page retry requires its original live
            construction owner, not adoption by a new pin. */
        }
        action def ReadConstructionLocations {
            in item pin : Domain::IndexReaderPin;
            out item batch : Domain::ConstructionLocationBatch;
            doc /* Verify a captured prefix in bounded indexed batches. The consumer
            must reach its terminal commitment before treating the set as complete.
            Release, expiry or authority change invalidates continuation. */
        }
        action def CleanupConstructionMetadata {
            in item job : Domain::ConstructionCleanupJob;
            in maximumLocations : Natural;
            out removedLocations : Natural;
            doc /* Process at most the bounded number of verified tracking entries
            and their leftover reservations. Require the owner's pin absent and
            exact retired head/cursor. Completion removes only job/head metadata.
            Retain all immutable pages even when abandoned; page reclamation still
            requires its separate global closure, reference barrier and retirement. */
        }
        action def RegisterPreparedIndexPublication {
            in item pin : Domain::IndexReaderPin;
            in item candidate : Domain::PreparedIndexPublication;
            out item registered : Domain::PreparedIndexPublication[0..1];
            doc /* Verify canonical population/lineage and the complete durable
            graph, by full audit or by a valid retained COW append proof preserving
            the verified immutable base and checking every new page. Recheck the
            exact live construction and current input view after
            I/O. Register before exposing publication eligibility; an identical
            retry returns the same candidate, while a changed root or target head
            conflicts. Protect in-progress pages before a final root exists as well
            as registered final roots. Registration is not a reclamation barrier. */
        }
        action def RetainIndexInsertion {
            in item pin : Domain::IndexReaderPin;
            in item previous : Domain::RetainedIndexAppend[0..1];
            out item retained : Domain::RetainedIndexAppend[0..1];
            doc /* Accept only provenance issued by the actual verified-balanced
            COW insertion algorithm; a copied structural plan is insufficient.
            Bind key schema and next Oseq. The first before-root equals the selected
            hot root, while subsequent roots equal this store's same-pin retained
            prefix. Require a retained base descriptor unless canonically empty.
            In a genuine active same-port construction transaction, check ownership
            and exact expected bytes of every new page, insert/read back the new
            root descriptor, then wait for durability before issuing the ephemeral
            certificate. Do not rescan unchanged immutable pages: their protection
            and prior verification remain owner/base obligations. Failures return
            no certificate and require uncertainty reconciliation before more work.
            Canonical state, selected roots and pin consumption remain unchanged. */
        }
        action def RegisterRetainedIndexAppend {
            in item pin : Domain::IndexReaderPin;
            in item retained : Domain::RetainedIndexAppend;
            in item candidate : Domain::PreparedIndexPublication;
            out item registered : Domain::PreparedIndexPublication[0..1];
            doc /* Require the store-instance certificate and exact active pin/view,
            with resulting population equal to old hot count plus retained additions.
            Use the existing same-port durable registration and retained-descriptor
            checks; no whole-index page scan. The owner must separately establish
            complete canonical identity delta and its source/group outcome binding.
            The compact indexed owner chains a retained insertion for every actual
            identity delta entry, including the command ID of retained rejections.
            An empty delta cannot authorize publication. Register only the final
            chain, then publish canonical outcome and enabled source/group catalogs
            in the existing root-selection transaction. This changes neither the
            durable format nor mandatory full-history startup verification.
            Final publication still uses the existing full-view/fence CAS and atomic
            canonical/root/pin transition. Do not use this API for unrelated roots,
            cold merges, adoption, restart shortcuts or bypassing archive durability. */
        }
        action def PublishPreparedIndexedOutcome {
            in item pin : Domain::IndexReaderPin;
            in item registered : Domain::PreparedIndexPublication;
            in item outcome : Domain::OutcomeRecord;
            out item selected : Domain::IndexedView[0..1];
            doc /* In one synchronous SQLite transaction, require the exact active
            pin, registered candidate hash, full current input view and the outcome's
            complete before/resulting heads. Select canonical outcome/chunks and
            the registered hot root, then consume the construction registration and
            pin atomically. Preserve cold coverage and any frozen prefix. Failure
            rolls all publication and consumption back. An ordinary expiry/conflict
            retains the trusted clock floor. Wait for durability before a receipt;
            uncertain replies reconcile actual canonical/index heads rather than
            repeating selection. Under archive-required mode, this cannot bypass
            canonical archive publication or its acknowledgement requirements. */
        }
        action def PrepareIndexedCanonicalStorage {
            in item outcome : Domain::OutcomeRecord[0..1];
            out item preparedHead : Domain::DurableHead[0..1];
            doc /* Internal new-format canonical persistence preparation, not
            accounting admission. Genesis must contain only configuration row one
            and otherwise empty canonical collections; ordinary preparation binds
            exact outcome framing to the independently expected complete current
            head/state. Issue only a store-instance opaque candidate holding copied
            immutable bytes. Existing compact/archive data cannot be adopted or
            reinterpreted through initialization. No writes or receipts here. */
        }
        action def ExecuteIndexedLedgerBridge {
            in item incomingCommand : RastrataAccountingBackend::Domain::BookCommand;
            out item response : Domain::ServiceResponse;
            doc /* Internal bounded new-format owner integration, not an enabled
            deployment profile or completion of indexed kernel read-set admission.
            After trusted gateway authorization, capture the complete typed command
            before queueing. Cold start and explicit audit recover complete canonical
            accounting and all indexes. A warm session may reuse that verified base
            and only locally admitted, durably confirmed atomic transitions after
            checking the exact current head, index view, complete catalog bodies and
            live authority with a newly acquired pin. Changed heads/views or uncertainty
            invalidate reuse and require full recovery. The kernel still evaluates
            its complete state; this is not sparse command admission.
            Preserve exact retry results/Oseq and unretained rejection behavior.
            Produce each newly retained outcome from the admitted intent or
            retained rejection and the authenticated prior logical root catalog
            using PrepareIndexedOutcomeChanges. Do not rebuild the full resulting
            legacy book merely to produce the publication candidate. Snapshot the
            decision and financial predecessor before callbacks; confirm live head,
            source catalog and authority around old-node reads and final delivery.
            Fully validate the initial catalog/anchor, then compare exact complete
            bytes at repeated checks; digest fields alone cannot establish that
            metadata remained unchanged. Any observed substitution retires this
            preparation even if a later callback would restore the original bytes.
            The serialized candidate must reproduce the exact kernel outcome bytes
            through the existing outcome decoder/delta projection path; this uses
            the same delta compiler, not an independent accounting oracle.
            Retained outcomes stage the exact canonical/source/group candidate,
            authenticate both permanent-ID partitions and original source bytes,
            then retain every genuine identity COW insertion under one construction
            pin. Final registration binds the full target head and fence. Publish
            canonical records, source/group catalogs, identity root and pin
            consumption in one existing controlled transaction. Recheck active
            authority and construction expiry inside publication. Confirm durability
            and verify actual newly selected outcome bytes plus exact resulting
            head/view/catalogs before returning a receipt. Only then may the new
            transition extend the verified session. Retried commands authenticate
            their permanent identity and actual retained source before reply.
            Full audit still independently projects every replayed complete book.
            Warm operations do not certify untouched historical storage bytes;
            damage there is detected on access, explicit audit or cold recovery.
            Whole-state admission, lot replacement, historical byte compatibility
            and source-closure checks remain. No startup checkpoint shortcut is added.
            Unknown durability or corruption is an operational failure; never invent
            a retained accounting rejection. Bounded head-conflict retries preserve
            the original command. Legacy-kernel aggregate and owner 1000-outcome/
            1 MiB bounds remain; no sparse state, migration, archive acknowledgement,
            external rollback detection or business-capacity claim is introduced. */
        }
        action def ExecuteNativeOrdinaryJournal {
            in item command : RastrataAccountingBackend::Domain::PostJournalCommand;
            in item current : Domain::NativeJournalInputs;
            out item result : RastrataAccountingBackend::Domain::BookCommandResult;
            out item revision : RastrataAccountingBackend::Domain::RevisionRecord[0..1];
            out item evidence : Domain::NativeJournalEvidence;
            doc /* Internal new-format candidate, not enabled production readiness.
            SQLite owns identity indexes and transactional current facts. Reload the
            actual head in one transaction and bind it to its actual retained tip.
            Evaluate the supported command through shared kernel primitives; retain
            exact legacy command/result/revision bytes, including rejection retries.
            Insert one permanent outcome, insert immutable journal/posting identities,
            replace only explicitly mutable current projections, and advance the
            complete head in that SAME transaction. Any failure rolls back all three.
            A retained rejection advances Oseq only. Lost durability replies return
            no acknowledgement; retry reads the stored identity and original outcome.
            Recheck trusted authority before publication and after storage.sync.
            Repository admission itself is bounded, including non-HTTP callers:
            at most 16 active-plus-waiting operations and 5000 milliseconds waiting
            by default, with explicitly bounded operator overrides. Reject excess
            work as a service overload without consuming a command identity or
            retaining an accounting outcome. Expired waiters are removed from the
            queue and checked again against monotonic time before dequeue. Never
            time out an already-started transaction or release serialization while
            its durability result is uncertain. The original identity resolves a
            lost acknowledgement after the active operation actually settles.
            Normal saves read only bounded current dependencies, not historical
            populations; no custom index pages, catalog pins or history hash rebuild.
            Keys encode collection and raw identity as separate tuple components.
            The head hash is domain-separated rastrata-native-sql-ledger-v1 over
            scoped sequence, financial revision, prior head and exact outcome digest,
            not a legacy aggregate state hash or a commitment to every current fact.
            Row checksums detect changed bytes on access, not arbitrary coordinated
            database rewrites or rollback. SQL transactional correctness is a stated
            trust assumption. Full accounting/index audit, independently authorized
            restoration, backup delivery and gateway/catalog admission remain required
            before production enablement; PL-007/008 are not declared discharged by
            a successful bounded save. Existing formats cannot be adopted implicitly.
            Legacy replay and canonical aggregate hashes retain their old meanings. */
        }
        action def ExecuteNativeBookCommand {
            in item command : RastrataAccountingBackend::Domain::BookCommand;
            in item current : Domain::NativeBookCommandInputs;
            out item result : RastrataAccountingBackend::Domain::BookCommandResult;
            out item evidence : Domain::NativeJournalEvidence;
            doc /* Apply ExecuteNativeOrdinaryJournal's complete atomic publication,
            authority, permanent-identity and durability obligations to the restricted
            postJournal, correctJournal, replaceConfiguration, closePeriod and
            reopenPeriod and postTaxedTransaction variants. Invoke shared kernel preparation, not duplicate
            accounting rules. Close packages and transitions are immutable; current
            close status and period status with cumulative close count are mutable.
            Native containment requires later current closes with closing journals
            to be explicitly reopened/reversed before an earlier reopen. The legacy
            kernel can otherwise supersede the later package and lose its reversal
            source. Refuse that unsafe commit as an unretained service failure;
            do not rewrite historical receipts or claim kernel repair. Latest-first
            reopening retains exact kernel reversals and outcomes.
            The first close atomically evolves the legacy immutable open-period fact
            with its outcome and effects; rollback restores the original identity.
            Every canonical effect and current projection belongs to the same SQL
            transaction as its original retained outcome. Unsupported variants fail
            without retaining a result. Specialized policies other than tax and allocation are not enabled by this
            action. Exact retries do not rescan the close or journal populations. */
        }
        action def VerifyNativeStagingCopy {
            doc /* Internal audit component, NOT a production restore installer.
            Require an explicitly supplied empty staging repository with the same
            tenant/book and a different physical scope. Pin an expected source tip.
            Read bounded outcome pages in numeric Oseq order; authenticate every
            cursor, contiguous chain edge and exact scoped terminal head. Reexecute
            original commands into staging, comparing exact canonical command,
            result and financial revision bytes. Compare ALL persisted projections,
            identities, mutability and origin Oseq in bounded encoded-identity order.
            Reject missing, extra or altered facts even when checksums are recomputed.
            Check both tips on every page and after comparison: any intervening
            publication is a stale-copy failure, not successful verification.
            Scoped native chain hashes differ across source and staging; canonical
            accounting bytes must agree. No whole-history BookState is constructed.
            Failure leaves staging unavailable. This action does not deliver backups,
            select an independent restore head, authorize maintenance, fence writers
            or activate a catalog generation. Those remain release obligations. */
        }
        action def RecoverIndexedLedgerBridge {
            out item recoveredHead : Domain::DurableHead[0..1];
            doc /* Reconcile actual storage/control/page metadata after uncertain
            replies. Under a live exact-head reader pin and trusted fence, stream
            the full canonical history and reexecute each original command/result/
            revision with the existing kernel. Compare each exact resulting indexed
            state against a full projection of the independently rebuilt aggregate.
            Authenticate current source/group catalogs and all cold/hot identities,
            preserving first-creation Oseq, checking duplicates and exact canonical
            populations, including retained rejections. Never manufacture a legacy
            head over new hashes to reuse the identity oracle. Source reads require
            hashes obtained from the replay-verified prefix and fresh durable bytes.
            A stored checksum or balanced page layout is not recovery authority.
            Release pins and recheck fence before exposing success. This full-state
            bridge is intentionally bounded and does not relax startup obligations. */
        }
        action def PublishIndexedCanonicalStorage {
            in item preparedHead : Domain::DurableHead;
            doc /* Require the original store-instance preparation and a genuine
            active same-port synchronous transaction. New-book initialization
            refuses every preexisting ledger table. Ordinary publication requires
            exact full current anchor CAS, writes immutable bounded record manifests
            and 256 KiB payload chunks, verifies full readback, then checks final
            metadata. Genesis is bounded to 16 MiB, indexed outcome to 4 MiB and
            anchor metadata to 512 KiB; these are component representation bounds,
            not an enabled adapter capacity increase. Reassemble UTF-8 before
            decoding; reject missing, extra, oversized or incorrectly typed chunks.
            The owner must publish source/group/permanent-identity roots in this
            same transaction under active fence authority. Preserve candidates
            after rollback. Selection is not durability confirmation or readiness. */
        }
        action def AuditIndexedCanonicalChain {
            in item expectedHead : Domain::DurableHead;
            out item verifiedHead : Domain::DurableHead[0..1];
            doc /* Structural sub-audit only, never a substitute for complete
            accounting recovery. Starting from the exact independently expected
            genesis, stream each consecutive Oseq through the expected full head,
            decode against the prior full state/head and verify exact final anchor.
            Keep bounded historical buffering, not an array of all outcomes. Check
            complete manifest/chunk populations, including orphaned extra records.
            Recheck live owner authority and current complete anchor before and
            after every observer callback and at final completion, including empty
            histories. Callbacks are provisional until the whole audit succeeds.
            Separately reexecute accounting and audit all derived indexes before
            readiness. Targeted source reads require an independently authenticated
            expected record hash; stored metadata does not prove prefix membership. */
        }
        action def FreezeIndexPrefix {
            in item current : Domain::IndexedView;
            in through : Natural;
            out item prefix : Domain::FrozenIndexPrefix;
            doc /* Persist a construction pin and exact complete prefix before merge
            work. New commands may continue into a bounded durable tail; the frozen
            population stays immutable. Account for hot/frozen/tail bytes together.
            If maintenance cannot keep up, backpressure precedes exhaustion; never
            evict identities or acknowledge an unindexed canonical outcome. */
        }
        action def InstallIndexedView {
            in item expected : Domain::IndexedView;
            in item prefix : Domain::FrozenIndexPrefix;
            in item replacement : Domain::IndexRoot;
            out item evidence : Domain::IndexCutoverEvidence;
            doc /* Verify exact prefix equivalence and replacement reachability.
            Re-read current full canonical head and view revision immediately before
            the atomic transaction. Preserve all post-freeze tail outcomes, including
            rejections. Concurrent appends require fresh expected context, not loss
            of their tail; another cold cutover invalidates the old base. No pending
            accounting selection may be bypassed. Publish only after durability.
            This maintenance advances viewRevision, never Oseq, accounting revisions,
            canonical state/protocol hashes or receipts. Lost replies reconcile the
            exact durable view; do not run an accounting command to repair an index. */
        }
        action def PinIndexedRead {
            in item authority : Domain::AuthorizationContext;
            in item indexedView : Domain::IndexedView;
            in item cutoff : Domain::DurableHead;
            out item pin : Domain::IndexReaderPin[0..1];
            out item evidence : Domain::IndexPinEvidence;
            doc /* Register the pin durably before exposing a cursor. Check full
            identity, view, format and canonical cutoff membership; filter later
            outcomes when reading an earlier cutoff. Admission serializes with
            retirement. Existing-pin continuation never revives an expired pin or
            silently switches a reader to a newer accounting snapshot. */
        }
        action def RetireDerivedIndexPages {
            in item current : Domain::IndexedView;
            out item retirement : Domain::IndexRetirement[0..1];
            out item evidence : Domain::IndexReclamationEvidence;
            doc /* Establish the collection reference barrier and capture all reader,
            construction and publication roots. Verify complete reachability with
            bounded traversal, retaining fresh epoch locations. Atomically record an
            exact unprotected derived-only location set under identity/fence authority.
            Barrier failure invalidates the mark, not accounting history. Deletion
            resumes only that durable selection and cannot reuse retired locations.
            Canonical source loss is not repaired by index reclamation. No full
            history pruning or unbounded stop-the-world maintenance is authorized. */
        }
        action def ProvisionBook {
            in item authorization : Domain::AuthorizationContext;
            in item catalog : Domain::CatalogEntry;
            in item genesis : Domain::Genesis;
            out item response : Domain::ProvisionResponse;
            doc /* Reserve exact identity/genesis/policy first. Archive-required
            provisioning initializes and verifies the independent genesis manifest
            and zero head as well as durable local genesis before confirming the
            receipt or activating the catalog. Partial provisioning resumes only
            identical content; active-plus-missing storage requires restoration. */
        }
        action def AdmitCommand {
            in item authorization : Domain::AuthorizationContext;
            in item envelope : Domain::CommandEnvelope;
            out item command : RastrataAccountingBackend::Domain::BookCommand;
            out failure : Domain::ServiceFailure[0..1];
        }
        action def ObserveNativeArchiveProgress {
            in item authorization : Domain::AuthorizationContext;
            out item progress : Domain::NativeArchiveProgress[0..1];
            out failure : Domain::ServiceFailure[0..1];
            doc /* Private maintenance-authorized service RPC. Check persisted
            revocation before archive reads, on source dequeue and after remote
            work. Verify the active control, frontier manifest and genesis against
            a bounded one-outcome source page; recheck control version and fence
            before returning. Never initialize, publish, drain, seal, repair or
            otherwise mutate canonical/archival state during observation. No new
            I/O is added to ordinary saves. Monitoring failures do not become
            evidence of backup completion or elapsed-time recovery guarantees. */
        }
        action def DrainRetainedOutcomeOutbox {
            doc /* Platform-confirmed mode only: immutable retained outcomes,
            including rejections, are the outbox. Arm a durable alarm before new
            publication; scheduling failure prevents that new publication. Drain
            does not make exact retained retries depend on successful new scheduling.
            Capture a scheduling failure inside command serialization and refuse
            any new outcome atomically; a previously retained authorized result
            remains available. Recheck authorization and fence after arming waits.
            A scheduled-deadline cache may avoid redundant alarm calls until
            delivery starts, restart or expiry; an in-flight stale observation
            cannot certify a future wake after the handler starts.
            Native delivery processes at most eight bounded batches per wake,
            then schedules remaining work within a one-second retry interval
            rather than the initial batching delay. This is a scheduling bound,
            not a guaranteed backup-lag or recovery-point objective under load.
            Drain
            through the owner's serial queue so an alarm cannot observe an empty
            backlog between arming and commit. Release the queue before R2 I/O.
            Capture a verified bounded page at one head. Publish content-addressed
            genesis/outcome payloads and linked manifests, then advance the remote
            contiguous cursor with conditional control replacement. New delivery
            cannot skip a sequence or an unpublished predecessor. This incremental
            drain does not re-audit older archived payloads; later historical damage
            is detected by explicit archive inspection. Retry lost replies from the remote cursor;
            concurrent relays may conflict but cannot create a second book outcome.
            Persist rescheduling after failure or remaining work, preserving the
            earliest scheduled deadline under continuous saves. Do not erase an
            alarm that a concurrent new command armed. Archive outages do not delay
            platform-confirmed acknowledgements; scheduler failure is distinct.
            Acknowledged but unarchived outcomes are exposed to primary-store loss.
            Declare and monitor backup lag before production enablement. Archive
            inspection verifies the chain; writable restoration additionally needs
            accounting replay, an authorized head and restore fencing.
            Native delivery uses rastrata-native-outbox-v1 rather than interpreting
            old indexed manifests. A batch contains at most sixteen outcomes and
            1048576 total outcome bytes, with one immutable manifest and conditional
            pointer advance per batch. Individual payloads remain content-addressed.
            Immutable payload I/O may overlap in groups of at most four. Every
            active group settles before failure returns; entry order, complete
            payload hash verification, byte limits and final authority/CAS checks
            are unchanged. Control writes and canonical replay remain ordered.
            Pointer absence during ordinary draining is an error, not permission
            to reinitialize; initialization belongs to explicit catalog reservation.
            The pointer binds an active/sealed status and fence. A stale publisher
            cannot advance a sealed or higher-fence pointer. Reverse-batch inspection
            checks bounded payloads and every edge to genesis without collecting
            the entire history; consume it to completion and recheck the pointer.
            A later installer may spool references in SQLite for forward replay.
            These batch/fence checks do not supply independent restore authority.
            This bounded
            internal relay is not archive-required canonical publication and does
            not discharge PL-015/016 or certify independent account-loss recovery. */
        }
        action def ExecuteArchiveCommand {
            in item authorization : Domain::AuthorizationContext;
            in item command : RastrataAccountingBackend::Domain::BookCommand;
            out item response : Domain::ServiceResponse;
            doc /* Trusted book-scoped coordinator, after gateway authentication,
            authorization and closed command decoding. Capture command input before
            asynchronous queueing. Require actual active catalog identity, genesis,
            policy and fence; recover any original pending candidate before new
            evaluation. Never reevaluate a pending command at a later head.
            Read a fully verified SQL/archive snapshot, delegate to the kernel,
            and select/publish/materialize only if it retains a new outcome.
            Exact replay, identity conflict and unretained rejection add no outcome.
            Before any receipt, bracket complete SQL/archive history verification
            with unchanged active catalog admission and confirm local durability.
            A no-write result also requires its evaluated full head unchanged.
            Return the exact original result and Oseq only for new retention or
            exact replay, plus the canonical manifest at the returned current head.
            Contention, maintenance, source loss and uncertain writes are service
            failures, not fabricated accounting rejections. Selection remains for
            reconciliation; do not abandon, downgrade policy or return early.
            Current bounded full-replay implementation is not scalable indexed
            execution, a network gateway or production workload certification. */
        }
        action def ReadArchiveFinancialState {
            in item authorization : Domain::AuthorizationContext;
            out item financialState : RastrataAccountingBackend::Domain::BookStateSnapshot[0..1];
            out item head : Domain::DurableHead[0..1];
            out failure : Domain::ServiceFailure[0..1];
            doc /* After gateway read authorization, require actual active catalog
            admission and reject any pending selection. Reexecute complete SQL and
            canonical archive histories and compare exact aggregate, full head and
            manifest. Recheck external control and unchanged active catalog/fence
            before returning an immutable snapshot at the verified cutoff. This
            read does not publish a pending candidate or release maintenance. */
        }
        action def EvaluateRetainedOutcome {
            doc /* Delegate accounting to the imported kernel authority. The runtime
            bridge uses executeBookCommand and its actual protocol retention decision;
            it does not treat every rejection as retained or rebuild accounting rules. */
            in item incomingCommand : RastrataAccountingBackend::Domain::BookCommand;
            in item currentState : RastrataAccountingBackend::Domain::BookStateSnapshot;
            in item retainedResult : RastrataAccountingBackend::Domain::BookCommandResult[0..*];
            out item result : RastrataAccountingBackend::Domain::BookCommandResult;
            out decision : Domain::RetentionDecision;
            perform action kernelEvaluation : RastrataAccountingBackend::Behavior::EvaluateBookCommand {
                in item bookState = currentState;
                in item command = incomingCommand;
            }
        }
        action def CommitOutcome {
            doc /* Local publication path: synchronous SQL transaction
            compares complete head, inserts outcome and optional unique revision,
            all chunks and command index, updates head, or rolls everything back.
            SQL-only mode may reevaluate the SAME command after a full-head conflict
            with bounded attempts. Archive-required mode first establishes PL-015
            canonical publication; this transaction materializes the exact selected
            outcome and clears its reservation. After archive commit, conflicts
            require reconciliation/quarantine, never reevaluation or abandonment. */
            in item expected : Domain::DurableHead;
            in item candidate : Domain::OutcomeRecord;
            in item policy : Domain::DurabilityPolicy;
            in item archiveEvidence : Domain::ArchivePublicationEvidence[0..1];
            out transactionCommitted : Boolean;
        }
        action def ConfirmDurability {
            doc /* Await storage.sync before acknowledging retained results or
            publishing candidate cache. Failure clears cache and gates future work
            through recovery. A request disconnect does not cancel a committed effect.
            This action confirms SQLite only; an archive-required receipt also needs
            PL-014 verification. It cannot bypass the archive publication lifecycle. */
            out durable : Boolean;
        }
        action def SelectArchiveCandidate {
            in item expected : Domain::DurableHead;
            in item candidate : Domain::SelectedArchiveCandidate;
            out selectedDurably : Boolean;
            doc /* Atomic full-head reservation, then storage.sync. No public state,
            index or receipt advances on reservation. A pending candidate survives
            restart and blocks new evaluation until reconciliation finishes.
            Compare the fully verified local history with the expected archive
            predecessor before reservation. Preserve exact payload chunks and the
            conditional-publication envelope in the same transaction. Concurrent
            selection may return only the identical existing candidate; a different
            payload, candidate ID or prior control expectation must fail. A failed
            durability response leaves the reservation intact for recovery. Recovery
            replays the original receipt to verify it, never generates a replacement
            outcome at a different head. Observing a durable reservation is not proof
            that its prior external anchor remains current or that it is published. */
        }
        action def InitializeArchiveBook {
            in item reserved : Domain::CatalogEntry;
            in item genesis : Domain::Genesis;
            in item manifest : Domain::ArchiveGenesisManifest;
            out item anchor : Domain::ArchiveAnchor[0..1];
            out verified : Boolean;
            doc /* Conditional create-only anchor at Oseq zero under reserved catalog
            identity. A preexisting anchor resumes only after exact genesis, policy,
            format and identity verification; never overwrite it to repair a mismatch.
            Missing authority, unexpected nonzero head or uncertain initialization
            cannot activate a book or yield an acknowledged genesis. */
        }
        action def QuiesceAndRetireNativeBook {
            in item expected : Domain::NativeCatalogControlSnapshot;
            in operationId : Domain::Identifier;
            out item current : Domain::NativeCatalogControlSnapshot;
            doc /* Platform-confirmed native mode, distinct from archive-required
            BeginCatalogMaintenance. First CAS active routing to maintenance,
            retaining the source archive fence for final delivery. Then call the
            trusted source retirement port using the persisted quiesce operation
            as its stable request identity. The source queue includes any earlier
            in-flight saves before atomically retiring and reporting its actual
            stopped head and next fence. CAS that evidence into the same pending
            catalog revision. Neither source nor catalog lost acknowledgement
            allows routing to resume: reconcile the identical durable operation.
            Continue final internal archiving at the old archive fence before
            sealing it at the stopped higher fence. Retirement is not yet a sealed
            archive cutoff or verified writable replacement. No ordinary reserve
            or activate operation clears maintenance or un-retires the source.
            Configured gateway admission must enforce routing status; a schema or
            an in-process callback does not prove that production integration. */
        }
        action def SealNativeCatalogArchive {
            in item expected : Domain::NativeCatalogControlSnapshot;
            in operationId : Domain::Identifier;
            out item current : Domain::NativeCatalogControlSnapshot;
            doc /* Require maintenance with actual source retirement and no prior
            seal. Read the configured R2 scope; its contiguous archive head must
            equal the full stopped head. Lag is an error, never permission to
            approve a shorter prefix. Check the selected manifest and original
            genesis, conditionally change active prior fence to sealed next fence
            without changing the head/manifest, and verify exact control readback.
            A higher or contradictory fence is never downgraded. A delayed publisher
            loses its old storage revision. Lost R2 replies reconcile from the
            already sealed pointer; persist that exact seal by catalog CAS and
            confirm durability. Catalog reply loss retries the same mutation.
            Maintenance is not cleared by sealing. Full history/accounting replay,
            approved replacement identity and verified installation are required
            before any writable replacement. A seal is not that authorization.
            A retired source alarm may stop only after matching its actual local
            head/retirement with the complete final sealed frontier and unchanged
            R2 control. Unexpected fencing of an active owner or mismatched/absent
            archive data remains a failure with retry, not successful completion. */
        }
        action def InspectNativeRecoverySource {
            in item expected : Domain::NativeCatalogControlSnapshot;
            in operationId : Domain::Identifier;
            out item candidate : Domain::NativeRecoveryEvidence[0..1];
            doc /* PL-011, PL-014 and PL-015: a pinned, expiring incident grant
            binds the exact original active catalog, scope and incident. Enter
            maintenance and acknowledge physical writer quarantine before source
            inspection. Read an existing native source at its original active
            access fence, never initialize absent data or accept a prepared replay
            target. Audit projection in bounded resumable slices under unchanged
            head and authorization revision; check incident expiry and catalog
            again after asynchronous work. The completed source head, projection,
            genesis and access revision are candidate evidence only. The operator
            must reconcile every acknowledged command before signing recovery. */
        }
        action def RecoverUnavailableNativeSource {
            in item expected : Domain::NativeCatalogControlSnapshot;
            in operationId : Domain::Identifier;
            in item reconciled : Domain::NativeRecoveryEvidence;
            out item approved : Domain::NativeCatalogControlSnapshot[0..1];
            doc /* PL-011, PL-014, PL-015 and PL-016: private incident control,
            independently authorized outside unavailable book access. Validate
            trusted evidence under a separately signed short-lived recovery grant
            bound to the actual quarantine hash. Incident-only and ordinary book
            credentials cannot approve recovery. The owning
            physical object acknowledges quarantine under that exact maintenance
            hash, rejecting cached and queued ordinary admissions without deleting
            data. Cold owners remain unavailable from independent catalog state.
            Seal R2 only at the full reconciled head and strictly next writer fence.
            Incomplete or contradictory archives cannot select an older cutoff.
            Recheck incident authorization and identical evidence after quarantine
            and remote I/O, then CAS-persist approval with evidence provenance,
            complete projection and access revision. The retirement is an
            independently authorized control-plane fence, not a claimed observation
            of a lost primary. Lost replies retry the same incident and original
            catalog expectation; later lifecycle revisions reject obsolete retries.
            Use the existing bounded archive replay or exact-snapshot verification
            and prepared-writer/catalog/local-activation protocol. Approval alone
            never permits reads or writes. No extra ordinary-save I/O is introduced.
            This requires surviving reconciled evidence; it cannot manufacture a
            missing acknowledged tail or certify the external operator process. */
        }
        action def ReserveCatalogIdentity {
            in item identity : Domain::BookIdentity;
            in item genesis : Domain::Genesis;
            in operationId : Domain::Identifier;
            out item current : Domain::CatalogControlSnapshot;
            doc /* Privileged new-book allocation only, never a recovery fallback
            from missing authority. Pin exact genesis, complete identity, format and
            durability policy in reserved status at fence/revision zero. Repeated
            allocation with the identical genesis returns the actual current status
            without resetting it; a different genesis or co-located store fails. */
        }
        action def ActivateCatalogBook {
            in item expected : Domain::CatalogControlSnapshot;
            in item verifiedBook : Domain::VerifiedArchiveBookHead;
            in operationId : Domain::Identifier;
            out item current : Domain::CatalogControlSnapshot;
            doc /* Only reserved authority may initially activate. Verify the exact
            independent R2 genesis at Oseq zero and the other object's durable SQL
            genesis, then CAS the same catalog record to active. Uncertain mutation
            responses require exact idempotent retry, not a second activation.
            A catalog mutation receipt alone is not a public service-ready result. */
        }
        action def BeginCatalogMaintenance {
            in item expected : Domain::CatalogControlSnapshot;
            in operationId : Domain::Identifier;
            out item current : Domain::CatalogControlSnapshot;
            doc /* CAS active or maintenance authority to maintenance with a strictly
            larger fence and no sealed cutoff, then confirm catalog durability.
            Superseding maintenance invalidates older release attempts. No archive
            or book change is presumed atomic with this separate catalog commit. */
            doc /* Preserve an outstanding restore obligation when superseding
            maintenance. The old permit is no longer usable at the new fence;
            explicit reauthorization after sealing must replace it before verified
            finish. A fence increment cannot silently remove this obligation.
            A permit retained after completed active status is historical and may
            be cleared when a new maintenance cycle starts. */
        }
        action def SealCatalogArchiveFence {
            in item expected : Domain::CatalogControlSnapshot;
            in operationId : Domain::Identifier;
            out item current : Domain::CatalogControlSnapshot;
            doc /* Under unsealed maintenance, fully recover the observed archive.
            Conditionally advance only its fence, preserving the actual canonical
            head/manifest. A publisher admitted earlier may win first; on conflict
            reread and retain that winning head, never the stale prior head. Bound
            retries and remain in maintenance after conflict or uncertainty. Never
            lower a newer archive fence. Verify readback before CAS-persisting the
            sealed anchor/control version in the same expected catalog revision. */
        }
        action def FinishCatalogMaintenance {
            in item expected : Domain::CatalogControlSnapshot;
            in item verifiedBook : Domain::VerifiedArchiveBookHead;
            in operationId : Domain::Identifier;
            out item current : Domain::CatalogControlSnapshot;
            doc /* Require this maintenance revision's sealed full archive cutoff,
            current exact control version and actual durable book verification with
            no pending selection. Only then CAS the same catalog revision to active.
            A concurrent maintenance change defeats release even if book verification
            completed earlier. Catalog checksums do not prove independence from
            compromise or coordinated rollback of the entire control plane. */
            doc /* If a restore permit is outstanding, the current fence must match
            that permit and actual durable book verification must identify local
            materialization under its exact content hash. Merely matching financial
            heads, incrementing maintenance, or echoing a requested permit cannot
            satisfy this additional requirement. */
        }
        action def AuthorizeArchiveRestore {
            in item expected : Domain::CatalogControlSnapshot;
            in operationId : Domain::Identifier;
            in approvedBy : Domain::Identifier;
            out item current : Domain::CatalogControlSnapshot;
            doc /* Privileged operation after sealed maintenance. Fully replay the
            actual canonical archive and recheck the sealed body/ETag/nonce. CAS
            the complete permit into this exact catalog revision and confirm
            durability before any book overwrite. Exact retries must preserve
            approver and intent; conflicts or uncertainty cannot issue a new permit.
            Reauthorization requires a strictly newer sealed fence. */
        }
        action def PrepareArchiveRestoreImage {
            in item expected : Domain::CatalogControlSnapshot;
            in item permit : Domain::RestorePermit;
            out item image : Domain::ArchiveRestoreImage;
            doc /* Read the actual catalog and match its exact current maintenance
            revision, retained permit and fence. Replay the entire canonical chain
            and retain exact original genesis/outcome/frame bytes in order. Confirm
            independent genesis identity, full control version and catalog again.
            Missing history, stale authorization or changed control yields no image.
            This read-only preparation neither installs a book nor releases ingress. */
        }
        action def AbandonFencedUnpublishedSelection {
            in item selected : Domain::SelectedArchiveCandidate;
            in item expectedCatalog : Domain::CatalogControlSnapshot;
            out item receipt : Domain::ArchiveAbandonmentReceipt[0..1];
            doc /* Read the actual separate durable catalog, not a supplied proof
            or Boolean. Require this exact maintenance revision's sealed anchor,
            a strictly newer fence than the selection, and the unchanged prior
            full head, manifest hash and locator. Recheck full archive replay,
            body/ETag/nonce and current catalog revision before local mutation.
            In one SQL transaction, require the exact selection hash and unchanged
            full local state; retain the abandonment receipt and clear only that
            selection/chunks/marker. Do not advance Oseq or any financial/protocol
            head. Confirm durability before returning. A canonical member must
            materialize, never abandon; missing history or uncertain fencing fails
            closed. These cross-object observations are not an atomic transaction:
            safety depends on exclusion of the old publisher by the newer R2 CAS
            fence. This operation does not release maintenance. Exact retained
            retries report historical completion, not current service readiness. */
        }
        action def PublishArchiveCandidate {
            in item selected : Domain::SelectedArchiveCandidate;
            in item expectedAnchor : Domain::ArchiveAnchor;
            in item manifest : Domain::ArchiveCommitManifest;
            out item evidence : Domain::ArchivePublicationEvidence;
            doc /* Verify exact immutable payload/manifest, then conditionally replace
            the full archive anchor. Null/precondition failure is not success. A lost
            response is uncertain, not permission to publish a different candidate.
            Once canonical, the selected result cannot be abandoned or reevaluated.
            New publication requires active matching catalog authority, rechecked
            after immutable uploads, and the durably selected exact prior control
            body/ETag/nonce. An admitted publisher may win before anchor rotation;
            after rotation its stale conditional replacement must lose. Read back
            and fully replay the linked canonical history before reporting membership.
            An already canonical exact candidate may be recovered under matching
            active or maintenance authority at a newer fence without rewriting its
            historical manifest. This evidence alone cannot acknowledge a receipt. */
        }
        action def ReconcileArchiveCandidate {
            in item candidate : Domain::SelectedArchiveCandidate;
            in item anchor : Domain::ArchiveAnchor;
            in item catalog : Domain::CatalogEntry;
            out item evidence : Domain::ArchiveReconciliationEvidence;
            doc /* Verify canonical membership and finish the exact local publication,
            or confirm a newer fence at the unchanged prior head before abandoning
            an unpublished selection. Reading an old anchor or getting a payload 404
            alone does not exclude an in-flight late publisher. Preserve Oseq across
            recovery, including rejected outcomes; conflicts or missing proof quarantine.
            Rotate the external catalog into maintenance before resolving a publisher
            whose status is unknown. Keep ingress fenced while the archive anchor and
            catalog generations converge; partial rotation is resumable, never ready.
            A publisher already admitted may win before anchor rotation; then retain
            that canonical head, not the prior head. Release maintenance only after
            full-head verification and conditional catalog/anchor generation agreement.
            Historical manifests keep their original authorized fence generation; it
            need not equal the current generation after a later maintenance event.
            Materialization inserts the exact outcome/chunks, advances the complete
            SQL head, retains the selected envelope as last-materialization evidence,
            and clears the reservation/chunks in one synchronous transaction. Only
            then confirm durability. After a lost sync response, verify that envelope
            against canonical SQL and the exact archive member; do not append again.
            Competing or delayed reconcilers may not clear a different selection.
            Matching financial heads alone do not prove selected-candidate identity.
            No public readiness or maintenance release follows from local materialization. */
        }
        action def RecoverBook {
            in item genesis : Domain::Genesis;
            in item catalog : Domain::CatalogEntry;
            in item expected : Domain::DurableHead;
            in item checkpoint : Domain::CheckpointManifest[0..1];
            in item tail : Domain::OutcomeRecord[0..*];
            out verified : Boolean;
            out failure : Domain::ServiceFailure[0..1];
            doc /* Reject gaps, duplicate IDs, mismatched input/result/revision/state/
            protocol hashes, versions, or complete final head. Reexecute retained
            rejections at original position. Checkpoints validate full aggregate and
            retained protocol, anchor at canonical cutoff, then replay complete tail.
            Bad checkpoints may be ignored only if genesis plus complete log verifies.
            No canonical-record corruption is repaired by accepting a shorter prefix. */
        }
        action def RestoreBook {
            in item permit : Domain::RestorePermit;
            in item restoredGenesis : Domain::Genesis;
            in item restoredTail : Domain::OutcomeRecord[0..*];
            out verified : Boolean;
            out item receipt : Domain::ArchiveRestoreReceipt[0..1];
            doc /* External maintenance fence remains active across object abort and
            database rollback. Clear it only after verified replay equals permit head
            and current catalog fence generation matches. No new command is accepted
            between cutoff capture and re-enable. No cross-object atomicity is claimed. */
            doc /* Read actual current permit authority, then durably select one
            local restore reservation before fetching a full image. Match complete
            slot identity/profile and refuse unknown tables or an intact newer
            local head, external cascading foreign keys and custom triggers on
            owned tables. Missing books and damaged canonical financial records may
            be replaced; unverified/foreign identity remains quarantined. Recheck
            full archive history/control/catalog before installation. In one local
            SQL transaction compare the exact reservation hash, replace only the
            five canonical book tables, retain original outcomes/frames and mark
            the reservation installed. Preserve the local restore row itself.
            Also retain its matching installed hash in canonical metadata so
            losing that row cannot look like a never-restored book, even at genesis.
            Reexecute complete local history, validate the stored cutoff manifest
            and predecessor against it, then confirm durability. A rollback keeps
            the selected reservation and original canonical tables; uncertainty
            requires retry, not re-evaluation. A delayed installer cannot replace
            a newer reservation or redo an installed permit after later postings.
            Only actual persisted permit evidence may satisfy catalog finish;
            installation itself does not release maintenance. */
        }
        action def ReadHistory {
            in item request : Domain::ReadRequest;
            out item page : Domain::ReadPage;
            out failure : Domain::ServiceFailure[0..1];
        }
    }

    package Architecture {
        port def CommandPort {
            in item authorization : Domain::AuthorizationContext;
            in item envelope : Domain::CommandEnvelope;
            out item response : Domain::ServiceResponse;
        }
        port def ReadPort {
            in item request : Domain::ReadRequest;
            out item page : Domain::ReadPage;
            out failure : Domain::ServiceFailure[0..1];
        }
        port def CatalogPort {
            in item catalogEntry : Domain::CatalogEntry;
            in item restorePermit : Domain::RestorePermit[0..1];
        }
        part def AuthorizedGateway {
            doc /* Application-owned authentication and membership. Not a public
            bypass to DO storage. No bank-feed, invoice, payroll or tax filing logic. */
        }
        part def SQLiteAdapter {
            perform action publish : Behavior::CommitOutcome;
            perform action durability : Behavior::ConfirmDurability;
        }
        part def ArchivePublisher {
            exhibit state publication : ArchiveLifecycle::ArchivePublicationLifecycle;
            perform action initialize : Behavior::InitializeArchiveBook;
            perform action selectCandidate : Behavior::SelectArchiveCandidate;
            perform action publishCandidate : Behavior::PublishArchiveCandidate;
            perform action reconcileCandidate : Behavior::ReconcileArchiveCandidate;
        }
        part def BookAuthority {
            port commands : CommandPort;
            port reads : ReadPort;
            port catalog : CatalogPort;
            part storage : SQLiteAdapter;
            part archive : ArchivePublisher[0..1];
            doc /* Archive publisher is required when the pinned durability policy
            requires it. It implements storage publication, not a second accounting
            authority. BookLifecycle ready/durability gates include its resolution.
            Trusted archive command/read coordination is implemented locally;
            authenticated network entry, scalable execution and the deployed
            independent durability guarantee remain separate unclosed work. */
            exhibit state lifecycle : Lifecycle::BookLifecycle;
            perform action admission : Behavior::AdmitCommand;
            perform action evaluation : Behavior::EvaluateRetainedOutcome;
            perform action archiveExecution : Behavior::ExecuteArchiveCommand;
            perform action archiveFinancialRead : Behavior::ReadArchiveFinancialState;
            perform action recovery : Behavior::RecoverBook;
            perform action restore : Behavior::RestoreBook;
            perform action provisioning : Behavior::ProvisionBook;
            perform action history : Behavior::ReadHistory;
        }
    }

    package Requirements {
        requirement def <'PL-017'> CompleteIndexedCoverage {
            doc /* A usable view covers the exact disjoint cold and hot canonical populations, including retained rejection identities and every indexed family. Missing pages and incomplete predicates are service failures, never evidence of an unused identity. Scalar counts are necessary checks, not proofs of exact membership. */
            subject observation : Domain::IndexCoverageEvidence;
            require constraint enforce : Invariants::IndexedCoverage {
                in usable = observation.usable;
                in coldThrough = observation.coldThrough;
                in hotFrom = observation.hotFrom;
                in hotThrough = observation.hotThrough;
                in committedThrough = observation.committedThrough;
                in coldCount = observation.coldCount;
                in hotCount = observation.hotCount;
                in expectedCount = observation.expectedCount;
                in exactPopulationsVerified = observation.exactPopulationsVerified;
            }
        }
        requirement completeIndexedCoverage : CompleteIndexedCoverage;
        requirement def <'PL-018'> AtomicIndexCutover {
            doc /* Install only a verified equivalent frozen prefix at current identity/fence and a fresh complete-head/view CAS, preserving the entire newer tail. Canonical accounting and protocol history are unchanged. Unknown persistence status reconciles exact durable metadata before view reuse. */
            subject observation : Domain::IndexCutoverEvidence;
            require constraint enforce : Invariants::IndexCutover {
                in installed = observation.installed;
                in expectedViewRevision = observation.expectedViewRevision;
                in currentViewRevision = observation.currentViewRevision;
                in resultingViewRevision = observation.resultingViewRevision;
                in expectedColdDigest = observation.expectedColdDigest;
                in currentColdDigest = observation.currentColdDigest;
                in currentColdThrough = observation.currentColdThrough;
                in frozenThrough = observation.frozenThrough;
                in resultingColdThrough = observation.resultingColdThrough;
                in currentThrough = observation.currentThrough;
                in resultingHotFrom = observation.resultingHotFrom;
                in resultingHotThrough = observation.resultingHotThrough;
                in expectedHeadDigest = observation.expectedHeadDigest;
                in beforeHeadDigest = observation.beforeHeadDigest;
                in afterHeadDigest = observation.afterHeadDigest;
                in identityAndFenceVerified = observation.identityAndFenceVerified;
                in frozenPrefixVerified = observation.frozenPrefixVerified;
                in replacementVerified = observation.replacementVerified;
                in tailPreserved = observation.tailPreserved;
                in postingResolved = observation.postingResolved;
                in transactionDurable = observation.transactionDurable;
            }
        }
        requirement atomicIndexCutover : AtomicIndexCutover;
        requirement def <'PL-019'> PinnedIndexReads {
            doc /* Reader and construction pins name verified immutable views/cutoffs. Register before use, serialize admission with retirement, and reject expired or retired pin resurrection. A pinned query may not silently switch to another head or lose pages during maintenance. */
            subject observation : Domain::IndexPinEvidence;
            require constraint enforce : Invariants::IndexPinAdmission {
                in admitted = observation.admitted;
                in authorityCurrent = observation.authorityCurrent;
                in contextAndCutoffVerified = observation.contextAndCutoffVerified;
                in currentView = observation.currentView;
                in existingPinActive = observation.existingPinActive;
                in pinRetired = observation.pinRetired;
                in retirementSelected = observation.retirementSelected;
            }
        }
        requirement pinnedIndexReads : PinnedIndexReads;
        requirement def <'PL-020'> SafeIndexReclamation {
            doc /* Only exact durably retired derived locations with verified replacement, complete protected-root closure and an uninterrupted reference barrier may be deleted. Never select canonical history or live/pending references. Physical location reuse after retirement is forbidden even for identical content. */
            subject observation : Domain::IndexReclamationEvidence;
            require constraint enforce : Invariants::IndexReclamation {
                in deleted = observation.deleted;
                in derivedOnly = observation.derivedOnly;
                in retiredDurably = observation.retiredDurably;
                in closureVerified = observation.closureVerified;
                in referenceBarrierHeld = observation.referenceBarrierHeld;
                in replacementVerified = observation.replacementVerified;
                in noProtectedReferences = observation.noProtectedReferences;
                in identityAndFenceVerified = observation.identityAndFenceVerified;
                in locationReusable = observation.locationReusable;
                in deletionMatchesRetirement = observation.deletionMatchesRetirement;
            }
        }
        requirement safeIndexReclamation : SafeIndexReclamation;
        requirement def <'PL-001'> IdentityAdmission {
            doc /* Before reads, command lookup, provisioning or mutation, bind trusted
            authorization, actor and command to catalog tenant/book/object/namespace/
            generation. An active catalog identity with missing genesis quarantines;
            retries recheck authorization and cannot disclose prior receipts. */
        }
        requirement identityAdmission : IdentityAdmission;
        requirement def <'PL-002'> AtomicPublication {
            doc /* One complete outcome, optional financial revision, all payload
            chunks, unique command index and full durable head publish atomically.
            No method exposes separately successful outcome or financial writes. */
            subject observation : Domain::TransitionEvidence;
            require constraint publication : Invariants::Publication {
                in published = observation.retained;
                in fullHeadMatches = observation.fullHeadMatches;
                in transactionCommitted = observation.transactionCommitted;
            }
        }
        requirement atomicPublication : AtomicPublication;
        requirement def <'PL-003'> DurableAcknowledgement {
            doc /* Receipt and candidate-cache publication follow confirmed durability.
            Exceptions and uncertain writes invalidate readiness/cache and require
            recovery; no storage failure is retained as an accounting rejection. */
            subject observation : Domain::TransitionEvidence;
            require constraint acknowledgement : Invariants::Acknowledgement {
                in acknowledged = observation.acknowledged;
                in durable = observation.durable;
            }
            require constraint noServiceRetention : Invariants::NoServiceRetention {
                in serviceFailure = observation.serviceFailure;
                in retained = observation.retained;
            }
        }
        requirement durableAcknowledgement : DurableAcknowledgement;
        requirement def <'PL-004'> RetainedIdentity {
            doc /* Command ID permanently identifies canonical content within book
            generation. Preserve both retained commits and rejections. Exact retries
            return original outcome sequence/result, changed content remains unclaimed,
            and unretained service failures leave identity reusable. No TTL pruning. */
        }
        requirement retainedIdentity : RetainedIdentity;
        requirement def <'PL-005'> IndependentOrdering {
            doc /* Outcome sequence advances exactly once per newly retained result,
            independently of book/posting/configuration revisions. Preserve frozen
            kernel financial ordering, and never rewrite expected client revision. */
            subject observation : Domain::TransitionEvidence;
            require constraint classification : Invariants::RetentionClassification {
                in retained = observation.retained;
                in revisionPresent = observation.revisionPresent;
                in committed = observation.decision == Domain::RetentionDecision::retainCommit;
                in rejected = observation.decision == Domain::RetentionDecision::retainRejection;
            }
            require constraint outcomeAdvance : Invariants::OutcomeAdvance {
                in retained = observation.retained;
                in before = observation.before.outcomeSequence;
                in resulting = observation.resulting.outcomeSequence;
            }
            require constraint revisionAdvance : Invariants::RevisionAdvance {
                in committed = observation.revisionPresent;
                in before = observation.before.bookRevision;
                in resulting = observation.resulting.bookRevision;
            }
            require constraint rejectionIdentity : Invariants::RejectionFinancialIdentity {
                in rejected = observation.decision == Domain::RetentionDecision::retainRejection;
                in before = observation.before.stateHash;
                in resulting = observation.resulting.stateHash;
            }
        }
        requirement independentOrdering : IndependentOrdering;
        requirement def <'PL-006'> CompleteHeadSerialization {
            doc /* Queue admission, evaluation, CAS, durability, publication and current
            reads per book. CAS compares full financial AND outcome heads; a rejection
            invalidates a stale writer even without financial change. Bound retries. */
        }
        requirement completeHeadSerialization : CompleteHeadSerialization;
        requirement def <'PL-007'> CompleteRecovery {
            doc /* Verify genesis, every retained result and financial/protocol change,
            and final complete head using the pinned kernel before cold readiness and
            during explicit full audit. Include mixed capabilities, configuration,
            corrections, closes and rejection tails. Warm session reuse follows the
            separate integrity constraint; it is not another cold recovery and does
            not claim rereading every historical byte. Every newly published extension
            is locally admitted, atomically selected and durably confirmed. */
            subject observation : Domain::RecoveryEvidence;
            require constraint recoveryReadiness : Invariants::RecoveryReadiness {
                in ready = observation.ready;
                in identityMatches = observation.identityMatches;
                in versionsSupported = observation.versionsSupported;
                in completeReplay = observation.completeReplay;
                in expectedHeadMatches = observation.expectedHeadMatches;
                in protocolMatches = observation.protocolMatches;
                in catalogActive = observation.catalogActive;
                in fenceMatches = observation.fenceMatches;
            }
            require constraint warmSessionIntegrity : Invariants::WarmSessionIntegrity {
                in sessionReused = observation.sessionReused;
                in verifiedBase = observation.verifiedBase;
                in exactCurrentView = observation.exactCurrentView;
                in exactCatalogs = observation.exactCatalogs;
                in authorityLive = observation.authorityLive;
                in noUncertainWrite = observation.noUncertainWrite;
                in confirmedDelta = observation.confirmedDelta;
            }
        }
        requirement completeRecovery : CompleteRecovery;
        requirement def <'PL-008'> FailClosedHistory {
            doc /* Missing intervals, changed bytes, invalid ordering, foreign identity
            or incomplete suffix refuse cold recovery/audit readiness. Warm sessions
            check touched historical sources and current view/catalog authority;
            untouched damage can remain undetected until access or audit. A failed
            check retires the session. A local head cannot prove that its
            entire database was not rolled back; controlled restore uses PL-011. */
        }
        requirement failClosedHistory : FailClosedHistory;
        requirement def <'PL-009'> ExactBoundedFormats {
            doc /* Enforce complete versioned shape and canonical exact wire numerics,
            metadata/content/depth/node/chunk/history bounds before mutation. Decode
            bytes before interpreting meaning; unsupported versions never auto-upgrade.
            At capacity, existing valid retries remain readable without new outcomes. */
            subject observation : Domain::TransitionEvidence;
            require constraint admission : Invariants::Admission {
                in retained = observation.retained;
                in identityMatches = observation.identityMatches;
                in authorized = observation.authorized;
                in decoded = observation.decoded;
                in withinCapacity = observation.withinCapacity;
            }
        }
        requirement exactBoundedFormats : ExactBoundedFormats;
        requirement def <'PL-010'> DerivedCheckpoints {
            doc /* Checkpoints are optional, complete, verified state/protocol caches
            at canonical full heads. Interrupted publication leaves them invisible.
            Preserve genesis and complete immutable log; no canonical archive deletion
            is in scope. PL-020 concerns derived index pages only and does not authorize
            removing checkpoint objects. */
            subject observation : Domain::CheckpointEvidence;
            require constraint checkpointVisibility : Invariants::CheckpointVisibility {
                in visible = observation.visible;
                in chunksComplete = observation.chunksComplete;
                in decoded = observation.decoded;
                in cutoffMatches = observation.cutoffMatches;
            }
        }
        requirement derivedCheckpoints : DerivedCheckpoints;
        requirement def <'PL-011'> ControlledRestoration {
            doc /* Fence ingress and drain work before capturing an independent full
            expected head. Preserve fence across restore. Require same identity and
            complete verified replay to that head before reopening. Version migrations
            preserve every canonical command/result/hash; unproven migrations refuse
            service. Coordinated loss of book AND external authority is not detectable
            locally and requires disaster reconciliation, not claimed self-repair. */
            subject observation : Domain::RestoreEvidence;
            require constraint restoreReadiness : Invariants::RestoreReadiness {
                in ready = observation.ready;
                in fenced = observation.fenced;
                in independentPermit = observation.independentPermit;
                in expectedHeadMatches = observation.expectedHeadMatches;
                in completeReplay = observation.completeReplay;
            }
        }
        requirement controlledRestoration : ControlledRestoration;
        requirement def <'PL-012'> OperationalEvidence {
            doc /* Release requires measured per-book and multi-book capacity, queue
            backpressure, bounded recovery, actual runtime failure exercises, verified
            backup restoration, meaningful coverage and mutation tests, and reviewed
            residual risks. Profile limits are enforced service boundaries, not SLAs. */
        }
        requirement operationalEvidence : OperationalEvidence;
        requirement def <'PL-013'> ConsistentReadBoundary {
            doc /* Authorized reads return a verified complete head and pinned history
            cursor. Never combine different heads in a page sequence. Independent
            consumers advance durable cursors after effects and deduplicate Oseq;
            their failures cannot roll back or duplicate canonical book effects. */
            subject page : Domain::ReadPage;
            require constraint pageCutoff : Invariants::PageCutoff {
                in cursor = page.afterOutcomeSequence;
                in next = page.nextOutcomeSequence;
                in cutoff = page.snapshotHead.outcomeSequence;
            }
        }
        requirement consistentReadBoundary : ConsistentReadBoundary;
        requirement def <'PL-014'> DeclaredAcknowledgementDurability {
            doc /* Disclose and pin the durability policy. Under archive-required mode,
            acknowledge only the exact independently recoverable canonical outcome,
            after local publication is durable too. R2/restore authority must survive
            the modeled primary-store loss; no all-copies-loss guarantee is claimed.
            Platform-confirmed mode may archive asynchronously through the retained
            outcome outbox. Such a receipt confirms primary durability, not R2
            inclusion. Explicit backup lag and loss exposure remain mandatory. */
            subject observation : Domain::ArchiveAcknowledgementEvidence;
            require constraint acknowledgement : Invariants::ArchiveAcknowledgement {
                in acknowledged = observation.acknowledged;
                in archiveRequired = observation.policy.archiveRequired;
                in sqliteDurable = observation.sqliteDurable;
                in archiveCanonical = observation.archiveCanonical;
                in payloadVerified = observation.payloadVerified;
                in membershipVerified = observation.membershipVerified;
                in fenceVerified = observation.fenceVerified;
            }
            require constraint readiness : Invariants::ArchiveServiceReadiness {
                in publicReady = observation.publicReady;
                in archiveRequired = observation.policy.archiveRequired;
                in archivePhase = observation.archivePhase;
                in pendingSelection = observation.pendingSelection;
            }
        }
        requirement declaredAcknowledgementDurability : DeclaredAcknowledgementDurability;
        requirement def <'PL-015'> CanonicalArchivePublication {
            doc /* Publish only the exact durably selected candidate at the expected
            full head and current fence, with verified payload and successful archive
            anchor CAS. Orphan objects and failed conditional writes do not commit. */
            subject observation : Domain::ArchivePublicationEvidence;
            require constraint publication : Invariants::ArchivePublication {
                in published = observation.published;
                in selectedDurably = observation.selectedDurably;
                in priorHeadMatches = observation.priorHeadMatches;
                in fenceMatches = observation.fenceMatches;
                in conditionalWriteSucceeded = observation.conditionalWriteSucceeded;
                in candidateMatches = observation.candidateMatches;
                in expectedPayloadHash = observation.expectedPayloadHash;
                in observedPayloadHash = observation.observedPayloadHash;
            }
        }
        requirement canonicalArchivePublication : CanonicalArchivePublication;
        requirement def <'PL-016'> ExactArchiveReconciliation {
            doc /* A canonical archived decision finishes exactly, even if SQL/cache
            finalization failed. An unpublished candidate can be abandoned only after
            confirmed fence replacement excludes late publication at the same prior
            head. Uncertainty blocks new commands; it is never a retained rejection. */
            subject observation : Domain::ArchiveReconciliationEvidence;
            require constraint abandonment : Invariants::ArchiveAbandonment {
                in abandoned = observation.abandoned;
                in canonicalCommit = observation.canonicalCommit;
                in priorHeadMatches = observation.priorHeadMatches;
                in fenceReplacementConfirmed = observation.fenceReplacementConfirmed;
                in catalogFenceMatches = observation.catalogFenceMatches;
                in previousFence = observation.previousFence;
                in resultingFence = observation.resultingFence;
                in selectionClearedDurably = observation.selectionClearedDurably;
            }
            require constraint identity : Invariants::ArchiveRecoveryIdentity {
                in recovered = observation.recovered;
                in canonicalCommit = observation.canonicalCommit;
                in payloadVerified = observation.payloadVerified;
                in membershipVerified = observation.membershipVerified;
                in expectedCandidateHash = observation.expectedCandidateHash;
                in observedCandidateHash = observation.observedCandidateHash;
                in expectedOutcomeSequence = observation.expectedOutcomeSequence;
                in observedOutcomeSequence = observation.observedOutcomeSequence;
            }
        }
        requirement exactArchiveReconciliation : ExactArchiveReconciliation;
        requirement def <'PL-021'> CompleteIndexedKernelContext {
            doc /* Indexed evaluation may replace whole-state materialization only
            under an explicit supported representation and a verified complete
            command read context. Derived index availability is not accounting
            authority. Preserve negative/range completeness and original receipts;
            retain final full-head/fence CAS, durability and full recovery rules.
            A legacy delimiter-keyed source lookup can depend on an unrelated
            journal/effect tuple. A raw-identity indexed lookup is not equivalent
            to that legacy behavior. Do not enable indexed command admission by
            silently changing retained rejections; explicit collision-free
            semantics and governed legacy replay must first be established. */
            subject observation : Domain::IndexedKernelReadEvidence;
            require constraint contextAdmission : Invariants::IndexedKernelAdmission {
                in evaluated = observation.evaluated;
                in profileSupported = observation.profileSupported;
                in completeCatalog = observation.completeCatalog;
                in projectionVerified = observation.projectionVerified;
                in completeReadSet = observation.completeReadSet;
                in sourceRowsVerified = observation.sourceRowsVerified;
                in absenceAndRangesVerified = observation.absenceAndRangesVerified;
                in pinnedHeadMatches = observation.pinnedHeadMatches;
                in publicationFenceMatches = observation.publicationFenceMatches;
                in requiredEvidenceAvailable = observation.requiredEvidenceAvailable;
            }
        }
        requirement completeIndexedKernelContext : CompleteIndexedKernelContext;
        requirement def <'PL-022'> NativeJournalCandidate {
            doc /* The optional restricted native SQL current-command candidate preserves
            exact kernel accounting and retry outcomes while bounding save work by
            current inputs, not retained history. This requirement does not enable
            deployment or waive any production recovery/authorization obligation. */
            subject observation : Domain::NativeJournalEvidence;
            require constraint publication : Invariants::NativeJournalPublication {
                in acknowledged = observation.acknowledged;
                in profileSupported = observation.profileSupported;
                in completeCurrentInputs = observation.completeCurrentInputs;
                in permanentIdentities = observation.permanentIdentities;
                in headAndAuthorityMatch = observation.headAndAuthorityMatch;
                in singleAtomicPublication = observation.singleAtomicPublication;
                in platformDurabilityConfirmed = observation.platformDurabilityConfirmed;
            }
        }
        requirement nativeJournalCandidate : NativeJournalCandidate;
    }

    package Verification {
        verification def L25NativeJournal {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::nativeJournalCandidate; verify Requirements::retainedIdentity; verify Requirements::durableAcknowledgement; }
        }
        verification def L24IndexedKernelContext {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::completeIndexedKernelContext; verify Requirements::completeHeadSerialization; verify Requirements::failClosedHistory; verify Requirements::exactBoundedFormats; }
        }
        verification def L20CompleteIndexedCoverage {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::completeIndexedCoverage; verify Requirements::completeRecovery; verify Requirements::failClosedHistory; }
        }
        verification def L21AtomicIndexCutover {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::atomicIndexCutover; verify Requirements::completeRecovery; verify Requirements::failClosedHistory; }
        }
        verification def L22PinnedIndexReads {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::pinnedIndexReads; verify Requirements::completeRecovery; verify Requirements::failClosedHistory; }
        }
        verification def L23SafeIndexReclamation {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::safeIndexReclamation; verify Requirements::completeRecovery; verify Requirements::failClosedHistory; }
        }
        verification def L01Provision {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::identityAdmission; }
        }
        verification def L02CommittedRetry {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::retainedIdentity; verify Requirements::durableAcknowledgement; }
        }
        verification def L03RejectedRetry {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::retainedIdentity; verify Requirements::independentOrdering; }
        }
        verification def L04IdentityRace {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::retainedIdentity; verify Requirements::identityAdmission; }
        }
        verification def L05FinancialRace {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::completeHeadSerialization; verify Requirements::atomicPublication; }
        }
        verification def L06RejectionRace {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::completeHeadSerialization; verify Requirements::independentOrdering; }
        }
        verification def L07InterruptedTransaction {
            doc /* For the new indexed owner, terminate a real isolated SQLite
            process after root selection and after pin consumption but before
            transaction commit, and separately after commit before a receipt.
            Require a synchronous reached-boundary marker and actual SIGKILL;
            watchdog termination is not evidence. Repeat for committed and retained
            rejected commands. Reopen through full accounting/source/group/identity
            recovery and compare exact original state, Oseq and retry result.
            This local process test is not power-loss or provider replication proof. */
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::atomicPublication; verify Requirements::failClosedHistory; }
        }
        verification def L08LostReply {
            doc /* Also exercise the new indexed owner with native workerd SQLite
            and storage.sync, not only a Bun port. Verify transaction rollback,
            lost durability reply, maintenance beginning after confirmed commit,
            and complete runtime replacement with persistent local DO storage.
            No receipt may escape while authority is pending; explicit trusted
            harness release precedes replay of the original retained outcome.
            Include rejection before activation, which must not advance the
            financial clock, and retained rejection after commits. Repeated reads
            and retries must fail closed on damaged required source evidence.
            Fixed harness authority is not persistent control-plane certification;
            local runtime evidence does not establish production latency, scale,
            account-loss recovery or archive-required acknowledgement. */
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::durableAcknowledgement; verify Requirements::retainedIdentity; }
        }
        verification def L09UnknownWrite {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::durableAcknowledgement; verify Requirements::completeRecovery; }
        }
        verification def L10HistoryDamage {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::failClosedHistory; verify Requirements::completeRecovery; }
        }
        verification def L11MixedRecovery {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::completeRecovery; }
        }
        verification def L12FormatCapacity {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::exactBoundedFormats; }
        }
        verification def L13Checkpoint {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::derivedCheckpoints; }
        }
        verification def L14RestoreUpgrade {
            doc /* Restore interruption evidence must identify the actual reached
            boundary and distinguish a hard process kill from an exception or a
            watchdog timeout. Before installation commits, reopening preserves
            the original canonical tables and any committed selection. After
            installation commits, reopening preserves the entire exact original
            archive history, including retained rejections. Retry uses the same
            permit without duplicate outcomes or automatic maintenance release.
            Missing archive payloads prevent completion and ordinary service.
            Local process-kill evidence does not establish provider replication,
            power-loss, account-loss or production-scale recovery guarantees. */
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::controlledRestoration; verify Requirements::identityAdmission; }
        }
        verification def L15Workload {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::operationalEvidence; }
        }
        verification def L16ReadCursor {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::consistentReadBoundary; verify Requirements::identityAdmission; }
        }
        verification def L17ArchiveAcknowledgement {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::declaredAcknowledgementDurability; verify Requirements::durableAcknowledgement; }
        }
        verification def L18ArchivePublication {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::canonicalArchivePublication; verify Requirements::completeHeadSerialization; }
        }
        verification def L19ArchiveReconciliation {
            subject ledger : Architecture::BookAuthority;
            objective { verify Requirements::exactArchiveReconciliation; verify Requirements::completeRecovery; verify Requirements::failClosedHistory; }
        }
    }

    package ArchiveLifecycle {
        attribute def Select;
        attribute def PayloadStored;
        attribute def ArchivePublished;
        attribute def LocalPublished;
        attribute def ReceiptReady;
        attribute def WriteUncertain;
        attribute def Resume;
        attribute def CanonicalFound;
        attribute def FencedUnpublished;
        attribute def ConflictingEvidence;
        attribute def AuthorizedRepair;

        state def ArchivePublicationLifecycle {
            doc /* This sub-lifecycle runs only after authorized book readiness; idle
            means no pending candidate, not unconditional service readiness. Verified
            internal evidence supplies guards, never caller Booleans. Process crashes
            from any phase enter uncertain; durable records determine reconciliation,
            not the lost in-memory state. Pending work fences new writes and reads.
            Fenced abandonment preserves the prior full head and leaves identity reusable.
            ReceiptReady means exact receipt verified and reservation cleared, not
            network delivery. BookLifecycle separately releases ready/acknowledgement
            only when PL-014 and complete recovery checks hold. Lost client replies
            cannot undo the canonical decision. */
            attribute selectionConfirmed : Boolean;
            attribute payloadConfirmed : Boolean;
            attribute archivePublicationConfirmed : Boolean;
            attribute localPublicationConfirmed : Boolean;
            attribute receiptConfirmed : Boolean;
            attribute authorityRechecked : Boolean;
            attribute canonicalMembershipVerified : Boolean;
            attribute abandonmentVerified : Boolean;
            attribute maintenanceAuthorized : Boolean;
            entry; then idle;
            state idle;
            state selected;
            state uploaded;
            state archiveCommitted;
            state locallyPublished;
            state uncertain;
            state reconciling;
            state quarantined;
            transition select first idle accept Select if selectionConfirmed then selected;
            transition upload first selected accept PayloadStored if payloadConfirmed then uploaded;
            transition archiveCommit first uploaded accept ArchivePublished if archivePublicationConfirmed then archiveCommitted;
            transition localCommit first archiveCommitted accept LocalPublished if localPublicationConfirmed then locallyPublished;
            transition receipt first locallyPublished accept ReceiptReady if receiptConfirmed then idle;
            transition idleUnknown first idle accept WriteUncertain then uncertain;
            transition selectionUnknown first selected accept WriteUncertain then uncertain;
            transition uploadUnknown first uploaded accept WriteUncertain then uncertain;
            transition archiveUnknown first archiveCommitted accept WriteUncertain then uncertain;
            transition localUnknown first locallyPublished accept WriteUncertain then uncertain;
            transition reconcileUnknown first reconciling accept WriteUncertain then uncertain;
            transition resume first uncertain accept Resume if authorityRechecked then reconciling;
            transition committedRecovery first reconciling accept CanonicalFound if canonicalMembershipVerified then archiveCommitted;
            transition abandon first reconciling accept FencedUnpublished if abandonmentVerified then idle;
            transition quarantine first reconciling accept ConflictingEvidence then quarantined;
            transition repair first quarantined accept AuthorizedRepair if maintenanceAuthorized then reconciling;
        }
    }
}

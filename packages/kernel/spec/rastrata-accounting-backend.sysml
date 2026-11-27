package RastrataAccountingBackend {
    private import ScalarValues::*;

    package Semantics {
        attribute def Identifier :> String;
        attribute def SemanticVersion :> String;
        attribute def Instant :> String;
        attribute def LocalDate :> String;
        attribute def EffectKey :> String;

        attribute def ContentHash {
            doc /* A digest is meaningful only with its algorithm and canonicalization version. */
            attribute algorithm : String;
            attribute canonicalizationVersion : SemanticVersion;
            attribute digest : String;
        }

        attribute def ExactDecimal {
            doc /* A source decimal preserved as signed coefficient and non-negative scale. */
            attribute coefficient : Integer;
            attribute scale : Natural;
        }

        attribute def ExactRational {
            doc /* A canonical exact fraction. denominator must be greater than zero. */
            attribute numerator : Integer;
            attribute denominator : Natural;
        }

        enum def AccountRole {
            asset;
            liability;
            equity;
            income;
            expense;
            gain;
            unrealizedGain;
        }

        enum def NormalSide {
            debit;
            credit;
        }

        enum def DerivationState {
            proposed;
            approved;
            rejected;
            applied;
        }

        enum def LotSelectionMethod {
            specificIdentification;
            fifo;
            lifo;
            hifo;
            weightedAverage;
        }

        enum def PolicyScope {
            account;
            legalEntity;
            jurisdictionPool;
        }

        enum def CorrectionKind {
            reversal;
            supersession;
        }

        enum def ReconciliationRelationKind {
            exactMatch;
            allocatedMatch;
            supportingEvidence;
            contradiction;
        }

        enum def MappingFidelity {
            full;
            transformed;
            lossy;
            unsupported;
        }

        enum def PriceObservationKind {
            marketQuote;
            officialRate;
            appraisedValue;
        }

        enum def CapabilityStatus {
            supported;
            experimental;
            unsupported;
        }

        enum def BookOwnerKind {
            legalEntity;
            entityGroup;
        }

        enum def BookKind {
            operational;
            tax;
            consolidation;
        }

        enum def BookStatus {
            configuring;
            open;
            closed;
            archived;
        }

        enum def AccountingBasis {
            accrual;
            cash;
        }

        enum def FiscalPeriodKind {
            regular;
            adjustment;
        }

        enum def FiscalPeriodStatus {
            open;
            closed;
        }

        enum def JournalKind {
            opening;
            ordinary;
            adjustment;
            reversing;
            closing;
        }

        enum def PeriodTransitionKind {
            close;
            reopen;
        }

        enum def CommandDisposition {
            committed;
            replayed;
            rejected;
        }

        enum def FinancialReportKind {
            journalRegister;
            generalLedger;
            trialBalance;
            profitAndLoss;
            balanceSheet;
            cashFlow;
        }

        enum def ProjectionKind {
            accountBalance;
            accountPeriodDelta;
            lotPosition;
            reportIndex;
        }

        enum def CrossBookEffectStatus {
            pending;
            complete;
            failed;
        }

        enum def InventoryShortageTreatment {
            reject;
            provisionalNegative;
        }

        enum def InventoryValueAdjustmentKind {
            directlyAttributableCost;
            purchaseRebate;
            productionOverhead;
            writeDown;
            writeDownReversal;
        }

        enum def ProvisionalBasisMethod {
            lastReceiptCost;
            movingAverage;
            standardCost;
            explicitRate;
        }

        enum def OpenItemKind {
            receivable;
            payable;
            credit;
        }

        enum def SettlementKind {
            cash;
            creditApplication;
            writeOff;
        }

        enum def SettlementOperation {
            recognizeUnallocated;
            allocateExisting;
        }

        enum def MonetaryClassification {
            monetary;
            nonMonetary;
        }

        enum def RemeasurementKind {
            realized;
            unrealized;
        }

        enum def AllocationMethod {
            straightLine;
            decliningBalance;
            unitsOfProduction;
        }

        enum def AllocationConvention {
            actualDays;
            fullPeriod;
            halfYear;
            midMonth;
            usageEvent;
        }

        enum def AllocationFrequency {
            monthly;
            quarterly;
            annual;
            eventDriven;
        }

        enum def AllocationScheduleChangeKind {
            estimateChange;
            impairment;
            disposal;
            termination;
        }

        enum def TaxInclusion {
            exclusive;
            inclusive;
        }

        enum def TaxRecoverability {
            recoverable;
            nonRecoverable;
            partiallyRecoverable;
        }

        enum def TaxTreatment {
            outputTax;
            inputTax;
            reverseCharge;
            withholding;
        }

        enum def TaxRoundingLevel {
            lineLevel;
            documentLevel;
        }

        enum def ConsolidationAdjustmentKind {
            accountMapping;
            currencyTranslation;
            elimination;
            nonControllingInterest;
        }

        enum def ConsolidationControlClassification {
            controlled;
            jointlyControlled;
            significantInfluence;
            other;
        }

        enum def ConsolidationMethod {
            full;
            equity;
            jointOperationShare;
        }

        enum def NonControllingInterestMethod {
            proportionateNetAssets;
            fairValue;
        }

        enum def AccountingBasisEventKind {
            recognition;
            settlement;
            creditApplication;
            writeOff;
            tax;
            inventoryCost;
            nonCash;
            rounding;
        }

        enum def AccountingBasisTreatment {
            recognizeAtAccountingDate;
            recognizeAtSettlement;
            allocateBySettlementRatio;
            carryThrough;
            exclude;
        }

        enum def BookCommandKind {
            activateBook;
            postJournal;
            correctJournal;
            closePeriod;
            reopenPeriod;
            replaceConfiguration;
            postInventoryTransaction;
            postOwnedInventoryTransaction;
            recostProvisionalInventory;
            adjustInventoryValue;
            recognizeOpenItem;
            applySettlement;
            postCurrencyRemeasurement;
            createAllocationSchedule;
            recognizeScheduledAllocation;
            reviseAllocationSchedule;
            postTaxedTransaction;
            compileConsolidation;
        }

        enum def SemanticDiagnosticCode {
            invalid_exact_number;
            monetary_type_mismatch;
            journal_imbalance;
            invalid_correction_topology;
            unresolved_accounting_input;
            impure_core_dependency;
            canonical_identity_conflict;
            lot_overallocation;
            transfer_policy_missing;
            valuation_mutates_booking;
            temporal_semantics_violation;
            invalid_chart_or_account;
            invalid_journal_structure;
            noncanonical_ordering;
            atomic_commit_failed;
            immutable_book_identity;
            fabricated_opening_journal;
            fiscal_period_admission;
            command_identity_conflict;
            ordered_history_violation;
            dependent_close_not_current;
            projection_rebuild_mismatch;
            invalid_dimension_selection;
            inventory_cost_policy_incoherent;
            provisional_inventory_violation;
            inventory_value_adjustment_violation;
            settlement_allocation_violation;
            accounting_basis_policy_incomplete;
            currency_remeasurement_violation;
            allocation_schedule_violation;
            allocation_schedule_revision_violation;
            tax_policy_ambiguity;
            consolidation_input_violation;
            external_accounting_authority;
        }
    }

    package Domain {
        item def BookOwner {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::BookOwnerKind;
        }

        item def Commodity {
            attribute id : Semantics::Identifier;
            attribute symbol : String;
        }

        item def Book {
            doc /* The indivisible accounting scope. A journal belongs to exactly one book, and a book belongs to exactly one owner. Status is the current projection of revision history, never permission to rewrite prior state. */
            attribute id : Semantics::Identifier;
            attribute code : String;
            attribute kind : Semantics::BookKind;
            attribute status : Semantics::BookStatus;
            attribute primaryBasis : Semantics::AccountingBasis;
            attribute timeZone : String;
            attribute financialIdentityHash : Semantics::ContentHash;
            item owner : BookOwner;
            item functionalCommodity : Commodity;
        }

        item def FiscalCalendar {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute yearStartMonth : Natural;
            attribute yearStartDay : Natural;
            attribute timeZone : String;
            item book : Book;
        }

        item def FiscalPeriod {
            doc /* Period identity and date bounds are immutable after activation. Status is the current projection of appended close and reopen transitions. */
            attribute id : Semantics::Identifier;
            attribute fiscalYear : Integer;
            attribute sequence : Natural;
            attribute label : String;
            attribute kind : Semantics::FiscalPeriodKind;
            attribute status : Semantics::FiscalPeriodStatus;
            attribute startsOn : Semantics::LocalDate;
            attribute endsOn : Semantics::LocalDate;
            item calendar : FiscalCalendar;
        }

        item def Quantity {
            doc /* Canonical quantity is rational. The source decimal, when one was written, remains evidence of coefficient and scale. */
            attribute canonicalNumber : Semantics::ExactRational;
            attribute sourceNumber : Semantics::ExactDecimal[0..1];
            item commodity : Commodity;
        }

        item def BookValue {
            attribute amount : Semantics::ExactDecimal;
            item functionalCommodity : Commodity;
        }

        item def TransactionPrice {
            attribute unitRate : Semantics::ExactRational;
            item baseCommodity : Commodity;
            item quoteCommodity : Commodity;
        }

        item def CostBasis {
            doc /* Authoritative total basis is rational so a partial allocation of an indivisible decimal total remains exact. */
            attribute totalBasis : Semantics::ExactRational;
            attribute sourceTotalBasis : Semantics::ExactDecimal[0..1];
            item basisCommodity : Commodity;
        }

        item def MarketValue {
            doc /* A reporting valuation is never a ledger book value. */
            attribute exactAmount : Semantics::ExactRational;
            attribute displayAmount : Semantics::ExactDecimal[0..1];
            item reportingCommodity : Commodity;
        }

        item def CostSpecification {
            doc /* A deliberately incomplete input specification. It is never valid in a booked posting. */
            attribute perUnit : Semantics::ExactDecimal[0..1];
            attribute total : Semantics::ExactDecimal[0..1];
            attribute acquiredAt : Semantics::Instant[0..1];
            attribute externalLabel : String[0..1];
            item basisCommodity : Commodity[0..1];
        }

        item def MarketPriceObservation {
            attribute id : Semantics::Identifier;
            attribute effectiveAt : Semantics::Instant;
            attribute observedAt : Semantics::Instant;
            attribute kind : Semantics::PriceObservationKind;
            attribute rate : Semantics::ExactRational;
            item baseCommodity : Commodity;
            item quoteCommodity : Commodity;
            item evidence : SourceEvidence;
        }

        item def Account {
            doc /* An empty allowedCommodity collection means unrestricted commodity admission. A nonempty collection is an allow-list. Parent and child accounts must belong to the same book. */
            attribute id : Semantics::Identifier;
            attribute code : String;
            attribute name : String;
            attribute role : Semantics::AccountRole;
            attribute normalSide : Semantics::NormalSide;
            attribute postingAllowed : Boolean;
            attribute openedOn : Semantics::LocalDate;
            attribute closedOn : Semantics::LocalDate[0..1];
            item book : Book;
            item parent : Account[0..1];
            item allowedCommodity : Commodity[0..*];
        }

        item def AccountingDimension {
            doc /* A typed analytic axis such as department, project, location, or cost center. It is never part of account identity or double-entry balance. */
            attribute id : Semantics::Identifier;
            attribute code : String;
            attribute name : String;
            attribute openedOn : Semantics::LocalDate;
            attribute closedOn : Semantics::LocalDate[0..1];
            item book : Book;
        }

        item def DimensionMember {
            attribute id : Semantics::Identifier;
            attribute code : String;
            attribute name : String;
            attribute openedOn : Semantics::LocalDate;
            attribute closedOn : Semantics::LocalDate[0..1];
            item dimension : AccountingDimension;
            item parent : DimensionMember[0..1];
        }

        item def ChartSnapshot {
            attribute id : Semantics::Identifier;
            attribute effectiveOn : Semantics::LocalDate;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item account : Account[1..*];
            item dimension : AccountingDimension[0..*];
            item dimensionMember : DimensionMember[0..*];
        }

        item def Posting {
            attribute id : Semantics::Identifier;
            attribute ordinal : Natural;
            item account : Account;
            item units : Quantity;
            item bookValue : BookValue;
            item transactionPrice : TransactionPrice[0..1];
            item costBasis : CostBasis[0..1];
            item dimensionMember : DimensionMember[0..*];
        }

        item def ProposedPosting {
            doc /* A posting proposal may contain unresolved values and may not enter the canonical journal. */
            attribute id : Semantics::Identifier;
            item account : Account;
            item units : Quantity[0..1];
            item bookValue : BookValue[0..1];
            item transactionPrice : TransactionPrice[0..1];
            item costSpecification : CostSpecification[0..1];
            item dimensionMember : DimensionMember[0..*];
        }

        item def JournalTransaction {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::JournalKind;
            attribute economicAt : Semantics::Instant;
            attribute accountingDate : Semantics::LocalDate;
            attribute settledAt : Semantics::Instant[0..1];
            attribute recordedAt : Semantics::Instant;
            attribute narration : String;
            item book : Book;
            item posting : Posting[2..*];
        }

        item def SourceEvidence {
            attribute id : Semantics::Identifier;
            attribute sourceSystem : String;
            attribute sourceRecordId : String;
            attribute observedAt : Semantics::Instant;
            attribute contentHash : Semantics::ContentHash;
        }

        item def RawSourceRecord {
            attribute id : Semantics::Identifier;
            attribute schemaId : String;
            item evidence : SourceEvidence;
        }

        item def NormalizedEconomicEvent {
            attribute id : Semantics::Identifier;
            attribute economicAt : Semantics::Instant;
            attribute eventKind : String;
            item evidence : SourceEvidence[1..*];
        }

        item def ProposedTransaction {
            attribute id : Semantics::Identifier;
            item economicEvent : NormalizedEconomicEvent;
            item proposedPosting : ProposedPosting[2..*];
        }

        item def ResolvedTransaction {
            attribute id : Semantics::Identifier;
            attribute policySnapshotHash : Semantics::ContentHash;
            attribute quantizationPolicySnapshotHash : Semantics::ContentHash;
            item resolvedPosting : Posting[2..*];
            item derivation : DerivationRecord[0..*];
            item lotAllocation : LotAllocation[0..*];
            item lotTransferAllocation : LotTransferAllocation[0..*];
        }

        item def ValidatedBookedJournal {
            attribute id : Semantics::Identifier;
            attribute commandId : Semantics::Identifier;
            attribute effectKey : Semantics::EffectKey;
            attribute bookRevision : Natural;
            attribute postingSequence : Natural;
            attribute policySnapshotHash : Semantics::ContentHash;
            attribute canonicalHash : Semantics::ContentHash;
            item book : Book;
            item fiscalPeriod : FiscalPeriod;
            item transaction : JournalTransaction;
        }

        item def CanonicalPostingReference {
            doc /* A source reference is prepared without fabricating book order. EvaluateBookCommand admits it only when journalId, postingId, effectKey, book, and complete postingContentHash resolve exactly one retained or same-command prepared posting; the committed reference then remains stable because that posting is immutable. */
            attribute id : Semantics::Identifier;
            attribute journalId : Semantics::Identifier;
            attribute postingId : Semantics::Identifier;
            attribute effectKey : Semantics::EffectKey;
            attribute postingContentHash : Semantics::ContentHash;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
        }

        item def OpeningBoundary {
            doc /* A book admits ordinary postings only after an immutable opening boundary has been activated. A zero-balance new book has no opening journal; a migrated book retains one balanced opening journal. */
            attribute id : Semantics::Identifier;
            attribute firstAccountingDate : Semantics::LocalDate;
            attribute activatedAt : Semantics::Instant;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item openingJournal : ValidatedBookedJournal[0..1];
            item configurationSnapshot : BookConfigurationSnapshot;
        }

        item def BookCommand {
            doc /* A typed, versioned request evaluated against one expected book revision. Exactly one payload matches commandKind. Times, identities, facts, and requested policy identities are supplied; the pure core reads none from its environment. */
            attribute id : Semantics::Identifier;
            attribute commandKind : Semantics::BookCommandKind;
            attribute protocolVersion : Semantics::SemanticVersion;
            attribute inputHash : Semantics::ContentHash;
            attribute expectedBookRevision : Natural;
            attribute issuedAt : Semantics::Instant;
            attribute completedAt : Semantics::Instant;
            attribute committedAt : Semantics::Instant[0..1];
            attribute actorId : Semantics::Identifier;
            item book : Book;
            item resolvedTransaction : ResolvedTransaction[0..1];
            item accountingPayload : AccountingCommandPayload[0..1];
        }

        enum def BookExecutionProfile {
            structuralSourceIdentityV1;
        }

        enum def BookStateCommitmentProfile {
            chainHeadStateCommitmentV1;
        }

        item def BookConfigurationSnapshot {
            doc /* Revision zero and every successor are complete immutable content-addressed configurations. A hash without these retained contents is not a reproducible snapshot.
            An absent executionProfile preserves the original source resolver and
            original hash preimage. structuralSourceIdentityV1 selects the wire
            marker structural-source-identity-v1 and exact structural source
            coordinates. Selection occurs only at genesis and is included in the
            snapshot hash. Every subsequent configuration, activation and close
            retains it unless an explicit ExecutionProfileAdoption changes legacy
            source semantics prospectively. Ordinary replacement without that
            payload cannot adopt, remove or downgrade it. Unknown markers fail closed. This profile changes
            only source identity resolution, not inventory arithmetic or ownership.
            No inventory ownership adoption is authorized by this source profile.
            An absent stateCommitmentProfile preserves the original BookStateSnapshot
            content-hash preimage. chainHeadStateCommitmentV1 selects the wire marker
            chain-head-state-commitment-v1 and the chain-head preimage described on
            BookStateSnapshot. It is independent of executionProfile, is selected only
            at genesis, is included in the snapshot hash, and is retained by every
            subsequent configuration, activation and close. No transition adopts,
            changes or removes it. Unknown markers fail closed. */
            attribute revision : Natural;
            attribute effectiveAt : Semantics::Instant;
            attribute executionProfile : BookExecutionProfile[0..1];
            attribute stateCommitmentProfile : BookStateCommitmentProfile[0..1];
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item fiscalPeriod : FiscalPeriod[1..*];
            item chartSnapshot : ChartSnapshot;
            item bookingPolicy : BookingPolicy[1..*];
            item quantizationPolicy : QuantizationPolicy[1..*];
            item inventoryCostPolicy : InventoryCostPolicy[0..*];
            item inventoryValueAdjustmentPolicy : InventoryValueAdjustmentPolicy[0..*];
            item accountingBasisPolicy : AccountingBasisPolicy[0..*];
            item monetaryClassificationPolicy : MonetaryClassificationPolicy[0..*];
            item remeasurementPolicy : RemeasurementPolicy[0..*];
            item allocationSchedulePolicy : AllocationSchedulePolicy[0..*];
            item taxPolicy : TaxPolicy[0..*];
            item consolidationPolicy : ConsolidationPolicy[0..*];
        }

        item def BookStateHeader {
            item book : Book;
            attribute fiscalCalendarId : Semantics::Identifier;
            attribute bookRevision : Natural;
            attribute latestPostingSequence : Natural;
            attribute configurationRevision : Natural;
            attribute configurationHash : Semantics::ContentHash;
            doc /* rastrata-book-state-header-v1 is a closed scalar codec, not a
            sparse BookStateSnapshot. Its seven wire fields are identity (including
            fiscal calendar), financialIdentityHash, status, bookRevision,
            latestPostingSequence, configurationRevision and configurationHash.
            Preserve exact legacy tagged field subtrees and all hash metadata.
            Counters are nonnegative, at most 64 decimal digits; configuration
            revision cannot exceed book revision. Recompute financial identity.
            Reject unknown fields and noncanonical bytes; limit UTF-8 to 65536.
            This header contains no legacy contentHash, collections, current
            configuration aliases or caller-supplied verification flags. Framing
            cannot prove configuration contents, row populations, financial
            admission, source authenticity or complete state integrity. */
        }

        item def BookStateSnapshot {
            doc /* contentHash is a reproducible content hash whose preimage the active configuration snapshot selects at genesis through stateCommitmentProfile.
            Without the marker it is the original complete-population hash: the typed BookStateSnapshot over identity, status, counters, every configuration snapshot hash, the active snapshot, the opening boundary, the flat configuration hashes, every lot, holding, allocation, ownership effect, accounting lifecycle value, journal effect and correction, every period transition and close hash, the revision count and the revision chain head.
            With chainHeadStateCommitmentV1 it is the typed BookStateChainHeadCommitment over exactly the financial identity hash, status, book revision, latest posting sequence, configuration revision, configuration hash, active configuration snapshot hash, opening boundary hash or null, the revision count and the revision chain head hash or null, plus the profile marker. The chain head hash covers the complete ordered typed effects of every revision, so every journal, correction, period transition, close, lot change and accounting effect is committed through it.
            Every other collection of a state with the marker is materialized from those ordered effects. Recovery shall recompute every revision hash and the commitment, shall prove each materialized collection and each retained configuration snapshot equal to the effects that produced it, and shall reject a state that differs. Admission of a command against an in-memory state of such a book checks in constant time that its counters agree with its collections and head revision, that its latest journal is the one its booking revision recorded, and that the commitment reproduces; it does not re-derive collections, which recovery has already proved. */
            attribute bookRevision : Natural;
            attribute latestPostingSequence : Natural;
            attribute configurationRevision : Natural;
            attribute configurationHash : Semantics::ContentHash;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item configurationSnapshot : BookConfigurationSnapshot[1..*];
            item activeConfigurationSnapshot : BookConfigurationSnapshot;
            item openingBoundary : OpeningBoundary[0..1];
            item fiscalPeriod : FiscalPeriod[1..*];
            item chartSnapshot : ChartSnapshot;
            item policy : BookingPolicy[1..*];
            item quantizationPolicy : QuantizationPolicy[1..*];
            item inventoryCostPolicy : InventoryCostPolicy[0..*];
            item inventoryValueAdjustmentPolicy : InventoryValueAdjustmentPolicy[0..*];
            item accountingBasisPolicy : AccountingBasisPolicy[0..*];
            item monetaryClassificationPolicy : MonetaryClassificationPolicy[0..*];
            item remeasurementPolicy : RemeasurementPolicy[0..*];
            item allocationSchedulePolicy : AllocationSchedulePolicy[0..*];
            item taxPolicy : TaxPolicy[0..*];
            item consolidationPolicy : ConsolidationPolicy[0..*];
            item lot : Lot[0..*];
            item lotHolding : LotHolding[0..*];
            item lotAllocation : LotAllocation[0..*];
            item provisionalInventoryLayer : ProvisionalInventoryLayer[0..*];
            item inventoryPostedAnchor : InventoryPostedAnchor[0..*];
            item inventoryPostedPosition : InventoryPostedPosition[0..*];
            item inventoryPostedMovement : InventoryPostedMovement[0..*];
            item inventoryQuantityAllocation : InventoryQuantityAllocation[0..*];
            doc /* Ownership catalogs are derived from immutable revision effects.
            The full-state wire may retain one optional inventoryOwnershipEffects
            materialization; it must equal the ordered effects from that same prefix.
            Legacy snapshots omit the field, preserving their bytes and hash preimage.
            Missing, additional or altered ownership projections reject during recovery;
            positions and quantity allocations are never independent mutable state. */
            item inventoryRecosting : InventoryRecosting[0..*];
            item inventoryValueAdjustment : InventoryValueAdjustment[0..*];
            item openItem : OpenItem[0..*];
            item settlement : Settlement[0..*];
            item settlementAllocation : SettlementAllocation[0..*];
            item allocationSchedule : AllocationSchedule[0..*];
            item allocationRecognition : AllocationRecognition[0..*];
            item allocationScheduleRevision : AllocationScheduleRevision[0..*];
            item taxDetermination : TaxDetermination[0..*];
            item remeasurementResult : RemeasurementResult[0..*];
            item remeasurementReversal : RemeasurementReversal[0..*];
            item consolidationCompilation : ConsolidationCompilation[0..*];
        }

        item def BookingPolicy {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute lotSelection : Semantics::LotSelectionMethod;
            attribute scope : Semantics::PolicyScope;
            item capability : PolicyCapability;
            item requiredDimension : AccountingDimension[0..*];
        }

        item def PolicyCapability {
            attribute id : Semantics::Identifier;
            attribute method : Semantics::LotSelectionMethod;
            attribute scope : Semantics::PolicyScope;
            attribute status : Semantics::CapabilityStatus;
            attribute implementationVersion : Semantics::SemanticVersion;
            item verificationEvidence : SourceEvidence[1..*];
        }

        item def AccountingFeatureCapability {
            doc /* Release-evidence key shared by the newer policy families. featureKey and methodKey are registry identifiers and must agree with each policy's typed fields. */
            attribute id : Semantics::Identifier;
            attribute featureKey : String;
            attribute methodKey : String;
            attribute scope : Semantics::PolicyScope;
            attribute status : Semantics::CapabilityStatus;
            attribute implementationVersion : Semantics::SemanticVersion;
            item verificationEvidence : SourceEvidence[1..*];
        }

        item def QuantizationPolicy {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute targetScale : Natural;
            attribute roundingMode : String;
            item roundingAccount : Account;
        }

        item def ValuationPolicy {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute maximumHops : Natural;
            attribute allowInverseObservation : Boolean;
            attribute preferDirectObservation : Boolean;
        }

        item def DerivationRecord {
            attribute id : Semantics::Identifier;
            attribute policyId : Semantics::Identifier;
            attribute policyVersion : Semantics::SemanticVersion;
            attribute algorithmVersion : Semantics::SemanticVersion;
            attribute inputHash : Semantics::ContentHash;
            attribute actorId : Semantics::Identifier;
            attribute derivationState : Semantics::DerivationState;
            attribute recordedAt : Semantics::Instant;
            item evidence : SourceEvidence[1..*];
        }

        item def SemanticDiagnostic {
            attribute id : Semantics::Identifier;
            attribute invariantId : String;
            attribute code : Semantics::SemanticDiagnosticCode;
            attribute diagnosticText : String;
            item evidence : SourceEvidence[0..*];
        }

        item def Lot {
            attribute id : Semantics::Identifier;
            attribute acquiredAt : Semantics::Instant;
            item commodity : Commodity;
            item acquisitionQuantity : Quantity;
            item acquisitionTotalBasis : CostBasis;
            item evidence : SourceEvidence[1..*];
        }

        item def LotHolding {
            doc /* The account-scoped derived balance of a stable acquisition lot. Remaining basis includes appended capitalizable cost and rebate effects; valuation allowance is separate so historical cost is never erased. A lot may have multiple holdings after a partial transfer. */
            attribute id : Semantics::Identifier;
            item lot : Lot;
            item account : Account;
            item remainingQuantity : Quantity;
            item remainingTotalBasis : CostBasis;
            item remainingValuationAllowance : ExactBookAmount;
            item remainingCarryingAmount : ExactBookAmount;
        }

        item def LotAllocation {
            attribute id : Semantics::Identifier;
            item holding : LotHolding;
            item reducingSource : CanonicalPostingReference;
            item allocatedQuantity : Quantity;
            item allocatedTotalBasis : CostBasis;
            item allocatedValuationAllowance : ExactBookAmount;
            item allocatedCarryingAmount : ExactBookAmount;
            item derivation : DerivationRecord;
        }

        item def LotTransferAllocation {
            attribute id : Semantics::Identifier;
            item sourceHolding : LotHolding;
            item destinationHolding : LotHolding;
            item transferredQuantity : Quantity;
            item transferredTotalBasis : CostBasis;
            item transferredValuationAllowance : ExactBookAmount;
            item transferredCarryingAmount : ExactBookAmount;
            item derivation : DerivationRecord;
        }

        item def ExactBookAmount {
            doc /* An exact pre-quantization amount denominated in the book's functional commodity. */
            attribute amount : Semantics::ExactRational;
            item functionalCommodity : Commodity;
        }

        item def QuantizationResult {
            doc /* Complete proof of how an exact amount became a booked decimal. The residual is exact and must be zero or assigned to the named rounding destination. */
            item exactInput : ExactBookAmount;
            item policy : QuantizationPolicy;
            item quantizedValue : BookValue;
            item exactResidual : ExactBookAmount;
        }

        item def PolicyReference {
            attribute policyId : Semantics::Identifier;
            attribute policyVersion : Semantics::SemanticVersion;
            attribute policyContentHash : Semantics::ContentHash;
        }

        item def CumulativePostedShare {
            doc /* Arithmetic evidence only, not an executable inventory-policy opt-in or proof of a holding's posted balance. P is a nonnegative, already-booked decimal exactly representable in the pinned policy. For cumulative fractions 0 <= f0 <= f1 <= 1, beforeTarget = P*f0, afterTarget = P*f1, and postedAmount = Q(afterTarget)-Q(beforeTarget). Shares from zero through one telescope exactly to P, including zero-value holdings. P must come from authenticated posted history, not Q(current exact basis plus allowance). The two quantization residuals describe targets derived from P, not a claim that postedAmount independently rounds the economic issue cost. Policy/anchor changes require explicit transitions and may not reinterpret past shares. A positive physical reduction may have zero postedAmount, including terminal depletion after prior rounding exhausted P. ACC-018 still forbids zero-valued canonical postings. Executable integration therefore requires an explicit versioned quantity-only lot/ownership effect with ordinary command authorization, period admission, immutable allocation lineage and revision/replay semantics; it must not fabricate a nonzero cent, skip the quantity reduction, or bypass the nonzero-posting invariant. That effect and its command topology are not implemented by this arithmetic item. */
            item postedTotal : BookValue;
            attribute beforeFraction : Semantics::ExactRational;
            attribute afterFraction : Semantics::ExactRational;
            item beforeTarget : ExactBookAmount;
            item afterTarget : ExactBookAmount;
            item beforeQuantization : QuantizationResult;
            item afterQuantization : QuantizationResult;
            item postedAmount : BookValue;
            item policy : QuantizationPolicy;
        }

        item def InventoryCostPool {
            doc /* Explicit same-book pool membership prevents a global average from silently omitting or importing holdings. */
            attribute id : Semantics::Identifier;
            attribute scope : Semantics::PolicyScope;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item commodity : Commodity;
            item memberAccount : Account[1..*];
        }

        enum def InventoryPostedAlgorithm { cumulativePostedInventoryV1; }
        enum def InventoryPostedMovementKind {
            acquisition; disposal; transferOut; transferIn;
            valueAdjustment; policyReanchor; legacyAdoption;
        }
        item def InventoryPostedCoordinate {
            attribute bookId : Semantics::Identifier;
            attribute holdingId : Semantics::Identifier;
            attribute lotId : Semantics::Identifier;
            attribute accountId : Semantics::Identifier;
            attribute unitsCommodityId : Semantics::Identifier;
            attribute functionalCommodityId : Semantics::Identifier;
            attribute dimensionMemberIds : Semantics::Identifier[0..*];
            doc /* Exact canonical dimension selection is part of posted ownership,
            not a display annotation. Account equality alone cannot authorize
            coalescing. Functional posted currency is not inferred from a source
            document currency or silently substituted for historical basis currency. */
        }
        item def InventoryPostedArtifactReference {
            attribute id : Semantics::Identifier;
            attribute contentHash : Semantics::ContentHash;
            attribute bookId : Semantics::Identifier;
            attribute effectKey : Semantics::EffectKey;
            attribute artifactOrdinal : Natural;
            attribute bookRevision : Natural;
            assert constraint committedArtifactOrigin { artifactOrdinal > 0 and bookRevision > 0 }
            doc /* Bounded immutable locator plus full content hash. Resolve the
            referenced typed artifact at its creating effect/ordinal and verify
            book, kind, ID and hash. Do not recursively embed predecessor histories
            in the active projection or accept a hash as proof that a source exists.
            Ownership artifact ordinals are one-based within their owning effect;
            revision zero has no committed ownership artifacts. */
        }
        item def InventoryPostedAnchorReference :> InventoryPostedArtifactReference;
        item def InventoryPostedPositionReference :> InventoryPostedArtifactReference {
            doc /* id is the holding ID. The full hash and origin identify the exact
            immutable version of that keyed position, not whichever version is
            current when the reference is read. */
        }
        item def InventoryPostedMovementReference :> InventoryPostedArtifactReference;

        item def InventoryPostedValueBudget {
            attribute basis : Semantics::ExactDecimal;
            attribute allowance : Semantics::ExactDecimal;
            doc /* Prospective component-bearing ownership contract. These are
            authenticated POSTED components, not rounded economic estimates.
            basis >= 0, allowance <= 0 and carrying = basis + allowance >= 0;
            both components are exactly representable in the pinned policy.
            Existing anchor/receipt bytes do not gain these fields implicitly.
            A component-bearing successor requires a new explicit artifact and
            command implementation version with complete predecessor authority.
            An old zero-allowance ownership epoch may supply basis = its actual
            posted budget only when authenticated history proves that attribution.
            Legacy unowned stock still requires governed verified adoption. */
        }

        item def InventoryPostedValueAllocation {
            item consumed : InventoryPostedValueBudget;
            item remaining : InventoryPostedValueBudget;
            item carryingConsumed : BookValue;
            item carryingRemaining : BookValue;
            item allowanceProof : CumulativePostedShare;
            item carryingProof : CumulativePostedShare;
            doc /* Keep the existing cumulative net carrying rule unchanged.
            For original posted basis B, signed allowance A and P = B + A,
            allocate nonnegative P and -A separately over the same original-epoch
            fractions f0 through f1. Signed allowance consumption is minus the
            cumulative share of -A; basis consumption is carrying consumption
            minus signed allowance consumption. Derive remainders from cumulative
            targets through f1. Never independently round B, P and A: with
            B = .03 and P = .02, f0 = .2 and f1 = .3 under half-even,
            independently rounded B changes by zero while P changes by .01,
            inventing a positive destination allowance. The specified two-budget
            rule consumes basis .01, allowance zero and carrying .01 instead.
            Every movement/remainder has nonnegative basis/carrying and nonpositive
            allowance. Terminal depletion consumes B, A and P exactly. Transfers
            inherit the exact component shares, with no destination rerounding.
            These arithmetic results do not authorize any source or transition. */
        }

        item def InventoryPostedAllowanceChange {
            item before : InventoryPostedValueBudget;
            item 'after' : InventoryPostedValueBudget;
            attribute economicChange : Semantics::ExactRational;
            attribute postedChange : Semantics::ExactDecimal;
            attribute postedMinusEconomic : Semantics::ExactRational;
            item proof : CumulativePostedShare;
            doc /* Prospective write-down/reversal arithmetic using authenticated
            current components after quantity consumption. For exact current
            carrying E and negative write-down d, postedChange =
            -Q(P * (-d/E)); require -E <= d < 0. For exact remaining allowance
            L < 0 and reversal d, postedChange = Q((-A) * d/(-L)); require
            0 < d <= -L. Keep posted basis unchanged and set after allowance to
            before allowance + postedChange. Thus full write-down consumes only
            actual posted carrying and full reversal restores only remaining
            posted allowance, never amounts already consumed by disposal.
            Retain postedMinusEconomic = postedChange - economicChange explicitly;
            it is not implicit permission to insert a rounding posting.
            A holding with exact carrying .006 but posted budget zero writes down
            to zero without a fake cent; exact .005 with posted budget .01 writes
            down that actual .01 and reverses no more than .01. Source economics,
            complete policy, scope/date/period, identities, journal topology,
            successor anchors, strict codecs and replay must be admitted together.
            Zero money still requires an immutable value effect and economic
            allowance change, not an invented quantity allocation or posting.
            This typed arithmetic provides the exact component budget allocation for ACC-039.7 through .9. */
        }

        item def InventoryPostedAnchor {
            attribute id : Semantics::Identifier;
            attribute algorithm : InventoryPostedAlgorithm;
            attribute algorithmVersion : Semantics::SemanticVersion;
            attribute quantity : Semantics::ExactRational;
            attribute postedBudget : Semantics::ExactDecimal;
            item postedValue : InventoryPostedValueBudget[0..1];
            attribute effectKey : Semantics::EffectKey;
            attribute artifactOrdinal : Natural;
            attribute bookRevision : Natural;
            attribute contentHash : Semantics::ContentHash;
            item coordinate : InventoryPostedCoordinate;
            item inventoryPolicy : PolicyReference;
            item quantizationPolicy : QuantizationPolicy;
            item predecessorPosition : InventoryPostedPositionReference[0..1];
            item sourcePosting : CanonicalPostingReference[0..*];
            item incomingMovement : InventoryPostedMovementReference[0..*];
            item evidence : SourceEvidence[0..*];
            assert constraint positiveQuantity { quantity.numerator > 0 and quantity.denominator > 0 }
            assert constraint nonnegativeBudget { postedBudget.coefficient >= 0 }
            assert constraint committedAnchorOrigin { artifactOrdinal > 0 and bookRevision > 0 }
            doc /* Immutable ownership epoch under an explicitly admitted command.
            The budget is actual posted carrying value, exactly representable
            under the complete pinned policy. Source postings and incoming movements
            are a complete non-duplicated attribution set; source debits cannot be
            counted twice. A successor closes the one previous position for this
            holding and sums its actual remainder with accepted incoming or governed
            adjustment amounts. Predecessor and source references are not optional
            authority: each transition kind specifies its required sources. A free
            acquisition has explicit governed source evidence and zero posted budget,
            not an invented zero journal posting. Legacy adoption additionally needs
            approved reconciliation through a pinned head; a proposal is insufficient.
            Positive quantity with zero budget is valid. Depletion retains a final
            position on the old positive-quantity anchor, not a zero-quantity anchor. */
            doc /* Artifact version 1.0.0 forbids postedValue and keeps its exact
            prior bytes and arithmetic. Version 1.1.0 requires postedValue, with
            basis + allowance exactly equal to postedBudget. Reductions keep the
            existing net cumulative rule and derive component shares using
            InventoryPostedValueAllocation. A transfer inherits those components
            in a version 1.1.0 destination anchor and rejects a destination policy
            that cannot represent both exactly. It also carries the exact economic
            allowance, without zeroing it. Codec support for this bounded artifact
            is not canonical value-adjustment command admission or legacy adoption. */
        }
        item def InventoryPostedPosition {
            attribute holdingId : Semantics::Identifier;
            attribute consumedQuantity : Semantics::ExactRational;
            attribute consumedPosted : Semantics::ExactDecimal;
            attribute contentHash : Semantics::ContentHash;
            item anchor : InventoryPostedAnchorReference;
            attribute originMovementId : Semantics::Identifier;
            attribute originEffectKey : Semantics::EffectKey;
            attribute originArtifactOrdinal : Natural;
            attribute originBookRevision : Natural;
            assert constraint committedPositionOrigin { originArtifactOrdinal > 0 and originBookRevision > 0 }
            assert constraint nonnegativeConsumption {
                consumedQuantity.numerator >= 0 and consumedQuantity.denominator > 0 and consumedPosted.coefficient >= 0
            }
            doc /* Current keyed projection, with its immutable after-image retained
            by the movement at the origin locator. The position hash binds the
            locator, not the containing movement's hash: embedding that hash here
            would create an impossible movement-to-position-to-movement hash cycle.
            Resolve the origin against the authenticated effect and compare the
            complete after-image; a locator alone is not authenticity. Resolve the
            exact historical anchor version, never a replacement current anchor.
            Current holding, position, anchor and origin reads must share one
            authenticated pinned head. Recheck that head around source reads and
            before returning an evaluated candidate, including outcome-only changes;
            publication still requires atomic compare-and-swap against the same
            head. Infrastructure failure or invalidation is not a retained semantic
            rejection. Resolve each original touched holding once, keep immutable
            copies and derive same-command successors internally. Resolve the
            anchor; require consumedQuantity <= anchor
            quantity and consumedPosted = Q(anchorBudget*consumedQuantity/anchorQuantity).
            Remaining quantity and posted budget are derived by subtraction, not
            independently mutable counters. Exact holding quantity must agree with
            the derived remainder. Historical basis and allowance remain separate.
            Depleted positions and stable identities remain retained. */
        }
        item def InventoryQuantityAllocation {
            attribute id : Semantics::Identifier;
            attribute holdingId : Semantics::Identifier;
            attribute lotId : Semantics::Identifier;
            attribute quantity : Semantics::ExactRational;
            attribute historicalBasis : Semantics::ExactRational;
            attribute valuationAllowance : Semantics::ExactRational;
            attribute carryingAmount : Semantics::ExactRational;
            attribute basisCommodityId : Semantics::Identifier;
            item derivation : DerivationRecord;
            doc /* Canonical economic allocation independent of whether money moved.
            It has no mandatory journal posting reference. Source closure derives it
            from the same admitted lot selection and exact before-holding state as
            the posted movement. Functional carrying comparisons require an explicit
            same-currency amount or governed valuation evidence, not unit erasure. */
            doc /* Ownership selection derives quantities from the
            complete authenticated policy pool under the applicable supported
            costing method; a caller's allocation amounts or partial layer list
            are not authority. Weighted-average quantities consume the same
            fraction of each source holding. Each allocation still retains that
            source's own proportional historical basis and allowance, rather than
            replacing individual lot history with a per-layer average. The total
            ordinary basis must equal the cost calculation and ordinary plus
            provisional quantity must equal the request. A provisional remainder
            needs its separate admitted effects, never an invented ordinary anchor.
            Current-pool selection alone does not prove historical availability:
            backdated admission requires its explicit chronology, provisional,
            recosting or restatement source closure. Sorting by acquisition time
            is not permission to use future state at an earlier accounting date. */
        }
        abstract item def InventoryPostedMovement {
            attribute id : Semantics::Identifier;
            attribute kind : InventoryPostedMovementKind;
            attribute effectKey : Semantics::EffectKey;
            attribute artifactOrdinal : Natural;
            attribute bookRevision : Natural;
            attribute accountingDate : Semantics::LocalDate;
            attribute postedAmount : Semantics::ExactDecimal;
            attribute contentHash : Semantics::ContentHash;
            item coordinate : InventoryPostedCoordinate;
            item fiscalPeriod : FiscalPeriod;
            item beforePosition : InventoryPostedPositionReference[0..1];
            item afterPosition : InventoryPostedPosition;
            item quantityAllocation : InventoryQuantityAllocation[0..1];
            item reductionProof : CumulativePostedShare[0..1];
            item acquisitionProof : CumulativePostedShare[0..1];
            item incomingSource : InventoryPostedMovementReference[0..*];
            assert constraint committedMovementOrigin { artifactOrdinal > 0 and bookRevision > 0 }
            doc /* Base shape is not an independently admissible variant. Every
            persisted movement is exactly journal-linked or quantity-only. Disposal
            and transfer-out require an allocation, before position and cumulative
            proof, including when their postedAmount is zero. Their after position
            advances by the allocated quantity; its posted delta exactly equals the
            signed share. Transfer-in inherits the opposite source shares without
            destination rerounding. Transition identity and complete before/after
            hashes prevent duplicate consumption; command CAS and outcome retention
            remain mandatory. Monetary value changes without quantity use an explicit
            governed successor anchor, not a fictional quantity allocation. */
            doc /* Acquisition has no before-position or reducing quantity
            allocation. A complete acquisition group has one inventory coordinate
            and attributes its actual admitted positive source posting across new
            holdings by cumulative exact carrying-value proportions in canonical
            holding-ID order. Cumulative quantized differences conserve that whole
            source posting; independent per-holding rounding is not admissible.
            Zero carrying-weight members receive zero money. A positive source
            posting with zero total carrying weight is ambiguous and rejects.
            A no-posting group requires complete governed acquisition evidence and
            a zero quantized aggregate carrying target. When total carrying is
            zero, quantity proportions give deterministic zero-money proofs.
            Each anchor retains its assigned posted share and full policy; the
            acquisition proof retains the common posted total and cumulative
            fractions. The origin after-position has zero consumption. New anchors
            are ordered first, then origin movements, each phase in holding-ID
            order. Zero-money members have no movement posting reference even
            when they share provenance from a real group source posting. */
        }
        item def JournalLinkedInventoryMovement :> InventoryPostedMovement {
            item posting : CanonicalPostingReference;
            assert constraint nonzeroMoney { postedAmount.coefficient != 0 }
            doc /* The actual journal posting has the same book/account/currency/
            dimensions and signed amount attributable to this movement. Several
            movements may share one posting only with a complete unique attribution
            set whose sum equals that posting. Do not require each share to equal the
            entire posting. For an admitted disposal/transfer-out operation group,
            inventory posting units and historical basis cover ALL group allocations,
            including quantity-only members; its money is the sum of nonzero shares.
            Group membership is derived from the complete canonical command, not
            inferred by account equality or a caller's partial attribution proposal.
            A posting is owned by one complete operation group, not independently
            reused by several groups. Group members receive artifact ordinals in
            canonical holding-ID order within canonical operation order. */
        }
        item def QuantityOnlyInventoryMovement :> InventoryPostedMovement {
            assert constraint zeroMoney { postedAmount.coefficient == 0 }
            doc /* No posting, journal ID, posting ordinal or fabricated canonical
            posting reference is carried. A positive quantity reduction can have zero
            money even at terminal depletion. This is a committed inventory effect,
            not a skipped command, no-op outcome or an exception to ACC-018.
            In a mixed reduction group its quantity and historical basis may
            contribute to the group's real inventory posting, but zero money still
            forbids a posting reference on this movement. An all-zero reduction
            group has no inventory posting; other command effects can independently
            require journals and must not be omitted on that account. */
        }
        item def LotChangesEffect {
            item newLot : Lot[0..*] ordered;
            item afterHolding : LotHolding[0..*] ordered;
            attribute contentHash : Semantics::ContentHash;
            doc /* Explicit owned-command version 1.2.0 persists only new lots
            and exact touched-holding after-images, alongside its complete
            immutable ownership effect. Unmentioned rows and legacy allocations
            are preserved. Existing holdings retain their original projection
            order; new holdings append in after-image order. Full hashes bind all
            changed row contents, never an omitted historical population. Shared
            ownership preparation proves source identity, uniqueness and exact
            after-images before publication. History validation reexecutes that
            preparation against the pre-revision state, then folds each change.
            A recomputed hash cannot authorize invented or omitted stock.
            Versions 1.0.0 and 1.1.0 keep their whole lot-state effects unchanged.
            Mixed-version replay must preserve canonical historical bytes. */
        }

        item def InventoryOwnershipEffect {
            attribute effectKey : Semantics::EffectKey;
            attribute bookRevision : Natural;
            attribute contentHash : Semantics::ContentHash;
            item newAnchor : InventoryPostedAnchor[0..*];
            item journalLinkedMovement : JournalLinkedInventoryMovement[0..*];
            item quantityOnlyMovement : QuantityOnlyInventoryMovement[0..*];
            assert constraint committedOwnershipRevision { bookRevision > 0 }
            doc /* Complete touched-set delta under one BookCommitIntent.
            Ownership effects retained by revision history are immutable authority.
            Current positions and the economic-allocation catalog are projections
            of those movements, not additional independently mutable authorities.
            Each projected allocation is exactly the movement's allocation; its
            lookup origin is the containing movement's bounded effect locator.
            This avoids an allocation hash containing the movement hash that in
            turn contains that allocation. Legacy LotAllocation.reducingSource
            remains mandatory for its old wire shape. InventoryQuantityAllocation
            uses the explicit ownership movement, not an optionalized legacy
            posting ID or an invented zero-value journal. Recovery/close must
            reproduce both families and all positions from the same full prefix.
            Every after-position hash, exact lot allocation and new anchor is
            recomputed from authenticated before state, admitted policy and actual
            source/effect data. Unique movement/allocation/anchor identities and
            ordinals are permanent. At least one material ownership/quantity change
            is required; an empty effect cannot manufacture a revision. Full history
            arrays do not belong inside each touched row. The indexed implementation
            must fetch required anchors and positions by verified point references
            and prove complete selection/coalescing groups independently. Hash
            dependencies must be acyclic: source postings, outgoing reductions,
            successor anchors, incoming after-positions/movements, then the effect.
            A position contains only its origin locator, never the hash of the
            movement containing it. Same-command source references resolve only
            to already finalized artifacts; future or cyclic references reject.
            Artifact order follows canonical command operation order, then canonical
            holding-ID order within each dependency phase. It cannot depend on
            storage iteration, locale collation or client arrival order. Anchor and
            movement ordinals are unique within the ownership effect; position
            after-images use their containing movement's origin. Within an atomic
            command, later operations consume earlier computed holding/position
            after-images rather than independently restarting from the original
            source rows. The original touched sources are resolved once per holding;
            their internal successors are produced by the kernel, not supplied as
            replacement authority by the caller. Posting/reference identity claims
            and journal source consistency are checked across the whole effect,
            not merely within each independently balanced operation group. Failure
            of any operation discards the entire candidate delta. */
            doc /* Acquisition and reduction operations share one candidate and
            artifact ordinal sequence. An earlier acquisition supplies its newly
            computed anchor, holding and origin after-image directly to later
            reductions; storage must not supply a stand-in same-command position.
            A reduction before creation cannot borrow a later acquisition's state.
            Original externally touched sources and new rows remain distinct:
            original rows must predate the revision and be used; new lot, holding,
            anchor and movement IDs must pass complete permanent-identity admission.
            Avoiding a source read for a newly created row is not evidence of ID
            absence. Group posting/reference claims and journal source consistency
            are checked across acquisition and reduction kinds together. New lots
            and final exact holdings belong in the same complete commit as their
            immutable ownership anchors and movements; a zero final balance cannot
            justify omitting the retained acquisition or intermediate movement. */
        }

        item def InventoryCostPolicy {
            doc /* A supplied capability-gated policy controls ordinary lot reduction and the exceptional treatment of an issue that precedes its cost-bearing receipt. */
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute lotSelection : Semantics::LotSelectionMethod;
            attribute shortageTreatment : Semantics::InventoryShortageTreatment;
            attribute provisionalBasisMethod : Semantics::ProvisionalBasisMethod[0..1];
            attribute algorithmVersion : Semantics::SemanticVersion;
            attribute postedAlgorithm : InventoryPostedAlgorithm[0..1];
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item pool : InventoryCostPool;
            item capability : PolicyCapability;
            item featureCapability : AccountingFeatureCapability;
            item quantizationPolicy : QuantizationPolicy;
            item policyProvisionalRate : TransactionPrice[0..1];
        }

        item def InventoryValueAdjustmentPolicy {
            doc /* Governs which later value changes may affect historical lot basis, recognized cost, or a separate valuation allowance. The policy never permits an adapter to rewrite a lot or disposal. Algorithm 1.0.1 validates the complete book population while scoping live allocation targets to inventoryAccount; other valid accounts do not block an adjustment. Algorithm 1.0.0 retains the historical whole-population account restriction for exact replay. Algorithm 1.0.2 additionally compares allocation identities as separate raw lot/optional-holding coordinates, distinguishing an absent holding from every valid holding identifier. Delimiters in valid identifiers cannot alias another allocation. Versions 1.0.0 and 1.0.1 retain their original delimiter-based duplicate decisions for replay. New deployments select 1.0.2; existing books upgrade by a prospective configuration command with a new policy version and matching capability implementationVersion. Unknown algorithms are not executable, and old commands, rejections, effects and hashes never change. */
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute algorithmVersion : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute allowedKind : Semantics::InventoryValueAdjustmentKind[1..*];
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item inventoryCostPolicy : InventoryCostPolicy;
            item quantizationPolicy : QuantizationPolicy;
            item featureCapability : AccountingFeatureCapability;
            item inventoryAccount : Account;
            item recognizedCostAccount : Account;
            item adjustmentAccount : Account;
        }

        item def ProvisionalInventoryLayer {
            doc /* An immutable temporary cost-bearing fact. Resolution status and remaining quantity derive only from appended recosting effects. */
            attribute id : Semantics::Identifier;
            attribute openedAt : Semantics::Instant;
            attribute issueEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item policy : InventoryCostPolicy;
            item issueSource : CanonicalPostingReference;
            item derivation : DerivationRecord;
        }

        item def InventoryRecostingSource {
            doc /* Exact share of one later receipt used to resolve a provisional quantity. */
            item receiptLot : Lot;
            item allocatedQuantity : Quantity;
            item allocatedTotalBasis : CostBasis;
        }

        item def InventoryRecosting {
            doc /* An immutable partial or complete resolution of a provisional layer. Prior journals and the layer are never rewritten. */
            attribute id : Semantics::Identifier;
            attribute resolvedAt : Semantics::Instant;
            attribute adjustmentEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item layer : ProvisionalInventoryLayer;
            item source : InventoryRecostingSource[1..*];
            item adjustment : QuantizationResult;
            item derivation : DerivationRecord;
        }

        item def InventoryValueAdjustmentAllocation {
            doc /* One exact supplied-and-validated share. Basis changes apply to remaining historical cost; recognized-cost changes catch up quantities already disposed; valuation changes remain a separate allowance. */
            attribute ordinal : Natural;
            item lot : Lot;
            item holding : LotHolding[0..1];
            item remainingBasisChange : ExactBookAmount;
            item recognizedCostChange : ExactBookAmount;
            item remainingValuationAllowanceChange : ExactBookAmount;
        }

        item def InventoryValueAdjustment {
            doc /* Immutable later inventory measurement. Direct costs, rebates, and overhead adjust historical basis; write-downs and reversals adjust only the separately retained valuation allowance. */
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::InventoryValueAdjustmentKind;
            attribute effectiveOn : Semantics::LocalDate;
            attribute generatedEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item policy : InventoryValueAdjustmentPolicy;
            item exactSourceAmount : ExactBookAmount;
            item 'allocation' : InventoryValueAdjustmentAllocation[1..*];
            item bookedAdjustment : QuantizationResult;
            item evidence : SourceEvidence[1..*];
            item derivation : DerivationRecord;
        }

        item def SettlementScope {
            doc /* Stable accounting identity for the counterparty and control account without importing customer or vendor workflow data. */
            attribute id : Semantics::Identifier;
            attribute externalPartyId : Semantics::Identifier;
            item book : Book;
            item controlAccount : Account;
        }

        item def OpenItem {
            doc /* An immutable receivable, payable, or credit recognition. Outstanding quantities derive from the allocation graph. */
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::OpenItemKind;
            attribute recognizedOn : Semantics::LocalDate;
            attribute dueOn : Semantics::LocalDate[0..1];
            attribute recognitionEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item settlementScope : SettlementScope;
            item recognitionSource : CanonicalPostingReference;
            item derivation : DerivationRecord;
        }

        item def Settlement {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::SettlementKind;
            attribute settledAt : Semantics::Instant;
            attribute settlementEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item settlementScope : SettlementScope;
            item settlementSource : CanonicalPostingReference;
            item derivation : DerivationRecord;
        }

        item def SettlementAllocation {
            doc /* An immutable exact edge. Open-item carrying value, settlement measurement, open-item denomination, and settlement denomination are conserved independently; any difference is derived and bound to one real generated effect in the same command. */
            attribute id : Semantics::Identifier;
            attribute appliedAt : Semantics::Instant[0..1];
            attribute realizedExchangeEffectKey : Semantics::EffectKey[0..1];
            attribute contentHash : Semantics::ContentHash;
            item openItem : OpenItem;
            item settlement : Settlement;
            item allocatedOpenItemBookValue : BookValue;
            item allocatedSettlementBookValue : BookValue;
            item allocatedOpenItemQuantity : Quantity;
            item allocatedSettlementQuantity : Quantity[0..1];
            item settlementMeasurement : QuantizationResult;
            item realizedExchangeDifference : QuantizationResult[0..1];
            item valuationPath : ValuationPath[0..1];
            item derivation : DerivationRecord;
        }

        item def AccountingBasisRule {
            attribute ordinal : Natural;
            attribute eventKind : Semantics::AccountingBasisEventKind;
            attribute treatment : Semantics::AccountingBasisTreatment;
            attribute contentHash : Semantics::ContentHash;
        }

        item def AccountingBasisPolicy {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute basis : Semantics::AccountingBasis;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item quantizationPolicy : QuantizationPolicy;
            item featureCapability : AccountingFeatureCapability;
            item rule : AccountingBasisRule[1..*];
        }

        item def AccountingBasisSourceEvent {
            doc /* Complete typed classification of one source amount. Exactly the lineage applicable to eventKind is present; no account-name inference is permitted. */
            attribute ordinal : Natural;
            attribute eventKind : Semantics::AccountingBasisEventKind;
            attribute accountingDate : Semantics::LocalDate;
            item source : CanonicalPostingReference;
            item exactSourceAmount : ExactBookAmount;
            item openItem : OpenItem[0..1];
            item settlement : Settlement[0..1];
            item settlementAllocation : SettlementAllocation[0..*];
            item taxDetermination : TaxDetermination[0..1];
            item inventoryRecosting : InventoryRecosting[0..1];
            item allocationRecognition : AllocationRecognition[0..1];
            item remeasurementResult : RemeasurementResult[0..1];
        }

        item def AccountingReadSnapshot {
            doc /* Complete immutable input to a read-side accounting projection; the compiler performs no repository reads. */
            attribute throughBookRevision : Natural;
            attribute throughPostingSequence : Natural;
            attribute contentHash : Semantics::ContentHash;
            attribute policyEffectiveAt : Semantics::Instant;
            item population : ReportPopulation;
            item configurationSnapshot : BookConfigurationSnapshot;
            item journal : ValidatedBookedJournal[0..*];
            item sourcePosting : CanonicalPostingReference[0..*];
            item sourceEvent : AccountingBasisSourceEvent[0..*];
            item openItem : OpenItem[0..*];
            item settlement : Settlement[0..*];
            item settlementAllocation : SettlementAllocation[0..*];
            item inventoryValueAdjustment : InventoryValueAdjustment[0..*];
            item inventoryRecosting : InventoryRecosting[0..*];
            item allocationRecognition : AllocationRecognition[0..*];
            item taxDetermination : TaxDetermination[0..*];
            item remeasurementResult : RemeasurementResult[0..*];
        }

        item def AccountingBasisProjectionEntry {
            attribute ordinal : Natural;
            attribute treatment : Semantics::AccountingBasisTreatment;
            item sourceEvent : AccountingBasisSourceEvent;
            item includedExactAmount : ExactBookAmount;
            item excludedExactAmount : ExactBookAmount;
            item recognizedAmount : QuantizationResult[0..1];
            item settlementAllocation : SettlementAllocation[0..*];
        }

        item def AccountingBasisReconciliation {
            doc /* Exact proof that every source amount is classified once, included plus excluded equals source, and quantized values plus residuals equal included exact amounts. */
            attribute contentHash : Semantics::ContentHash;
            item sourceExactTotal : ExactBookAmount;
            item includedExactTotal : ExactBookAmount;
            item excludedExactTotal : ExactBookAmount;
            item projectedExactTotal : ExactBookAmount;
            item projectedBookValueTotal : BookValue;
            item quantizationResidualTotal : ExactBookAmount;
        }

        item def AccountingBasisProjection {
            doc /* A reproducible read model over one complete source snapshot, never an alternate journal or canonical mutation. */
            attribute id : Semantics::Identifier;
            attribute basis : Semantics::AccountingBasis;
            attribute contentHash : Semantics::ContentHash;
            item sourceSnapshot : AccountingReadSnapshot;
            item policy : AccountingBasisPolicy;
            item projectionEntry : AccountingBasisProjectionEntry[0..*];
            item reconciliation : AccountingBasisReconciliation;
            item derivation : DerivationRecord[0..*];
        }

        item def MonetaryClassificationRule {
            attribute ordinal : Natural;
            attribute classification : Semantics::MonetaryClassification;
            item account : Account;
        }

        item def MonetaryClassificationPolicy {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item featureCapability : AccountingFeatureCapability;
            item rule : MonetaryClassificationRule[1..*];
        }

        item def MonetaryPosition {
            attribute id : Semantics::Identifier;
            attribute throughBookRevision : Natural;
            item book : Book;
            item classificationPolicy : MonetaryClassificationPolicy;
            item classificationRule : MonetaryClassificationRule;
            item source : CanonicalPostingReference;
            item openItem : OpenItem[0..1];
            item carryingBookValue : BookValue;
            item denomination : Quantity;
        }

        item def RemeasurementPolicy {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute reversalRequired : Boolean;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item classificationPolicy : MonetaryClassificationPolicy;
            item valuationPolicy : ValuationPolicy;
            item quantizationPolicy : QuantizationPolicy;
            item featureCapability : AccountingFeatureCapability;
            item gainAccount : Account;
            item lossAccount : Account;
        }

        item def RemeasurementResult {
            doc /* One immutable realized or unrealized difference linked to its exact source and intended journal effect. */
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::RemeasurementKind;
            attribute effectiveOn : Semantics::LocalDate;
            attribute adjustmentEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item position : MonetaryPosition;
            item settlementAllocation : SettlementAllocation[0..1];
            item policy : RemeasurementPolicy;
            item valuationPath : ValuationPath;
            item difference : QuantizationResult;
            item derivation : DerivationRecord;
        }

        item def RemeasurementReversal {
            attribute id : Semantics::Identifier;
            attribute reversalEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item original : RemeasurementResult;
            item exactReversalOf : ValidatedBookedJournal;
            item derivation : DerivationRecord;
        }

        item def AllocationSchedulePolicy {
            doc /* Explicit postingAlgorithm cumulative-posted-allocation-v1 together with algorithmVersion 1.1.0 opts into a required cumulative plan. A version string alone never opts in: all policies without postingAlgorithm retain independent per-recognition rounding and omit the plan, including historical policies that already used version 1.1.0. The explicit marker with another version is inadmissible. A new policy may not reinterpret a legacy schedule or a retained recognition. Conversion requires a separate verified posted-history transition; until provided it rejects. Cumulative revisions retain the posting accounts and complete quantization policy. */
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute algorithmVersion : Semantics::SemanticVersion;
            attribute postingAlgorithm : String[0..1];
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute method : Semantics::AllocationMethod;
            attribute convention : Semantics::AllocationConvention;
            attribute frequency : Semantics::AllocationFrequency;
            attribute decliningRate : Semantics::ExactRational[0..1];
            attribute expectedUsage : Semantics::ExactRational[0..1];
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item quantizationPolicy : QuantizationPolicy;
            item featureCapability : AccountingFeatureCapability;
            item allocationAccount : Account;
            item contraAccount : Account;
        }

        item def AllocationUsage {
            attribute ordinal : Natural;
            attribute accountingDate : Semantics::LocalDate;
            attribute exactUsage : Semantics::ExactRational;
        }

        item def ScheduledAllocation {
            attribute ordinal : Natural;
            attribute accountingDate : Semantics::LocalDate;
            item amount : QuantizationResult;
        }

        item def AllocationPostingPlanEntry {
            doc /* Immutable ordinal allocation. postedAmount is the difference between this cumulativeQuantization decimal and the preceding ordinal's decimal (zero before ordinal one), not a separately rounded exactAmount. The cumulative target follows the exact installment proportions of the posted allocable basis. exactToPostedDifference is explicit economic-to-book reconciliation, not an ordinary per-row rounding proof. */
            attribute ordinal : Natural;
            attribute accountingDate : Semantics::LocalDate;
            item exactAmount : ExactBookAmount;
            item cumulativeTarget : ExactBookAmount;
            item cumulativeQuantization : QuantizationResult;
            item postedAmount : BookValue;
            item exactToPostedDifference : ExactBookAmount;
        }

        item def AllocationPostingPlan {
            doc /* Prospective cumulative-posted-allocation-v1 arithmetic contract, not a grant of command authority. Let A = exactSourceBasis - exactResidualValue, B = postedSourceBasis, Rb = quantize(exactResidualValue).decimal and T = B - Rb. For exact cumulative installments E_k, cumulativeTarget_k = T * E_k / A, with zero targets only when A and T are both zero. postedAmount_k = Q(cumulativeTarget_k) - Q(cumulativeTarget_(k-1)); the initial quantized cumulative amount is zero. Complete posted amounts sum exactly to T. Ordinals are contiguous, dates strictly increasing, exact amounts nonnegative, exact amounts sum to A, B is representable in the pinned policy, and B and T are nonnegative. A zero exact schedule with nonzero T requires explicit rounding settlement, not fabricated usage or division by zero. Planning is bounded by the executable installment limit. The complete captured policy, source bases, targets, proofs and rows are immutable and content-hashed. */
            attribute algorithmVersion : String;
            attribute contentHash : Semantics::ContentHash;
            item exactSourceBasis : ExactBookAmount;
            item exactResidualValue : ExactBookAmount;
            item postedSourceBasis : BookValue;
            item residualQuantization : QuantizationResult;
            item quantizationPolicy : QuantizationPolicy;
            item installment : AllocationPostingPlanEntry[1..*];
        }

        item def AllocationSchedule {
            doc /* An immutable exact schedule pinned to its complete policy and canonical source. Recognition and prospective revision are later appended effects and never mutate this schedule. The explicit cumulative policy discriminator and algorithm 1.1.0 require exactly one completely recomputed postingPlan whose posted source basis is representable and matches sourceBasis; policies without that discriminator must omit postingPlan. A successor's source basis is its predecessor's verified posted carrying amount plus its booked adjustment, while the canonical source reference retains the original root posting. Successive revisions preserve this immutable chain. */
            attribute id : Semantics::Identifier;
            attribute startsOn : Semantics::LocalDate;
            attribute endsOn : Semantics::LocalDate;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item policy : AllocationSchedulePolicy;
            item source : CanonicalPostingReference;
            item sourceBasis : BookValue;
            item residualValue : BookValue;
            item exactAllocableBasis : ExactBookAmount;
            item scheduledAllocation : ScheduledAllocation[1..*];
            item postingPlan : AllocationPostingPlan[0..1];
            item derivation : DerivationRecord;
        }

        item def AllocationRecognition {
            doc /* Cumulative recognition posts the precomputed ordinal amount exactly, including its signed contra amount, under the schedule's retained quantization policy. A conflicting active quantization policy rejects rather than rerounding. Restoration reconciles actual posting IDs, accounts, amounts, units, accounting date and policy hash against the independently recomputed plan; a plan hash alone is insufficient. */
            attribute id : Semantics::Identifier;
            attribute scheduleOrdinal : Natural;
            attribute recognitionEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item schedule : AllocationSchedule;
            item derivation : DerivationRecord;
        }

        item def AllocationScheduleRevision {
            doc /* Immutable prospective lifecycle effect. Prior recognitions remain canonical; future ordinals at or after effectiveOn derive from the successor schedule or become permanently inadmissible. Any impairment, disposal, or termination adjustment retains the exact supplied amount and its complete quantization proof. */
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::AllocationScheduleChangeKind;
            attribute effectiveOn : Semantics::LocalDate;
            attribute generatedEffectKey : Semantics::EffectKey[0..1];
            attribute contentHash : Semantics::ContentHash;
            item original : AllocationSchedule;
            item priorRecognition : AllocationRecognition[0..*];
            item recognizedToDate : ExactBookAmount;
            item carryingAmountAtRevision : ExactBookAmount;
            item postedRecognizedToDate : ExactBookAmount[0..1];
            item postedCarryingAmountAtRevision : ExactBookAmount[0..1];
            item revisedResidualValue : BookValue;
            item exactAdjustmentAmount : ExactBookAmount[0..1];
            item bookedAdjustment : QuantizationResult[0..1];
            item successor : AllocationSchedule[0..1];
            item policy : AllocationSchedulePolicy;
            item evidence : SourceEvidence[1..*];
            item derivation : DerivationRecord;
        }

        item def TaxPolicy {
            doc /* Supplied deterministic component policy. Components are evaluated in compoundOrdinal order; compoundsOn must be acyclic and reference earlier components. The kernel does not discover jurisdiction, rates, nexus, filing status, or forms.
            The prospective structural-tax-groups-v1 groupingAlgorithm requires
            algorithmVersion and capability implementationVersion 1.1.0. Document
            rounding groups compare separate policy ID, policy version and
            component ID coordinates. Distinct policies/components/versions must
            never share rounding or recoverability accumulators through delimiter
            aliases. Marked groups and unmarked legacy groups occupy disjoint
            identities, even when user identifiers contain punctuation. Absent
            groupingAlgorithm preserves original delimiter-based grouping for
            unchanged historical outcomes; selecting new grouping requires an
            explicit prospective policy/configuration. A new version number alone
            does not reinterpret formerly admitted unmarked policies. */
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute taxCode : String;
            attribute jurisdiction : String;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute roundingLevel : Semantics::TaxRoundingLevel;
            attribute groupingAlgorithm : String[0..1];
            attribute inclusion : Semantics::TaxInclusion;
            attribute recoverability : Semantics::TaxRecoverability;
            attribute treatment : Semantics::TaxTreatment;
            attribute rate : Semantics::ExactRational;
            attribute recoverableShare : Semantics::ExactRational;
            attribute compoundOrdinal : Natural;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item compoundsOn : TaxPolicy[0..*];
            item quantizationPolicy : QuantizationPolicy;
            item featureCapability : AccountingFeatureCapability;
            item taxLiabilityAccount : Account;
            item recoverableTaxAccount : Account[0..1];
            item nonRecoverableDestinationAccount : Account[0..1];
        }

        item def TaxBasisInput {
            doc /* One explicit taxable line amount. If amountIncludesTax is false, statedAmount is the exclusive starting basis. If true, the policy graph must have one exact exclusive solution that reconstructs statedAmount; no solution or multiple solutions fail closed. */
            attribute id : Semantics::Identifier;
            attribute ordinal : Natural;
            attribute amountIncludesTax : Boolean;
            item statedAmount : ExactBookAmount;
            item source : CanonicalPostingReference[1..*];
            item applicablePolicy : PolicyReference[1..*];
        }

        item def TaxComponent {
            attribute id : Semantics::Identifier;
            item policy : TaxPolicy;
            item sourceBasis : TaxBasisInput;
            item taxableBasis : ExactBookAmount;
            item taxAmount : QuantizationResult;
            item recoverableBookValue : BookValue[0..1];
            item nonRecoverableBookValue : BookValue[0..1];
        }

        item def TaxDetermination {
            attribute id : Semantics::Identifier;
            attribute taxPoint : Semantics::Instant;
            attribute generatedEffectKey : Semantics::EffectKey;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item sourceTransaction : ResolvedTransaction;
            item sourceBasis : TaxBasisInput[1..*];
            item component : TaxComponent[1..*];
            item generatedPosting : Posting[1..*];
            item derivation : DerivationRecord;
        }

        item def ConsolidationRelationship {
            doc /* Supplied, effective-dated group-scope decision. Control is evidence-backed and is not inferred from ownership percentage alone. A partially owned full-consolidation relationship selects exactly one NCI method: proportionateNetAssets derives the signed NCI credit from translated net assets; fairValue supplies that signed exact credit explicitly. Full ownership and non-full methods admit neither NCI method nor NCI fair value. */
            attribute id : Semantics::Identifier;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute ownershipShare : Semantics::ExactRational;
            attribute votingShare : Semantics::ExactRational;
            attribute controlClassification : Semantics::ConsolidationControlClassification;
            attribute method : Semantics::ConsolidationMethod;
            attribute nonControllingInterestMethod : Semantics::NonControllingInterestMethod[0..1];
            item consolidationBook : Book;
            item sourceBook : Book;
            item controlEvidence : SourceEvidence[1..*];
            item nonControllingInterestFairValue : ExactBookAmount[0..1];
        }

        item def ConsolidationAccountMapping {
            attribute id : Semantics::Identifier;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            item sourceAccount : Account;
            item targetAccount : Account;
        }

        item def ConsolidationBalance {
            attribute ordinal : Natural;
            item sourceAccount : Account;
            item amount : BookValue;
        }

        item def ConsolidationSourceSnapshot {
            attribute id : Semantics::Identifier;
            attribute throughBookRevision : Natural;
            attribute throughPostingSequence : Natural;
            attribute contentHash : Semantics::ContentHash;
            item sourceBook : Book;
            item population : ReportPopulation;
            item relationship : ConsolidationRelationship;
            item balance : ConsolidationBalance[1..*];
        }

        item def ConsolidationEliminationEvidence {
            attribute id : Semantics::Identifier;
            item sourceEvidence : SourceEvidence[1..*];
            item source : CanonicalPostingReference[1..*];
            item targetAccount : Account;
            item exactAmount : ExactBookAmount;
        }

        item def ConsolidationPolicy {
            attribute id : Semantics::Identifier;
            attribute version : Semantics::SemanticVersion;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            attribute contentHash : Semantics::ContentHash;
            attribute supportedMethod : Semantics::ConsolidationMethod[1..*];
            item consolidationBook : Book;
            item accountMapping : ConsolidationAccountMapping[1..*];
            item translationRule : ConsolidationTranslationRule[1..*];
            item valuationPolicy : ValuationPolicy;
            item quantizationPolicy : QuantizationPolicy;
            item featureCapability : AccountingFeatureCapability;
            item translationAdjustmentAccount : Account;
            item parentAttributableEquityAccount : Account;
            item nonControllingInterestAccount : Account;
        }

        item def ConsolidationTranslationRule {
            doc /* Explicit rate-selection rule for one mapped source population. Translation never reads a market or account-name convention. */
            attribute id : Semantics::Identifier;
            attribute validFrom : Semantics::Instant;
            attribute validTo : Semantics::Instant[0..1];
            item sourceAccount : Account;
            item targetAccount : Account;
            item valuationPolicy : ValuationPolicy;
        }

        item def ConsolidationAdjustment {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::ConsolidationAdjustmentKind;
            item amount : QuantizationResult;
            item sourceBalance : ConsolidationBalance[1..*];
            item eliminationEvidence : ConsolidationEliminationEvidence[0..*];
            item generatedPosting : Posting[1..*];
            item derivation : DerivationRecord;
        }

        item def ConsolidationCompilation {
            doc /* A pure compilation over complete pinned source snapshots. It produces draft transactions for one target book and never assigns revisions or mutates a source book. */
            attribute id : Semantics::Identifier;
            attribute throughOn : Semantics::LocalDate;
            attribute contentHash : Semantics::ContentHash;
            item policy : ConsolidationPolicy;
            item sourceSnapshot : ConsolidationSourceSnapshot[1..*];
            item eliminationEvidence : ConsolidationEliminationEvidence[0..*];
            item adjustment : ConsolidationAdjustment[0..*];
            item generatedTransaction : JournalTransaction[1..*];
            item derivation : DerivationRecord[1..*];
        }

        item def GeneratedPostingDimensionSelection {
            doc /* Complete caller-supplied analytic selection for one generated posting. effectKey plus postingOrdinal resolves exactly one prepared posting; omitted, duplicate-axis, unused, or ambiently inferred selections fail. */
            attribute effectKey : Semantics::EffectKey;
            attribute postingOrdinal : Natural;
            item dimensionMember : DimensionMember[0..*];
        }

        item def InventoryCostRequest {
            item policy : PolicyReference;
            item provisionalLayer : ProvisionalInventoryLayer[0..1];
        }

        item def InventoryValueAdjustmentRequest {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::InventoryValueAdjustmentKind;
            attribute effectiveOn : Semantics::LocalDate;
            attribute policyEffectiveAt : Semantics::Instant;
            attribute generatedEffectKey : Semantics::EffectKey;
            item policy : PolicyReference;
            item exactSourceAmount : ExactBookAmount;
            item 'allocation' : InventoryValueAdjustmentAllocation[1..*];
            item evidence : SourceEvidence[1..*];
        }

        item def OpenItemRecognitionRequest {
            item transaction : ResolvedTransaction;
            item openItem : OpenItem[1..*];
        }

        item def SettlementRequest {
            attribute operation : Semantics::SettlementOperation[0..1];
            attribute appliedAt : Semantics::Instant[0..1];
            item settlement : Settlement;
            item openItem : OpenItem[0..*];
            item 'allocation' : SettlementAllocation[0..*];
            item remeasurementPolicy : PolicyReference[0..1];
            doc /* Omitted operation preserves legacy new-settlement-with-edges
            semantics and canonical bytes. recognizeUnallocated creates one new
            settlement with zero edges. allocateExisting requires its exact
            immutable settlement snapshot, a nonempty edge set and appliedAt;
            it emits edges, not another settlement or source owner. New dated
            edges retain appliedAt. Unknown operations or inconsistent shapes fail.
            appliedAt must be no earlier than the payment or target recognition
            and no later than command issuance; its accounting period must be
            open even when no journal is generated. The original payment source
            date and carrying basis never change. */
        }

        item def RemeasurementRequest {
            attribute effectiveOn : Semantics::LocalDate;
            attribute policyEffectiveAt : Semantics::Instant;
            item policy : PolicyReference;
            item position : MonetaryPosition[1..*];
            item valuationPath : ValuationPath[1..*];
            item reversalOf : RemeasurementResult[0..*];
        }

        item def AllocationScheduleRequest {
            attribute startsOn : Semantics::LocalDate;
            attribute endsOn : Semantics::LocalDate;
            attribute policyEffectiveAt : Semantics::Instant;
            item policy : PolicyReference;
            item source : CanonicalPostingReference;
            item residualValue : BookValue;
            item usage : AllocationUsage[0..*];
        }

        item def AllocationRecognitionRequest {
            item schedule : AllocationSchedule;
            attribute scheduleOrdinal : Natural[1..*];
        }

        item def AllocationScheduleRevisionRequest {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::AllocationScheduleChangeKind;
            attribute effectiveOn : Semantics::LocalDate;
            attribute policyEffectiveAt : Semantics::Instant;
            attribute generatedEffectKey : Semantics::EffectKey[0..1];
            item original : AllocationSchedule;
            item priorRecognition : AllocationRecognition[0..*];
            item policy : PolicyReference;
            item revisedResidualValue : BookValue;
            item exactAdjustmentAmount : ExactBookAmount[0..1];
            attribute revisedEndsOn : Semantics::LocalDate[0..1];
            item revisedUsage : AllocationUsage[0..*];
            item evidence : SourceEvidence[1..*];
        }

        item def TaxRequest {
            attribute taxPoint : Semantics::Instant;
            item basis : TaxBasisInput[1..*];
        }

        item def ConsolidationRequest {
            attribute throughOn : Semantics::LocalDate;
            attribute policyEffectiveAt : Semantics::Instant;
            item policy : PolicyReference;
            item sourceSnapshot : ConsolidationSourceSnapshot[1..*];
            item eliminationEvidence : ConsolidationEliminationEvidence[0..*];
            item valuationPath : ValuationPath[0..*];
        }

        item def AccountingPolicyAdoption {
            doc /* The immutable configuration effect. It advances configuration order independently of posting order and retains both complete content-addressed snapshots, not merely their hashes. */
            attribute id : Semantics::Identifier;
            attribute expectedConfigurationRevision : Natural;
            attribute nextConfigurationRevision : Natural;
            attribute effectiveAt : Semantics::Instant;
            attribute previousConfigurationHash : Semantics::ContentHash;
            attribute resultingConfigurationHash : Semantics::ContentHash;
            attribute contentHash : Semantics::ContentHash;
            item previousSnapshot : BookConfigurationSnapshot;
            item resultingSnapshot : BookConfigurationSnapshot;
            item inventoryCostPolicy : InventoryCostPolicy[0..*];
            item inventoryValueAdjustmentPolicy : InventoryValueAdjustmentPolicy[0..*];
            item accountingBasisPolicy : AccountingBasisPolicy[0..*];
            item monetaryClassificationPolicy : MonetaryClassificationPolicy[0..*];
            item remeasurementPolicy : RemeasurementPolicy[0..*];
            item allocationSchedulePolicy : AllocationSchedulePolicy[0..*];
            item taxPolicy : TaxPolicy[0..*];
            item consolidationPolicy : ConsolidationPolicy[0..*];
        }

        item def AccountingCommandPayload {
            doc /* Exactly one payload compatible with BookCommand.commandKind is present. External workflows may supply facts but may not omit or choose accounting policy silently. */
            item inventoryCostRequest : InventoryCostRequest[0..1];
            item ownedInventoryRequest : OwnedInventoryTransactionRequest[0..1];
            item inventoryValueAdjustmentRequest : InventoryValueAdjustmentRequest[0..1];
            item openItemRecognitionRequest : OpenItemRecognitionRequest[0..1];
            item settlementRequest : SettlementRequest[0..1];
            item remeasurementRequest : RemeasurementRequest[0..1];
            item allocationScheduleRequest : AllocationScheduleRequest[0..1];
            item allocationRecognitionRequest : AllocationRecognitionRequest[0..1];
            item allocationScheduleRevisionRequest : AllocationScheduleRevisionRequest[0..1];
            item taxRequest : TaxRequest[0..1];
            item consolidationRequest : ConsolidationRequest[0..1];
            item policyAdoption : AccountingPolicyAdoption[0..1];
            item generatedPostingDimensionSelection : GeneratedPostingDimensionSelection[0..*];
        }

        item def PolicyAdoptionPayload :> AccountingCommandPayload {
            item :>> policyAdoption : AccountingPolicyAdoption[1];
        }

        item def InventoryCostPayload :> AccountingCommandPayload {
            item :>> inventoryCostRequest : InventoryCostRequest[1];
        }

        item def OwnedInventoryCoordinateInput {
            attribute accountId : Semantics::Identifier;
            attribute unitsCommodityId : Semantics::Identifier;
            attribute dimensionMemberId : Semantics::Identifier[0..*];
            item bookingPolicy : PolicyReference;
            doc /* Input identity and explicit booking-policy selection, not a
            supplied account snapshot. Resolve the account, members and exactly one
            applicable policy from the pinned configuration at the command date.
            Book and functional commodity come from the authoritative book. Use
            that policy's required dimensions even when no posting exists. Selected
            dimensions must be unique by dimension and canonically ordered by ID.
            Coordinate equality is structural, never delimiter-concatenated. */
        }

        item def OwnedInventoryPostingLink {
            attribute journalOrdinal : Natural;
            attribute postingId : Semantics::Identifier;
            attribute referenceId : Semantics::Identifier;
            doc /* Zero-based ordinal into this request's resolvedJournal list,
            plus the real posting ID. Not a claimed historical posting, supplied
            journal hash or caller-chosen generated effect key. Evaluation admits
            that complete journal and derives the full canonical posting reference
            from its actual booked effect, command origin and assigned revision.
            Each inventory posting is attributed to exactly one complete operation
            group; members can share that group posting, not own it independently. */
        }

        enum def OwnedInventoryOperationKind {
            acquisition;
            issue;
            transfer;
        }

        abstract item def OwnedInventoryOperationInput {
            attribute kind : OwnedInventoryOperationKind;
            attribute ordinal : Natural;
            attribute id : Semantics::Identifier;
            item coordinate : OwnedInventoryCoordinateInput;
            item inventoryPolicy : PolicyReference;
            item derivation : DerivationRecord;
            item postingLink : OwnedInventoryPostingLink[0..1];
            doc /* Version 1.0.0 admits acquisition or issue only. The explicit
            prospective command versions 1.1.0 and 1.2.0 also admit transfer, without changing
            prior command results or the version 1.0.0 ownership artifact arithmetic.
            Ordinals are contiguous from zero and list order is semantic. Unique
            group IDs do not permit caller-supplied amounts, positions or anchors
            to become authority. All operations use the command date and the one
            pinned configuration; policy capability, validity, pool membership,
            full policy hash, quantization and derivation admission are mandatory.
            Newly acquired groups pin the selected quantization policy. An issue
            uses each source anchor's retained posting budget and quantization,
            never requantizes it under today's policy. Mixed anchor policies that
            cannot form one admitted group require separate explicit groups. */
        }

        item def OwnedInventoryAcquisitionEntry {
            attribute anchorId : Semantics::Identifier;
            attribute movementId : Semantics::Identifier;
            item lot : Lot;
            item holding : LotHolding;
            item evidence : SourceEvidence[1..*];
            doc /* New identities and positive quantities only, with complete
            economic acquisition evidence. Initial quantity/basis equal the lot's
            acquisition values; initial allowance is zero and carrying equals basis.
            Existing holdings, imported balances and write-downs cannot masquerade
            as acquisition. The anchor/position is computed by the evaluator and
            is never accepted as command input. acquiredAt cannot follow governedAt.
            Economic instants and explicitly admitted accounting dates are distinct:
            do not infer accounting dates through a host timezone conversion.
            Subsequent issues compare the original movement's admitted accounting
            date with their own date as well as checking economic-time availability. */
        }

        item def OwnedInventoryAcquisitionInput :> OwnedInventoryOperationInput {
            :>> kind = OwnedInventoryOperationKind::acquisition;
            item acquisitionEntry : OwnedInventoryAcquisitionEntry[1..*];
            doc /* Complete same-coordinate group. An admitted positive inventory
            posting must cover every member's exact quantity and historical basis.
            Its posted amount is the governed quantization of aggregate carrying
            amount; any different settlement requires a separately specified policy
            and cannot be hidden in a caller-chosen posting. Attribute that actual
            amount in holding-ID order by cumulative carrying proportions. A group
            whose quantized aggregate is zero has no posting link and retains all
            evidence. Members with zero attributed money remain quantity-only even
            when the complete group has a real posting. */
        }

        item def OwnedInventoryIssueIdentity {
            attribute holdingId : Semantics::Identifier;
            attribute allocationId : Semantics::Identifier;
            attribute movementId : Semantics::Identifier;
        }

        item def OwnedInventoryIssueInput :> OwnedInventoryOperationInput {
            :>> kind = OwnedInventoryOperationKind::issue;
            attribute quantity : Semantics::ExactRational;
            attribute specificHoldingId : Semantics::Identifier[0..*];
            item identity : OwnedInventoryIssueIdentity[1..*];
            assert constraint positiveIssue { quantity.numerator > 0 and quantity.denominator > 0 }
            doc /* No caller-supplied layers, per-holding quantities, basis amounts,
            anchor budgets or after-positions. Resolve the COMPLETE current policy
            pool, including same-command changes from earlier operation ordinals,
            and compute selection by the admitted method. Identity inputs must
            exactly cover computed ordinary allocations. Every selected holding
            requires an authenticated current position and its exact historical
            anchor/origin. Unowned legacy stock cannot be skipped to alter FIFO,
            average cost or shortage results. Shortage/provisional stock requires
            its separately specified command variant; this version rejects shortage.
            Reject dates before any selected acquisition or latest selected
            ownership movement. General backdated recosting is not implied.
            One group must reproduce the full selection at its coordinate; if the
            policy selection spans other accounts/dimensions, reject rather than
            silently narrowing the pool. Full multi-coordinate selection/transfer
            remains a separate topology, not caller-controlled partial selection.
            Compute exact economic allocations separately from cumulative posted
            shares. A linked reducing inventory posting covers ALL selected units
            and basis but its money is exactly the sum of negative posted shares.
            When every share is zero there is no inventory posting, while economic
            allocations, position advances and consumed identities still commit. */
        }

        item def OwnedInventoryTransferEntry {
            attribute holdingId : Semantics::Identifier;
            attribute allocationId : Semantics::Identifier;
            attribute transferOutMovementId : Semantics::Identifier;
            attribute destinationAnchorId : Semantics::Identifier;
            attribute destinationMovementId : Semantics::Identifier;
            attribute destinationHoldingId : Semantics::Identifier;
            attribute destinationLotId : Semantics::Identifier;
            item evidence : SourceEvidence[1..*];
        }

        item def OwnedInventoryTransferInput :> OwnedInventoryOperationInput {
            :>> kind = OwnedInventoryOperationKind::transfer;
            attribute quantity : Semantics::ExactRational;
            attribute specificHoldingId : Semantics::Identifier[0..*];
            item destinationCoordinate : OwnedInventoryCoordinateInput;
            item destinationInventoryPolicy : PolicyReference;
            item destinationPostingLink : OwnedInventoryPostingLink[0..1];
            item transferEntry : OwnedInventoryTransferEntry[1..*];
            doc /* Resolve the complete source policy pool at one authenticated
            head. Compute selected quantities and exact economics internally.
            Each destination receives its selected source's actual cumulative
            posted share, never a share rerounded in destination order. Source
            and destination policies, dimensions, dates and permanent identities
            are independently admitted. A newly managed destination must have
            zero prior posted balance and no live unowned stock; transfer is not
            legacy adoption. Nonzero movements require both matching journal
            postings even when source and destination use the same account.
            Quantity-only movements invent no posting identities. Publish source
            reductions, destination anchors, movements and journals atomically.
            Legacy adoption remains unsupported until its complete historical
            ownership proof and governed migration transition are implemented.
            A decodable prospective adoption payload is not admission authority. */
        }

        item def OwnedInventoryTransactionRequest {
            attribute algorithm : String;
            attribute algorithmVersion : Semantics::SemanticVersion;
            attribute accountingDate : Semantics::LocalDate;
            attribute governedAt : Semantics::Instant;
            attribute fiscalPeriodId : Semantics::Identifier;
            item operation : OwnedInventoryOperationInput[1..*] ordered;
            item resolvedJournal : ResolvedTransaction[0..*] ordered;
            doc /* Closed discriminator postOwnedInventoryTransaction,
            algorithm cumulativePostedInventoryV1, versions 1.0.0, 1.1.0 and 1.2.0 as
            restricted by the operation contract above. Unsupported
            algorithm/version requests reject; changing this version's meaning or
            widening historically rejected combinations is prohibited. Legacy
            command shapes/hashes and original committed/rejected receipts do not
            change. Strict codecs reject unknown fields and variant mismatches.
            Bound combined operations, entries, identities, evidence, journals and
            source work before allocation; per-array bounds alone are insufficient.
            Supplied journals are ordinary/adjustment journals on the command date.
            Admit full balanced journals by existing booking/quantization rules;
            ownership groups account for every posting that changes an owned
            inventory coordinate. Counterpart/ancillary postings remain subject
            to ordinary admission, never inferred from account names. A nonzero
            balanced journal is retained even if its signed total is zero. Only
            an empty set of nonzero coordinate postings permits journal omission.
            Acquisition and issue within one request execute in ordinal order,
            with first reads authenticated at one head and successors derived
            internally. No earlier-group effects escape if a later group rejects.
            Version 1.2.0 replaces the whole lot-state snapshot with exactly one
            LotChangesEffect; ownership arithmetic and artifact versions remain
            unchanged. Its selection read is the complete active policy-account
            and units-commodity pool, excluding depleted zero-quantity holdings.
            Permanent holding/lot/allocation identities remain retained and checked
            independently. A depleted holding cannot be selected, but can never
            become a new identity. Older versions retain their complete-pool work
            bounds including depleted rows. Quantity-only movement dates constrain
            subsequent configuration changes exactly as journal accounting dates;
            historical effect validation enforces that same prospective boundary.
            Current-state execution admits this bounded effect shape
            only. Older command versions require their existing full-state path.
            This contract retains its pending adoption and production evidence
            obligations; a new version does not establish legacy ownership. */
        }

        item def OwnedInventoryPayload :> AccountingCommandPayload {
            item :>> ownedInventoryRequest : OwnedInventoryTransactionRequest[1];
        }

        item def InventoryValueAdjustmentPayload :> AccountingCommandPayload {
            item :>> inventoryValueAdjustmentRequest : InventoryValueAdjustmentRequest[1];
        }

        item def OpenItemRecognitionPayload :> AccountingCommandPayload {
            item :>> openItemRecognitionRequest : OpenItemRecognitionRequest[1];
        }

        item def SettlementPayload :> AccountingCommandPayload {
            item :>> settlementRequest : SettlementRequest[1];
        }

        item def RemeasurementPayload :> AccountingCommandPayload {
            item :>> remeasurementRequest : RemeasurementRequest[1];
        }

        item def AllocationSchedulePayload :> AccountingCommandPayload {
            item :>> allocationScheduleRequest : AllocationScheduleRequest[1];
        }

        item def AllocationRecognitionPayload :> AccountingCommandPayload {
            item :>> allocationRecognitionRequest : AllocationRecognitionRequest[1];
        }

        item def AllocationScheduleRevisionPayload :> AccountingCommandPayload {
            item :>> allocationScheduleRevisionRequest : AllocationScheduleRevisionRequest[1];
        }

        item def TaxPayload :> AccountingCommandPayload {
            item :>> taxRequest : TaxRequest[1];
        }

        item def ConsolidationPayload :> AccountingCommandPayload {
            item :>> consolidationRequest : ConsolidationRequest[1];
        }

        item def ActivateBookCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::activateBook;
            item :>> accountingPayload : AccountingCommandPayload[0];
        }

        item def PostJournalCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::postJournal;
            item :>> resolvedTransaction : ResolvedTransaction[1];
            item :>> accountingPayload : AccountingCommandPayload[0];
        }

        item def CorrectJournalCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::correctJournal;
            item :>> resolvedTransaction : ResolvedTransaction[1];
            item :>> accountingPayload : AccountingCommandPayload[0];
        }

        item def ClosePeriodCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::closePeriod;
            item :>> accountingPayload : AccountingCommandPayload[0];
        }

        item def ReopenPeriodCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::reopenPeriod;
            item :>> accountingPayload : AccountingCommandPayload[0];
        }

        item def ExecutionProfileAdoption {
            attribute 'from' : String;
            attribute 'to' : String;
            attribute expectedConfigurationHash : Semantics::ContentHash;
            attribute reason : String;
            attribute evidenceId : Semantics::Identifier[1..64];
            doc /* The closed wire fields are from, to, expectedConfigurationHash,
            reason and evidenceIds. Requested names remain strings so unsupported
            names can produce durable rejections; the committed configuration
            profile remains a closed enum. Only legacy to structural-source-identity-v1
            is supported by this payload shape permanently. A future transition
            target requires a new explicitly versioned payload shape; widening
            this shape's vocabulary would reinterpret old unsupported-target
            rejections and is prohibited. The previous complete configuration hash, a nonblank
            reason of at most 4096 Unicode code points and 1..64 distinct nonempty
            evidence IDs are required. The authorized actor and command times are
            supplied by the enclosing configuration command. External evidence
            custody and actor authorization remain application responsibilities.
            All fields participate in canonical command identity. Adoption shares
            the existing book/configuration CAS and one configuration effect; it
            advances both revisions and Oseq, not posting sequence or balances.
            Replacement without this payload preserves the selected profile.
            Repeated fresh adoption, downgrade, unknown targets, stale hashes and
            incomplete evidence reject atomically. Exact retained retries are
            resolved first. Selection changes only commands evaluated after this
            committed transition, including permitted backdated commands; economic
            dates still obey ordinary opening/period/configuration rules. Earlier
            committed and rejected outcomes replay under their original preceding
            configuration and retain all bytes, hashes, times and Oseq. */
        }

        item def ReplaceConfigurationCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::replaceConfiguration;
            item :>> accountingPayload : PolicyAdoptionPayload[1];
            item executionProfileAdoption : ExecutionProfileAdoption[0..1];
        }

        item def PostInventoryTransactionCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::postInventoryTransaction;
            item :>> accountingPayload : InventoryCostPayload[1];
        }

        item def PostOwnedInventoryTransactionCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::postOwnedInventoryTransaction;
            item :>> resolvedTransaction : ResolvedTransaction[0];
            item :>> accountingPayload : OwnedInventoryPayload[1];
            doc /* EvaluateBookCommand is the only intent factory.
            Admission requires the explicitly selected structural-source-identity-v1
            execution profile. Live unowned holdings in a proposed acquisition's
            account require verified adoption first: legacy holdings lack analytic
            coordinates, so no dimension-specific absence may be inferred from them.
            A newly managed money scope must also have zero aggregate posted balance
            across all units commodities in the complete preceding canonical history.
            Otherwise verified adoption must reconcile that existing balance, including
            residuals on exhausted lots or balances with no lot rows. A new acquisition
            cannot silently claim or strand an old balance. Previously managed scopes
            retain their authenticated ownership; they are not required to be empty.
            On success: exactly one InventoryOwnershipEffect plus its exact lot/holding and
            economic-allocation deltas, and precisely the admitted journals in
            input order. Anchor and movement artifact ordinals follow operation
            order, then holding-ID order, with acquisition anchors before their
            origin movements. All IDs are unique against permanent history and
            all groups, including exhausted holdings and quantity-only outcomes.
            A legacy allocation in another account cannot reuse an ownership
            allocation ID; the permanent allocation namespace spans both shapes.
            The intent advances book revision once, posting sequence only by real
            journals, and configuration revision not at all. Publication atomically
            CASes the complete expected head, including rejection-only changes,
            and retains the original outcome under the same command ID.
            Financial/opening/period/configuration and actor admission apply even
            with zero journals. Unknown storage evidence/invalidation is a retryable
            infrastructure failure, not a durable accounting rejection.
            Once ownership exists, ordinary journal/lot, correction, value-adjustment
            or transfer commands must not mutate its holding or managed money scope
            without the corresponding ownership transition. Reject such unsupported
            cross-profile writes; do not reinterpret old receipts. Generic reversal
            is not an ownership correction. Dedicated restoration/transfer/value
            adjustment/adoption topologies and their compatibility tests remain
            required before enabling this profile for real business use. */
            doc /* A managed money scope is book, inventory account, functional
            commodity and analytic members, across ALL units commodities. Using
            functional-currency units for a write-down must not bypass inventory
            ownership. Scope admission is retained once established, including
            depleted stock, and cannot disappear when a current balance becomes
            zero. Every posting into that scope needs complete admitted ownership
            attribution or its dedicated value-transition topology. Read-side
            presence AND absence must be authenticated; a missing index is not
            proof that the scope is unmanaged. Reversing any source journal still
            requires its ownership correction after later depletion or transfer.
            Close/reopen without monetary inventory changes is permitted by the
            normal period protocol; close packages pin complete ownership state.
            All original retries resolve before these prospective scope guards. */
        }

        item def RecostProvisionalInventoryCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::recostProvisionalInventory;
            item :>> accountingPayload : InventoryCostPayload[1];
        }

        item def AdjustInventoryValueCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::adjustInventoryValue;
            item :>> accountingPayload : InventoryValueAdjustmentPayload[1];
        }

        item def RecognizeOpenItemCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::recognizeOpenItem;
            item :>> accountingPayload : OpenItemRecognitionPayload[1];
        }

        item def ApplySettlementCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::applySettlement;
            item :>> accountingPayload : SettlementPayload[1];
        }

        item def PostCurrencyRemeasurementCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::postCurrencyRemeasurement;
            item :>> accountingPayload : RemeasurementPayload[1];
        }

        item def CreateAllocationScheduleCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::createAllocationSchedule;
            item :>> accountingPayload : AllocationSchedulePayload[1];
        }

        item def RecognizeScheduledAllocationCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::recognizeScheduledAllocation;
            item :>> accountingPayload : AllocationRecognitionPayload[1];
        }

        item def ReviseAllocationScheduleCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::reviseAllocationSchedule;
            item :>> accountingPayload : AllocationScheduleRevisionPayload[1];
            item disposalJournal : ResolvedTransaction[0..1];
            doc /* A supplied disposal journal is admitted only with a disposal revision. The generated carrying-value adjustment and supplied disposal journal share one atomic intent, book revision, and accounting date. The supplied journal must exactly clear the generated allocation-account adjustment in functional-currency units and book value. Its policy-resolved postings specify cost derecognition, proceeds, and gain or loss; these are not inferred from account names. */
        }

        item def PostTaxedTransactionCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::postTaxedTransaction;
            item :>> accountingPayload : TaxPayload[1];
        }

        item def CompileConsolidationCommand :> BookCommand {
            :>> commandKind = Semantics::BookCommandKind::compileConsolidation;
            item :>> accountingPayload : ConsolidationPayload[1];
        }

        item def PreparedJournalEffect {
            attribute effectKey : Semantics::EffectKey;
            attribute policySnapshotHash : Semantics::ContentHash;
            item transaction : JournalTransaction;
        }

        item def BookEffectDraft {
            doc /* Complete noncanonical output of a specialized pure calculator. Only EvaluateBookCommand may validate it, assign book order, and create a BookCommitIntent. */
            attribute id : Semantics::Identifier;
            attribute contentHash : Semantics::ContentHash;
            item preparedJournal : PreparedJournalEffect[0..*];
            item inventoryOwnership : InventoryOwnershipEffect[0..*];
            item lotChanges : LotChangesEffect[0..1];
            item provisionalInventoryLayer : ProvisionalInventoryLayer[0..*];
            item inventoryRecosting : InventoryRecosting[0..*];
            item inventoryValueAdjustment : InventoryValueAdjustment[0..*];
            item openItem : OpenItem[0..*];
            item settlement : Settlement[0..*];
            item settlementAllocation : SettlementAllocation[0..*];
            item allocationSchedule : AllocationSchedule[0..*];
            item allocationRecognition : AllocationRecognition[0..*];
            item allocationScheduleRevision : AllocationScheduleRevision[0..*];
            item taxDetermination : TaxDetermination[0..*];
            item remeasurementResult : RemeasurementResult[0..*];
            item remeasurementReversal : RemeasurementReversal[0..*];
            item consolidationCompilation : ConsolidationCompilation[0..*];
            item policyAdoption : AccountingPolicyAdoption[0..1];
        }

        item def ValuationStep {
            attribute ordinal : Natural;
            attribute usesInverse : Boolean;
            item observation : MarketPriceObservation;
            item inputCommodity : Commodity;
            item outputCommodity : Commodity;
        }

        item def ValuationPath {
            attribute id : Semantics::Identifier;
            attribute effectiveAt : Semantics::Instant;
            item sourceQuantity : Quantity;
            item policy : ValuationPolicy;
            item step : ValuationStep[1..*];
            item resultingValue : MarketValue;
            item derivation : DerivationRecord;
        }

        item def BalanceAssertion {
            attribute id : Semantics::Identifier;
            attribute assertedAt : Semantics::Instant;
            item account : Account;
            item expected : Quantity;
            item evidence : SourceEvidence[1..*];
        }

        item def ReconciliationLink {
            attribute id : Semantics::Identifier;
            attribute relation : Semantics::ReconciliationRelationKind;
            attribute method : String;
            attribute confidenceBasis : String;
            attribute reviewedAt : Semantics::Instant[0..1];
            item sourceEvidence : SourceEvidence[1..*];
            item posting : Posting[1..*];
            item allocatedBookValue : BookValue[0..1];
        }

        item def CorrectionLink {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::CorrectionKind;
            item original : ValidatedBookedJournal;
            item correction : ValidatedBookedJournal;
        }

        item def PeriodTransition {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::PeriodTransitionKind;
            attribute reason : String;
            attribute bookRevision : Natural;
            attribute recordedAt : Semantics::Instant;
            attribute contentHash : Semantics::ContentHash;
            item fiscalPeriod : FiscalPeriod;
        }

        item def ReportPopulation {
            doc /* The immutable read boundary shared by every report in one financial statement package. */
            attribute id : Semantics::Identifier;
            attribute basis : Semantics::AccountingBasis;
            attribute rangeStartsOn : Semantics::LocalDate[0..1];
            attribute throughOn : Semantics::LocalDate;
            attribute throughBookRevision : Natural;
            attribute throughPostingSequence : Natural;
            attribute reportingPolicySnapshotHash : Semantics::ContentHash;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
            item chartSnapshot : ChartSnapshot;
        }

        item def FinancialReport {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::FinancialReportKind;
            attribute compilerVersion : Semantics::SemanticVersion;
            attribute contentHash : Semantics::ContentHash;
            item population : ReportPopulation;
        }

        item def CloseCheckpoint {
            attribute id : Semantics::Identifier;
            attribute throughBookRevision : Natural;
            attribute throughPostingSequence : Natural;
            attribute configurationRevision : Natural;
            attribute configurationSnapshotHash : Semantics::ContentHash;
            attribute bookStateSnapshotHash : Semantics::ContentHash;
            attribute ledgerHash : Semantics::ContentHash;
            attribute contentHash : Semantics::ContentHash;
            item fiscalPeriod : FiscalPeriod;
            item population : ReportPopulation;
            item configurationSnapshot : BookConfigurationSnapshot;
        }

        item def ClosePackage {
            attribute id : Semantics::Identifier;
            attribute cycle : Natural;
            attribute contentHash : Semantics::ContentHash;
            item checkpoint : CloseCheckpoint;
            item report : FinancialReport[6];
            item closingJournal : ValidatedBookedJournal[0..1];
        }

        item def ReopenEffect {
            attribute id : Semantics::Identifier;
            attribute reason : String;
            attribute impactDisclosure : String;
            attribute bookRevision : Natural;
            attribute contentHash : Semantics::ContentHash;
            item priorClose : ClosePackage;
            item closingJournalReversal : ValidatedBookedJournal[0..1];
        }

        item def ProjectionCheckpoint {
            attribute id : Semantics::Identifier;
            attribute kind : Semantics::ProjectionKind;
            attribute throughBookRevision : Natural;
            attribute sourceHash : Semantics::ContentHash;
            attribute contentHash : Semantics::ContentHash;
            item book : Book;
        }

        item def CrossBookEffectLink {
            doc /* Cross-entity activity is represented by independently balanced book journals joined by evidence; no journal spans books. */
            attribute id : Semantics::Identifier;
            attribute groupCommandId : Semantics::Identifier;
            attribute status : Semantics::CrossBookEffectStatus;
            attribute contentHash : Semantics::ContentHash;
            item sourceJournal : ValidatedBookedJournal[0..1];
            item destinationJournal : ValidatedBookedJournal[0..1];
        }

        item def BookCommitIntent {
            doc /* Complete deterministic output of the pure core. It contains no unresolved accounting and performs no persistence. */
            attribute id : Semantics::Identifier;
            attribute expectedBookRevision : Natural;
            attribute nextBookRevision : Natural;
            attribute resultingPostingSequence : Natural[0..1];
            attribute resultingConfigurationRevision : Natural;
            attribute resultingConfigurationHash : Semantics::ContentHash;
            attribute canonicalHash : Semantics::ContentHash;
            item command : BookCommand;
            item journal : ValidatedBookedJournal[0..*];
            item inventoryOwnership : InventoryOwnershipEffect[0..*];
            item lotChanges : LotChangesEffect[0..1];
            item correction : CorrectionLink[0..*];
            item periodTransition : PeriodTransition[0..1];
            item closePackage : ClosePackage[0..1];
            item reopenEffect : ReopenEffect[0..1];
            item lotAllocation : LotAllocation[0..*];
            item lotTransferAllocation : LotTransferAllocation[0..*];
            item provisionalInventoryLayer : ProvisionalInventoryLayer[0..*];
            item inventoryRecosting : InventoryRecosting[0..*];
            item inventoryValueAdjustment : InventoryValueAdjustment[0..*];
            item openItem : OpenItem[0..*];
            item settlement : Settlement[0..*];
            item settlementAllocation : SettlementAllocation[0..*];
            item allocationSchedule : AllocationSchedule[0..*];
            item allocationRecognition : AllocationRecognition[0..*];
            item allocationScheduleRevision : AllocationScheduleRevision[0..*];
            item taxDetermination : TaxDetermination[0..*];
            item remeasurementResult : RemeasurementResult[0..*];
            item remeasurementReversal : RemeasurementReversal[0..*];
            item consolidationCompilation : ConsolidationCompilation[0..*];
            item policyAdoption : AccountingPolicyAdoption[0..1];
        }

        item def AtomicBookCommit {
            attribute id : Semantics::Identifier;
            attribute bookRevision : Natural;
            attribute resultHash : Semantics::ContentHash;
            attribute committedAt : Semantics::Instant;
            item intent : BookCommitIntent;
        }

        item def FinancialRevisionPredecessor {
            attribute bookId : Semantics::Identifier;
            attribute bookRevision : Natural;
            attribute chainHash : Semantics::ContentHash;
        }
        item def BookCommitRecordContext {
            attribute bookId : Semantics::Identifier;
            attribute bookRevision : Natural;
            item previousRevision : FinancialRevisionPredecessor[0..1];
            doc /* Complete scalar mathematical context for the next financial
            revision. Zero requires explicit predecessor absence; a positive
            revision requires the same book/revision and complete hash identity.
            A retained rejection is never the financial predecessor. Source
            authentication and canonical-head binding remain owner obligations. */
        }
        item def BookCommitRecordCandidate {
            item revision : RevisionRecord;
            item result : BookCommandResult;
            item retainedResult : BookCommandResult;
            doc /* Immutable record candidates only, not publication or accounting
            admission. The retained result includes the exact original command,
            input/result/intent hashes, financial revision, diagnostics and times.
            No complete historical state or protocol array is required to construct
            these records. State effects and publication remain atomic together. */
        }

        item def BookCommandResult {
            doc /* The retained result of command evaluation. A commit is present only for a successful result; diagnostics are present only for a failed result. Either outcome may be replayed without a new effect. */
            attribute disposition : Semantics::CommandDisposition;
            attribute observedBookRevision : Natural;
            attribute resultHash : Semantics::ContentHash;
            attribute completedAt : Semantics::Instant;
            item command : BookCommand;
            item commit : AtomicBookCommit[0..1];
            item diagnostic : SemanticDiagnostic[0..*];
        }

        item def RevisionRecord {
            attribute bookRevision : Natural;
            attribute previousHash : Semantics::ContentHash[0..1];
            attribute effectsHash : Semantics::ContentHash;
            attribute chainHash : Semantics::ContentHash;
            item command : BookCommand;
        }

        item def AdapterMapping {
            attribute id : Semantics::Identifier;
            attribute adapterName : String;
            attribute featureName : String;
            attribute fidelity : Semantics::MappingFidelity;
        }
    }

    package Requirements {
        private import RequirementDerivation::*;

        requirement def <'ACC-001'> ExactArithmetic {
            doc /* The accounting core shall preserve source decimal coefficient and scale, use canonical exact rational intermediate arithmetic, prohibit binary floating point, and reject invalid rationals or representational overflow before mutation. */
        }
        requirement exactArithmetic : ExactArithmetic;

        requirement def <'ACC-002'> TypedMonetarySemantics {
            doc /* Quantity, book value, transaction price, cost basis, and market price shall be distinct non-substitutable types. */
        }
        requirement typedMonetarySemantics : TypedMonetarySemantics;

        requirement def <'ACC-003'> ExactBalance {
            doc /* Every booked transaction shall balance exactly in its one book's functional commodity after the pinned quantization policy is applied. Any nonzero residual shall be represented by one explicit posting to that policy's designated rounding account, and the complete quantization-policy snapshot shall be canonical provenance. */
        }
        requirement exactBalance : ExactBalance;

        requirement def <'ACC-004'> ImmutablePosting {
            doc /* A posted journal shall be immutable and undeletable. A correction shall be a same-book linked supersession or an exact reversal of units, book values, prices, basis allocations, and lineage, and duplicate correction effects shall fail. */
        }
        requirement immutablePosting : ImmutablePosting;

        requirement def <'ACC-005'> ResolvedInputBoundary {
            doc /* Boundary services may normalize and propose external facts, but the kernel shall admit only a fully resolved typed command and only command evaluation may create a canonical journal intent. */
        }
        requirement resolvedInputBoundary : ResolvedInputBoundary;

        requirement def <'ACC-006'> DeterministicPureCore {
            doc /* The semantic core shall perform no I/O, network access, database access, authorization, wall-clock reads, randomness, or callback-driven identity generation and shall be deterministic for identical complete inputs and policy snapshots. All identifiers and protocol times shall be supplied facts or canonical deterministic derivations. */
        }
        requirement deterministicPureCore : DeterministicPureCore;

        requirement def <'ACC-007'> FailClosedAmbiguity {
            doc /* Any unresolved accounting choice shall fail unless one applicable versioned policy deterministically resolves it from the supplied facts. */
        }
        requirement failClosedAmbiguity : FailClosedAmbiguity;

        requirement def <'ACC-008'> LotIdentity {
            doc /* Every lot shall have a stable identifier independent of date, label, account name, display precision, and cost rendering. Holding identifiers are permanent within the book, including depleted holdings. A newly created transfer destination shall not reuse a source holding identifier or any identifier assigned in another account or earlier operation of the same command. Coalescing may update only the existing destination holding for the same lot and account. */
        }
        requirement lotIdentity : LotIdentity;

        requirement def <'ACC-009'> BasisConservation {
            doc /* Lot splitting, reduction, allocation, and transfer shall conserve quantity and authoritative total basis exactly; over-allocation and a negative ordinary holding shall fail before mutation. Each operation consumes its linked canonical posting quantity exactly once: acquisition and disposal each link one distinct posting, and a transfer links two distinct postings not used by another lot operation in the same journal. An ordinary acquisition's posted inventory value shall not be negative, and an ordinary disposal's posted inventory value shall not be positive; journal-level balance cannot excuse a reversed inventory direction. Selected holdings shall match the source posting's book, account and commodity; a transfer destination posting shall match the destination account and source commodity. Any supplied transfer cost-basis annotation shall match allocated authoritative historical basis with the corresponding source or destination sign. Historical basis is distinct from quantized book value and valuation allowance. These sign constraints do not establish an authenticated posted-carrying budget or prove that an independently rounded issue fully consumes it. */
        }
        requirement basisConservation : BasisConservation;

        requirement def <'ACC-010'> TransferContinuity {
            doc /* A transfer shall preserve lot identity and basis unless an applicable supplied boundary policy requires an explicit disposal and reacquisition. Continuity transfers require distinct source and destination accounts and disjoint holding identities; a same-account continuity request shall fail before mutation, not overwrite the reduced source with an increased destination. The source posted inventory value shall be nonpositive, the destination posted inventory value nonnegative, and the two signed book values shall sum exactly to zero in the book's functional commodity. A compensating posting elsewhere in a balanced journal cannot authorize an unexplained continuity gain or loss. Separately governed cost adjustments remain separate accounting effects. Existing nonzero-journal-posting admission remains applicable; cumulative zero-posted quantity movements require their own explicit versioned effect topology. */
        }
        requirement transferContinuity : TransferContinuity;

        requirement def <'ACC-011'> VersionedPolicy {
            doc /* Every policy-dependent result shall identify the complete booking and quantization policy content, version, validity interval, scope, and supplied input snapshot, and shall use the policy applicable to the explicitly governed accounting or economic fact rather than recording time. Conflicting policy identity, content, interval, or posting scope shall fail closed. */
        }
        requirement versionedPolicy : VersionedPolicy;

        requirement def <'ACC-012'> PriceSeparation {
            doc /* Market observations and derived cross rates shall never overwrite transaction price, cost basis, or book value. */
        }
        requirement priceSeparation : PriceSeparation;

        requirement def <'ACC-013'> TemporalSemantics {
            doc /* Economic, accounting, settlement, recording, observation, command issue, evaluation completion, atomic commit, and policy-validity times shall remain distinct supplied facts, and every admission or derivation rule shall name the time dimension it governs. */
        }
        requirement temporalSemantics : TemporalSemantics;

        requirement def <'ACC-014'> AccountLifecycle {
            doc /* At the accounting date, an account shall be active, posting-enabled, in the journal book, and commodity-admissible. Chart codes shall be unique within a snapshot and same-book parent relationships shall be acyclic; an empty commodity allow-list means unrestricted. */
        }
        requirement accountLifecycle : AccountLifecycle;

        requirement def <'ACC-015'> EvidenceAssertions {
            doc /* Balance assertions shall be immutable evidence and shall never create or alter journal postings. */
        }
        requirement evidenceAssertions : EvidenceAssertions;

        requirement def <'ACC-016'> ReconciliationGraph {
            doc /* As a Ring C proof service, reconciliation shall support many-to-many evidence links with allocations, method, review state, and provenance rather than a posting boolean, and shall never mutate canonical history. */
        }
        requirement reconciliationGraph : ReconciliationGraph;

        requirement def <'ACC-017'> DerivationProvenance {
            doc /* Every inferred or automated value admitted into canonical meaning shall retain evidence, policy and algorithm versions, complete canonical input hash, actor, approval state, and recorded time. */
        }
        requirement derivationProvenance : DerivationProvenance;

        requirement def <'ACC-018'> CanonicalJournalIntegrity {
            doc /* A canonical journal shall contain at least two uniquely identified, uniquely ordered, nonzero real postings whose accounts, book values, lots, policies, period, and corrections all close over the same book; virtual or unresolved postings are forbidden. */
        }
        requirement canonicalJournalIntegrity : CanonicalJournalIntegrity;

        requirement def <'ACC-019'> OrderIndependentMeaning {
            doc /* Reordering economically equivalent source records or postings shall not change booked meaning, and canonical serialization shall apply one explicit deterministic ordering before identity or hash comparison. Semantic string ordering and identifier tie-breaks shall use lexicographic UTF-16 code-unit order, independent of host locale or collation libraries. Canonical record-key byte encoding retains its separately specified UTF-8 byte ordering. */
        }
        requirement orderIndependentMeaning : OrderIndependentMeaning;

        requirement def <'ACC-020'> CanonicalInterchange {
            doc /* As a Ring D boundary contract, canonical export shall be versioned and every external adapter feature shall declare full, transformed, lossy, or unsupported fidelity without becoming an alternate posting authority. */
        }
        requirement canonicalInterchange : CanonicalInterchange;

        requirement def <'ACC-021'> AtomicPersistence {
            doc /* The book protocol shall atomically persist the retained command result, validated commit intent, canonical journals, provenance, lot mutations, and revision record. The complete aggregate shall have a versioned durable codec and validate by replay before restoration. Rebuildable projections and external publication work shall not enlarge this canonical atomic boundary. */
        }
        requirement atomicPersistence : AtomicPersistence;

        requirement def <'ACC-022'> TypedFailure {
            doc /* Every failed semantic stage shall return a typed diagnostic that identifies the violated invariant and supporting evidence. */
        }
        requirement typedFailure : TypedFailure;

        requirement def <'ACC-023'> AuthoritativeTotalBasis {
            doc /* Authoritative lot basis shall be stored as an exact total rational; per-unit decimal basis and rendered lot names shall be derived views that cannot feed back into canonical matching. */
        }
        requirement authoritativeTotalBasis : AuthoritativeTotalBasis;

        requirement def <'ACC-024'> ValuationPathProvenance {
            doc /* As a Ring C proof service, every cross-commodity valuation shall record the versioned path policy, ordered observations, direction of every edge, effective time, exact result, and any display quantization without rewriting booked values. */
        }
        requirement valuationPathProvenance : ValuationPathProvenance;

        requirement def <'ACC-025'> ExecutableCapability {
            doc /* As Ring D release governance, a policy or adapter feature shall be reported as supported only when its executable implementation and invariant fixtures pass for the declared version and scope. Trace evidence shall assert required command topology, canonical effect fields, state delta, exact result, and both admitting and rejecting observations; symbol or fixture-name presence alone is insufficient. */
        }
        requirement executableCapability : ExecutableCapability;

        requirement def <'ACC-026'> BookIsolation {
            doc /* Every canonical journal shall belong to exactly one book and every referenced account, chart, period, policy, lot, correction, and report population shall close over that same book; no journal may span book boundaries. */
        }
        requirement bookIsolation : BookIsolation;

        requirement def <'ACC-027'> ImmutableFinancialIdentity {
            doc /* An activated book's owner, kind, functional commodity, primary basis, fiscal calendar identity, and accounting timezone shall never change in place; a migration shall create an explicitly linked successor book with retained evidence. */
        }
        requirement immutableFinancialIdentity : ImmutableFinancialIdentity;

        requirement def <'ACC-028'> OpeningBoundary {
            doc /* Ordinary posting shall be impossible before an immutable opening boundary is activated. A migrated book shall retain one balanced opening journal; a zero-balance new book shall activate without fabricated postings; no later posting may precede the boundary. */
        }
        requirement openingBoundary : OpeningBoundary;

        requirement def <'ACC-029'> FiscalPeriodAdmission {
            doc /* Every accounting date shall resolve to exactly one non-overlapping, gap-free regular fiscal period in a uniquely sequenced calendar. A booked journal shall resolve to one admissible regular or explicit adjustment period. A correction affecting a closed population shall fail until the affected period and every dependent close are explicitly reopened; ordinary replacement into a later period shall never silently rewrite a closed population. */
        }
        requirement fiscalPeriodAdmission : FiscalPeriodAdmission;

        requirement def <'ACC-030'> IdempotentCommand {
            doc /* The protocol shall recompute identity from complete canonical command input before current-state admission. Repeating an ID with identical input shall return the retained success or failure; changed input shall fail without a new effect. A supplied hash inconsistent with canonical input or a command belonging to another book shall not be retained or claim an identity. Valid same-book accounting rejections remain retained. Historical entries violating these invariants shall fail verification, never be dropped or renumbered. */
        }
        requirement idempotentCommand : IdempotentCommand;

        requirement def <'ACC-031'> OrderedBookHistory {
            doc /* Every committed canonical state transition, including chart, calendar, policy, and lot-state evolution, shall receive the next book revision and extend a hash chain over the previous hash plus the complete ordered typed effects. Configuration revision zero and every successor shall retain a complete immutable content-addressed snapshot whose contents can be reconstructed without current state or an optional external service. The active configuration hash and every materialized configuration field shall equal the latest snapshot, while earlier snapshots remain addressable. Every state snapshot shall carry a reproducible content hash whose preimage its genesis configuration selected. Without a state commitment profile the hash shall cover the complete materialized population. With the chain-head state commitment profile the hash shall cover the book identity, status, counters, active configuration and opening boundary, the revision count and the revision chain head, which commits to every effect, and recovery shall prove every materialized collection and retained configuration snapshot equal to the ordered effects; a profile is selected only at genesis and shall never be adopted, changed or removed. Every posted journal shall separately receive the next gap-free posting sequence; rejection and replay shall consume neither. */
        }
        requirement orderedBookHistory : OrderedBookHistory;

        requirement def <'ACC-032'> ReproduciblePeriodControl {
            doc /* Close and reopen shall append immutable atomic effects that pin the ledger, chart, complete policy configuration contents, report population, posting sequence, book revision, and any closing or reversal journal. Every pinned configuration shall resolve its retained historical snapshot after any number of later configuration changes. A close package shall never be mutated after hashing; currentness is derived from later reopen effects. Reopening shall disclose or supersede every dependent later close before it may be presented as current. */
        }
        requirement reproduciblePeriodControl : ReproduciblePeriodControl;

        requirement def <'ACC-033'> ReproducibleReports {
            doc /* Ring C reports shall derive from one explicit population and reproduce identical content for the same book revision, posting cutoff, date range, chart snapshot, basis, and complete reporting-policy snapshot including cash-flow classifications. */
        }
        requirement reproducibleReports : ReproducibleReports;

        requirement def <'ACC-034'> RebuildableProjections {
            doc /* Destroying and rebuilding any projection or book-state snapshot from decoded, schema-versioned canonical revisions shall validate every nested complete content hash and reproduce the incremental state, projection, and source cutoff exactly. */
        }
        requirement rebuildableProjections : RebuildableProjections;

        requirement def <'ACC-035'> CrossBookSeparation {
            doc /* As Ring D orchestration, cross-book activity shall submit independently balanced idempotent commands to each book and retain explicit linkage and partial-completion evidence without creating a multi-book atomic authority. */
        }
        requirement crossBookSeparation : CrossBookSeparation;

        requirement def <'ACC-036'> StoragePortability {
            doc /* As a Ring D quality attribute, the accounting core, command protocol, commit intent, canonical export, and verification fixtures shall not depend on a database, cloud runtime, or deployment vendor. */
        }
        requirement storagePortability : StoragePortability;

        requirement def <'ACC-037'> DimensionalIntegrity {
            doc /* Optional analytic dimensions shall remain separate from account identity and double-entry balance. Every submitted or generated posting shall receive its complete dimension selection from canonical command input, never an empty default or ambient inference. Every selected member shall be active on the accounting date, belong to one dimension and the journal book, occur at most once per dimension on a posting, satisfy every applicable required-dimension policy, and use unique acyclic codes within its snapshot. Omitted, unused, duplicate, or mismatched generated selections shall reject before mutation. */
        }
        requirement dimensionalIntegrity : DimensionalIntegrity;

        requirement def <'ACC-038'> CanonicalIdentity {
            doc /* Every canonical identifier shall be nonempty, unique within its declared global or book scope, and never reassigned. Every retained posting reference shall resolve exactly one same-book journal and posting by journal ID, posting ID, effect key, book, and complete posting content hash; every copied account, commodity, quantity, book value, date, and dimension field shall equal that source. Every accounting effect key shall resolve exactly one prepared and retained journal effect in its command. Every content hash shall identify its algorithm and canonicalization version and cover the complete typed object. Identity equality shall compare canonical content as well as its digest so duplicate, dangling, ambiguous, reused, or collision-conflicting identity fails before mutation.
            Compound source identities shall preserve separate raw coordinates;
            delimiter concatenation shall not allow an unrelated journal/effect
            tuple to shadow a retained source. Same-command overlays may replace
            only the exact same tuple. Prospective collision-free lookup semantics
            shall be explicitly selected and legacy retained outcomes replayed
            under their original semantics, not silently reinterpreted. The
            structuralSourceIdentityV1 profile may be selected at genesis or by
            the explicit monotonic ExecutionProfileAdoption transition. Indexed
            admission shall exhaust the same profile-specific candidate population
            at its pinned head and preserve exact retained outcomes on restart. */
        }
        requirement canonicalIdentity : CanonicalIdentity;

        requirement def <'ACC-039'> DeterministicInventoryCosting {
            doc /* The kernel shall apply one supplied, versioned, dated, and scoped policy for specific-identification, FIFO, LIFO, HIFO, or weighted-average inventory costing. Selection, pool membership, acquisition, disposal, transfer, later directly attributable cost, rebate, production overhead, write-down, and write-down reversal shall conserve exact quantity, historical basis, recognized cost, and separate valuation allowance. Unsupported methods, incoherent pools, negative resulting historical basis, excessive write-down reversal, or a journal/effect mismatch shall fail before mutation. */
        }
        requirement deterministicInventoryCosting : DeterministicInventoryCosting;

        requirement def <'ACC-040'> ProvisionalInventoryIntegrity {
            doc /* Inventory shall become negative only when an explicit applicable policy permits a provisional layer and supplies its deterministic provisional basis. Later receipts shall resolve that layer through immutable exact receipt-lot quantity and basis allocations plus recosting adjustments with complete lineage; ordinary lots shall not become negative, prior journals shall not be rewritten, and a closed affected population shall require an admissible adjustment or reopen. */
        }
        requirement provisionalInventoryIntegrity : ProvisionalInventoryIntegrity;

        requirement def <'ACC-041'> OpenItemSettlementIntegrity {
            doc /* Receivables, payables, credits, settlements, and exact allocation edges shall be immutable same-book accounting facts closed over their exact canonical control-account postings. Allocation shall remain within one settlement scope, support partial and many-to-many application, conserve allocated open-item carrying value, settlement measurement, and both transaction denominations independently, preserve recognition and settlement dates, prohibit over-allocation, and compute each realized exchange difference exactly. A cross-currency difference shall resolve one same-command generated journal effect whose postings equal that difference. */
        }
        requirement openItemSettlementIntegrity : OpenItemSettlementIntegrity;

        requirement def <'ACC-042'> AccountingBasisProjectionIntegrity {
            doc /* Accrual and cash-basis results shall be deterministic reproducible read-side projections of one complete pinned configuration, journal and accounting-effect population, typed source-event classification derived from exact canonical posting fields, settlement graph, and versioned typed basis policy. Partial settlement, credits, write-offs, tax, inventory cost and value adjustment, noncash entries, allocations, remeasurement, and rounding shall each have one explicit treatment. Included, excluded, projected, and residual totals shall reconcile exactly without becoming an alternate journal or canonical mutation. */
        }
        requirement accountingBasisProjectionIntegrity : AccountingBasisProjectionIntegrity;

        requirement def <'ACC-043'> CurrencyRemeasurementIntegrity {
            doc /* Monetary classification, transaction measurement, settlement measurement, realized exchange effects, and period-end unrealized remeasurement shall use complete supplied dated observations, exact canonical posting lineage, exact pre-quantization arithmetic, and the complete policy snapshot retained by the original effect. Every recognized difference shall resolve one same-command generated journal effect with the exact quantized amount. Every required reversal shall exactly reverse the original retained journal rather than resolving current destinations. Prices shall never silently rewrite carrying amount, transaction price, cost basis, or an earlier result. */
        }
        requirement currencyRemeasurementIntegrity : CurrencyRemeasurementIntegrity;

        requirement def <'ACC-044'> AllocationScheduleIntegrity {
            doc /* The kernel shall deterministically compile capitalization, depreciation, amortization, and other time or usage schedules from one exact canonical source posting, residual value, dates, frequency, method parameters, convention, usage facts, and complete retained policy. Exact scheduled amounts plus residual shall equal source basis. Recognition shall append separate linked effects. Estimate change, impairment, disposal, and termination shall append immutable prospective revision effects that preserve recognized-to-date amounts, prohibit superseded future ordinals, and optionally establish one complete successor schedule. Physical asset and register workflow remain outside the kernel. */
        }
        requirement allocationScheduleIntegrity : AllocationScheduleIntegrity;

        requirement def <'ACC-045'> TaxDeterminationIntegrity {
            doc /* Given a resolved transaction, explicit taxable line amounts, tax point, and complete applicable versioned component policies, the kernel shall deterministically calculate inclusive, exclusive, compound, recoverable, partially recoverable, nonrecoverable, reverse-charge, and withholding effects using an acyclic component graph, exact pre-quantization arithmetic, and explicit posting destinations. An inclusive amount must have one exact reconstructing solution. Tax determination and its source transaction shall enter one atomic command intent. Rate discovery, nexus and filing decisions, forms, remittance, and submission remain outside. */
        }
        requirement taxDeterminationIntegrity : TaxDeterminationIntegrity;

        requirement def <'ACC-046'> ConsolidationIntegrity {
            doc /* Consolidation shall consume complete pinned source-book populations, evidence-backed dated control classifications, ownership and voting shares, explicit consolidation and non-controlling-interest methods, account mappings, supplied dated valuation paths under currency-translation and quantization policy, and elimination evidence, then compile reproducible draft transactions for admission through the distinct consolidation book's ordinary command authority. No journal shall span books, no source book shall be rewritten, and missing, stale, circular, unmapped, unmatched, or unbalanced input shall fail closed. */
        }
        requirement consolidationIntegrity : ConsolidationIntegrity;

        requirement def <'ACC-047'> AccountingWorkflowBoundary {
            doc /* Only EvaluateBookCommand may create a BookCommitIntent, only the serialized book authority may commit it, and every specialized accounting calculator shall return a noncanonical draft or read-side projection. EvaluateBookCommand shall close every retained source reference, dimension selection, policy snapshot, exact amount, and effect key over the same command before assigning order. Customers, vendors, documents, asset custody, bank feeds, matching, data acquisition, jurisdiction selection, filing, payment initiation, UI, approvals, and notifications may supply evidence or typed commands but shall not create booked journals, assign book order, or choose accounting policy silently. */
        }
        requirement accountingWorkflowBoundary : AccountingWorkflowBoundary;

        requirement def <'ACC-039.1'> InventoryPolicyAdmission {
            doc /* Exactly one applicable inventory policy and matching supported capability shall be selected at the governed economic time. */
        }
        requirement inventoryPolicyAdmission : InventoryPolicyAdmission;

        requirement def <'ACC-039.2'> InventoryPoolClosure {
            doc /* An inventory cost pool shall name one book, one commodity, and every account whose holdings participate in the calculation. Value adjustment shall distinguish globally valid holdings from policy-scoped live allocation targets: unrelated valid accounts shall not prevent an adjustment, and a target in another account shall not be modified. Fully disposed status requires the complete retained holding population for that lot across all accounts; filtering away a live transferred holding shall not admit recognized-cost catch-up. Historical algorithm behavior is retained only under its explicit versioned compatibility contract. */
        }
        requirement inventoryPoolClosure : InventoryPoolClosure;

        requirement def <'ACC-039.3'> InventoryMethodDeterminism {
            doc /* Specific-identification, FIFO, LIFO, HIFO, and weighted-average selection shall each return one deterministic allocation for identical ordered holdings and request facts. */
        }
        requirement inventoryMethodDeterminism : InventoryMethodDeterminism;

        requirement def <'ACC-039.4'> InventoryQuantityConservation {
            doc /* Every inventory acquisition, disposal, recosting, and transfer shall conserve exact quantity across source, allocation, and remainder. A value-only adjustment shall preserve quantity exactly. Disposal and transfer shall allocate historical basis, valuation allowance, and resulting carrying amount in the same exact quantity proportion so later cost of goods sold cannot diverge from inventory state. */
        }
        requirement inventoryQuantityConservation : InventoryQuantityConservation;

        requirement def <'ACC-039.5'> InventoryBasisConservation {
            doc /* Every inventory acquisition, disposal, recosting, transfer, and later value adjustment shall conserve authoritative exact historical basis, recognized-cost catch-up, and separate valuation allowance before explicit quantization. Directly attributable cost and overhead have positive source amounts; rebates have negative source amounts; all three sum exactly across remaining-basis and recognized-cost changes with zero valuation change. Write-downs are non-positive and reversals non-negative, both have zero basis and recognized-cost change, and affect only remaining valuation allowance. A reversal shall not exceed retained write-down history, and neither historical basis nor carrying amount may become negative. Acquisition shall establish a non-positive valuation allowance and carrying amount equal to historical basis plus that allowance. Inventory issue journals shall recognize allocated carrying value, including the proportionally consumed valuation allowance, while cost-basis annotations and allocations retain historical basis separately. Generated issue journal amounts and identities shall be independently reconstructed under the retained configuration during semantic history validation, not accepted merely because their own hashes and lot effects are internally consistent. */
        }
        requirement inventoryBasisConservation : InventoryBasisConservation;

        requirement def <'ACC-039.6'> InventoryFailureAtomicity {
            doc /* An unsupported method or adjustment kind, incoherent pool, ambiguous selection, over-allocation, nonconserving result, negative historical basis or carrying amount, excessive reversal, closed-period violation, or unmatched generated effect shall return a typed diagnostic without a draft or state delta. */
        }
        requirement inventoryFailureAtomicity : InventoryFailureAtomicity;

        requirement def <'ACC-039.7'> PostedInventoryOwnershipAuthority {
            doc /* An executable cumulative inventory profile shall derive each
            immutable posted anchor from complete authenticated canonical posting,
            predecessor-position and incoming-movement evidence. It shall never
            initialize the posted budget by requantizing current exact carrying
            value or by accepting an unapproved attribution proposal. Current
            positions and movements shall reproduce the pinned anchor's cumulative
            quantity/posted-consumption equations, retain exact economic allocations
            separately, and transfer each selected source share to its destination
            without rerounding by destination order. Command admission, strict codecs,
            source closure and canonical replay implement the typed ownership artifacts. */
        }
        requirement postedInventoryOwnershipAuthority : PostedInventoryOwnershipAuthority;

        requirement def <'ACC-039.8'> QuantityOnlyInventoryCommit {
            doc /* A positive admitted inventory quantity movement whose verified
            posted share is zero shall commit an explicit quantity-only ownership
            effect without a fake journal, posting ID or posting ordinal. It shall
            retain its outcome, increment the financial revision, preserve journal
            posting sequence, and apply the same book, policy, account, dimension,
            opening-boundary, period, identity, authorization and CAS checks as a
            money-bearing movement. Account/commodity/dimension validation shall
            accept a monetary-independent coordinate (book, functional commodity,
            accounting date, account, units commodity and selected members) and
            explicit required dimensions from the applicable resolved policy.
            It shall not invent a posting ID to resolve posting-specific overrides.
            Coordinate validation alone neither resolves policy nor admits quantity,
            ownership, an opening boundary, period, command or commit.
            Mixed zero/nonzero movements shall publish all
            exact lot and ownership effects with the nonzero journal postings
            atomically. Zero signed sum is not a reason to omit a balanced journal;
            only absence of nonzero coordinate postings permits journal omission.
            The typed PostOwnedInventoryTransactionCommand specifies acquisition/issue
            inputs and atomic output topology, verified across command/codec,
            correction/close/replay integration and dual-oracle executors. */
        }
        requirement quantityOnlyInventoryCommit : QuantityOnlyInventoryCommit;

        requirement def <'ACC-039.9'> PostedInventoryHistoryCompatibility {
            doc /* Canonical posted ownership shall use acyclic full-hash source
            dependencies and bounded origin references, not recursive embedded
            histories or a position hash containing its own containing movement's
            hash. Old commands, receipts and encoded artifacts shall not acquire
            new ownership fields or change rounding semantics merely because a
            current policy version changed. A supported explicit algorithm marker
            and reviewed implementation version are required for new ownership;
            existing holdings require a separately governed verified adoption
            transition. Unsupported versions, absent required history, corrupt
            sources and unresolved residuals shall fail closed. Strict serialization,
            source-origin resolution, migration admission and restart replay are
            implemented and fail closed on invalid or unsupported artifacts. */
        }
        requirement postedInventoryHistoryCompatibility : PostedInventoryHistoryCompatibility;

        requirement def <'ACC-040.1'> ProvisionalShortageAuthorization {
            doc /* A shortage shall open a provisional layer only when the one applicable policy explicitly authorizes provisional-negative treatment. */
        }
        requirement provisionalShortageAuthorization : ProvisionalShortageAuthorization;

        requirement def <'ACC-040.2'> ProvisionalBasisDeterminism {
            doc /* Every provisional layer shall obtain one exact basis from the policy-declared last-receipt, moving-average, standard-cost, or explicit-rate method. */
        }
        requirement provisionalBasisDeterminism : ProvisionalBasisDeterminism;

        requirement def <'ACC-040.3'> ProvisionalReceiptAllocation {
            doc /* Each recosting shall allocate exact receipt-lot quantities and bases without resolving more than the layer's derived open quantity. */
        }
        requirement provisionalReceiptAllocation : ProvisionalReceiptAllocation;

        requirement def <'ACC-040.4'> ProvisionalRecostingImmutability {
            doc /* Recosting shall append a linked adjustment effect and shall not rewrite the provisional layer, receipt lot, or prior journal. */
        }
        requirement provisionalRecostingImmutability : ProvisionalRecostingImmutability;

        requirement def <'ACC-040.5'> ProvisionalPeriodAdmission {
            doc /* A recosting that affects a closed population shall be rejected unless it enters an admissible later-period adjustment or an explicit reopen. */
        }
        requirement provisionalPeriodAdmission : ProvisionalPeriodAdmission;

        requirement def <'ACC-041.1'> OpenItemRecognitionIdentity {
            doc /* Each receivable, payable, credit, and settlement shall be an immutable same-book fact linked to one canonical control-account posting whose account, commodity, quantity, book value, dimensions, and accounting date exactly reconcile to the fact. One canonical posting shall have at most one financial source owner, either an open-item fact or a settlement fact; switching families shall not create another budget. Changing a fact or reference identifier shall not create new authority over an already represented posting. Source ownership uses the complete raw book, journal, effect-key and posting tuple, independently of delimiter aliases or reference metadata. A duplicate owner shall fail without financial effects; unsafe historical duplicate owners shall fail semantic restoration rather than be silently repaired. */
        }
        requirement openItemRecognitionIdentity : OpenItemRecognitionIdentity;

        requirement def <'ACC-041.2'> SettlementScopeIntegrity {
            doc /* A settlement allocation shall connect facts in the same book and the same explicit counterparty-and-control-account scope. */
        }
        requirement settlementScopeIntegrity : SettlementScopeIntegrity;

        requirement def <'ACC-041.3'> SettlementGraphCardinality {
            doc /* The allocation graph shall support partial, one-to-many, many-to-one, and many-to-many settlement without a mutable settled flag. A new payment or credit may remain wholly unallocated. Later applications reuse its immutable identity and source, never create a duplicate payment, and retain their own effective application time. Closed periods cannot receive new allocation edges merely because no journal is needed. All command forms enforce this rule: omitted-operation new settlements use their settlement date, and explicit later applications use their own application date. Restored effects shall be checked against the period state immediately before their revision; valid checksums cannot authorize an allocation into a then-closed period. Retained retries return their original result independently of subsequent close or reopen transitions. */
        }
        requirement settlementGraphCardinality : SettlementGraphCardinality;

        requirement def <'ACC-041.4'> SettlementBookValueConservation {
            doc /* Allocation edges shall separately retain and not exceed the open item's allocated carrying book value and the settlement's allocated functional-currency measurement, cumulatively across all commands. Later applications must use the complete prior settlement and open-item totals, not reset either budget. Each allocated book value shall equal its corresponding denomination quantity's exact proportional share of that source's complete book value. Their exact difference shall not be hidden inside one shared amount; fully allocating a source denomination shall leave no unallocated source book value. */
        }
        requirement settlementBookValueConservation : SettlementBookValueConservation;

        requirement def <'ACC-041.5'> SettlementDenominationConservation {
            doc /* Allocation edges shall conserve open-item and settlement denominations independently, including all prior applications and every pending edge in the command. Unknown prior totals shall fail closed, never count as zero. */
        }
        requirement settlementDenominationConservation : SettlementDenominationConservation;

        requirement def <'ACC-041.6'> SettlementExchangeLineage {
            doc /* A cross-denomination allocation shall preserve recognition and settlement times, use one complete dated valuation path from settlement denomination to the book's functional commodity identified by its supplied quantization policy, compute the exact pre-quantization difference between allocated functional-currency carrying value and settlement measurement, and bind its quantized result to exactly one balanced same-command generated effect. The open-item denomination may be a third commodity and shall not be mistaken for functional currency. Each settlement source shall oppose its allocated open-item source's signed control balance. Gain and loss direction shall derive from those canonical signs, including payables and credits, not from account names. Offsetting gains and losses shall retain a generated effect even when their net is zero; zero-difference edges shall not require a generated-effect key. */
        }
        requirement settlementExchangeLineage : SettlementExchangeLineage;

        requirement def <'ACC-042.1'> BasisSnapshotCompleteness {
            doc /* A basis projection shall consume one content-hashed snapshot containing the complete configuration, journal population, open items, settlements, allocation edges, inventory recostings and value adjustments, allocation recognitions, tax determinations, remeasurement results, and every typed source event through exact book-revision and posting-sequence cutoffs. */
        }
        requirement basisSnapshotCompleteness : BasisSnapshotCompleteness;

        requirement def <'ACC-042.2'> BasisEventClassification {
            doc /* Every in-scope source posting through the cutoff shall resolve one exact canonical posting reference and exactly one supplied accounting-basis event classification, including postings whose treatment is exclude. Source amounts and settlement ratios shall be derived from retained accounting facts, never trusted as caller-computed values or inferred from account names. A settlement-ratio classification shall bind to the source transaction's own open item by canonical journal and effect identity; another transaction's settlement graph shall not authorize recognition. */
        }
        requirement basisEventClassification : BasisEventClassification;

        requirement def <'ACC-042.3'> BasisPolicyCompleteness {
            doc /* The applicable capability-gated basis policy shall define exactly one treatment for every event kind present in the snapshot. */
        }
        requirement basisPolicyCompleteness : BasisPolicyCompleteness;

        requirement def <'ACC-042.4'> BasisProjectionDeterminism {
            doc /* Identical snapshot, policy, settlement graph, and quantization inputs shall produce identical ordered projection entries and content hash. */
        }
        requirement basisProjectionDeterminism : BasisProjectionDeterminism;

        requirement def <'ACC-042.5'> BasisProjectionReconciliation {
            doc /* Accrual and cash results shall each expose machine-checkable source, included, excluded, projected-exact, projected-book-value, and quantization-residual totals. Source shall equal included plus excluded, projected exact shall equal included, projected book value plus residual shall equal projected exact, and the complete settlement allocation graph shall reconcile. */
        }
        requirement basisProjectionReconciliation : BasisProjectionReconciliation;

        requirement def <'ACC-042.6'> BasisProjectionReadOnly {
            doc /* Basis projection shall create no BookEffectDraft, BookCommitIntent, journal, revision, posting sequence, or canonical state mutation. */
        }
        requirement basisProjectionReadOnly : BasisProjectionReadOnly;

        requirement def <'ACC-043.1'> MonetaryClassificationAdmission {
            doc /* Each remeasured position shall resolve exactly one applicable capability-gated monetary-classification rule for its source account. */
        }
        requirement monetaryClassificationAdmission : MonetaryClassificationAdmission;

        requirement def <'ACC-043.2'> CurrencyValuationInputCompleteness {
            doc /* Remeasurement shall use only supplied dated valuation paths that connect the position denomination to the book's functional commodity under the pinned policy. */
        }
        requirement currencyValuationInputCompleteness : CurrencyValuationInputCompleteness;

        requirement def <'ACC-043.3'> RealizedExchangeCalculation {
            doc /* A realized exchange effect shall equal the exact difference between allocated carrying book value and settlement measurement before quantization, and the named effect key shall resolve exactly one generated journal whose gain or loss postings equal the quantized difference. */
        }
        requirement realizedExchangeCalculation : RealizedExchangeCalculation;

        requirement def <'ACC-043.4'> UnrealizedRemeasurementCalculation {
            doc /* A period-end unrealized effect shall equal the exact difference between an open monetary position's carrying value and closing measurement before quantization. Its quantity and carrying value shall retain the canonical source posting's signs and deduct that source's already allocated settlement quantities and carrying values, whether the source owns an open item or a payment. Immediate and later payment applications consume the same budget. Source occupancy and active adjustments shall use the underlying canonical posting identity, not an independently named reference record. An active unrealized result for that source shall be explicitly reversed before another remeasurement or settlement against the original carrying basis; active adjustments shall not stack or disappear into stale settlement arithmetic. */
        }
        requirement unrealizedRemeasurementCalculation : UnrealizedRemeasurementCalculation;

        requirement def <'ACC-043.5'> RemeasurementEffectImmutability {
            doc /* Every recognized exchange difference and required later reversal shall be separate immutable linked effects. An explicit unrealized-result reversal is also allowed when policy does not mandate an automatic reversal. A reversal shall negate the exact original retained journal, dimensions, policy identity, and lineage instead of resolving current policy destinations. Multiple overdue required reversals shall be dischargeable one at a time in either order; another overdue position shall not block a valid explicit reversal. Non-reversal commands remain blocked until every due obligation is discharged. Generic journal correction shall not alter currency-result or currency-reversal journals: their monetary postings and currency lifecycle must transition together, preventing a second reversal through another command family. */
        }
        requirement remeasurementEffectImmutability : RemeasurementEffectImmutability;

        requirement def <'ACC-043.6'> RemeasurementPriceSeparation {
            doc /* Remeasurement shall not rewrite transaction price, cost basis, original book value, valuation observations, or an earlier result. */
        }
        requirement remeasurementPriceSeparation : RemeasurementPriceSeparation;

        requirement def <'ACC-044.1'> AllocationInputCompleteness {
            doc /* Schedule compilation shall receive one closed canonical source-posting reference, source basis derived from it, residual value, start and end dates, frequency, convention, method parameters, policy-effective time, complete policy snapshot, and quantization policy. */
        }
        requirement allocationInputCompleteness : AllocationInputCompleteness;

        requirement def <'ACC-044.2'> AllocationMethodAdmission {
            doc /* Straight-line, declining-balance, and units-of-production methods shall be admitted only with their required capability evidence and method parameters. */
        }
        requirement allocationMethodAdmission : AllocationMethodAdmission;

        requirement def <'ACC-044.3'> AllocationBasisConservation {
            doc /* Exact scheduled amounts plus residual value shall equal source basis, with every decimal amount accompanied by its quantization residual. A prospective cumulative posting plan shall additionally conserve posted source basis less the explicitly quantized residual. Its immutable ordinal amounts shall not depend on recognition arrival order. A plan shall not authenticate its own supplied posted source basis: command admission must resolve that basis and prior recognized decimals from canonical source and recognition journals. Legacy schedules retain their original independent-rounding algorithm and exact historical effects; no missing plan may be synthesized as a historical rewrite. */
        }
        requirement allocationBasisConservation : AllocationBasisConservation;

        requirement def <'ACC-044.4'> AllocationScheduleImmutability {
            doc /* A compiled allocation schedule and every later revision shall be immutable, independently content-hashed, and retain their complete executable policy identities and evidence. A revision shall pin the exact prior-recognition set and its recognized-to-date and carrying totals. Cumulative algorithm 1.1.0 shall additionally retain postedRecognizedToDate and postedCarryingAmountAtRevision, derived from its original plan's verified posted ordinals; these are distinct from the exact economic totals. A successor takes posted carrying plus the quantized adjustment as its source basis. The exact adjustment and its residual remain explicit even when the generated journal uses the booked decimal. Estimate change requires exactly one successor and no adjustment amount or journal; impairment requires one exact supplied adjustment amount, its matching quantization proof and journal effect, and a successor for any continuing allocable basis; disposal and termination permit no successor and require one exact supplied adjustment amount and matching effect exactly when the relevant carrying value remains (posted carrying for cumulative schedules, original exact carrying for legacy replay). A fully allocated cumulative asset may therefore be disposed without a fabricated zero-value adjustment journal. Conversion between these algorithms and posting-account or quantization-policy changes require a verified transition, not reinterpretation of old effects. */
        }
        requirement allocationScheduleImmutability : AllocationScheduleImmutability;

        requirement def <'ACC-044.5'> AllocationRecognitionIdentity {
            doc /* Recognition shall append at most one effect for each schedule ordinal and shall not mutate the schedule. A prospective estimate change or impairment shall reject until every original installment earlier than its effective date has been recognized; otherwise its unrecognized amount could be allocated again by both schedules. After that revision, no original ordinal at or after its effective date may be recognized; only the successor schedule, when present, may supply future ordinals. Disposal or termination closes every unrecognized ordinal of the original schedule, including earlier-dated ordinals; a backdated recognition may not change the carrying amount after the terminal revision. */
        }
        requirement allocationRecognitionIdentity : AllocationRecognitionIdentity;

        requirement def <'ACC-044.6'> AllocationPeriodAdmission {
            doc /* Each recognition, impairment, disposal, or termination effect shall pass the ordinary account, dimension, fiscal-period, quantization, journal-balance, effect-key, and command-replay rules. When a disposal revision supplies a completion journal, both journals and the immutable terminal schedule revision shall enter one atomic intent and one book revision. The completion journal shall have the same accounting date and exactly clear the generated carrying-value adjustment account in units and book value. A rejected completion, closed period, stale revision, identity conflict, or failed commit shall leave both the schedule and financial state unchanged. Replay and durable restoration shall preserve the complete operation. */
        }
        requirement allocationPeriodAdmission : AllocationPeriodAdmission;

        requirement def <'ACC-045.1'> TaxInputCompleteness {
            doc /* Tax determination shall receive one resolved transaction, explicit taxable-line amounts, explicit tax point, and complete applicable policy references. */
        }
        requirement taxInputCompleteness : TaxInputCompleteness;

        requirement def <'ACC-045.2'> TaxComponentGraphIntegrity {
            doc /* Tax components shall form an acyclic compound graph whose dependencies exist and precede each dependent component. */
        }
        requirement taxComponentGraphIntegrity : TaxComponentGraphIntegrity;

        requirement def <'ACC-045.3'> InclusiveTaxReconstruction {
            doc /* A tax-inclusive line shall be admitted only when one exact exclusive basis reconstructs the stated amount under the complete component graph. */
        }
        requirement inclusiveTaxReconstruction : InclusiveTaxReconstruction;

        requirement def <'ACC-045.4'> TaxExactQuantization {
            doc /* Every component shall calculate from an exact rational basis and rate before recording its explicit quantization result and residual under an explicitly declared rounding level (line-level or document-level). Document-level rounding groups shall aggregate taxable basis and deterministically allocate rounded amounts and residuals back to lines so that line amounts, tax totals, counterparty amounts, and committed postings reconcile exactly without generic rounding discrepancies. */
        }
        requirement taxExactQuantization : TaxExactQuantization;

        requirement def <'ACC-045.5'> TaxTreatmentDestinations {
            doc /* Output, input, reverse-charge, withholding, recoverable, partially recoverable, and nonrecoverable amounts shall post only to policy-declared same-book destinations. */
        }
        requirement taxTreatmentDestinations : TaxTreatmentDestinations;

        requirement def <'ACC-045.6'> TaxTransactionAtomicity {
            doc /* The source transaction, tax determination, generated postings, and provenance shall enter one BookCommitIntent or all reject without state change. */
        }
        requirement taxTransactionAtomicity : TaxTransactionAtomicity;

        requirement def <'ACC-045.7'> TaxWorkflowExclusion {
            doc /* The kernel shall not discover jurisdiction, nexus, rates, filing status, forms, remittance, or submission decisions. */
        }
        requirement taxWorkflowExclusion : TaxWorkflowExclusion;

        requirement def <'ACC-046.1'> ConsolidationPopulationCompleteness {
            doc /* Consolidation shall receive every source book's complete content-hashed population at explicit book-revision and posting-sequence cutoffs. */
        }
        requirement consolidationPopulationCompleteness : ConsolidationPopulationCompleteness;

        requirement def <'ACC-046.2'> ConsolidationRelationshipAdmission {
            doc /* Every source shall have evidence-backed effective-dated control classification, ownership share, voting share, and compatible consolidation and non-controlling-interest methods. A partially owned full-consolidation source shall select exactly one NCI method. Proportionate NCI shall be the exact non-parent share of translated net assets; fair-value NCI shall use one supplied non-positive exact book amount. Full ownership and non-full consolidation methods shall reject NCI inputs. The compilation shall reclassify that exact credit from the policy's parent-attributable-equity account to its NCI account without changing total equity. */
        }
        requirement consolidationRelationshipAdmission : ConsolidationRelationshipAdmission;

        requirement def <'ACC-046.3'> ConsolidationMappingCompleteness {
            doc /* Every nonzero source account balance shall resolve exactly one applicable source-to-target account mapping. Source coordinates are the raw book/account tuple, not a delimiter-concatenated identifier. Ambiguous textual sort keys shall use a deterministic raw-tuple tie-breaker rather than supplied array order. */
        }
        requirement consolidationMappingCompleteness : ConsolidationMappingCompleteness;

        requirement def <'ACC-046.4'> ConsolidationTranslationCompleteness {
            doc /* Every cross-currency source balance shall use one supplied dated valuation path selected by an applicable translation rule and policy. */
        }
        requirement consolidationTranslationCompleteness : ConsolidationTranslationCompleteness;

        requirement def <'ACC-046.5'> ConsolidationEliminationEvidence {
            doc /* Every elimination shall link the matched source postings and exact amount; an unexplained difference shall fail closed. Source posting identities are scoped by source book: equal local posting IDs in distinct books are independent, while repeated consumption within one source book shall reject. */
        }
        requirement consolidationEliminationEvidence : ConsolidationEliminationEvidence;

        requirement def <'ACC-046.6'> ConsolidationAdjustmentBalance {
            doc /* Mapping, translation, elimination, ownership, and non-controlling-interest adjustments shall compile to exactly balanced target-book draft transactions. */
        }
        requirement consolidationAdjustmentBalance : ConsolidationAdjustmentBalance;

        requirement def <'ACC-046.7'> ConsolidationBookIsolation {
            doc /* Consolidation shall mutate no source book and shall admit its draft only through the distinct target book's ordinary command authority. */
        }
        requirement consolidationBookIsolation : ConsolidationBookIsolation;

        requirement def <'ACC-046.8'> ConsolidationFailureAtomicity {
            doc /* A stale, circular, unmapped, untranslated, unmatched, unsupported, or unbalanced consolidation input shall return a typed diagnostic without target-book state change. */
        }
        requirement consolidationFailureAtomicity : ConsolidationFailureAtomicity;

        requirement def <'ACC-047.1'> SoleIntentFactory {
            doc /* EvaluateBookCommand shall be the only action permitted to create a BookCommitIntent. */
        }
        requirement soleIntentFactory : SoleIntentFactory;

        requirement def <'ACC-047.2'> CalculatorDraftBoundary {
            doc /* A specialized accounting calculator shall output only a noncanonical BookEffectDraft or a read-side projection plus typed diagnostics. */
        }
        requirement calculatorDraftBoundary : CalculatorDraftBoundary;

        requirement def <'ACC-047.3'> SoleCommitAuthority {
            doc /* The serialized book authority shall be the only component permitted to assign and atomically commit book revision and posting sequence. */
        }
        requirement soleCommitAuthority : SoleCommitAuthority;

        requirement def <'ACC-047.4'> ExternalWorkflowInputBoundary {
            doc /* External product workflows shall supply only evidence, resolved facts, or typed commands to the accounting boundary. */
        }
        requirement externalWorkflowInputBoundary : ExternalWorkflowInputBoundary;

        requirement def <'ACC-047.5'> ExternalAuthorityProhibition {
            doc /* No external workflow shall create a booked journal, choose accounting policy silently, assign book order, overwrite history, or persist a canonical effect directly. */
        }
        requirement externalAuthorityProhibition : ExternalAuthorityProhibition;

        #derivation connection inventoryRequirementDerivation {
            end #original ::> deterministicInventoryCosting;
            end #derive ::> inventoryPolicyAdmission;
            end #derive ::> inventoryPoolClosure;
            end #derive ::> inventoryMethodDeterminism;
            end #derive ::> inventoryQuantityConservation;
            end #derive ::> inventoryBasisConservation;
            end #derive ::> inventoryFailureAtomicity;
            end #derive ::> postedInventoryOwnershipAuthority;
            end #derive ::> quantityOnlyInventoryCommit;
            end #derive ::> postedInventoryHistoryCompatibility;
        }

        #derivation connection provisionalInventoryRequirementDerivation {
            end #original ::> provisionalInventoryIntegrity;
            end #derive ::> provisionalShortageAuthorization;
            end #derive ::> provisionalBasisDeterminism;
            end #derive ::> provisionalReceiptAllocation;
            end #derive ::> provisionalRecostingImmutability;
            end #derive ::> provisionalPeriodAdmission;
        }

        #derivation connection settlementRequirementDerivation {
            end #original ::> openItemSettlementIntegrity;
            end #derive ::> openItemRecognitionIdentity;
            end #derive ::> settlementScopeIntegrity;
            end #derive ::> settlementGraphCardinality;
            end #derive ::> settlementBookValueConservation;
            end #derive ::> settlementDenominationConservation;
            end #derive ::> settlementExchangeLineage;
        }

        #derivation connection basisRequirementDerivation {
            end #original ::> accountingBasisProjectionIntegrity;
            end #derive ::> basisSnapshotCompleteness;
            end #derive ::> basisEventClassification;
            end #derive ::> basisPolicyCompleteness;
            end #derive ::> basisProjectionDeterminism;
            end #derive ::> basisProjectionReconciliation;
            end #derive ::> basisProjectionReadOnly;
        }

        #derivation connection currencyRequirementDerivation {
            end #original ::> currencyRemeasurementIntegrity;
            end #derive ::> monetaryClassificationAdmission;
            end #derive ::> currencyValuationInputCompleteness;
            end #derive ::> realizedExchangeCalculation;
            end #derive ::> unrealizedRemeasurementCalculation;
            end #derive ::> remeasurementEffectImmutability;
            end #derive ::> remeasurementPriceSeparation;
        }

        #derivation connection allocationRequirementDerivation {
            end #original ::> allocationScheduleIntegrity;
            end #derive ::> allocationInputCompleteness;
            end #derive ::> allocationMethodAdmission;
            end #derive ::> allocationBasisConservation;
            end #derive ::> allocationScheduleImmutability;
            end #derive ::> allocationRecognitionIdentity;
            end #derive ::> allocationPeriodAdmission;
        }

        #derivation connection taxRequirementDerivation {
            end #original ::> taxDeterminationIntegrity;
            end #derive ::> taxInputCompleteness;
            end #derive ::> taxComponentGraphIntegrity;
            end #derive ::> inclusiveTaxReconstruction;
            end #derive ::> taxExactQuantization;
            end #derive ::> taxTreatmentDestinations;
            end #derive ::> taxTransactionAtomicity;
            end #derive ::> taxWorkflowExclusion;
        }

        #derivation connection consolidationRequirementDerivation {
            end #original ::> consolidationIntegrity;
            end #derive ::> consolidationPopulationCompleteness;
            end #derive ::> consolidationRelationshipAdmission;
            end #derive ::> consolidationMappingCompleteness;
            end #derive ::> consolidationTranslationCompleteness;
            end #derive ::> consolidationEliminationEvidence;
            end #derive ::> consolidationAdjustmentBalance;
            end #derive ::> consolidationBookIsolation;
            end #derive ::> consolidationFailureAtomicity;
        }

        #derivation connection workflowBoundaryRequirementDerivation {
            end #original ::> accountingWorkflowBoundary;
            end #derive ::> soleIntentFactory;
            end #derive ::> calculatorDraftBoundary;
            end #derive ::> soleCommitAuthority;
            end #derive ::> externalWorkflowInputBoundary;
            end #derive ::> externalAuthorityProhibition;
        }
    }

    package Behavior {
        action def NormalizeSource {
            in item raw : Domain::RawSourceRecord;
            out item normalized : Domain::NormalizedEconomicEvent;
        }

        action def ProposeTransaction {
            in item normalized : Domain::NormalizedEconomicEvent;
            out item proposed : Domain::ProposedTransaction;
        }

        action def ResolveTransaction {
            in item proposed : Domain::ProposedTransaction;
            in item bookingPolicy : Domain::BookingPolicy;
            in item quantizationPolicy : Domain::QuantizationPolicy;
            out item resolved : Domain::ResolvedTransaction;
        }

        action def ValidateTransaction {
            in item resolved : Domain::ResolvedTransaction;
            out item validated : Domain::ResolvedTransaction;
        }

        action def RunBoundaryResolutionPipeline {
            doc /* Boundary translation may normalize external evidence and resolve proposals, but it cannot book. Only EvaluateBookCommand may create a canonical commit intent. */
            in item raw : Domain::RawSourceRecord;
            in item bookingPolicy : Domain::BookingPolicy;
            in item quantizationPolicy : Domain::QuantizationPolicy;
            out item resolved : Domain::ResolvedTransaction;

            action normalize : NormalizeSource;
            action propose : ProposeTransaction;
            action resolve : ResolveTransaction;
            action validate : ValidateTransaction;

            flow raw to normalize.raw;
            flow normalize.normalized to propose.normalized;
            flow propose.proposed to resolve.proposed;
            flow bookingPolicy to resolve.bookingPolicy;
            flow quantizationPolicy to resolve.quantizationPolicy;
            flow resolve.resolved to validate.resolved;
            flow validate.validated to resolved;

            first normalize;
            then propose;
            then resolve;
            then validate;
        }

        action def EvaluateBookCommand {
            doc /* The sole canonical intent factory. The complete snapshot and typed command are the authority; internal calculators may return drafts, but this action alone validates them, assigns the next revision and posting sequence, and produces an intent without I/O or ambient state.
            The shared journal-preparation implementation may consume complete configuration,
            explicit journal/posting identity presence or absence (including same-command
            prepared effects), and the selected period's closure status. Unresolved evidence
            is not absence or openness. Its candidate journal, supplied order and closed-period
            override are noncanonical until this action validates the entire command context;
            the helper does not replace protocol, chronology, opening, FX, source-closure,
            correction, lot or intent-topology admission, nor create a commit intent.
            The shared protocol prefix may consume explicit retained-command presence
            or absence and the last financial commit time. Exact retries precede current
            admission; retained rejections do not advance that financial clock. Unresolved
            evidence is not absence. Continue from this prefix means further evaluation
            is required, and a finished candidate result is not a durable receipt.
            Shared financial-identity validation compares chart scope, current financial
            identity and its complete hash against the original activation's pinned hash.
            Shared configuration validation requires the complete fiscal/chart/policy
            population. Neither validator authenticates supplied history or replaces
            full state integrity. Preserve ordering: protocol, financial identity, full
            state integrity, expected revision, then complete configuration semantics.
            Shared book-wide guards follow configuration and precede command dispatch.
            Specialized accounting requires an activated open book before looking up
            overdue FX. The shared FX eligibility predicate uses the first matching
            current policy, a strict prior-date test and the explicit reversal exception;
            callers still prove the complete unreversed population and canonical order.
            Missing evidence is not absence, and these guards alone cannot book.
            Inventory cost admission compares the complete canonical layer population
            with submitted layers using exact identity, account, acquisition time,
            quantity and basis equality, independently of input ordering. A shared
            comparison helper does not prove that supplied canonical layers are
            complete or authenticated, or replace policy, costing, disposal and
            generated-journal admission. */
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item intent : Domain::BookCommitIntent;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def EvaluateInventoryCost {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def EvaluateInventoryValueAdjustment {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def EvaluateOpenItemRecognition {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def EvaluateSettlement {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def ProjectAccountingBasis {
            in item readSnapshot : Domain::AccountingReadSnapshot;
            in item policy : Domain::AccountingBasisPolicy;
            out item projection : Domain::AccountingBasisProjection;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def CompileCurrencyRemeasurement {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def CompileAllocationSchedule {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def RecognizeScheduledAllocation {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def ReviseAllocationSchedule {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def DetermineTax {
            in item bookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def CompileConsolidation {
            in item targetBookState : Domain::BookStateSnapshot;
            in item command : Domain::BookCommand;
            out item draft : Domain::BookEffectDraft;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        action def CommitBookIntent {
            doc /* The application shell compares the expected complete head,
            serializes the book, and commits the complete intent atomically.
            Reevaluate untrusted intent and verify complete effect topology first.
            Shared record construction preserves the existing revision/effect/result
            hash preimages and does not bypass state commitment or durable CAS. */
            in item context : Domain::BookCommitRecordContext;
            in item intent : Domain::BookCommitIntent;
            out item commit : Domain::AtomicBookCommit;
        }

        action def PrepareBookCommitRecords {
            in item context : Domain::BookCommitRecordContext;
            in item intent : Domain::BookCommitIntent;
            out item candidate : Domain::BookCommitRecordCandidate;
            doc /* Check exact command/intent content hashes and predecessor
            book/revision/hash identity. Use the admitted next financial revision,
            original command times and immutable effects to construct the revision,
            retained original result and response. Canonicalize/copy command input
            through the same legacy ownership procedure. A correctly hashed but
            inadmissible intent may produce mathematical records; it must still
            fail authoritative command evaluation before any state or storage
            mutation. This action assigns no independent accounting authority. */
        }

        action def CompileFinancialReports {
            in item population : Domain::ReportPopulation;
            out item report : Domain::FinancialReport[6];
        }

        action def RebuildProjection {
            in item book : Domain::Book;
            in item throughRevision : Domain::RevisionRecord[1..*];
            out item checkpoint : Domain::ProjectionCheckpoint;
        }
    }

    package Architecture {
        port def IntakePort {
            in item raw : Domain::RawSourceRecord;
        }

        port def ResolutionPort {
            in item raw : Domain::RawSourceRecord;
            out item resolved : Domain::ResolvedTransaction;
            out item diagnostic : Domain::SemanticDiagnostic[0..*];
        }

        port def EvidencePort {
            in item evidence : Domain::SourceEvidence;
        }

        port def BookCommandPort {
            in item command : Domain::BookCommand;
            out item result : Domain::BookCommandResult;
        }

        port def CanonicalExportPort {
            in item book : Domain::Book;
        }

        part def SourceGateway {
            port intake : IntakePort;
        }

        part def BoundaryResolutionService {
            port resolution : ResolutionPort;
            part normalizationEngine : NormalizationEngine;
            perform action resolutionPipeline : Behavior::RunBoundaryResolutionPipeline;
        }

        part def NumericKernel;
        part def NormalizationEngine;
        part def PolicyResolver;
        part def LotEngine;
        part def InventoryCostEngine {
            perform action evaluateInventoryCost : Behavior::EvaluateInventoryCost;
            perform action evaluateInventoryValueAdjustment : Behavior::EvaluateInventoryValueAdjustment;
        }
        part def SettlementEngine {
            perform action evaluateOpenItemRecognition : Behavior::EvaluateOpenItemRecognition;
            perform action evaluateSettlement : Behavior::EvaluateSettlement;
        }
        part def AccountingBasisProjectionEngine {
            perform action projectAccountingBasis : Behavior::ProjectAccountingBasis;
        }
        part def CurrencyRemeasurementEngine {
            perform action compileCurrencyRemeasurement : Behavior::CompileCurrencyRemeasurement;
        }
        part def AllocationScheduleEngine {
            perform action compileAllocationSchedule : Behavior::CompileAllocationSchedule;
            perform action recognizeScheduledAllocation : Behavior::RecognizeScheduledAllocation;
            perform action reviseAllocationSchedule : Behavior::ReviseAllocationSchedule;
        }
        part def TaxDeterminationEngine {
            perform action determineTax : Behavior::DetermineTax;
        }
        part def ConsolidationCompiler {
            perform action compileConsolidation : Behavior::CompileConsolidation;
        }
        part def ValuationEngine;
        part def InvariantValidator;
        part def PeriodEngine;
        part def ReportCompiler {
            perform action compileReports : Behavior::CompileFinancialReports;
        }

        part def PureAccountingCore {
            part numericKernel : NumericKernel;
            part policyResolver : PolicyResolver;
            part lotEngine : LotEngine;
            part inventoryCostEngine : InventoryCostEngine;
            part settlementEngine : SettlementEngine;
            part currencyRemeasurementEngine : CurrencyRemeasurementEngine;
            part allocationScheduleEngine : AllocationScheduleEngine;
            part taxDeterminationEngine : TaxDeterminationEngine;
            part consolidationCompiler : ConsolidationCompiler;
            part invariantValidator : InvariantValidator;
            part periodEngine : PeriodEngine;
            perform action evaluateCommand : Behavior::EvaluateBookCommand;
        }

        part def BookRepository;
        part def JournalRepository;
        part def RevisionRepository;
        part def ProjectionRepository {
            perform action rebuildProjection : Behavior::RebuildProjection;
        }
        part def EvidenceRepository;
        part def PolicyRepository;
        part def PriceObservationRepository;
        part def ReconciliationService;
        part def CanonicalExporter;
        part def AdapterRegistry;
        part def CapabilityRegistry;
        part def TransactionalOutbox;
        part def AuthorizationService;
        part def IdempotencyService;
        part def TransactionCoordinator;
        part def SerializedBookAuthority {
            doc /* Exactly one logical serialization authority admits canonical changes for a book. Its deployment may be a database lock protocol, actor, or Durable Object. */
            port command : BookCommandPort;
            perform action commitIntent : Behavior::CommitBookIntent;
        }

        part def StorageAdapter;

        part def AccountingApplicationService {
            part authorization : AuthorizationService;
            part idempotency : IdempotencyService;
            part transactionCoordinator : TransactionCoordinator;
            part bookAuthority : SerializedBookAuthority;
        }

        part def Backend {
            part sourceGateway : SourceGateway;
            part boundaryResolution : BoundaryResolutionService;
            part applicationService : AccountingApplicationService;
            part accountingCore : PureAccountingCore;
            part bookRepository : BookRepository;
            part journalRepository : JournalRepository;
            part revisionRepository : RevisionRepository;
            part projectionRepository : ProjectionRepository;
            part evidenceRepository : EvidenceRepository;
            part policyRepository : PolicyRepository;
            part priceRepository : PriceObservationRepository;
            part valuationEngine : ValuationEngine;
            part accountingBasisProjectionEngine : AccountingBasisProjectionEngine;
            part reportCompiler : ReportCompiler;
            part reconciliationService : ReconciliationService;
            part canonicalExporter : CanonicalExporter;
            part adapterRegistry : AdapterRegistry;
            part capabilityRegistry : CapabilityRegistry;
            part outbox : TransactionalOutbox;
            part storageAdapter : StorageAdapter;
        }

        part rastrataBackend : Backend {
            satisfy Requirements::exactArithmetic by accountingCore.numericKernel;
            satisfy Requirements::typedMonetarySemantics by accountingCore;
            satisfy Requirements::exactBalance by accountingCore.invariantValidator;
            satisfy Requirements::immutablePosting by journalRepository;
            satisfy Requirements::resolvedInputBoundary by accountingCore.invariantValidator;
            satisfy Requirements::deterministicPureCore by accountingCore;
            satisfy Requirements::failClosedAmbiguity by accountingCore.policyResolver;
            satisfy Requirements::lotIdentity by accountingCore.lotEngine;
            satisfy Requirements::basisConservation by accountingCore.lotEngine;
            satisfy Requirements::authoritativeTotalBasis by accountingCore.lotEngine;
            satisfy Requirements::transferContinuity by accountingCore.lotEngine;
            satisfy Requirements::versionedPolicy by policyRepository;
            satisfy Requirements::priceSeparation by valuationEngine;
            satisfy Requirements::valuationPathProvenance by valuationEngine;
            satisfy Requirements::temporalSemantics by accountingCore.invariantValidator;
            satisfy Requirements::accountLifecycle by accountingCore.invariantValidator;
            satisfy Requirements::evidenceAssertions by evidenceRepository;
            satisfy Requirements::reconciliationGraph by reconciliationService;
            satisfy Requirements::derivationProvenance by evidenceRepository;
            satisfy Requirements::canonicalJournalIntegrity by accountingCore.invariantValidator;
            satisfy Requirements::orderIndependentMeaning by accountingCore;
            satisfy Requirements::canonicalInterchange by canonicalExporter;
            satisfy Requirements::atomicPersistence by applicationService.transactionCoordinator;
            satisfy Requirements::typedFailure by accountingCore.invariantValidator;
            satisfy Requirements::executableCapability by capabilityRegistry;
            satisfy Requirements::bookIsolation by applicationService.bookAuthority;
            satisfy Requirements::immutableFinancialIdentity by bookRepository;
            satisfy Requirements::openingBoundary by accountingCore.periodEngine;
            satisfy Requirements::fiscalPeriodAdmission by accountingCore.periodEngine;
            satisfy Requirements::idempotentCommand by applicationService.idempotency;
            satisfy Requirements::orderedBookHistory by revisionRepository;
            satisfy Requirements::reproduciblePeriodControl by accountingCore.periodEngine;
            satisfy Requirements::reproducibleReports by reportCompiler;
            satisfy Requirements::rebuildableProjections by projectionRepository;
            satisfy Requirements::crossBookSeparation by applicationService.bookAuthority;
            satisfy Requirements::storagePortability by storageAdapter;
            satisfy Requirements::dimensionalIntegrity by accountingCore.invariantValidator;
            satisfy Requirements::canonicalIdentity by accountingCore.invariantValidator;
            satisfy Requirements::deterministicInventoryCosting by accountingCore.inventoryCostEngine;
            satisfy Requirements::deterministicInventoryCosting by accountingCore.lotEngine;
            satisfy Requirements::deterministicInventoryCosting by accountingCore.policyResolver;
            satisfy Requirements::provisionalInventoryIntegrity by accountingCore.inventoryCostEngine;
            satisfy Requirements::provisionalInventoryIntegrity by accountingCore.periodEngine;
            satisfy Requirements::openItemSettlementIntegrity by accountingCore.settlementEngine;
            satisfy Requirements::openItemSettlementIntegrity by accountingCore.invariantValidator;
            satisfy Requirements::accountingBasisProjectionIntegrity by accountingBasisProjectionEngine;
            satisfy Requirements::accountingBasisProjectionIntegrity by reportCompiler;
            satisfy Requirements::currencyRemeasurementIntegrity by accountingCore.currencyRemeasurementEngine;
            satisfy Requirements::currencyRemeasurementIntegrity by valuationEngine;
            satisfy Requirements::currencyRemeasurementIntegrity by accountingCore.periodEngine;
            satisfy Requirements::allocationScheduleIntegrity by accountingCore.allocationScheduleEngine;
            satisfy Requirements::allocationScheduleIntegrity by accountingCore.periodEngine;
            satisfy Requirements::taxDeterminationIntegrity by accountingCore.taxDeterminationEngine;
            satisfy Requirements::taxDeterminationIntegrity by accountingCore.invariantValidator;
            satisfy Requirements::consolidationIntegrity by accountingCore.consolidationCompiler;
            satisfy Requirements::consolidationIntegrity by applicationService.bookAuthority;
            satisfy Requirements::accountingWorkflowBoundary by accountingCore;
            satisfy Requirements::accountingWorkflowBoundary by applicationService.bookAuthority;
            satisfy Requirements::inventoryPolicyAdmission by accountingCore.policyResolver;
            satisfy Requirements::inventoryPoolClosure by accountingCore.inventoryCostEngine;
            satisfy Requirements::inventoryMethodDeterminism by accountingCore.inventoryCostEngine;
            satisfy Requirements::inventoryQuantityConservation by accountingCore.lotEngine;
            satisfy Requirements::inventoryBasisConservation by accountingCore.lotEngine;
            satisfy Requirements::inventoryFailureAtomicity by accountingCore.invariantValidator;
            satisfy Requirements::postedInventoryOwnershipAuthority by accountingCore.inventoryCostEngine;
            satisfy Requirements::quantityOnlyInventoryCommit by accountingCore.invariantValidator;
            satisfy Requirements::postedInventoryHistoryCompatibility by accountingCore;
            satisfy Requirements::provisionalShortageAuthorization by accountingCore.inventoryCostEngine;
            satisfy Requirements::provisionalBasisDeterminism by accountingCore.inventoryCostEngine;
            satisfy Requirements::provisionalReceiptAllocation by accountingCore.inventoryCostEngine;
            satisfy Requirements::provisionalRecostingImmutability by accountingCore.inventoryCostEngine;
            satisfy Requirements::provisionalPeriodAdmission by accountingCore.periodEngine;
            satisfy Requirements::openItemRecognitionIdentity by accountingCore.settlementEngine;
            satisfy Requirements::settlementScopeIntegrity by accountingCore.invariantValidator;
            satisfy Requirements::settlementGraphCardinality by accountingCore.settlementEngine;
            satisfy Requirements::settlementBookValueConservation by accountingCore.invariantValidator;
            satisfy Requirements::settlementDenominationConservation by accountingCore.invariantValidator;
            satisfy Requirements::settlementExchangeLineage by accountingCore.settlementEngine;
            satisfy Requirements::basisSnapshotCompleteness by accountingBasisProjectionEngine;
            satisfy Requirements::basisEventClassification by accountingBasisProjectionEngine;
            satisfy Requirements::basisPolicyCompleteness by accountingBasisProjectionEngine;
            satisfy Requirements::basisProjectionDeterminism by accountingBasisProjectionEngine;
            satisfy Requirements::basisProjectionReconciliation by accountingBasisProjectionEngine;
            satisfy Requirements::basisProjectionReadOnly by accountingBasisProjectionEngine;
            satisfy Requirements::monetaryClassificationAdmission by accountingCore.currencyRemeasurementEngine;
            satisfy Requirements::currencyValuationInputCompleteness by valuationEngine;
            satisfy Requirements::realizedExchangeCalculation by accountingCore.currencyRemeasurementEngine;
            satisfy Requirements::unrealizedRemeasurementCalculation by accountingCore.currencyRemeasurementEngine;
            satisfy Requirements::remeasurementEffectImmutability by accountingCore.currencyRemeasurementEngine;
            satisfy Requirements::remeasurementPriceSeparation by accountingCore.currencyRemeasurementEngine;
            satisfy Requirements::allocationInputCompleteness by accountingCore.allocationScheduleEngine;
            satisfy Requirements::allocationMethodAdmission by accountingCore.allocationScheduleEngine;
            satisfy Requirements::allocationBasisConservation by accountingCore.allocationScheduleEngine;
            satisfy Requirements::allocationScheduleImmutability by accountingCore.allocationScheduleEngine;
            satisfy Requirements::allocationRecognitionIdentity by accountingCore.allocationScheduleEngine;
            satisfy Requirements::allocationPeriodAdmission by accountingCore.periodEngine;
            satisfy Requirements::taxInputCompleteness by accountingCore.taxDeterminationEngine;
            satisfy Requirements::taxComponentGraphIntegrity by accountingCore.taxDeterminationEngine;
            satisfy Requirements::inclusiveTaxReconstruction by accountingCore.taxDeterminationEngine;
            satisfy Requirements::taxExactQuantization by accountingCore.taxDeterminationEngine;
            satisfy Requirements::taxTreatmentDestinations by accountingCore.taxDeterminationEngine;
            satisfy Requirements::taxTransactionAtomicity by accountingCore;
            satisfy Requirements::taxWorkflowExclusion by accountingCore.taxDeterminationEngine;
            satisfy Requirements::consolidationPopulationCompleteness by accountingCore.consolidationCompiler;
            satisfy Requirements::consolidationRelationshipAdmission by accountingCore.consolidationCompiler;
            satisfy Requirements::consolidationMappingCompleteness by accountingCore.consolidationCompiler;
            satisfy Requirements::consolidationTranslationCompleteness by accountingCore.consolidationCompiler;
            satisfy Requirements::consolidationEliminationEvidence by accountingCore.consolidationCompiler;
            satisfy Requirements::consolidationAdjustmentBalance by accountingCore.consolidationCompiler;
            satisfy Requirements::consolidationBookIsolation by applicationService.bookAuthority;
            satisfy Requirements::consolidationFailureAtomicity by accountingCore.consolidationCompiler;
            satisfy Requirements::soleIntentFactory by accountingCore;
            satisfy Requirements::calculatorDraftBoundary by accountingCore;
            satisfy Requirements::soleCommitAuthority by applicationService.bookAuthority;
            satisfy Requirements::externalWorkflowInputBoundary by boundaryResolution;
            satisfy Requirements::externalAuthorityProhibition by applicationService.bookAuthority;
        }
    }

    package Verification {
        verification def ExactArithmeticCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::exactArithmetic;
            }
        }

        verification def BalanceInvariantCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::exactBalance;
            }
        }

        verification def AmbiguousLotCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::failClosedAmbiguity;
            }
        }

        verification def BasisConservationCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::basisConservation;
            }
        }

        verification def TransferContinuityCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::transferContinuity;
            }
        }

        verification def DeterminismCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::deterministicPureCore;
                verify Requirements::orderIndependentMeaning;
            }
        }

        verification def CorrectionAuditCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::immutablePosting;
                verify Requirements::derivationProvenance;
            }
        }

        verification def AdapterFidelityCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::canonicalInterchange;
                verify Requirements::executableCapability;
            }
        }

        verification def RepeatingBasisCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::exactArithmetic;
                verify Requirements::authoritativeTotalBasis;
                verify Requirements::basisConservation;
            }
        }

        verification def ValuationPathCase {
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::priceSeparation;
                verify Requirements::valuationPathProvenance;
            }
        }

        verification def PolicyCapabilityCase {
            doc /* A supported claim names executable command topology, required effect fields, exact state delta, and admitting and rejecting fixtures; a live symbol or executor name without those observations rejects the release claim. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::executableCapability;
                verify Requirements::failClosedAmbiguity;
            }
        }

        verification def ResolvedInputBoundaryCase {
            doc /* Boundary translation preserves source scale and typed stages, while the kernel admits only a fully resolved command under a pinned policy and returns a typed diagnostic for any unresolved field. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::typedMonetarySemantics;
                verify Requirements::resolvedInputBoundary;
                verify Requirements::versionedPolicy;
                verify Requirements::temporalSemantics;
                verify Requirements::derivationProvenance;
                verify Requirements::typedFailure;
            }
        }

        verification def LotIdentityCase {
            doc /* Two same-instant acquisitions with the same label, quantity, and basis remain distinct stable lots, and explicit selection records the chosen IDs. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::lotIdentity;
                verify Requirements::failClosedAmbiguity;
            }
        }

        verification def AccountAndBookBoundaryCase {
            doc /* An account belongs to one book, respects its dated lifetime, and an opened book rejects a silent owner, functional-commodity, calendar, basis, or timezone rewrite. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::accountLifecycle;
                verify Requirements::bookIsolation;
                verify Requirements::immutableFinancialIdentity;
            }
        }

        verification def OpeningAndPeriodAdmissionCase {
            doc /* A balanced opening activates the boundary; ordinary posting before activation, before the boundary, outside all periods, or into a closed period returns a typed rejection. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::openingBoundary;
                verify Requirements::fiscalPeriodAdmission;
                verify Requirements::typedFailure;
            }
        }

        verification def CommandReplayAndAtomicCommitCase {
            doc /* Same ID and same input returns the retained commit; changed input under the same ID and a stale expected revision append nothing and consume no posting sequence. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::atomicPersistence;
                verify Requirements::idempotentCommand;
                verify Requirements::orderedBookHistory;
            }
        }

        verification def EvidenceReconciliationCase {
            doc /* One external balance assertion and many-to-many allocated reconciliation links can prove or contradict a balance without creating, clearing, or modifying any posting. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::evidenceAssertions;
                verify Requirements::reconciliationGraph;
                verify Requirements::immutablePosting;
            }
        }

        verification def PeriodCloseReopenCase {
            doc /* Month close pins its exact ledger, report population, and complete configuration contents; after multiple prospective configuration replacements the old close still reproduces without current configuration, then reopen appends disclosure plus any exact closing-journal reversal. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::fiscalPeriodAdmission;
                verify Requirements::reproduciblePeriodControl;
                verify Requirements::immutablePosting;
            }
        }

        verification def GoldenCompanyYearCase {
            doc /* One accrual-basis company opens, funds cash, sells on credit, collects partial and final payment, incurs and pays AP, capitalizes and depreciates equipment, sells FIFO inventory, settles foreign AR with exact gain, corrects by reversal/replacement, closes the year, and produces one tied report package. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::exactBalance;
                verify Requirements::canonicalJournalIntegrity;
                verify Requirements::reproduciblePeriodControl;
                verify Requirements::reproducibleReports;
            }
        }

        verification def ProjectionRebuildCase {
            doc /* Delete all account, period-delta, lot-position, and report-index projections; replay canonical revisions and reproduce the incremental hashes and cutoffs exactly. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::rebuildableProjections;
                verify Requirements::orderedBookHistory;
            }
        }

        verification def CrossBookRecoveryCase {
            doc /* Linked intercompany effects produce separate balanced journals; an interruption after one book commits remains explicitly incomplete and retry safely completes the other without duplication. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::bookIsolation;
                verify Requirements::idempotentCommand;
                verify Requirements::crossBookSeparation;
            }
        }

        verification def StorageParityCase {
            doc /* Canonically export one book, reconstruct it through a second storage adapter, and reproduce identities, revisions, journal hashes, lots, statements, and projection rebuild results exactly. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::canonicalInterchange;
                verify Requirements::rebuildableProjections;
                verify Requirements::storagePortability;
            }
        }

        verification def EmptyBookActivationCase {
            doc /* Activate a new zero-balance book without a fabricated journal or posting sequence, then admit its first ordinary journal at revision two and posting sequence one. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::openingBoundary;
                verify Requirements::orderedBookHistory;
                verify Requirements::canonicalJournalIntegrity;
            }
        }

        verification def CanonicalJournalStructureCase {
            doc /* Reject duplicate posting identity or ordinal, zero book value, cross-book account, invalid commodity, unresolved value, or a journal with fewer than two real postings before any canonical effect. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::exactBalance;
                verify Requirements::accountLifecycle;
                verify Requirements::canonicalJournalIntegrity;
                verify Requirements::bookIsolation;
            }
        }

        verification def CorrectionTopologyCase {
            doc /* An exact same-book reversal succeeds once; partial, wrong-book, and duplicate reversals reject, while supersession retains one unambiguous predecessor and complete lineage. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::immutablePosting;
                verify Requirements::idempotentCommand;
                verify Requirements::orderedBookHistory;
            }
        }

        verification def ChartAndCalendarIntegrityCase {
            doc /* Reject duplicate chart codes, cross-book or cyclic parents, ambiguous commodity admission, overlapping regular periods, and a journal resolving to no period or more than one period. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::accountLifecycle;
                verify Requirements::bookIsolation;
                verify Requirements::fiscalPeriodAdmission;
            }
        }

        verification def DownstreamCloseImpactCase {
            doc /* Reopening an earlier period retains every historical package but prevents a dependent later close from being presented as current until it is explicitly superseded or reopened and reclosed. A dependent close with a closing journal must first be explicitly reopened with its exact reversal; an earlier reopen cannot supersede that package and orphan its monetary effect. Dependent nonmonetary closes may be superseded without invented reversals. Rejections retain their original result through restart and subsequent successful latest-first reopening. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::reproduciblePeriodControl;
                verify Requirements::reproducibleReports;
            }
        }

        verification def PolicyAndQuantizationAdmissionCase {
            doc /* Reject invalid rational, overflow, missing or stale policy, recording-time policy substitution, implicit FX path, and unposted quantization residual without consuming a revision. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::exactArithmetic;
                verify Requirements::failClosedAmbiguity;
                verify Requirements::versionedPolicy;
                verify Requirements::temporalSemantics;
                verify Requirements::typedFailure;
            }
        }

        verification def AdversarialKernelCase {
            doc /* Reject floating input, imbalance, double-sided value, unknown or inactive account, wrong book, forbidden commodity, period violation, ambiguous lot, basis drift, illegal mutation, invalid reversal, stale revision, and unpinned policy without a partial commit. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::exactArithmetic;
                verify Requirements::exactBalance;
                verify Requirements::typedFailure;
                verify Requirements::atomicPersistence;
                verify Requirements::bookIsolation;
            }
        }

        verification def DimensionalIntegrityCase {
            doc /* Admit zero or one active same-book member per selected dimension for submitted and every specialized generated posting; reject empty-default, unused, omitted, duplicate-axis, wrong-effect, wrong-ordinal, wrong-book, inactive, cyclic, unknown, or missing-required selections without changing monetary balance. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::dimensionalIntegrity;
                verify Requirements::bookIsolation;
                verify Requirements::versionedPolicy;
            }
        }

        verification def CanonicalIdentityCase {
            doc /* Retained identifiers, posting references, effect keys, and historical configuration snapshots resolve exactly once and typed content hashes reproduce across adapters; empty, reused, dangling, wrong-field, wrong-cutoff, ambiguous, unversioned, or collision-conflicting identities reject before a revision is consumed. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::canonicalIdentity;
                verify Requirements::orderIndependentMeaning;
                verify Requirements::orderedBookHistory;
            }
        }

        verification def DeterministicInventoryCostingCase {
            doc /* The same acquisition and disposal history produces exact SPECID, FIFO, LIFO, HIFO, or weighted-average results. Later freight, rebate, overhead, write-down, and reversal effects allocate exactly between remaining holdings, recognized cost, and valuation allowance without changing quantity or rewriting history; unsupported, excessive, or incoherent adjustments reject. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::deterministicInventoryCosting;
                verify Requirements::inventoryPolicyAdmission;
                verify Requirements::inventoryPoolClosure;
                verify Requirements::inventoryMethodDeterminism;
                verify Requirements::inventoryQuantityConservation;
                verify Requirements::inventoryBasisConservation;
                verify Requirements::inventoryFailureAtomicity;
            }
        }

        verification def PostedInventoryOwnershipCase {
            doc /* Prospective verification objective, not completed runtime evidence.
            Actual source closure, zero/nonzero command variants, strict codec,
            origin resolution and restart execution must exercise complete ownership
            workflows. Arithmetic examples alone cannot discharge these objectives. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::postedInventoryOwnershipAuthority;
                verify Requirements::quantityOnlyInventoryCommit;
                verify Requirements::postedInventoryHistoryCompatibility;
            }
        }

        verification def ProvisionalInventoryRecostingCase {
            doc /* A policy-authorized issue before receipt opens one provisional layer, later receipts resolve it with one exact linked adjustment, and an unauthorized shortage or silent rewrite rejects. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::provisionalInventoryIntegrity;
                verify Requirements::provisionalShortageAuthorization;
                verify Requirements::provisionalBasisDeterminism;
                verify Requirements::provisionalReceiptAllocation;
                verify Requirements::provisionalRecostingImmutability;
                verify Requirements::provisionalPeriodAdmission;
            }
        }

        verification def OpenItemSettlementCase {
            doc /* Several settlements and credits partially allocate across several canonical control-account postings. A foreign settlement retains separate carrying and settlement book values, exact denomination allocations, valuation path, computed difference, and one matching same-command gain/loss effect; missing, wrong-field, arbitrary-key, date-loss, cross-book, or over-allocation input rejects. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::openItemSettlementIntegrity;
                verify Requirements::openItemRecognitionIdentity;
                verify Requirements::settlementScopeIntegrity;
                verify Requirements::settlementGraphCardinality;
                verify Requirements::settlementBookValueConservation;
                verify Requirements::settlementDenominationConservation;
                verify Requirements::settlementExchangeLineage;
            }
        }

        verification def AccountingBasisProjectionCase {
            doc /* One complete pinned configuration, journal, and accounting-effect population produces tied accrual and cash projections across partial payments, credits, write-offs, tax, inventory cost/value, schedules, remeasurement, and noncash journals. Exact included, excluded, projected, and residual totals reconcile and caller-fabricated amounts or ratios reject. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::accountingBasisProjectionIntegrity;
                verify Requirements::basisSnapshotCompleteness;
                verify Requirements::basisEventClassification;
                verify Requirements::basisPolicyCompleteness;
                verify Requirements::basisProjectionDeterminism;
                verify Requirements::basisProjectionReconciliation;
                verify Requirements::basisProjectionReadOnly;
            }
        }

        verification def CurrencyRemeasurementCase {
            doc /* Foreign monetary positions closed over canonical postings produce exact realized settlement differences and period-end unrealized adjustments whose keys resolve matching journals. A later configuration change cannot redirect a required reversal, which must exactly negate the original journal while price, basis, and carrying lineage remain immutable. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::currencyRemeasurementIntegrity;
                verify Requirements::monetaryClassificationAdmission;
                verify Requirements::currencyValuationInputCompleteness;
                verify Requirements::realizedExchangeCalculation;
                verify Requirements::unrealizedRemeasurementCalculation;
                verify Requirements::remeasurementEffectImmutability;
                verify Requirements::remeasurementPriceSeparation;
            }
        }

        verification def AllocationScheduleCase {
            doc /* A schedule closed over one canonical posting produces exact period amounts whose total plus residual equals source basis. After partial recognition, estimate change creates a prospective successor while impairment, disposal, or termination permanently blocks superseded future ordinals; stale policy, invalid cutoff, date, method, source, or total rejects without partial state. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::allocationScheduleIntegrity;
                verify Requirements::allocationInputCompleteness;
                verify Requirements::allocationMethodAdmission;
                verify Requirements::allocationBasisConservation;
                verify Requirements::allocationScheduleImmutability;
                verify Requirements::allocationRecognitionIdentity;
                verify Requirements::allocationPeriodAdmission;
            }
        }

        verification def TaxDeterminationCase {
            doc /* Supplied inclusive, exclusive, compound, recoverable, and nonrecoverable policies produce exact traceable tax components at the named tax point; missing or conflicting policy rejects. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::taxDeterminationIntegrity;
                verify Requirements::taxInputCompleteness;
                verify Requirements::taxComponentGraphIntegrity;
                verify Requirements::inclusiveTaxReconstruction;
                verify Requirements::taxExactQuantization;
                verify Requirements::taxTreatmentDestinations;
                verify Requirements::taxTransactionAtomicity;
                verify Requirements::taxWorkflowExclusion;
            }
        }

        verification def ConsolidationCompilationCase {
            doc /* Pinned entity snapshots translate and eliminate into a balanced consolidation book while a stale snapshot, missing mapping, circular source, cross-book journal, or unmatched elimination rejects. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::consolidationIntegrity;
                verify Requirements::consolidationPopulationCompleteness;
                verify Requirements::consolidationRelationshipAdmission;
                verify Requirements::consolidationMappingCompleteness;
                verify Requirements::consolidationTranslationCompleteness;
                verify Requirements::consolidationEliminationEvidence;
                verify Requirements::consolidationAdjustmentBalance;
                verify Requirements::consolidationBookIsolation;
                verify Requirements::consolidationFailureAtomicity;
            }
        }

        verification def AccountingWorkflowBoundaryCase {
            doc /* Identical typed accounting facts produce identical effects regardless of document, feed, provider, or UI origin, and no external workflow artifact can post or silently choose an accounting policy. */
            subject backend : Architecture::Backend;
            objective {
                verify Requirements::accountingWorkflowBoundary;
                verify Requirements::soleIntentFactory;
                verify Requirements::calculatorDraftBoundary;
                verify Requirements::soleCommitAuthority;
                verify Requirements::externalWorkflowInputBoundary;
                verify Requirements::externalAuthorityProhibition;
            }
        }
    }

    package ReferenceTraceability {
        item def ReferenceRevision {
            attribute name : String;
            attribute revision : String;
            attribute role : String;
        }

        item beancount : ReferenceRevision {
            :>> name = "Beancount";
            :>> revision = "9747213802acb733ce53acc6e963f5961f47d6cd";
            :>> role = "immutable values, staged booking, strict ambiguity, account lifetimes";
        }

        item hledger : ReferenceRevision {
            :>> name = "hledger";
            :>> revision = "d06affcbb692bae849b7f33eb52b2958dc39243d";
            :>> role = "lot classification, selection policies, basis-preserving transfers, finalisation stages";
        }

        item ledger : ReferenceRevision {
            :>> name = "Ledger";
            :>> revision = "6fcfab268068164e0141a4e9770784c6bf4484ac";
            :>> role = "exact rational arithmetic, commodity price graph, queries, hashes";
        }

        item bigcapital : ReferenceRevision {
            :>> name = "Bigcapital";
            :>> revision = "7883ad07e3e38ef7fc56d6c83ea0e851c1b80d1d";
            :>> role = "operational evidence for inventory costing, invoice and bill settlement allocations, basic tax components, and bank-transaction matching; not a semantic authority";
        }

        item gnucash : ReferenceRevision {
            :>> name = "GnuCash";
            :>> revision = "80c442dad342a73677e1a6060a73ef5b597185c9";
            :>> role = "book-scoped engine, hierarchical accounts, transaction splits, opening and closing entries, multi-currency values, reconciliation, and statements";
        }

        item tigerbeetle : ReferenceRevision {
            :>> name = "TigerBeetle";
            :>> revision = "97c7a8ef385270ebe0e1b75959d3d21d134629df";
            :>> role = "integrity reference for immutable debit-credit transfers, idempotent identity, ordered state transitions, overflow checks, and concurrency failure behavior; not a general ledger";
        }

        item legacyRastrata : ReferenceRevision {
            :>> name = "Rastrata legacy accounting system";
            :>> revision = "8dc3c1af8251975e4b14302f4c6e6a444fa09fb6";
            :>> role = "internal evidence for legal-entity books, fiscal admission, immutable posting envelopes, reversal/replacement lineage, gap-free posting sequence, close checkpoints, and golden financial reports";
        }

        item compatibilityLab : ReferenceRevision {
            :>> name = "Rastrata accounting engine compatibility lab";
            :>> revision = "rastrata-accounting-engine-lab-v0.1";
            :>> role = "pinned executable fixtures for numeric, lot, valuation, lifecycle, assertion, ordering, and virtual-posting behavior";
        }

        item xbrlGlobalLedger : ReferenceRevision {
            :>> name = "XBRL Global Ledger";
            :>> revision = "2015-03-25 Recommendation; accessed 2026-08-25";
            :>> role = "system-independent transaction detail, source linkage, typed dimensions, aggregation, and interchange coverage";
        }

        item quickBooksEnterpriseLandedCost : ReferenceRevision {
            :>> name = "QuickBooks Enterprise landed cost";
            :>> revision = "Intuit product documentation accessed 2026-08-31";
            :>> role = "product capability cross-check for freight, duties, insurance, and other later inventory costs; not an accounting authority";
        }

        item xeroTrackedInventory : ReferenceRevision {
            :>> name = "Xero tracked inventory integration guidance";
            :>> revision = "Xero developer documentation accessed 2026-08-31";
            :>> role = "product capability cross-check for inventory quantity and value adjustment; not an accounting authority";
        }

        item quickBooksAdvancedFixedAssets : ReferenceRevision {
            :>> name = "QuickBooks Online Advanced fixed assets";
            :>> revision = "Intuit product documentation accessed 2026-08-31";
            :>> role = "product capability cross-check for asset detail changes and disposal; not an accounting authority";
        }

        item ias2Inventories : ReferenceRevision {
            :>> name = "IFRS Foundation IAS 2 Inventories";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "inventory cost composition and specific-identification, FIFO, and weighted-average cost-formula coverage";
        }

        item ias8Policies : ReferenceRevision {
            :>> name = "IFRS Foundation IAS 8 Basis of Preparation of Financial Statements";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "accounting-policy selection, change, estimate, and error-correction semantics";
        }

        item ias16PropertyPlantEquipment : ReferenceRevision {
            :>> name = "IFRS Foundation IAS 16 Property, Plant and Equipment";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "depreciable asset recognition, measurement, and depreciation coverage";
        }

        item ias21ForeignExchange : ReferenceRevision {
            :>> name = "IFRS Foundation IAS 21 The Effects of Changes in Foreign Exchange Rates";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "functional currency, foreign-currency transaction, exchange-rate, and foreign-operation translation coverage";
        }

        item ias38Intangibles : ReferenceRevision {
            :>> name = "IFRS Foundation IAS 38 Intangible Assets";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "finite-life intangible-asset amortisation and carrying-amount coverage";
        }

        item ifrs10Consolidation : ReferenceRevision {
            :>> name = "IFRS Foundation IFRS 10 Consolidated Financial Statements";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "control-based consolidation and single-economic-entity statement population";
        }

        item ias28AssociatesJointVentures : ReferenceRevision {
            :>> name = "IFRS Foundation IAS 28 Investments in Associates and Joint Ventures";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "equity-method coverage for associates and joint ventures";
        }

        item ifrs11JointArrangements : ReferenceRevision {
            :>> name = "IFRS Foundation IFRS 11 Joint Arrangements";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "classification and operator-recognition coverage for joint arrangements";
        }

        item ifrs3BusinessCombinations : ReferenceRevision {
            :>> name = "IFRS Foundation IFRS 3 Business Combinations";
            :>> revision = "issued-standard page accessed 2026-08-29";
            :>> role = "acquired asset, liability, goodwill, and non-controlling-interest measurement coverage";
        }

        item irsPublication538 : ReferenceRevision {
            :>> name = "US Internal Revenue Service Publication 538 Accounting Periods and Methods";
            :>> revision = "Publication 538 (01/2022) page accessed 2026-08-29";
            :>> role = "one jurisdictional cross-check for cash and accrual accounting-method projections; not a universal policy source";
        }

        dependency stagedBookingEvidence from beancount to Requirements::resolvedInputBoundary;
        dependency strictAmbiguityEvidence from beancount to Requirements::failClosedAmbiguity;
        dependency lotConservationEvidence from hledger to Requirements::basisConservation;
        dependency transferEvidence from hledger to Requirements::transferContinuity;
        dependency exactArithmeticEvidence from ledger to Requirements::exactArithmetic;
        dependency priceGraphEvidence from ledger to Requirements::priceSeparation;
        dependency repeatingBasisEvidence from compatibilityLab to Requirements::authoritativeTotalBasis;
        dependency valuationPathEvidence from compatibilityLab to Requirements::valuationPathProvenance;
        dependency capabilityEvidence from compatibilityLab to Requirements::executableCapability;
        dependency bookBoundaryEvidence from gnucash to Requirements::bookIsolation;
        dependency reportEvidence from gnucash to Requirements::reproducibleReports;
        dependency idempotencyEvidence from tigerbeetle to Requirements::idempotentCommand;
        dependency orderedHistoryEvidence from tigerbeetle to Requirements::orderedBookHistory;
        dependency legacyBookEvidence from legacyRastrata to Requirements::immutableFinancialIdentity;
        dependency legacyOpeningEvidence from legacyRastrata to Requirements::openingBoundary;
        dependency legacyPeriodEvidence from legacyRastrata to Requirements::fiscalPeriodAdmission;
        dependency legacyCloseEvidence from legacyRastrata to Requirements::reproduciblePeriodControl;
        dependency legacyReportEvidence from legacyRastrata to Requirements::reproducibleReports;
        dependency dimensionalEvidence from xbrlGlobalLedger to Requirements::dimensionalIntegrity;
        dependency transactionDetailEvidence from xbrlGlobalLedger to Requirements::derivationProvenance;
        dependency hledgerCostMethodEvidence from hledger to Requirements::deterministicInventoryCosting;
        dependency beancountCrossZeroEvidence from beancount to Requirements::provisionalInventoryIntegrity;
        dependency ledgerBasisProjectionEvidence from ledger to Requirements::accountingBasisProjectionIntegrity;
        dependency ledgerRemeasurementEvidence from ledger to Requirements::currencyRemeasurementIntegrity;
        dependency bigcapitalInventoryEvidence from bigcapital to Requirements::deterministicInventoryCosting;
        dependency quickBooksLandedCostCoverage from quickBooksEnterpriseLandedCost to Requirements::deterministicInventoryCosting;
        dependency xeroInventoryAdjustmentCoverage from xeroTrackedInventory to Requirements::deterministicInventoryCosting;
        dependency bigcapitalSettlementEvidence from bigcapital to Requirements::openItemSettlementIntegrity;
        dependency bigcapitalTaxEvidence from bigcapital to Requirements::taxDeterminationIntegrity;
        dependency bigcapitalReconciliationEvidence from bigcapital to Requirements::reconciliationGraph;
        dependency ias2CostFormulaEvidence from ias2Inventories to Requirements::deterministicInventoryCosting;
        dependency ias8PolicyEvidence from ias8Policies to Requirements::versionedPolicy;
        dependency ias8CorrectionEvidence from ias8Policies to Requirements::immutablePosting;
        dependency ias16DepreciationEvidence from ias16PropertyPlantEquipment to Requirements::allocationScheduleIntegrity;
        dependency quickBooksFixedAssetCoverage from quickBooksAdvancedFixedAssets to Requirements::allocationScheduleIntegrity;
        dependency ias38AmortisationEvidence from ias38Intangibles to Requirements::allocationScheduleIntegrity;
        dependency ias21RemeasurementEvidence from ias21ForeignExchange to Requirements::currencyRemeasurementIntegrity;
        dependency ias21TranslationEvidence from ias21ForeignExchange to Requirements::consolidationIntegrity;
        dependency ifrs10PopulationEvidence from ifrs10Consolidation to Requirements::consolidationIntegrity;
        dependency ias28EquityMethodEvidence from ias28AssociatesJointVentures to Requirements::consolidationRelationshipAdmission;
        dependency ifrs11JointArrangementEvidence from ifrs11JointArrangements to Requirements::consolidationRelationshipAdmission;
        dependency ifrs3MeasurementEvidence from ifrs3BusinessCombinations to Requirements::consolidationIntegrity;
        dependency cashAccrualMethodEvidence from irsPublication538 to Requirements::accountingBasisProjectionIntegrity;
    }
}

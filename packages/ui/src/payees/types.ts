/** The shapes the payees components are given. They mirror the service's replies (payees.totals,
 * payees.get, payees.test and payees.save) field for field, so the web app hands over what the service
 * said. Money is a wire amount ("-12.34"); a component never turns it into a number. */

export type PayeeDirection = "both" | "spent" | "received";

export interface PayeeTallyView {
  readonly received: string;
  readonly spent: string;
  readonly transactions: number;
}

export interface PayeeRefView {
  readonly id: string;
  readonly name: string;
}

export interface PayeeRowView extends PayeeTallyView {
  readonly payeeId: string;
  readonly name: string;
  readonly retired: boolean;
  readonly net: string;
  readonly firstOn: string;
  readonly lastOn: string;
}

export interface PayeeUnnamedView extends PayeeTallyView {
  readonly key: string;
  readonly text: string;
  readonly suggestedWords: string;
  readonly net: string;
  readonly firstOn: string;
  readonly lastOn: string;
}

export interface PayeeAmbiguousView extends PayeeTallyView {
  readonly key: string;
  readonly text: string;
  readonly payees: readonly PayeeRefView[];
  readonly net: string;
  readonly firstOn: string;
  readonly lastOn: string;
}

/** What a bounded list left out, added up. */
export interface PayeeRestView extends PayeeTallyView {
  readonly groups: number;
}

export interface PayeeTieView {
  readonly profitLossIncome: string;
  readonly profitLossExpenses: string;
  readonly income: string;
  readonly expenses: string;
  /** What each place adds up to over the whole range: the payees, the texts not named yet, the texts two
   * payees match equally, and the entries with no payee. */
  readonly places: {
    readonly payees: PayeeTallyView;
    readonly unnamed: PayeeTallyView;
    readonly ambiguous: PayeeTallyView;
    readonly noPayee: PayeeTallyView;
  };
  readonly matches: boolean;
}

export interface PayeeWarningView {
  readonly code: string;
  readonly message: string;
}

export interface PayeeReportData {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly basis: "cash" | "accrual";
  readonly bookRevision: string;
  readonly payeesRevision: string;
  readonly populationHash: string;
  readonly direction: PayeeDirection;
  readonly rows: readonly PayeeRowView[];
  readonly rowCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly unnamed: readonly PayeeUnnamedView[];
  readonly unnamedCount: number;
  readonly unnamedRest: PayeeRestView;
  readonly ambiguous: readonly PayeeAmbiguousView[];
  readonly ambiguousCount: number;
  readonly ambiguousRest: PayeeRestView;
  readonly noPayee: {
    readonly byHand: PayeeTallyView;
    readonly noBankText: PayeeTallyView;
  };
  readonly totals: PayeeTallyView;
  readonly tieOut: PayeeTieView;
  readonly inboxRead: boolean;
  readonly warnings: readonly PayeeWarningView[];
}

export interface PayeeView {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly words: readonly string[];
  readonly defaultAccountId: string | null;
  readonly note: string;
  readonly retired: boolean;
  readonly hasTaxDetails: boolean;
  readonly recordedAt: string;
  readonly principal: string;
}

export interface PayeeVersionView {
  readonly version: number;
  readonly name: string;
  readonly words: readonly string[];
  readonly note: string;
  readonly retired: boolean;
  readonly recordedAt: string;
  readonly principal: string;
  readonly via: string;
}

export interface PayeeTransactionView {
  readonly date: string;
  readonly journalId: string;
  readonly narration: string;
  readonly text: string;
  readonly textFrom: "counterparty" | "description" | "connector" | "narration" | null;
  readonly received: string;
  readonly spent: string;
  readonly accounts: string;
  readonly payee: PayeeRefView | null;
  readonly key: string | null;
  readonly reverses: string | null;
}

export interface PayeeSubjectView {
  readonly kind: "payee" | "unnamed" | "ambiguous" | "no_payee";
  readonly payeeId?: string | undefined;
  readonly key?: string | undefined;
  readonly text?: string | undefined;
  readonly why?: "by_hand" | "no_bank_text" | undefined;
  readonly payees?: readonly PayeeRefView[] | undefined;
}

export interface PayeeDetailData {
  readonly subject: PayeeSubjectView;
  readonly payee: PayeeView | null;
  readonly history: readonly PayeeVersionView[];
  readonly transactions: readonly PayeeTransactionView[];
  readonly count: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totals: PayeeTallyView;
  readonly from: string;
  readonly to: string;
  readonly inboxRead: boolean;
}

export interface PayeeTestData {
  readonly keys: readonly string[];
  readonly problems: readonly PayeeWarningView[];
  readonly matches: PayeeTallyView;
  readonly stays: PayeeTallyView;
  readonly fromUnnamed: PayeeTallyView;
  readonly fromAmbiguous: PayeeTallyView;
  readonly fromNowhere: PayeeTallyView;
  readonly taken: readonly { readonly payee: PayeeRefView; readonly tally: PayeeTallyView }[];
  readonly lost: PayeeTallyView;
  readonly tied: PayeeTallyView & { readonly payees: readonly PayeeRefView[] };
  readonly beaten: readonly { readonly payee: PayeeRefView; readonly tally: PayeeTallyView }[];
}

/** What the form for a payee holds, as typed. */
export interface PayeeFormValues {
  readonly name: string;
  /** One set of words to a row. */
  readonly words: string;
  readonly note: string;
  readonly retired: boolean;
}

/** One row of the report that can be opened: its transactions are read with `payees.get`. */
export type PayeeSubject =
  | { readonly kind: "payee"; readonly payeeId: string; readonly label: string }
  | {
      readonly kind: "unnamed";
      readonly key: string;
      readonly label: string;
      /** Words to start from if the person names a payee out of it. */
      readonly suggestedWords: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly key: string;
      readonly label: string;
      readonly payees: readonly PayeeRefView[];
    }
  | { readonly kind: "no_payee"; readonly why: "by_hand" | "no_bank_text"; readonly label: string };

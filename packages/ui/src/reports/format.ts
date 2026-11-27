/** The reports modules' names for the shared money helpers in `../format`. There is one
 * implementation (digits grouped, two decimals, a real minus sign, exact cents); these names are kept
 * so the statements, their stories and their tests read as they always have. */
export {
  centsToMoney as centsAmount,
  formatMoney as formatAmount,
  isNegativeMoney as isNegativeAmount,
  moneyDifference as amountDifference,
  moneyToCents as amountCents,
  type MoneyParts as AmountParts,
  parseMoney as parseAmount,
} from "../format";

import { identifier, type Identifier } from "./canonical.ts";
import type { CommodityId, Instant, Quantity } from "./journal.ts";
import { ExactRational } from "./numeric.ts";
import type { EvidenceId } from "./policy.ts";

export type PriceObservationId = Identifier<"MarketPriceObservation">;
export const priceObservationId = (value: string): PriceObservationId =>
  identifier<"MarketPriceObservation">(value);

export interface MarketPriceObservation {
  readonly id: PriceObservationId;
  readonly effectiveAt: Instant;
  readonly observedAt: Instant;
  readonly kind: "marketQuote" | "officialRate" | "appraisedValue";
  readonly rate: ExactRational;
  readonly baseCommodityId: CommodityId;
  readonly quoteCommodityId: CommodityId;
  readonly evidenceId: EvidenceId;
}

export interface MarketValue {
  readonly exactAmount: ExactRational;
  readonly reportingCommodityId: CommodityId;
  readonly sourceObservationId: PriceObservationId;
  readonly usesInverse: boolean;
  readonly effectiveAt: Instant;
}

export function valueWithObservation(
  quantity: Quantity,
  observation: MarketPriceObservation,
  effectiveAt: Instant,
  allowInverse: boolean,
): MarketValue {
  if (Date.parse(observation.effectiveAt) > Date.parse(effectiveAt)) {
    throw new RangeError("A valuation cannot use an observation from after its effective time");
  }
  if (quantity.commodityId === observation.baseCommodityId) {
    return Object.freeze({
      exactAmount: quantity.canonicalNumber.multiply(observation.rate),
      reportingCommodityId: observation.quoteCommodityId,
      sourceObservationId: observation.id,
      usesInverse: false,
      effectiveAt,
    });
  }
  if (allowInverse && quantity.commodityId === observation.quoteCommodityId) {
    return Object.freeze({
      exactAmount: quantity.canonicalNumber.divide(observation.rate),
      reportingCommodityId: observation.baseCommodityId,
      sourceObservationId: observation.id,
      usesInverse: true,
      effectiveAt,
    });
  }
  throw new RangeError("Observation does not connect the source commodity under the supplied policy");
}

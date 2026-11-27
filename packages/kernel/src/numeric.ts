export type ExactNumberErrorCode =
  | "invalid_decimal"
  | "invalid_rational"
  | "representation_limit_exceeded"
  | "scale_limit_exceeded";

export class ExactNumberError extends Error {
  readonly code: ExactNumberErrorCode;

  constructor(code: ExactNumberErrorCode, message: string) {
    super(message);
    this.name = "ExactNumberError";
    this.code = code;
  }
}

export const MAX_DECIMAL_SCALE = 1_000n;
export const MAX_EXACT_INTEGER_BITS = 16_384;

function requireMagnitude(value: bigint, field: string): void {
  const magnitude = value < 0n ? -value : value;
  if (magnitude !== 0n && magnitude.toString(2).length > MAX_EXACT_INTEGER_BITS) {
    throw new ExactNumberError(
      "representation_limit_exceeded",
      `${field} exceeds the admitted ${MAX_EXACT_INTEGER_BITS}-bit exact-integer limit`,
    );
  }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;

  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a;
}

function requireScale(scale: bigint): void {
  if (scale < 0n) {
    throw new ExactNumberError("invalid_decimal", "Decimal scale must be non-negative");
  }
  if (scale > MAX_DECIMAL_SCALE) {
    throw new ExactNumberError(
      "scale_limit_exceeded",
      `Decimal scale exceeds the admitted limit of ${MAX_DECIMAL_SCALE}`,
    );
  }
}

export class ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: bigint;

  private constructor(coefficient: bigint, scale: bigint) {
    this.coefficient = coefficient;
    this.scale = scale;
    Object.freeze(this);
  }

  static of(coefficient: bigint, scale: bigint): ExactDecimal {
    requireScale(scale);
    requireMagnitude(coefficient, "Decimal coefficient");
    return new ExactDecimal(coefficient, scale);
  }

  static parse(source: string): ExactDecimal {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(source);
    if (match === null) {
      throw new ExactNumberError("invalid_decimal", `Invalid source decimal: ${source}`);
    }

    const sign = match[1] === "-" ? -1n : 1n;
    const whole = match[2];
    const fraction = match[3] ?? "";
    if (whole === undefined) {
      throw new ExactNumberError("invalid_decimal", `Invalid source decimal: ${source}`);
    }

    const scale = BigInt(fraction.length);
    requireScale(scale);
    const coefficient = sign * BigInt(`${whole}${fraction}`);
    requireMagnitude(coefficient, "Decimal coefficient");
    return new ExactDecimal(coefficient, scale);
  }

  isZero(): boolean {
    return this.coefficient === 0n;
  }

  negate(): ExactDecimal {
    return new ExactDecimal(-this.coefficient, this.scale);
  }

  toRational(): ExactRational {
    return ExactRational.of(this.coefficient, 10n ** this.scale);
  }

  toString(): string {
    const negative = this.coefficient < 0n;
    const magnitude = (negative ? -this.coefficient : this.coefficient).toString();
    const scale = Number(this.scale);

    if (scale === 0) {
      return `${negative ? "-" : ""}${magnitude}`;
    }

    const padded = magnitude.padStart(scale + 1, "0");
    const splitAt = padded.length - scale;
    return `${negative ? "-" : ""}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
  }
}

export class ExactRational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    this.numerator = numerator;
    this.denominator = denominator;
    Object.freeze(this);
  }

  static of(numerator: bigint, denominator: bigint): ExactRational {
    if (denominator <= 0n) {
      throw new ExactNumberError("invalid_rational", "Rational denominator must be positive");
    }

    if (numerator === 0n) {
      return new ExactRational(0n, 1n);
    }

    requireMagnitude(numerator, "Rational numerator");
    requireMagnitude(denominator, "Rational denominator");

    const divisor = greatestCommonDivisor(numerator, denominator);
    return new ExactRational(numerator / divisor, denominator / divisor);
  }

  static zero(): ExactRational {
    return new ExactRational(0n, 1n);
  }

  add(other: ExactRational): ExactRational {
    return ExactRational.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  subtract(other: ExactRational): ExactRational {
    return this.add(other.negate());
  }

  multiply(other: ExactRational): ExactRational {
    return ExactRational.of(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    );
  }

  divide(other: ExactRational): ExactRational {
    if (other.numerator === 0n) {
      throw new ExactNumberError("invalid_rational", "Cannot divide by zero");
    }
    const numerator = this.numerator * other.denominator;
    const denominator = this.denominator * other.numerator;
    return denominator < 0n
      ? ExactRational.of(-numerator, -denominator)
      : ExactRational.of(numerator, denominator);
  }

  compare(other: ExactRational): -1 | 0 | 1 {
    const difference =
      this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  isNegative(): boolean {
    return this.numerator < 0n;
  }

  abs(): ExactRational {
    return this.numerator < 0n ? this.negate() : this;
  }

  negate(): ExactRational {
    return new ExactRational(-this.numerator, this.denominator);
  }

  equals(other: ExactRational): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  toString(): string {
    return `${this.numerator}/${this.denominator}`;
  }
}

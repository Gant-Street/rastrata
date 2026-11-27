import Rastrata.Kernel.Numeric
import Oracle.Dispatch

namespace Oracle

open Rastrata.Kernel

instance : ToOracleError NumErr where
  toErrorCode
    | .invalidDecimal => "invalid_decimal"
    | .invalidRational => "invalid_rational"
    | .representationLimitExceeded => "representation_limit_exceeded"
    | .scaleLimitExceeded => "scale_limit_exceeded"

instance : FromOracleJson ExactRational where
  fromOracleJson j := do
    let nJson ← j.getObjVal? "numerator"
    let dJson ← j.getObjVal? "denominator"
    let numerator ← FromOracleJson.fromOracleJson nJson
    let denominator ← FromOracleJson.fromOracleJson dJson
    pure ⟨numerator, denominator⟩

instance : ToOracleJson ExactRational where
  toOracleJson r := Lean.Json.mkObj
    [ ("numerator", ToOracleJson.toOracleJson r.numerator)
    , ("denominator", ToOracleJson.toOracleJson r.denominator)
    ]

instance : FromOracleJson ExactDecimal where
  fromOracleJson j := do
    let cJson ← j.getObjVal? "coefficient"
    let sJson ← j.getObjVal? "scale"
    let coefficient ← FromOracleJson.fromOracleJson cJson
    let scale ← FromOracleJson.fromOracleJson sJson
    pure ⟨coefficient, scale⟩

instance : ToOracleJson ExactDecimal where
  toOracleJson d := Lean.Json.mkObj
    [ ("coefficient", ToOracleJson.toOracleJson d.coefficient)
    , ("scale", ToOracleJson.toOracleJson d.scale)
    ]

end Oracle

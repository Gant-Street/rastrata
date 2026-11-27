import Oracle.Dispatch
import Oracle.Numeric
import Oracle.Canonical
import Oracle.Wave2a
import Oracle.Wave2b

open Oracle
open Rastrata.Kernel

/-- Single dispatch table for every kernel model function exposed by the oracle. -/
def dispatchTable : Std.HashMap String Handler :=
  Std.HashMap.ofList
    [ ("ExactRational.of", fn2 ExactRational.of)
    , ("ExactRational.zero", fn0 ExactRational.zero)
    , ("ExactRational.negate", fn1 ExactRational.negate)
    , ("ExactRational.add", fn2 ExactRational.add)
    , ("ExactRational.subtract", fn2 ExactRational.subtract)
    , ("ExactRational.multiply", fn2 ExactRational.multiply)
    , ("ExactRational.divide", fn2 ExactRational.divide)
    , ("ExactRational.compare", fn2 ExactRational.compare)
    , ("ExactRational.isNegative", fn1 ExactRational.isNegative)
    , ("ExactRational.abs", fn1 ExactRational.abs)
    , ("ExactRational.equals", fn2 ExactRational.equals)
    , ("ExactRational.isZero", fn1 ExactRational.isZero)
    , ("ExactDecimal.of", fn2 ExactDecimal.of)
    , ("ExactDecimal.isZero", fn1 ExactDecimal.isZero)
    , ("ExactDecimal.negate", fn1 ExactDecimal.negate)
    , ("ExactDecimal.toRational", fn1 ExactDecimal.toRational)
    ] |>.insertMany canonicalEntries |>.insertMany wave2aEntries |>.insertMany wave2bEntries

/-- Process one JSON request line and return the JSON response object. -/
def handleLine (table : Std.HashMap String Handler) (line : String) : Lean.Json :=
  match Lean.Json.parse line with
  | .error e =>
    Lean.Json.mkObj
      [ ("id", Lean.Json.null)
      , ("error", Lean.Json.str s!"protocol_error: invalid json: {e}")
      ]
  | .ok req =>
    let id := match req.getObjVal? "id" with
      | .ok v => v
      | .error _ => Lean.Json.null
    let outcome : CallOutcome :=
      match req.getObjVal? "fn" >>= Lean.Json.getStr?,
          req.getObjVal? "args" >>= Lean.Json.getArr? with
      | .error e, _ => .protocolError s!"missing or invalid 'fn': {e}"
      | _, .error e => .protocolError s!"missing or invalid 'args': {e}"
      | .ok fnName, .ok args =>
        match table.get? fnName with
        | none => .protocolError s!"unknown function: {fnName}"
        | some handler => handler args
    match outcome with
    | .ok result => Lean.Json.mkObj [("id", id), ("ok", result)]
    | .domainError code => Lean.Json.mkObj [("id", id), ("error", Lean.Json.str code)]
    | .protocolError msg =>
      Lean.Json.mkObj [("id", id), ("error", Lean.Json.str s!"protocol_error: {msg}")]

/-- Read JSON requests one line at a time on stdin and write flushed JSON responses on stdout. -/
def main : IO Unit := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  repeat do
    let line ← stdin.getLine
    if line.isEmpty then break
    if line.trimAscii.isEmpty then continue
    let resp := handleLine dispatchTable line
    stdout.putStrLn (Lean.Json.compress resp)
    stdout.flush

import Lean.Data.Json
import Std.Data.HashMap

namespace Oracle

/-- Outcome of dispatching one oracle request. -/
inductive CallOutcome where
  | ok (value : Lean.Json)
  | domainError (code : String)
  | protocolError (message : String)

/-- Decode a JSON value into a Lean argument type. -/
class FromOracleJson (α : Type) where
  fromOracleJson : Lean.Json → Except String α

/-- Encode a Lean result value as JSON. -/
class ToOracleJson (α : Type) where
  toOracleJson : α → Lean.Json

/-- Map a Lean error type to the TypeScript diagnostic error code string. -/
class ToOracleError (ε : Type) where
  toErrorCode : ε → String

/-- Convert a function's return value (either pure or `Except`) into `CallOutcome`. -/
class ToOracleResult (α : Type) where
  toOutcome : α → CallOutcome

instance {ε α : Type} [ToOracleError ε] [ToOracleJson α] : ToOracleResult (Except ε α) where
  toOutcome
    | .ok a => .ok (ToOracleJson.toOracleJson a)
    | .error e => .domainError (ToOracleError.toErrorCode e)

instance (priority := low) {α : Type} [ToOracleJson α] : ToOracleResult α where
  toOutcome a := .ok (ToOracleJson.toOracleJson a)

instance : FromOracleJson Int where
  fromOracleJson j := do
    let s ← j.getStr?
    match s.toInt? with
    | some n => .ok n
    | none => .error s!"expected decimal integer string, got: {s}"

instance : ToOracleJson Int where
  toOracleJson n := Lean.Json.str (toString n)

instance : FromOracleJson Nat where
  fromOracleJson j := do
    let s ← j.getStr?
    match s.toNat? with
    | some n => .ok n
    | none => .error s!"expected decimal natural string, got: {s}"

instance : ToOracleJson Nat where
  toOracleJson n := Lean.Json.str (toString n)

instance : FromOracleJson Bool where
  fromOracleJson j := j.getBool?

instance : ToOracleJson Bool where
  toOracleJson b := Lean.Json.bool b

instance : FromOracleJson String where
  fromOracleJson j := j.getStr?

instance : ToOracleJson String where
  toOracleJson s := Lean.Json.str s

instance : FromOracleJson Ordering where
  fromOracleJson j := do
    let n ← j.getInt?
    if n = -1 then .ok .lt
    else if n = 0 then .ok .eq
    else if n = 1 then .ok .gt
    else .error s!"expected -1, 0, or 1 for Ordering, got: {n}"

instance : ToOracleJson Ordering where
  toOracleJson
    | .lt => Lean.Json.num (-1 : Int)
    | .eq => Lean.Json.num (0 : Int)
    | .gt => Lean.Json.num (1 : Int)

instance {α : Type} [FromOracleJson α] : FromOracleJson (Option α) where
  fromOracleJson j :=
    if j.isNull then .ok none
    else some <$> FromOracleJson.fromOracleJson j

instance {α : Type} [ToOracleJson α] : ToOracleJson (Option α) where
  toOracleJson
    | none => Lean.Json.null
    | some a => ToOracleJson.toOracleJson a

instance {α : Type} [FromOracleJson α] : FromOracleJson (Array α) where
  fromOracleJson j := do
    let arr ← j.getArr?
    arr.mapM FromOracleJson.fromOracleJson

instance {α : Type} [ToOracleJson α] : ToOracleJson (Array α) where
  toOracleJson arr := Lean.Json.arr (arr.map ToOracleJson.toOracleJson)

instance {α : Type} [FromOracleJson α] : FromOracleJson (List α) where
  fromOracleJson j := do
    let arr ← j.getArr?
    (arr.mapM FromOracleJson.fromOracleJson).map Array.toList

instance {α : Type} [ToOracleJson α] : ToOracleJson (List α) where
  toOracleJson xs := Lean.Json.arr (xs.toArray.map ToOracleJson.toOracleJson)

/-- Uniform handler signature for entries in the oracle dispatch table. -/
abbrev Handler := Array Lean.Json → CallOutcome

/-- Wrap a 0-argument Lean definition for the oracle dispatch table. -/
def fn0 {R : Type} [ToOracleResult R] (f : R) : Handler := fun args =>
  if args.size ≠ 0 then .protocolError s!"expected 0 args, got {args.size}"
  else ToOracleResult.toOutcome f

/-- Wrap a 1-argument Lean function for the oracle dispatch table. -/
def fn1 {A R : Type} [FromOracleJson A] [ToOracleResult R] (f : A → R) : Handler := fun args =>
  if _ : args.size = 1 then
    match FromOracleJson.fromOracleJson args[0] with
    | .ok a => ToOracleResult.toOutcome (f a)
    | .error e => .protocolError s!"arg 0: {e}"
  else .protocolError s!"expected 1 arg, got {args.size}"

/-- Wrap a 2-argument Lean function for the oracle dispatch table. -/
def fn2 {A B R : Type} [FromOracleJson A] [FromOracleJson B] [ToOracleResult R]
    (f : A → B → R) : Handler := fun args =>
  if _ : args.size = 2 then
    match FromOracleJson.fromOracleJson args[0], FromOracleJson.fromOracleJson args[1] with
    | .ok a, .ok b => ToOracleResult.toOutcome (f a b)
    | .error e, _ => .protocolError s!"arg 0: {e}"
    | _, .error e => .protocolError s!"arg 1: {e}"
  else .protocolError s!"expected 2 args, got {args.size}"

/-- Wrap a 3-argument Lean function for the oracle dispatch table. -/
def fn3 {A B C R : Type} [FromOracleJson A] [FromOracleJson B] [FromOracleJson C]
    [ToOracleResult R] (f : A → B → C → R) : Handler := fun args =>
  if _ : args.size = 3 then
    match FromOracleJson.fromOracleJson args[0], FromOracleJson.fromOracleJson args[1],
        FromOracleJson.fromOracleJson args[2] with
    | .ok a, .ok b, .ok c => ToOracleResult.toOutcome (f a b c)
    | .error e, _, _ => .protocolError s!"arg 0: {e}"
    | _, .error e, _ => .protocolError s!"arg 1: {e}"
    | _, _, .error e => .protocolError s!"arg 2: {e}"
  else .protocolError s!"expected 3 args, got {args.size}"

/-- Wrap a 4-argument Lean function for the oracle dispatch table. -/
def fn4 {A B C D R : Type} [FromOracleJson A] [FromOracleJson B] [FromOracleJson C]
    [FromOracleJson D] [ToOracleResult R] (f : A → B → C → D → R) : Handler := fun args =>
  if _ : args.size = 4 then
    match FromOracleJson.fromOracleJson args[0], FromOracleJson.fromOracleJson args[1],
        FromOracleJson.fromOracleJson args[2], FromOracleJson.fromOracleJson args[3] with
    | .ok a, .ok b, .ok c, .ok d => ToOracleResult.toOutcome (f a b c d)
    | .error e, _, _, _ => .protocolError s!"arg 0: {e}"
    | _, .error e, _, _ => .protocolError s!"arg 1: {e}"
    | _, _, .error e, _ => .protocolError s!"arg 2: {e}"
    | _, _, _, .error e => .protocolError s!"arg 3: {e}"
  else .protocolError s!"expected 4 args, got {args.size}"

/-- Answer many calls of one handler in a single request. The one argument is a list of argument
lists; the result is a list with `{"ok": value}` or `{"error": code}` for each, in order. A malformed
call anywhere is a protocol error for the whole request. -/
def each (handler : Handler) : Handler := fun args =>
  if _ : args.size = 1 then
    match args[0].getArr? with
    | .error e => .protocolError s!"arg 0: {e}"
    | .ok calls =>
      let step (acc : Except String (Array Lean.Json)) (call : Lean.Json) :
          Except String (Array Lean.Json) :=
        match acc with
        | .error e => .error e
        | .ok results =>
          match call.getArr? with
          | .error e => .error s!"call {results.size}: {e}"
          | .ok callArgs =>
            match handler callArgs with
            | .ok value => .ok (results.push (Lean.Json.mkObj [("ok", value)]))
            | .domainError code =>
              .ok (results.push (Lean.Json.mkObj [("error", Lean.Json.str code)]))
            | .protocolError message => .error s!"call {results.size}: {message}"
      match calls.foldl step (.ok #[]) with
      | .ok results => .ok (Lean.Json.arr results)
      | .error e => .protocolError e
  else .protocolError s!"expected 1 arg, got {args.size}"

end Oracle

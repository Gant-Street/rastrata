/-
The one import of every file in this project. It names the parts of Mathlib the proofs use,
because importing all of Mathlib costs a minute and 3 GB a build on the machine this runs on.
A file that needs more imports the specific Mathlib module itself, never `Mathlib`.
-/
import Mathlib.Data.Rat.Defs
import Mathlib.Data.Rat.Floor
import Mathlib.Data.Int.GCD
import Mathlib.Data.List.Basic
import Mathlib.Algebra.Order.Field.Basic
import Mathlib.Algebra.Order.Ring.Abs
import Mathlib.Algebra.BigOperators.Group.List.Basic
import Mathlib.Tactic.Ring
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Positivity
import Mathlib.Tactic.NormNum
import Mathlib.Tactic.Push
import Mathlib.Tactic.Zify
import Mathlib.Tactic.Qify

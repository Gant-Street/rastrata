/-
Pinned IANA time-zone identifiers: the Lean model of `packages/kernel/src/iana-timezones.ts`.

`zones` holds the 445 canonical identifiers in the exact order and exact spelling of `ZONES`.
`ZONE_SET = new Set(ZONES)` in TypeScript gives O(1) lookup with JavaScript string equality
(case-sensitive, exact UTF-16 code-unit match, no normalization or trimming); `isKnownIanaTimeZone`
checks the same UTF-16 length bounds (`3 <= length <= 64`), the same ASCII slash-delimited
segment syntax (`/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/`), and exact membership in `zones`.
-/
import Rastrata.Prelude

namespace Rastrata.Kernel

/-- `ZONES` (`iana-timezones.ts` lines 11–457). -/
def zones : List String := [
  "Africa/Abidjan", "Africa/Accra", "Africa/Addis_Ababa", "Africa/Algiers", "Africa/Asmera", "Africa/Bamako", "Africa/Bangui", "Africa/Banjul", "Africa/Bissau",
  "Africa/Blantyre", "Africa/Brazzaville", "Africa/Bujumbura", "Africa/Cairo", "Africa/Casablanca", "Africa/Ceuta", "Africa/Conakry", "Africa/Dakar", "Africa/Dar_es_Salaam",
  "Africa/Djibouti", "Africa/Douala", "Africa/El_Aaiun", "Africa/Freetown", "Africa/Gaborone", "Africa/Harare", "Africa/Johannesburg", "Africa/Juba", "Africa/Kampala",
  "Africa/Khartoum", "Africa/Kigali", "Africa/Kinshasa", "Africa/Lagos", "Africa/Libreville", "Africa/Lome", "Africa/Luanda", "Africa/Lubumbashi", "Africa/Lusaka",
  "Africa/Malabo", "Africa/Maputo", "Africa/Maseru", "Africa/Mbabane", "Africa/Mogadishu", "Africa/Monrovia", "Africa/Nairobi", "Africa/Ndjamena", "Africa/Niamey",
  "Africa/Nouakchott", "Africa/Ouagadougou", "Africa/Porto-Novo", "Africa/Sao_Tome", "Africa/Tripoli", "Africa/Tunis", "Africa/Windhoek", "America/Adak", "America/Anchorage",
  "America/Anguilla", "America/Antigua", "America/Araguaina", "America/Argentina/La_Rioja", "America/Argentina/Rio_Gallegos", "America/Argentina/Salta", "America/Argentina/San_Juan", "America/Argentina/San_Luis", "America/Argentina/Tucuman",
  "America/Argentina/Ushuaia", "America/Aruba", "America/Asuncion", "America/Bahia", "America/Bahia_Banderas", "America/Barbados", "America/Belem", "America/Belize", "America/Blanc-Sablon",
  "America/Boa_Vista", "America/Bogota", "America/Boise", "America/Buenos_Aires", "America/Cambridge_Bay", "America/Campo_Grande", "America/Cancun", "America/Caracas", "America/Catamarca",
  "America/Cayenne", "America/Cayman", "America/Chicago", "America/Chihuahua", "America/Ciudad_Juarez", "America/Coral_Harbour", "America/Cordoba", "America/Costa_Rica", "America/Coyhaique",
  "America/Creston", "America/Cuiaba", "America/Curacao", "America/Danmarkshavn", "America/Dawson", "America/Dawson_Creek", "America/Denver", "America/Detroit", "America/Dominica",
  "America/Edmonton", "America/Eirunepe", "America/El_Salvador", "America/Fort_Nelson", "America/Fortaleza", "America/Glace_Bay", "America/Godthab", "America/Goose_Bay", "America/Grand_Turk",
  "America/Grenada", "America/Guadeloupe", "America/Guatemala", "America/Guayaquil", "America/Guyana", "America/Halifax", "America/Havana", "America/Hermosillo", "America/Indiana/Knox",
  "America/Indiana/Marengo", "America/Indiana/Petersburg", "America/Indiana/Tell_City", "America/Indiana/Vevay", "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Indianapolis", "America/Inuvik", "America/Iqaluit",
  "America/Jamaica", "America/Jujuy", "America/Juneau", "America/Kentucky/Monticello", "America/Kralendijk", "America/La_Paz", "America/Lima", "America/Los_Angeles", "America/Louisville",
  "America/Lower_Princes", "America/Maceio", "America/Managua", "America/Manaus", "America/Marigot", "America/Martinique", "America/Matamoros", "America/Mazatlan", "America/Mendoza",
  "America/Menominee", "America/Merida", "America/Metlakatla", "America/Mexico_City", "America/Miquelon", "America/Moncton", "America/Monterrey", "America/Montevideo", "America/Montserrat",
  "America/Nassau", "America/New_York", "America/Nome", "America/Noronha", "America/North_Dakota/Beulah", "America/North_Dakota/Center", "America/North_Dakota/New_Salem", "America/Ojinaga", "America/Panama",
  "America/Paramaribo", "America/Phoenix", "America/Port-au-Prince", "America/Port_of_Spain", "America/Porto_Velho", "America/Puerto_Rico", "America/Punta_Arenas", "America/Rankin_Inlet", "America/Recife",
  "America/Regina", "America/Resolute", "America/Rio_Branco", "America/Santarem", "America/Santiago", "America/Santo_Domingo", "America/Sao_Paulo", "America/Scoresbysund", "America/Sitka",
  "America/St_Barthelemy", "America/St_Johns", "America/St_Kitts", "America/St_Lucia", "America/St_Thomas", "America/St_Vincent", "America/Swift_Current", "America/Tegucigalpa", "America/Thule",
  "America/Tijuana", "America/Toronto", "America/Tortola", "America/Vancouver", "America/Whitehorse", "America/Winnipeg", "America/Yakutat", "Antarctica/Casey", "Antarctica/Davis",
  "Antarctica/DumontDUrville", "Antarctica/Macquarie", "Antarctica/Mawson", "Antarctica/McMurdo", "Antarctica/Palmer", "Antarctica/Rothera", "Antarctica/Syowa", "Antarctica/Troll", "Antarctica/Vostok",
  "Arctic/Longyearbyen", "Asia/Aden", "Asia/Almaty", "Asia/Amman", "Asia/Anadyr", "Asia/Aqtau", "Asia/Aqtobe", "Asia/Ashgabat", "Asia/Atyrau",
  "Asia/Baghdad", "Asia/Bahrain", "Asia/Baku", "Asia/Bangkok", "Asia/Barnaul", "Asia/Beirut", "Asia/Bishkek", "Asia/Brunei", "Asia/Calcutta",
  "Asia/Chita", "Asia/Colombo", "Asia/Damascus", "Asia/Dhaka", "Asia/Dili", "Asia/Dubai", "Asia/Dushanbe", "Asia/Famagusta", "Asia/Gaza",
  "Asia/Hebron", "Asia/Hong_Kong", "Asia/Hovd", "Asia/Irkutsk", "Asia/Jakarta", "Asia/Jayapura", "Asia/Jerusalem", "Asia/Kabul", "Asia/Kamchatka",
  "Asia/Karachi", "Asia/Katmandu", "Asia/Khandyga", "Asia/Krasnoyarsk", "Asia/Kuala_Lumpur", "Asia/Kuching", "Asia/Kuwait", "Asia/Macau", "Asia/Magadan",
  "Asia/Makassar", "Asia/Manila", "Asia/Muscat", "Asia/Nicosia", "Asia/Novokuznetsk", "Asia/Novosibirsk", "Asia/Omsk", "Asia/Oral", "Asia/Phnom_Penh",
  "Asia/Pontianak", "Asia/Pyongyang", "Asia/Qatar", "Asia/Qostanay", "Asia/Qyzylorda", "Asia/Rangoon", "Asia/Riyadh", "Asia/Saigon", "Asia/Sakhalin",
  "Asia/Samarkand", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore", "Asia/Srednekolymsk", "Asia/Taipei", "Asia/Tashkent", "Asia/Tbilisi", "Asia/Tehran",
  "Asia/Thimphu", "Asia/Tokyo", "Asia/Tomsk", "Asia/Ulaanbaatar", "Asia/Urumqi", "Asia/Ust-Nera", "Asia/Vientiane", "Asia/Vladivostok", "Asia/Yakutsk",
  "Asia/Yekaterinburg", "Asia/Yerevan", "Atlantic/Azores", "Atlantic/Bermuda", "Atlantic/Canary", "Atlantic/Cape_Verde", "Atlantic/Faeroe", "Atlantic/Madeira", "Atlantic/Reykjavik",
  "Atlantic/South_Georgia", "Atlantic/St_Helena", "Atlantic/Stanley", "Australia/Adelaide", "Australia/Brisbane", "Australia/Broken_Hill", "Australia/Darwin", "Australia/Eucla", "Australia/Hobart",
  "Australia/Lindeman", "Australia/Lord_Howe", "Australia/Melbourne", "Australia/Perth", "Australia/Sydney", "Etc/GMT+1", "Etc/GMT+10", "Etc/GMT+11", "Etc/GMT+12",
  "Etc/GMT+2", "Etc/GMT+3", "Etc/GMT+4", "Etc/GMT+5", "Etc/GMT+6", "Etc/GMT+7", "Etc/GMT+8", "Etc/GMT+9", "Etc/GMT-1",
  "Etc/GMT-10", "Etc/GMT-11", "Etc/GMT-12", "Etc/GMT-13", "Etc/GMT-14", "Etc/GMT-2", "Etc/GMT-3", "Etc/GMT-4", "Etc/GMT-5",
  "Etc/GMT-6", "Etc/GMT-7", "Etc/GMT-8", "Etc/GMT-9", "Europe/Amsterdam", "Europe/Andorra", "Europe/Astrakhan", "Europe/Athens", "Europe/Belgrade",
  "Europe/Berlin", "Europe/Bratislava", "Europe/Brussels", "Europe/Bucharest", "Europe/Budapest", "Europe/Busingen", "Europe/Chisinau", "Europe/Copenhagen", "Europe/Dublin",
  "Europe/Gibraltar", "Europe/Guernsey", "Europe/Helsinki", "Europe/Isle_of_Man", "Europe/Istanbul", "Europe/Jersey", "Europe/Kaliningrad", "Europe/Kiev", "Europe/Kirov",
  "Europe/Lisbon", "Europe/Ljubljana", "Europe/London", "Europe/Luxembourg", "Europe/Madrid", "Europe/Malta", "Europe/Mariehamn", "Europe/Minsk", "Europe/Monaco",
  "Europe/Moscow", "Europe/Oslo", "Europe/Paris", "Europe/Podgorica", "Europe/Prague", "Europe/Riga", "Europe/Rome", "Europe/Samara", "Europe/San_Marino",
  "Europe/Sarajevo", "Europe/Saratov", "Europe/Simferopol", "Europe/Skopje", "Europe/Sofia", "Europe/Stockholm", "Europe/Tallinn", "Europe/Tirane", "Europe/Ulyanovsk",
  "Europe/Vaduz", "Europe/Vatican", "Europe/Vienna", "Europe/Vilnius", "Europe/Volgograd", "Europe/Warsaw", "Europe/Zagreb", "Europe/Zurich", "Indian/Antananarivo",
  "Indian/Chagos", "Indian/Christmas", "Indian/Cocos", "Indian/Comoro", "Indian/Kerguelen", "Indian/Mahe", "Indian/Maldives", "Indian/Mauritius", "Indian/Mayotte",
  "Indian/Reunion", "Pacific/Apia", "Pacific/Auckland", "Pacific/Bougainville", "Pacific/Chatham", "Pacific/Easter", "Pacific/Efate", "Pacific/Enderbury", "Pacific/Fakaofo",
  "Pacific/Fiji", "Pacific/Funafuti", "Pacific/Galapagos", "Pacific/Gambier", "Pacific/Guadalcanal", "Pacific/Guam", "Pacific/Honolulu", "Pacific/Kiritimati", "Pacific/Kosrae",
  "Pacific/Kwajalein", "Pacific/Majuro", "Pacific/Marquesas", "Pacific/Midway", "Pacific/Nauru", "Pacific/Niue", "Pacific/Norfolk", "Pacific/Noumea", "Pacific/Pago_Pago",
  "Pacific/Palau", "Pacific/Pitcairn", "Pacific/Ponape", "Pacific/Port_Moresby", "Pacific/Rarotonga", "Pacific/Saipan", "Pacific/Tahiti", "Pacific/Tarawa", "Pacific/Tongatapu",
  "Pacific/Truk", "Pacific/Wake", "Pacific/Wallis", "UTC"
]

/-- UTF-16 code-unit length of `s`, matching JavaScript `String.prototype.length`. -/
def utf16Length (s : String) : Nat :=
  s.toList.foldl (fun acc c => acc + if c.toNat ≥ 0x10000 then 2 else 1) 0

/-- Character class `[A-Za-z0-9_+\-]` (case-sensitive ASCII). -/
def isZoneSegmentChar (c : Char) : Bool :=
  let n := c.toNat
  (65 ≤ n && n ≤ 90) || (97 ≤ n && n ≤ 122) || (48 ≤ n && n ≤ 57) ||
    n == 95 || n == 43 || n == 45

private def validSegments : List Char → Bool
  | [] => true
  | '/' :: c :: rest => isZoneSegmentChar c && validSegments rest
  | c :: rest => isZoneSegmentChar c && validSegments rest

/-- `/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/`. -/
def isValidIanaSyntax (s : String) : Bool :=
  match s.toList with
  | [] => false
  | c :: rest => isZoneSegmentChar c && validSegments rest

/-- `isKnownIanaTimeZone` (`iana-timezones.ts` lines 467–471).
Checks UTF-16 length in `[3, 64]`, the ASCII segment regex, and exact case-sensitive membership
in `zones` (extensionally identical to `ZONE_SET.has(value)`). -/
def isKnownIanaTimeZone (value : String) : Bool :=
  let len := utf16Length value
  if len < 3 || len > 64 then false
  else isValidIanaSyntax value && zones.contains value

/-- Every character of `s` is 7-bit ASCII (`c.toNat < 128`). -/
def isAsciiString (s : String) : Bool :=
  s.toList.all (fun c => decide (c.toNat < 128))

/-- Length, syntax, and membership preconditions checked on every entry of `zones`. -/
def isValidZoneEntry (z : String) : Bool :=
  let len := utf16Length z
  3 ≤ len && len ≤ 64 && isValidIanaSyntax z

/-- Linear adjacency check that a list of strings is strictly increasing under `<`. -/
def isStrictlySorted : List String → Bool
  | [] | [_] => true
  | a :: b :: rest => decide (a < b) && isStrictlySorted (b :: rest)

private theorem zones_all_valid_entries : zones.all isValidZoneEntry = true := by
  decide +kernel

private theorem zones_strictly_sorted : isStrictlySorted zones = true := by
  decide +kernel

/-- `isKnownIanaTimeZone` returns `true` if and only if the identifier is in `zones`. -/
theorem isKnownIanaTimeZone_iff (value : String) :
    isKnownIanaTimeZone value = true ↔ value ∈ zones := by
  constructor
  · intro h
    unfold isKnownIanaTimeZone at h
    dsimp only at h
    split at h
    · contradiction
    · simp only [Bool.and_eq_true, List.contains_iff_mem] at h
      exact h.2
  · intro h
    have hvalid := List.all_eq_true.mp zones_all_valid_entries value h
    unfold isValidZoneEntry at hvalid
    dsimp only at hvalid
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hvalid
    rcases hvalid with ⟨⟨hmin, hmax⟩, hsyn⟩
    unfold isKnownIanaTimeZone
    dsimp only
    have hlen : (decide (utf16Length value < 3) || decide (utf16Length value > 64)) = false := by
      simp only [Bool.or_eq_false_eq_eq_false_and_eq_false, decide_eq_false_iff_not]
      omega
    rw [hlen]
    simp only [Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true, List.contains_iff_mem]
    exact ⟨hsyn, h⟩

private theorem pairwise_lt_of_strictlySorted :
    ∀ {l : List String}, isStrictlySorted l = true → l.Pairwise (· < ·)
  | [], _ => .nil
  | [_], _ => List.Pairwise.cons (fun _ h => by simp at h) .nil
  | a :: b :: rest, h => by
    simp only [isStrictlySorted, Bool.and_eq_true, decide_eq_true_eq] at h
    have htail := pairwise_lt_of_strictlySorted h.2
    refine List.Pairwise.cons ?_ htail
    intro c hc
    rcases List.mem_cons.mp hc with rfl | hc'
    · exact h.1
    · exact Std.lt_trans h.1 ((List.pairwise_cons.mp htail).1 c hc')

/-- The pinned IANA time-zone list has no duplicate entries. -/
theorem zones_nodup : zones.Nodup :=
  (pairwise_lt_of_strictlySorted zones_strictly_sorted).imp fun hlt heq =>
    absurd (heq ▸ hlt) Std.lt_irrefl

private theorem isZoneSegmentChar_ascii {c : Char} (h : isZoneSegmentChar c = true) :
    c.toNat < 128 := by
  unfold isZoneSegmentChar at h
  simp only [Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq] at h
  omega

private theorem validSegments_ascii :
    ∀ (cs : List Char), validSegments cs = true → ∀ x ∈ cs, x.toNat < 128
  | [], _ => fun _ hx => by simp at hx
  | c :: rest, h => by
    cases rest with
    | nil =>
      have h' : isZoneSegmentChar c = true := by simpa [validSegments] using h
      intro x hx
      rw [List.mem_singleton.mp hx]
      exact isZoneSegmentChar_ascii h'
    | cons d ds =>
      by_cases hc : c = '/'
      · subst hc
        simp only [validSegments, Bool.and_eq_true] at h
        intro x hx
        rcases List.mem_cons.mp hx with rfl | hx'
        · decide
        · rcases List.mem_cons.mp hx' with rfl | hx''
          · exact isZoneSegmentChar_ascii h.1
          · exact validSegments_ascii ds h.2 x hx''
      · have h' : isZoneSegmentChar c = true ∧ validSegments (d :: ds) = true := by
          simpa [validSegments, hc] using h
        intro x hx
        rcases List.mem_cons.mp hx with rfl | hx'
        · exact isZoneSegmentChar_ascii h'.1
        · exact validSegments_ascii (d :: ds) h'.2 x hx'
termination_by cs => cs.length

/-- Any identifier matching the IANA time-zone syntax uses only 7-bit ASCII characters. -/
theorem isAsciiString_of_isValidIanaSyntax {s : String} (h : isValidIanaSyntax s = true) :
    isAsciiString s = true := by
  unfold isValidIanaSyntax at h
  unfold isAsciiString
  rw [List.all_eq_true]
  cases hcs : s.toList with
  | nil => simp [hcs] at h
  | cons c rest =>
    rw [hcs] at h
    simp only [Bool.and_eq_true] at h
    intro x hx
    rw [decide_eq_true_eq]
    rcases List.mem_cons.mp hx with rfl | hx'
    · exact isZoneSegmentChar_ascii h.1
    · exact validSegments_ascii rest h.2 x hx'

/-- Every name in the pinned IANA time-zone list is pure 7-bit ASCII. -/
theorem zones_ascii : ∀ z ∈ zones, isAsciiString z = true := by
  intro z hz
  have hvalid := List.all_eq_true.mp zones_all_valid_entries z hz
  unfold isValidZoneEntry at hvalid
  dsimp only at hvalid
  simp only [Bool.and_eq_true] at hvalid
  exact isAsciiString_of_isValidIanaSyntax hvalid.2

end Rastrata.Kernel

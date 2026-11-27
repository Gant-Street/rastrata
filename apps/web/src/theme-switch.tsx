import { Segment } from "@rastrata/ui";
import { createSignal } from "solid-js";
import { applyTheme, storedTheme, type Theme } from "./theme";

const choices: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
];

// One choice for the whole page, so the switch in the footer and the one in Settings, Business agree
// whichever was pressed.
const [theme, setTheme] = createSignal<Theme>(storedTheme());

/** Light, dark, or follow the system: the kit's segmented control, small, in the footer. The choice is remembered on this device. */
export function ThemeSwitch() {
  return (
    <div class="theme-switch">
      <span aria-hidden="true">Theme</span>
      <Segment
        label="Theme"
        value={theme()}
        options={choices}
        onChange={(value) => {
          applyTheme(value);
          setTheme(value);
        }}
      />
    </div>
  );
}

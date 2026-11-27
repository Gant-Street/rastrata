import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Check,
  Plus,
  Search,
  X,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  LockKeyhole,
} from "../src/icons";
import { For } from "solid-js";
import { Button, Notice, TextField } from "../src";
import { Catalog, Specimen } from "./catalog";

function Rules() {
  return (
    <Catalog
      section="01 / Foundations"
      title="Precision, without noise."
      description="Inter. Five source-defined colors. A four-pixel spacing unit. Enough structure to do careful work, without decoration competing with the figures."
    >
      <Specimen
        title="Type hierarchy"
        note="Weight and spacing establish priority. Tabular figures align without changing typefaces."
      >
        <div class="rt-stack">
          <p
            class="catalog-type"
            style={{ "font-size": "2rem", "font-weight": 600, "letter-spacing": "-.04em" }}
          >
            September, in balance.
          </p>
          <p class="catalog-type" style={{ "font-size": "1.25rem", "font-weight": 600 }}>
            General journal
          </p>
          <p class="catalog-type">Body · 15px / 1.5 · Keep the explanation short.</p>
          <p class="rt-hint">
            Supporting text · 13px equivalent · Never hide the essential detail.
          </p>
          <p class="catalog-type" style={{ "font-size": "1.5rem" }}>
            1,234,567.89 &nbsp; (98.10) &nbsp; 0.00
          </p>
        </div>
      </Specimen>
      <Specimen
        title="Spacing"
        note="4, 8, 12, 16, 24 and 32px. Tight within a relationship; generous between separate tasks."
      >
        <div class="rt-stack">
          <For each={[4, 8, 12, 16, 24, 32]}>
            {(space) => (
              <div class="catalog-scale">
                <code>{space}px</code>
                <span style={{ width: `${space}px` }} />
              </div>
            )}
          </For>
        </div>
      </Specimen>
      <Specimen
        title="Geometry & density"
        note="2px corners. Quiet separators, stronger input boundaries. Compact changes spacing, not the legibility of the type."
      >
        <div class="catalog-split">
          <TextField label="Comfortable" value="September adjustments" readOnly />
          <div style={{ "--rt-control-padding": ".375rem .625rem" }}>
            <TextField label="Compact" value="September adjustments" readOnly />
          </div>
        </div>
      </Specimen>
      <Specimen
        title="Icons"
        note="Lucide, 18px and a consistent stroke. Icons support labels; icon-only controls always need an accessible name."
      >
        <div class="catalog-row">
          <Search aria-label="Search" role="img" />
          <Plus aria-label="Add" role="img" />
          <Check aria-label="Confirmed" role="img" />
          <X aria-label="Close" role="img" />
          <CalendarDays aria-label="Calendar" role="img" />
          <ChevronDown aria-label="Expand" role="img" />
          <LockKeyhole aria-label="Locked" role="img" />
          <ArrowRight aria-label="Continue" role="img" />
        </div>
      </Specimen>
      <Specimen
        title="Focus & motion"
        note="Blue outlines belong to keyboard focus. Transitions take 120ms; reduced-motion preferences remove animation."
      >
        <div class="catalog-row">
          <Button label="Tab to this button" />
          <TextField label="Then to this field" placeholder="Visible, not surprising" />
        </div>
      </Specimen>
      <Specimen
        title="Words & meaning"
        note="Explain the next action. Do not expose infrastructure or imply an outcome we have not confirmed."
      >
        <div class="rt-stack">
          <Notice title="Enter your password">
            Not “Use the password stored for this account.”
          </Notice>
          <Notice title="Checking whether your entry was posted" tone="review">
            Not “Failed” when the result is still unknown.
          </Notice>
        </div>
      </Specimen>
    </Catalog>
  );
}
export default {
  title: "Foundations/System rules",
  component: Rules,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof Rules>;
export const Review: StoryObj<typeof Rules> = {};

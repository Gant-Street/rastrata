import { createSignal, For, Show } from "solid-js";
import { Plus, Trash, Check } from "../src/icons";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, buttonAttrs, Dialog, DialogClose, Notice, Status, TextField } from "../src";
import { Catalog } from "./catalog";
import { AccountPicker, CalendarField } from "./controls";

type Line = { id: number; account: string; debit: string; credit: string };
function Journal(props: { unbalanced: boolean }) {
  const initial = (): Line[] => [
    { id: 1, account: "office", debit: "128.40", credit: "" },
    { id: 2, account: "cash", debit: "", credit: props.unbalanced ? "120.00" : "128.40" },
  ];
  const [lines, setLines] = createSignal(initial());
  const [edited, setEdited] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [posted, setPosted] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  let nextId = 3;
  let addLineButton: HTMLButtonElement | undefined;
  // Input values stay in their native controls while editing. Keep row identity
  // stable so typing does not unmount a row and lose keyboard focus.
  const update = () => {
    setEdited(true);
    setSaved(false);
  };
  return (
    <Catalog
      section="06 / Journal entry"
      title="A record worth keeping."
      description="North Workshop · USD · Journal-entry composition. Exact amounts stay as entered; accounting evaluation belongs to the application."
    >
      <Show
        when={!posted()}
        fallback={
          <Notice title="Preview entry posted" role="status">
            <p>The supplied balanced fixture has been confirmed in this preview only.</p>
            <a href="?id=patterns-journal--posted&viewMode=story">Review a posted-entry specimen</a>
          </Notice>
        }
      >
        <div class="catalog-split">
          <TextField label="Reference" value="Office supplies" onInput={update} />
          <CalendarField defaultDateValues={["2026-09-23"]} onDatesChange={update} />
        </div>
        <div class="catalog-toolbar">
          <h2>Journal lines</h2>
          <Status>Draft</Status>
        </div>
        <section
          class="rt-table-scroll"
          tabindex={0}
          aria-label="Journal lines, scroll horizontally on narrow screens"
        >
          <table class="rt-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" class="rt-number">
                  Debit · USD
                </th>
                <th scope="col" class="rt-number">
                  Credit · USD
                </th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              <For each={lines()}>
                {(line) => (
                  <tr>
                    <td>
                      <AccountPicker
                        label={`Account for line ${line.id}`}
                        value={line.account}
                        onChange={update}
                      />
                    </td>
                    <td>
                      <input
                        class="rt-input rt-number"
                        aria-label={`Debit for line ${line.id}`}
                        inputmode="decimal"
                        value={line.debit}
                        onInput={update}
                      />
                    </td>
                    <td>
                      <input
                        class="rt-input rt-number"
                        aria-label={`Credit for line ${line.id}`}
                        inputmode="decimal"
                        value={line.credit}
                        onInput={update}
                      />
                    </td>
                    <td>
                      <Button
                        variant="quiet"
                        iconOnly
                        icon={<Trash />}
                        label={`Remove line ${line.id}`}
                        disabled={lines().length <= 2}
                        onClick={() => {
                          setEdited(true);
                          setSaved(false);
                          setLines((current) => current.filter((item) => item.id !== line.id));
                          addLineButton?.focus();
                        }}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{edited() ? "Awaiting evaluation" : "Fixture totals"}</th>
                <td class="rt-number">{edited() ? "—" : "128.40"}</td>
                <td class="rt-number">{edited() ? "—" : props.unbalanced ? "120.00" : "128.40"}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </section>
        <div class="catalog-toolbar">
          <Button
            ref={addLineButton}
            variant="secondary"
            icon={<Plus />}
            label="Add line"
            onClick={() => {
              setEdited(true);
              setSaved(false);
              setLines((current) => [
                ...current,
                { id: nextId++, account: "", debit: "", credit: "" },
              ]);
            }}
          />
          <span class="rt-hint">At least two lines · No real posting</span>
        </div>
        <Show when={edited()}>
          <Notice title="This edited draft needs accounting evaluation" tone="review">
            The preview does not calculate new totals. Reload the story to restore the evaluated
            fixture.
          </Notice>
        </Show>
        <Show when={!edited() && props.unbalanced}>
          <Notice title="Debits and credits do not balance" tone="error">
            The supplied fixture has a difference of USD 8.40. Posting is unavailable.
          </Notice>
        </Show>
        <div class="catalog-toolbar">
          <Button label="Save draft" variant="secondary" onClick={() => setSaved(true)} />
          <Button
            label="Review posting"
            disabled={edited() || props.unbalanced}
            onClick={() => setOpen(true)}
          />
          <Dialog
            open={open()}
            onOpenChange={setOpen}
            title="Review this posting"
            description="Office supplies · USD 128.40 debit and credit. This is a preview, not a real ledger submission."
            footer={
              <>
                <DialogClose {...buttonAttrs({ variant: "secondary" })}>Keep editing</DialogClose>
                <Button
                  label="Confirm preview posting"
                  onClick={() => {
                    setOpen(false);
                    setPosted(true);
                  }}
                />
              </>
            }
          >
            <Notice title="Balanced fixture">Both sides total USD 128.40.</Notice>
          </Dialog>
        </div>
        <Show when={saved()}>
          <p role="status" class="rt-hint">
            Draft saved in this preview only. Reloading clears it.
          </p>
        </Show>
      </Show>
    </Catalog>
  );
}

function PostedExample() {
  return (
    <Catalog
      section="06 / Posted entry"
      title="The record stays intact."
      description="JRN-0043 · North Workshop · September 22, 2026. A posted entry is read-only; its history explains how it came to be."
    >
      <div class="catalog-toolbar">
        <h2>Office supplies</h2>
        <Status>
          <Check aria-hidden="true" /> Posted
        </Status>
      </div>
      <div class="rt-table-scroll">
        <table class="rt-table">
          <caption>Postings · USD</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" class="rt-number">
                Debit
              </th>
              <th scope="col" class="rt-number">
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">6100 · Office expenses</th>
              <td class="rt-number">128.40</td>
              <td class="rt-number">—</td>
            </tr>
            <tr>
              <th scope="row">1000 · Cash</th>
              <td class="rt-number">—</td>
              <td class="rt-number">128.40</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td class="rt-number">128.40</td>
              <td class="rt-number">128.40</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <section style={{ "margin-top": "2rem" }}>
        <h2>Entry history</h2>
        <ol class="catalog-history">
          <li>
            <time datetime="2026-09-22T09:40:00Z">09:40 UTC</time>
            <div>
              <strong>Draft created</strong>
              <p class="rt-hint">Alex Morgan · Office supplies</p>
            </div>
          </li>
          <li>
            <time datetime="2026-09-22T09:43:00Z">09:43 UTC</time>
            <div>
              <strong>Entry posted</strong>
              <p class="rt-hint">Alex Morgan · JRN-0043</p>
            </div>
          </li>
        </ol>
        <Notice title="Corrections preserve history">
          A correction must retain the original accounting record. This specimen does not offer an
          edit-in-place or delete action.
        </Notice>
      </section>
    </Catalog>
  );
}
export default {
  title: "Patterns/Journal",
  component: Journal,
  args: { unbalanced: false },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Journal>;
type Story = StoryObj<typeof Journal>;
export const Review: Story = {};
export const Unbalanced: Story = { args: { unbalanced: true } };
export const Posted: Story = { render: () => <PostedExample /> };

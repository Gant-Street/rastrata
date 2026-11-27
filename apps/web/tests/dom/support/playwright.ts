// Playwright's test API on a page of happy-dom: `test`, `expect`, `page` and `request` as the browser tests use them,
// so a test that is about what a screen shows and does moves from tests/browser to tests/dom with its body unchanged,
// and runs in milliseconds against the real application in this process (support/book.ts).
//
// What it keeps from Playwright: locators are lazy and strict (an action on a locator that finds two elements fails),
// actions and `expect` on a locator wait for the page, a name or a text given as a string matches part of the text
// whatever its case unless `exact` says otherwise, and typing, clicks and keys go through user-event, so Enter on a
// button presses it and Tab moves the focus. What it cannot have is a real layout: sizes, positions, colours, the
// accessibility scan and screenshots stay in the browser tests, and the calls that need them say so.
import {
  afterAll as bunAfterAll,
  afterEach as bunAfterEach,
  beforeAll as bunBeforeAll,
  beforeEach as bunBeforeEach,
  describe as bunDescribe,
  expect as bunExpect,
  setSystemTime,
  test as bunTest,
} from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { cleanup } from "@solidjs/testing-library";
import { queryAllByRole } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { computeAccessibleName } from "dom-accessibility-api";
import { openApp } from "./app";
import { type Book, openBook } from "./book";

const WAIT_MS = Number(process.env.DOM_WAIT_MS ?? 5_000);
/** The scan's rules that measure the layout, which happy-dom does not have. */
const LAYOUT_RULES = {
  "color-contrast": { enabled: false },
  "color-contrast-enhanced": { enabled: false },
  "target-size": { enabled: false },
  "scrollable-region-focusable": { enabled: false },
};
const TEST_MS = 60_000;

// ---- text and visibility ------------------------------------------------------------------------------------------

const normal = (text: string) => text.replace(/\s+/g, " ").trim();

type Text = string | RegExp;

/** Playwright's rule for a name or a text: a RegExp tests it, an exact string is the whole of it, any other string is
 * a part of it in any case. */
function matches(value: string, wanted: Text, exact = false): boolean {
  const text = normal(value);
  if (wanted instanceof RegExp) return wanted.test(text);
  return exact
    ? text === normal(wanted)
    : text.toLowerCase().includes(normal(wanted).toLowerCase());
}

/** Out of sight: hidden by the style sheet (the application's own is on the page, support/dom-preload.ts), by an
 * attribute, or inside a closed <details> or <dialog>. There is no layout, so an element of no size still counts as
 * in sight. */
function invisible(element: Element): boolean {
  if (!element.isConnected) return true;
  if (style(element).visibility === "hidden") return true;
  return hiddenByAncestry(element);
}

/** The page's version: it moves on with every change to it (and with the window's size, which the style sheet's media
 * queries read), so what was worked out about an element holds until then. happy-dom works a computed style out
 * again each time it is asked, and a wait asks many times. */
let version = 0;
export const pageChanged = () => {
  version += 1;
};
new MutationObserver(pageChanged).observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
});

const styles = new WeakMap<Element, { at: number; style: CSSStyleDeclaration }>();
function style(element: Element): CSSStyleDeclaration {
  const kept = styles.get(element);
  if (kept && kept.at === version) return kept.style;
  const computed = getComputedStyle(element);
  // A snapshot of what the checks read, not the live declaration, which happy-dom works out on each read.
  const snapshot = {
    display: computed.display,
    visibility: computed.visibility,
  } as CSSStyleDeclaration;
  styles.set(element, { at: version, style: snapshot });
  return snapshot;
}

const ancestry = new WeakMap<Element, { at: number; hidden: boolean }>();
function hiddenByAncestry(node: Element): boolean {
  const kept = ancestry.get(node);
  if (kept && kept.at === version) return kept.hidden;
  const parent = node.parentElement;
  const hidden =
    (node.hasAttribute("hidden") && node.getAttribute("hidden") !== "until-found") ||
    style(node).display === "none" ||
    (parent?.tagName === "DETAILS" &&
      !(parent as HTMLDetailsElement).open &&
      node.tagName !== "SUMMARY") ||
    (node.tagName === "DIALOG" && !(node as HTMLDialogElement).open) ||
    node.tagName === "TEMPLATE" ||
    (parent ? hiddenByAncestry(parent) : false);
  ancestry.set(node, { at: version, hidden });
  return hidden;
}

/** Out of the accessibility tree too, as Playwright's role queries see it. */
function inaccessible(element: Element): boolean {
  if (invisible(element)) return true;
  for (let node: Element | null = element; node; node = node.parentElement)
    if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) return true;
  return false;
}

/** The text as it reads on the page (Playwright's `useInnerText`): what the style sheet hides is left out, and a part
 * that is laid out as a block (or as an item of a flex or grid row) is set apart from its neighbours. */
function renderedText(element: Element): string {
  const parts: string[] = [];
  const walk = (node: Node, parentDisplay: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.tagName === "BR") {
      parts.push("\n");
      return;
    }
    const display = getComputedStyle(child).display;
    if (
      display === "none" ||
      (child.hasAttribute("hidden") && child.getAttribute("hidden") !== "until-found")
    )
      return;
    const apart =
      /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/.test(display) ||
      /^(inline-)?(flex|grid)$/.test(parentDisplay);
    if (apart) parts.push("\n");
    for (let inner = child.firstChild; inner; inner = inner.nextSibling) walk(inner, display);
    if (apart) parts.push("\n");
  };
  const display = getComputedStyle(element).display;
  for (let inner = element.firstChild; inner; inner = inner.nextSibling) walk(inner, display);
  return parts.join("");
}

const textOf = (element: Element): string => {
  if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type))
    return element.value;
  return element.textContent ?? "";
};

function labelsOf(element: Element): string[] {
  const out: string[] = [];
  const by = element.getAttribute("aria-labelledby");
  if (by)
    out.push(
      by
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
  const aria = element.getAttribute("aria-label");
  if (aria) out.push(aria);
  const labels = (element as HTMLInputElement).labels;
  if (labels) for (const label of Array.from(labels)) out.push(label.textContent ?? "");
  return out;
}

// ---- locators -----------------------------------------------------------------------------------------------------

type Resolve = () => Element[];

type RoleOptions = {
  name?: Text;
  exact?: boolean;
  checked?: boolean;
  pressed?: boolean;
  selected?: boolean;
  expanded?: boolean;
  level?: number;
  disabled?: boolean;
  includeHidden?: boolean;
};

const unique = (elements: Element[]): Element[] => {
  const seen = new Set<Element>();
  return elements.filter((element) => {
    if (seen.has(element)) return false;
    seen.add(element);
    return true;
  });
};

const inOrder = (elements: Element[]): Element[] =>
  unique(elements).sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );

/** Fields that Chromium's accessibility tree calls a textbox and the role library calls nothing. */
const DATE_FIELDS =
  'input[type="date"],input[type="time"],input[type="datetime-local"],input[type="month"],input[type="week"]';

/** The same options with no name, for saying what elements of a role there are. */
function withoutName(options: RoleOptions = {}): RoleOptions {
  const { name: _name, ...rest } = options;
  return rest;
}

function byRole(root: Element, role: string, options: RoleOptions = {}): Element[] {
  const { name, exact, includeHidden, disabled, ...states } = options;
  const roled = queryAllByRole(root as HTMLElement, role, { hidden: true, ...states });
  if (role === "textbox")
    roled.push(...(Array.from(root.querySelectorAll(DATE_FIELDS)) as HTMLElement[]));
  // <search> is the search landmark to a browser; the role library is older than the element.
  if (role === "search")
    roled.push(
      ...(Array.from(root.querySelectorAll("search:not([role])")) as HTMLElement[]),
      ...(root.matches?.("search:not([role])") ? [root as HTMLElement] : []),
    );
  const found = inOrder(roled).filter((element) => includeHidden || !inaccessible(element));
  return found.filter((element) => {
    if (disabled !== undefined && isDisabled(element) !== disabled) return false;
    if (name === undefined) return true;
    return matches(computeAccessibleName(element), name, exact);
  });
}

function byText(root: Element, wanted: Text, exact = false): Element[] {
  const all = [root, ...Array.from(root.querySelectorAll("*"))].filter(
    (element) => !["SCRIPT", "STYLE", "TEMPLATE", "HEAD", "TITLE"].includes(element.tagName),
  );
  const hits = all.filter((element) => matches(textOf(element), wanted, exact));
  // The innermost elements that hold the text, as Playwright picks them.
  return hits.filter(
    (element) => !hits.some((other) => other !== element && element.contains(other)),
  );
}

function byLabel(root: Element, wanted: Text, exact = false): Element[] {
  return Array.from(root.querySelectorAll("*")).filter((element) =>
    labelsOf(element).some((label) => matches(label, wanted, exact)),
  );
}

function isDisabled(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  const fieldset = element.closest("fieldset");
  return !!fieldset && (fieldset as HTMLFieldSetElement).disabled && !element.closest("legend");
}

/** Run a script's source in the page's global scope, as a <script> runs it (a test's own expression or script). */
// biome-ignore lint/security/noGlobalEval: the source is the test's own, as Playwright's evaluate and addScriptTag run it
const globalEval = (source: string): unknown => globalThis.eval(source);

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Ask until `check` is true, or fail with what it says about the page then. What it says is worked out only for the
 * failure (it can name every element with a role, which is not cheap), and the asking slows from 10 ms to 100 ms:
 * most answers come at once, and a long wait needs no tight loop. */
async function until(
  check: () => true | string | (() => string),
  timeout = WAIT_MS,
): Promise<void> {
  const deadline = performance.now() + timeout;
  let pause = 10;
  for (;;) {
    const result = check();
    if (result === true) return;
    if (performance.now() > deadline)
      throw new Error(typeof result === "function" ? result() : result);
    await wait(pause);
    pause = Math.min(100, pause * 1.5);
  }
}

class DomLocator {
  /** What to say about the page when this locator finds nothing. */
  hint: () => string = () => "";
  constructor(
    readonly page: DomPage,
    readonly resolve: Resolve,
    readonly description: string,
  ) {}

  private child(make: (root: Element) => Element[], description: string): DomLocator {
    return new DomLocator(
      this.page,
      () => inOrder(this.resolve().flatMap(make)),
      `${this.description} >> ${description}`,
    );
  }

  getByRole(role: string, options?: RoleOptions) {
    const located = this.child(
      (root) => byRole(root, role, options),
      `role=${role}${options?.name ? `[name=${options.name}]` : ""}`,
    );
    // When nothing matches, say what there is: the names of every element with that role.
    located.hint = () => {
      const all = this.resolve().flatMap((root) => byRole(root, role, withoutName(options)));
      return `the ${role} elements are: ${all.map((element) => JSON.stringify(computeAccessibleName(element))).join(", ") || "none"}`;
    };
    return located;
  }
  getByText(text: Text, options?: { exact?: boolean }) {
    return this.child((root) => byText(root, text, options?.exact), `text=${text}`);
  }
  getByLabel(text: Text, options?: { exact?: boolean }) {
    return this.child((root) => byLabel(root, text, options?.exact), `label=${text}`);
  }
  getByPlaceholder(text: Text, options?: { exact?: boolean }) {
    return this.child(
      (root) =>
        Array.from(root.querySelectorAll("[placeholder]")).filter((element) =>
          matches(element.getAttribute("placeholder") ?? "", text, options?.exact),
        ),
      `placeholder=${text}`,
    );
  }
  getByTitle(text: Text, options?: { exact?: boolean }) {
    return this.child(
      (root) =>
        Array.from(root.querySelectorAll("[title]")).filter((element) =>
          matches(element.getAttribute("title") ?? "", text, options?.exact),
        ),
      `title=${text}`,
    );
  }
  getByTestId(id: string) {
    return this.child(
      (root) => Array.from(root.querySelectorAll(`[data-testid="${id}"]`)),
      `testid=${id}`,
    );
  }
  locator(selector: string | DomLocator, options?: FilterOptions) {
    const located =
      typeof selector === "string"
        ? this.child((root) => select(root, selector), selector)
        : this.child(
            (root) => selector.resolve().filter((element) => root.contains(element)),
            selector.description,
          );
    return options ? located.filter(options) : located;
  }
  filter(options: FilterOptions) {
    return new DomLocator(
      this.page,
      () =>
        this.resolve().filter((element) => {
          if (options.hasText !== undefined && !matches(textOf(element), options.hasText))
            return false;
          if (options.hasNotText !== undefined && matches(textOf(element), options.hasNotText))
            return false;
          if (options.has && !options.has.resolve().some((inner) => element.contains(inner)))
            return false;
          if (options.hasNot?.resolve().some((inner) => element.contains(inner))) return false;
          if (options.visible !== undefined && invisible(element) === options.visible) return false;
          return true;
        }),
      `${this.description} >> filter`,
    );
  }
  first() {
    return new DomLocator(
      this.page,
      () => this.resolve().slice(0, 1),
      `${this.description} >> first`,
    );
  }
  last() {
    return new DomLocator(this.page, () => this.resolve().slice(-1), `${this.description} >> last`);
  }
  nth(index: number) {
    return new DomLocator(
      this.page,
      () => {
        const all = this.resolve();
        const at = index < 0 ? all.length + index : index;
        return all[at] ? [all[at] as Element] : [];
      },
      `${this.description} >> nth=${index}`,
    );
  }
  or(other: DomLocator) {
    return new DomLocator(
      this.page,
      () => inOrder([...this.resolve(), ...other.resolve()]),
      `${this.description} | ${other.description}`,
    );
  }
  and(other: DomLocator) {
    return new DomLocator(
      this.page,
      () => {
        const theirs = new Set(other.resolve());
        return this.resolve().filter((element) => theirs.has(element));
      },
      `${this.description} & ${other.description}`,
    );
  }
  async all(): Promise<DomLocator[]> {
    return this.resolve().map((_, index) => this.nth(index));
  }

  /** The one element an action is for: waits for it to be there and in sight, and fails at once if there are two. */
  async element(
    options: { visible?: boolean; enabled?: boolean } = { visible: true },
  ): Promise<HTMLElement> {
    let found: Element | undefined;
    await until(() => {
      const all = this.resolve();
      if (all.length > 1)
        throw new Error(
          `strict mode violation: ${this.description} resolved to ${all.length} elements`,
        );
      const one = all[0];
      if (!one) return () => `waiting for ${this.description}; ${this.hint()}`;
      if (options.visible && invisible(one)) return `${this.description} is not visible`;
      if (options.enabled && isDisabled(one)) return `${this.description} is disabled`;
      found = one;
      return true;
    });
    return found as HTMLElement;
  }

  async click(options?: { modifiers?: string[]; force?: boolean; clickCount?: number }) {
    const element = await this.element({ visible: !options?.force, enabled: !options?.force });
    const keys = (options?.modifiers ?? []).map((key) => keyName(key));
    for (const key of keys) await this.page.user.keyboard(`{${key}>}`);
    const clicked = this.page.watchClick();
    if (options?.clickCount === 2) await this.page.user.dblClick(element);
    else await this.page.user.click(element);
    for (const key of keys.reverse()) await this.page.user.keyboard(`{/${key}}`);
    await settle();
    await this.page.followLink(clicked());
  }
  async dblclick() {
    await this.page.user.dblClick(await this.element());
    await settle();
  }
  async fill(value: string) {
    const element = await this.element({ visible: true, enabled: true });
    element.focus();
    await this.page.user.clear(element);
    if (value !== "") await this.page.user.paste(value);
    await settle();
  }
  async clear() {
    await this.fill("");
  }
  async type(text: string) {
    const element = await this.element();
    await this.page.user.type(element, escapeKeys(text), {
      skipClick: element === document.activeElement,
    });
    await settle();
  }
  async pressSequentially(text: string) {
    await this.type(text);
  }
  async press(key: string) {
    const element = await this.element({ visible: false });
    if (document.activeElement !== element) element.focus();
    await this.page.keyboard.press(key);
  }
  async check() {
    const element = (await this.element()) as HTMLInputElement;
    if (!isChecked(element)) await this.click();
  }
  async uncheck() {
    const element = (await this.element()) as HTMLInputElement;
    if (isChecked(element)) await this.click();
  }
  async setChecked(checked: boolean) {
    if (checked) await this.check();
    else await this.uncheck();
  }
  async selectOption(
    values:
      | string
      | { label?: string; value?: string }
      | (string | { label?: string; value?: string })[],
  ) {
    const element = (await this.element({ visible: true, enabled: true })) as HTMLSelectElement;
    // An option's label is its text when it has no label attribute (happy-dom leaves the property empty).
    const labelOf = (option: HTMLOptionElement) =>
      normal(option.getAttribute("label") ?? option.textContent ?? "");
    const wanted = (Array.isArray(values) ? values : [values]).map((value) => {
      const options = Array.from(element.options);
      const option =
        typeof value === "string"
          ? (options.find((item) => item.value === value) ??
            options.find((item) => labelOf(item) === normal(value)))
          : options.find((item) =>
              value.value !== undefined
                ? item.value === value.value
                : labelOf(item) === normal(value.label ?? ""),
            );
      if (!option) throw new Error(`${this.description} has no option ${JSON.stringify(value)}`);
      return option;
    });
    await this.page.user.selectOptions(element, wanted);
    await settle();
    return wanted.map((option) => option.value);
  }
  async focus() {
    (await this.element({ visible: false })).focus();
    await settle();
  }
  async blur() {
    (await this.element({ visible: false })).blur();
    await settle();
  }
  async hover() {
    await this.page.user.hover(await this.element());
    await settle();
  }
  async setInputFiles(
    files:
      | string
      | string[]
      | { name: string; mimeType: string; buffer: Uint8Array }
      | { name: string; mimeType: string; buffer: Uint8Array }[],
  ) {
    const element = (await this.element({ visible: false })) as HTMLInputElement;
    const list = (Array.isArray(files) ? files : [files]).map((file) =>
      typeof file === "string"
        ? new File([readFileSync(file)], basename(file))
        : new File([file.buffer as unknown as BlobPart], file.name, { type: file.mimeType }),
    );
    await this.page.user.upload(element, list);
    await settle();
  }
  async dispatchEvent(type: string, init?: EventInit) {
    (await this.element({ visible: false })).dispatchEvent(
      new Event(type, { bubbles: true, ...init }),
    );
    await settle();
  }
  async scrollIntoViewIfNeeded() {
    await this.element();
  }
  async waitFor(
    options: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number } = {},
  ) {
    const state = options.state ?? "visible";
    await until(() => {
      const one = this.resolve()[0];
      const ok =
        state === "attached"
          ? !!one
          : state === "detached"
            ? !one
            : state === "visible"
              ? !!one && !invisible(one)
              : !one || invisible(one);
      return ok || `waiting for ${this.description} to be ${state}`;
    }, options.timeout);
  }

  async textContent() {
    return (await this.element({ visible: false })).textContent;
  }
  async innerText() {
    return renderedText(await this.element({ visible: false }))
      .replace(/[ \t]+/g, " ")
      .trim();
  }
  async allTextContents() {
    return this.resolve().map((element) => element.textContent ?? "");
  }
  async allInnerTexts() {
    return this.resolve().map((element) =>
      renderedText(element)
        .replace(/[ \t]+/g, " ")
        .trim(),
    );
  }
  async getAttribute(name: string) {
    return (await this.element({ visible: false })).getAttribute(name);
  }
  async inputValue() {
    return ((await this.element({ visible: false })) as HTMLInputElement).value;
  }
  async count() {
    return this.resolve().length;
  }
  async isVisible() {
    const one = this.resolve()[0];
    return !!one && !invisible(one);
  }
  async isHidden() {
    return !(await this.isVisible());
  }
  async isChecked() {
    return isChecked(await this.element({ visible: false }));
  }
  async isDisabled() {
    return isDisabled(await this.element({ visible: false }));
  }
  async isEnabled() {
    return !(await this.isDisabled());
  }
  async evaluate<R, A>(fn: (element: HTMLElement, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return fn(await this.element({ visible: false }), arg as A);
  }
  async evaluateAll<R, A>(
    fn: (elements: HTMLElement[], arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R> {
    return fn(this.resolve() as HTMLElement[], arg as A);
  }
  async boundingBox(): Promise<never> {
    throw new Error("boundingBox needs a real layout: keep this test in tests/browser");
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

/** A CSS selector, or the few XPath ones the tests write (the nearest ancestor of a kind, the parent). */
function select(root: Element, selector: string): Element[] {
  if (!selector.startsWith("xpath=")) return Array.from(root.querySelectorAll(selector));
  const path = selector.slice("xpath=".length).trim();
  if (path === "..") return root.parentElement ? [root.parentElement] : [];
  const ancestor = /^ancestor::([a-z0-9-]+)\[1\]$/i.exec(path);
  if (ancestor) {
    const found = root.parentElement?.closest(ancestor[1] as string);
    return found ? [found] : [];
  }
  throw new Error(
    `the XPath ${path} is not one this adapter reads: write it as CSS, or keep the test in tests/browser`,
  );
}

type FilterOptions = {
  hasText?: Text;
  hasNotText?: Text;
  has?: DomLocator;
  hasNot?: DomLocator;
  visible?: boolean;
};

function isChecked(element: Element): boolean {
  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  )
    return element.checked;
  const aria = element.getAttribute("aria-checked") ?? element.getAttribute("aria-pressed");
  return aria === "true";
}

// ---- keys ---------------------------------------------------------------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  Control: "Control",
  ControlOrMeta: "Meta",
  Meta: "Meta",
  Shift: "Shift",
  Alt: "Alt",
  " ": " ",
  Space: " ",
};

const keyName = (key: string) => KEY_NAMES[key] ?? key;

/** user-event reads `{` and `[` as key names: a literal one is doubled. */
const escapeKeys = (text: string) => text.replace(/[{[]/g, (bracket) => bracket + bracket);

const TEXT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
]);

/** Enter in a text field submits its form through the form's default button, wherever that button is in the page (a
 * dialog's buttons sit outside its form and join it with `form=`), unless the page took the key itself. user-event
 * looks for the button inside the form only. Returns whether it handled the key. */
function implicitSubmit(): boolean {
  const field = document.activeElement;
  if (!(field instanceof HTMLInputElement) || !TEXT_TYPES.has(field.type) || !field.form)
    return false;
  const form = field.form;
  const options = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
  const down = new KeyboardEvent("keydown", options);
  field.dispatchEvent(down);
  if (!down.defaultPrevented) {
    const button = Array.from(form.elements).find(
      (element) =>
        (element instanceof HTMLButtonElement && element.type === "submit") ||
        (element instanceof HTMLInputElement &&
          (element.type === "submit" || element.type === "image")),
    ) as HTMLButtonElement | HTMLInputElement | undefined;
    if (button) {
      if (!button.disabled) form.requestSubmit(button);
    } else {
      const fields = Array.from(form.elements).filter(
        (element) => element instanceof HTMLInputElement && TEXT_TYPES.has(element.type),
      );
      if (fields.length === 1) form.requestSubmit();
    }
  }
  field.dispatchEvent(new KeyboardEvent("keyup", options));
  return true;
}

/** Let the page finish what an event started: Solid's effects and the requests it makes in the same moment. */
async function settle() {
  await wait(0);
  await wait(0);
}

// ---- downloads ----------------------------------------------------------------------------------------------------

/** The files the page has made addresses for, so a download of one can be read back. */
const objects = new Map<string, Blob>();
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object: Blob | MediaSource) => {
  const url = createObjectURL(object as Blob);
  if (object instanceof Blob) objects.set(url, object);
  return url;
};

/** A file the page handed to the browser to save, as Playwright's Download reads. */
class DomDownload {
  constructor(
    private readonly name: string,
    private readonly bytes: Promise<Buffer>,
  ) {}
  suggestedFilename() {
    return this.name;
  }
  async createReadStream() {
    return Readable.from([await this.bytes]);
  }
  async path() {
    const path = join(mkdtempSync(join(tmpdir(), "rastrata-download-")), this.name);
    writeFileSync(path, await this.bytes);
    return path;
  }
  async saveAs(path: string) {
    writeFileSync(path, await this.bytes);
  }
  url() {
    return "";
  }
  async failure() {
    return null;
  }
}

// ---- the page -----------------------------------------------------------------------------------------------------

type Route = {
  request(): {
    url(): string;
    method(): string;
    postData(): string | null;
    postDataJSON(): unknown;
    headers(): Record<string, string>;
  };
  fetch(): Promise<RouteResponse>;
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
  fulfill(options: {
    status?: number;
    contentType?: string;
    body?: string;
    json?: unknown;
    headers?: Record<string, string>;
    response?: RouteResponse;
  }): Promise<void>;
  fallback(): Promise<void>;
};

type RouteResponse = {
  status(): number;
  ok(): boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers(): Record<string, string>;
  raw: Response;
};

const wrapResponse = (response: Response, body: string): RouteResponse => ({
  status: () => response.status,
  ok: () => response.ok,
  json: async () => JSON.parse(body),
  text: async () => body,
  headers: () => Object.fromEntries(response.headers.entries()),
  raw: response,
});

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\uE000")
    .replace(/\*/g, "[^/]*")
    .replace(/\uE000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

type Listener = (value: unknown) => void;

class DomPage {
  user = userEvent.setup({ delay: null, document });
  readonly keyboard = {
    press: async (key: string) => {
      const parts = key.split("+");
      const main = parts.pop() as string;
      const modifiers = parts.map(keyName);
      if (main === "Enter" && modifiers.length === 0 && implicitSubmit()) {
        // submitted as a browser submits it
      } else if (main === "Tab" && modifiers.every((modifier) => modifier === "Shift")) {
        await this.user.tab({ shift: modifiers.includes("Shift") });
      } else {
        const name = keyName(main);
        const down = modifiers.map((modifier) => `{${modifier}>}`).join("");
        const up = [...modifiers]
          .reverse()
          .map((modifier) => `{/${modifier}}`)
          .join("");
        const pressed =
          name.length === 1 && name !== " "
            ? escapeKeys(name)
            : name === " "
              ? "[Space]"
              : `{${name}}`;
        await this.user.keyboard(`${down}${pressed}${up}`);
      }
      await settle();
    },
    type: async (text: string) => {
      const field = document.activeElement;
      if (field instanceof HTMLSelectElement) {
        // A browser's type-ahead on a focused list: the first option whose text starts with what was typed.
        const wanted = text.toLowerCase();
        const option = Array.from(field.options).find((item) =>
          normal(item.getAttribute("label") ?? item.textContent ?? "")
            .toLowerCase()
            .startsWith(wanted),
        );
        if (option && field.value !== option.value) {
          field.value = option.value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else await this.user.keyboard(escapeKeys(text));
      await settle();
    },
    insertText: async (text: string) => {
      await this.user.paste(text);
      await settle();
    },
    down: async (key: string) => this.user.keyboard(`{${keyName(key)}>}`),
    up: async (key: string) => this.user.keyboard(`{/${keyName(key)}}`),
  };
  /** Playwright's clock as the tests use it: the time `Date` says is fixed, and timers run as they do. */
  readonly clock = {
    setFixedTime: async (time: string | number | Date) => {
      setSystemTime(new Date(time));
    },
    setSystemTime: async (time: string | number | Date) => {
      setSystemTime(new Date(time));
    },
    install: async (options: { time?: string | number | Date } = {}) => {
      if (options.time !== undefined) setSystemTime(new Date(options.time));
    },
  };
  readonly mouse = {
    // Where the pointer rests changes nothing on a page with no layout.
    move: async () => {},
    click: async () => {
      throw new Error("a click at a position needs a real layout: keep this test in tests/browser");
    },
  };
  private mounted = false;
  private initScripts: (() => void)[] = [];
  private listeners = new Map<string, Set<Listener>>();
  private routes: {
    pattern: string | RegExp | ((url: URL) => boolean);
    handler: (route: Route) => unknown;
    stop: () => void;
  }[] = [];
  private stopWatching: () => void;

  private stopDownloads: () => void;

  constructor(readonly book: Book) {
    this.stopWatching = book.watch((request, response) =>
      this.emit("response", { request, response }),
    );
    // A click on a link that downloads (the page's own save, an object URL and a link it clicks) is a download.
    const onClick = (event: Event) => {
      const link = (event.target as Element | null)?.closest?.(
        "a[download]",
      ) as HTMLAnchorElement | null;
      if (!link || event.defaultPrevented) return;
      event.preventDefault();
      const href = link.getAttribute("href") ?? "";
      const blob = objects.get(href);
      const bytes = blob
        ? blob.arrayBuffer().then((buffer) => Buffer.from(buffer))
        : href.startsWith("data:")
          ? fetch(href).then(async (response) => Buffer.from(await response.arrayBuffer()))
          : this.book
              .serve(new Request(new URL(href, window.location.href)))
              .then(async (response) => Buffer.from(await response.arrayBuffer()));
      this.emit(
        "download",
        new DomDownload(
          link.download || basename(new URL(href, window.location.href).pathname),
          bytes,
        ),
      );
    };
    window.addEventListener("click", onClick);
    this.stopDownloads = () => window.removeEventListener("click", onClick);
    // A load the page starts itself (`location.assign` after a save, a reload) is a page load here too.
    const location = window.location;
    const load = (address: string | URL) => {
      setTimeout(() => void this.goto(String(address)), 0);
    };
    const own = ["assign", "replace", "reload"] as const;
    const before = own.map((key) => Object.getOwnPropertyDescriptor(location, key));
    const hrefBefore = Object.getOwnPropertyDescriptor(location, "href");
    Object.defineProperty(location, "assign", { configurable: true, value: load });
    Object.defineProperty(location, "replace", { configurable: true, value: load });
    Object.defineProperty(location, "reload", {
      configurable: true,
      value: () => load(window.location.href),
    });
    const proto = Object.getPrototypeOf(location);
    const hrefGetter = Object.getOwnPropertyDescriptor(proto, "href")?.get;
    Object.defineProperty(location, "href", {
      configurable: true,
      get: () => (hrefGetter ? hrefGetter.call(location) : String(location)),
      set: (address: string) => load(address),
    });
    this.stopLoads = () => {
      own.forEach((key, index) => {
        const descriptor = before[index];
        if (descriptor) Object.defineProperty(location, key, descriptor);
        else delete (location as unknown as Record<string, unknown>)[key];
      });
      if (hrefBefore) Object.defineProperty(location, "href", hrefBefore);
      else delete (location as unknown as Record<string, unknown>).href;
    };
  }
  private stopLoads: () => void = () => {};

  /** The next time the page says `event` ("download", "response"...). */
  waitForEvent(
    event: string,
    options?:
      | ((value: unknown) => boolean)
      | { predicate?: (value: unknown) => boolean; timeout?: number },
  ) {
    const predicate = typeof options === "function" ? options : options?.predicate;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${event} within the time`)),
        (typeof options === "object" && options?.timeout) || WAIT_MS,
      );
      const listener: Listener = (value) => {
        if (predicate && !predicate(value)) return;
        clearTimeout(timer);
        this.off(event, listener);
        resolve(value);
      };
      this.on(event, listener);
    });
  }

  /** Start watching for a click; the function it returns gives the click that happened, if any. */
  watchClick(): () => MouseEvent | undefined {
    let seen: MouseEvent | undefined;
    // On the window, after the page's own handlers (Solid's are on the document), so `defaultPrevented` is known.
    const listener = (event: Event) => {
      seen = event as MouseEvent;
    };
    window.addEventListener("click", listener);
    return () => {
      window.removeEventListener("click", listener);
      return seen;
    };
  }

  /** A click on a link that nothing on the page took (the router takes its own links) loads the link's address. */
  async followLink(event: MouseEvent | undefined) {
    if (!event || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const url = new URL(link.getAttribute("href") ?? "", window.location.href);
    if (url.origin !== new URL(window.location.href).origin) return;
    if (
      url.pathname === window.location.pathname &&
      url.search === window.location.search &&
      url.hash
    )
      return;
    await this.goto(`${url.pathname}${url.search}${url.hash}`);
  }

  on(event: string, listener: Listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  // Locators from the whole page.
  private get root(): DomLocator {
    return new DomLocator(this, () => [document.body], "page");
  }
  getByRole(role: string, options?: RoleOptions) {
    return this.root.getByRole(role, options);
  }
  getByText(text: Text, options?: { exact?: boolean }) {
    return this.root.getByText(text, options);
  }
  getByLabel(text: Text, options?: { exact?: boolean }) {
    return this.root.getByLabel(text, options);
  }
  getByPlaceholder(text: Text, options?: { exact?: boolean }) {
    return this.root.getByPlaceholder(text, options);
  }
  getByTitle(text: Text, options?: { exact?: boolean }) {
    return this.root.getByTitle(text, options);
  }
  getByTestId(id: string) {
    return this.root.getByTestId(id);
  }
  locator(selector: string, options?: FilterOptions) {
    const located = new DomLocator(
      this,
      () => Array.from(document.querySelectorAll(selector)),
      selector,
    );
    return options ? located.filter(options) : located;
  }

  /** Open an address as a new load would: the page is drawn again from nothing (what the browser keeps, its storage,
   * is kept). */
  async goto(address: string) {
    const url = new URL(address, this.book.origin);
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (this.mounted) cleanup();
    for (const script of this.initScripts) script();
    this.user = userEvent.setup({ delay: null, document });
    await openApp(path);
    this.mounted = true;
    await settle();
    return null;
  }
  async reload() {
    await this.goto(window.location.href);
    return null;
  }
  async goBack() {
    window.history.back();
    await wait(20);
    return null;
  }
  async goForward() {
    window.history.forward();
    await wait(20);
    return null;
  }
  url() {
    return window.location.href;
  }
  async title() {
    return document.title;
  }
  async content() {
    return document.documentElement.outerHTML;
  }
  async evaluate<R, A>(fn: ((arg: A) => R | Promise<R>) | string, arg?: A): Promise<R> {
    return typeof fn === "string" ? (globalEval(fn) as R) : fn(arg as A);
  }
  async waitForTimeout(ms: number) {
    await wait(ms);
  }
  async waitForLoadState() {
    await settle();
    await wait(20);
  }
  async waitForURL(wanted: Text | ((url: URL) => boolean)) {
    await until(() => {
      const here = window.location.href;
      const ok =
        typeof wanted === "function"
          ? wanted(new URL(here))
          : wanted instanceof RegExp
            ? wanted.test(here)
            : here === new URL(wanted, this.book.origin).href || here.endsWith(wanted);
      return ok || `waiting for the address ${wanted}, at ${here}`;
    });
  }
  waitForResponse(wanted: Text | ((response: RouteResponse & { url(): string }) => boolean)) {
    return new Promise((resolve) => {
      const listener: Listener = async (value) => {
        const { request, response } = value as { request: Request; response: Response };
        const body = await response.text();
        const requestBody =
          request.method === "GET" || request.method === "HEAD"
            ? null
            : await request.clone().text();
        const wrapped = Object.assign(wrapResponse(response, body), {
          url: () => request.url,
          request: () => ({
            url: () => request.url,
            method: () => request.method,
            postData: () => requestBody,
            postDataJSON: () => (requestBody ? JSON.parse(requestBody) : null),
            headers: () => Object.fromEntries(request.headers.entries()),
          }),
        });
        const ok =
          typeof wanted === "function"
            ? wanted(wrapped)
            : wanted instanceof RegExp
              ? wanted.test(request.url)
              : request.url.includes(wanted.replace(/\*\*/g, ""));
        if (ok) {
          this.off("response", listener);
          resolve(wrapped);
        }
      };
      this.on("response", listener);
    });
  }
  async setViewportSize(size: { width: number; height: number }) {
    (window as unknown as { happyDOM?: { setViewport(size: object): void } }).happyDOM?.setViewport(
      size,
    );
    pageChanged();
  }
  viewportSize() {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  async addInitScript<A>(
    script: ((arg: A) => void) | { content?: string; path?: string },
    arg?: A,
  ) {
    if (typeof script === "function") this.initScripts.push(() => script(arg as A));
    // The accessibility scan's own source: the scan needs a real browser, and stays in tests/browser.
  }
  /** A script's source run on the page. The accessibility scan's (axe) runs here with the rules that need a layout
   * left out: colour contrast and target sizes are measured by the browser tests, in both themes and at both widths. */
  async addScriptTag(script: { content?: string; path?: string } = {}) {
    const source = script.content ?? (script.path ? readFileSync(script.path, "utf8") : "");
    const scanner = window as unknown as {
      axe?: { run: (...args: unknown[]) => unknown; __layoutFree?: boolean };
    };
    if (source.includes("axe.run") && scanner.axe?.__layoutFree) return;
    globalEval(source);
    if (scanner.axe && !scanner.axe.__layoutFree) {
      const run = scanner.axe.run.bind(scanner.axe);
      scanner.axe.run = (...args: unknown[]) => {
        const options = (args[1] ?? {}) as { rules?: Record<string, unknown> };
        return run(args[0], { ...options, rules: { ...options.rules, ...LAYOUT_RULES } });
      };
      scanner.axe.__layoutFree = true;
    }
  }
  async addStyleTag(style: { content?: string } = {}) {
    const element = document.createElement("style");
    element.textContent = style.content ?? "";
    document.head.append(element);
  }
  async emulateMedia(media: {
    colorScheme?: "light" | "dark" | "no-preference" | null;
    reducedMotion?: "reduce" | "no-preference" | null;
  }) {
    const settings = (
      window as unknown as { happyDOM?: { settings: { device: Record<string, unknown> } } }
    ).happyDOM?.settings;
    if (settings && media.colorScheme)
      settings.device.prefersColorScheme = media.colorScheme === "dark" ? "dark" : "light";
    if (settings && media.reducedMotion) settings.device.prefersReducedMotion = media.reducedMotion;
    pageChanged();
    await settle();
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async bringToFront() {}
  async close() {
    setSystemTime();
    this.stopDownloads();
    this.stopLoads();
    for (const route of this.routes) route.stop();
    this.routes = [];
    this.stopWatching();
    if (this.mounted) cleanup();
    this.mounted = false;
  }
  context() {
    return {
      clearCookies: async () => {},
      cookies: async () => [],
      addCookies: async () => {},
      grantPermissions: async () => {},
      addInitScript: (script: () => void) => this.addInitScript(script),
    };
  }

  async route(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler: (route: Route) => unknown,
  ) {
    const test = (url: URL) =>
      typeof pattern === "function"
        ? pattern(url)
        : pattern instanceof RegExp
          ? pattern.test(url.href)
          : globToRegExp(pattern).test(url.href);
    const stop = this.book.intercept(async (request, proceed) => {
      const url = new URL(request.url);
      if (!test(url)) return undefined;
      const body =
        request.method === "GET" || request.method === "HEAD" ? null : await request.clone().text();
      let outcome:
        | { kind: "answer"; response: Response }
        | { kind: "go" }
        | { kind: "abort" }
        | undefined;
      const route: Route = {
        request: () => ({
          url: () => request.url,
          method: () => request.method,
          postData: () => body,
          postDataJSON: () => (body ? JSON.parse(body) : null),
          headers: () => Object.fromEntries(request.headers.entries()),
        }),
        fetch: async () => {
          const response = await proceed();
          return wrapResponse(response, await response.clone().text());
        },
        continue: async () => {
          outcome = { kind: "go" };
        },
        fallback: async () => {
          outcome = { kind: "go" };
        },
        abort: async () => {
          outcome = { kind: "abort" };
        },
        fulfill: async (options) => {
          if (options.response) {
            outcome = { kind: "answer", response: options.response.raw };
            return;
          }
          const text =
            options.json !== undefined ? JSON.stringify(options.json) : (options.body ?? "");
          outcome = {
            kind: "answer",
            response: new Response(text, {
              status: options.status ?? 200,
              headers: {
                "content-type":
                  options.contentType ??
                  (options.json !== undefined ? "application/json" : "text/plain"),
                ...options.headers,
              },
            }),
          };
        },
      };
      await handler(route);
      if (outcome?.kind === "abort") throw new TypeError("Failed to fetch");
      if (outcome?.kind === "answer") return outcome.response;
      return undefined;
    });
    this.routes.push({ pattern, handler, stop });
  }
  async unroute(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler?: (route: Route) => unknown,
  ) {
    this.routes = this.routes.filter((route) => {
      const same =
        String(route.pattern) === String(pattern) && (!handler || route.handler === handler);
      if (same) route.stop();
      return !same;
    });
  }
  async unrouteAll() {
    for (const route of this.routes) route.stop();
    this.routes = [];
  }
}

// ---- the service as a program reaches it ----------------------------------------------------------------------------

type APIResponse = RouteResponse & { url(): string };

class DomRequest {
  constructor(private readonly book: Book) {}
  private async send(
    method: string,
    address: string,
    options: {
      data?: unknown;
      headers?: Record<string, string>;
      form?: Record<string, string>;
      multipart?: Record<string, unknown>;
    } = {},
  ): Promise<APIResponse> {
    const url = new URL(address, this.book.origin);
    // Bytes go as they are (an upload), text as it is, anything else as JSON, as Playwright's request sends them.
    const raw = options.data;
    const bytes = raw instanceof Uint8Array || raw instanceof ArrayBuffer;
    const body =
      raw === undefined
        ? undefined
        : bytes
          ? (raw as BodyInit)
          : typeof raw === "string"
            ? raw
            : JSON.stringify(raw);
    const response = await this.book.serve(
      new Request(url, {
        method,
        headers: {
          ...(body !== undefined && !bytes && typeof raw !== "string"
            ? { "content-type": "application/json" }
            : {}),
          host: url.host,
          ...options.headers,
        },
        ...(body !== undefined ? { body } : {}),
      }),
    );
    const text = await response.text();
    return Object.assign(wrapResponse(response, text), { url: () => url.href });
  }
  post(address: string, options?: { data?: unknown; headers?: Record<string, string> }) {
    return this.send("POST", address, options);
  }
  get(address: string, options?: { headers?: Record<string, string> }) {
    return this.send("GET", address, options);
  }
  put(address: string, options?: { data?: unknown; headers?: Record<string, string> }) {
    return this.send("PUT", address, options);
  }
  delete(address: string, options?: { headers?: Record<string, string> }) {
    return this.send("DELETE", address, options);
  }
  fetch(
    address: string,
    options: { method?: string; data?: unknown; headers?: Record<string, string> } = {},
  ) {
    return this.send(options.method ?? "GET", address, options);
  }
  async dispose() {}
}

// ---- expect -------------------------------------------------------------------------------------------------------

type Matchers = Record<string, (...args: never[]) => Promise<void>>;

function locatorMatchers(locator: DomLocator, negate: boolean, timeout?: number) {
  const check = (pass: () => boolean, what: () => string) =>
    until(
      () =>
        pass() !== negate
          ? true
          : () =>
              `expected ${locator.description} ${negate ? "not " : ""}${what()}${locator.resolve().length === 0 ? `; ${locator.hint()}` : ""}`,
      timeout,
    );
  const one = () => locator.resolve()[0];
  let inner = false;
  const text = (element: Element | undefined) =>
    normal(element ? (inner ? renderedText(element) : textOf(element)) : "");
  const strictOne = () => {
    const all = locator.resolve();
    if (all.length > 1)
      throw new Error(
        `strict mode violation: ${locator.description} resolved to ${all.length} elements`,
      );
    return all[0];
  };
  const textMatch =
    (
      expected: Text | Text[],
      contain: boolean,
      options?: { ignoreCase?: boolean; useInnerText?: boolean },
    ) =>
    () => {
      inner = options?.useInnerText ?? false;
      const compare = (actual: string, wanted: Text) => {
        if (wanted instanceof RegExp) return wanted.test(actual);
        const a = options?.ignoreCase ? actual.toLowerCase() : actual;
        const w = normal(options?.ignoreCase ? wanted.toLowerCase() : wanted);
        return contain ? a.includes(w) : a === w;
      };
      if (Array.isArray(expected)) {
        const all = locator.resolve().map(text);
        return contain
          ? expected.every((wanted) => all.some((actual) => compare(actual, wanted)))
          : all.length === expected.length &&
              expected.every((wanted, index) => compare(all[index] ?? "", wanted));
      }
      const element = strictOne();
      return !!element && compare(text(element), expected);
    };
  return {
    toBeVisible: (options?: { visible?: boolean; timeout?: number }): Promise<void> =>
      options?.visible === false
        ? locatorMatchers(locator, !negate, options.timeout ?? timeout).toBeVisible()
        : check(
            () => {
              const element = strictOne();
              return !!element && !invisible(element);
            },
            () => "to be visible",
          ),
    toBeHidden: () =>
      check(
        () => {
          const element = strictOne();
          return !element || invisible(element);
        },
        () => "to be hidden",
      ),
    toBeAttached: (options?: { attached?: boolean }) =>
      check(
        () => !!one() === (options?.attached ?? true),
        () => "to be attached",
      ),
    toHaveCount: (count: number) =>
      check(
        () => locator.resolve().length === count,
        () => `to have ${count} elements, has ${locator.resolve().length}`,
      ),
    toHaveText: (
      expected: Text | Text[],
      options?: { ignoreCase?: boolean; useInnerText?: boolean; timeout?: number },
    ) =>
      locatorMatchersWait(
        textMatch(expected, false, options),
        () => `to have text ${expected}, has "${text(one())}"`,
      ),
    toContainText: (
      expected: Text | Text[],
      options?: { ignoreCase?: boolean; useInnerText?: boolean; timeout?: number },
    ) =>
      locatorMatchersWait(
        textMatch(expected, true, options),
        () => `to contain text ${expected}, has "${text(one())}"`,
      ),
    toHaveValue: (expected: Text) =>
      check(
        () => {
          const value = (strictOne() as HTMLInputElement | undefined)?.value ?? "";
          return expected instanceof RegExp ? expected.test(value) : value === expected;
        },
        () => `to have value ${expected}, has "${(one() as HTMLInputElement | undefined)?.value}"`,
      ),
    toHaveAttribute: (name: string, expected?: Text) =>
      check(
        () => {
          const value = strictOne()?.getAttribute(name);
          if (value === null || value === undefined) return false;
          return (
            expected === undefined ||
            (expected instanceof RegExp ? expected.test(value) : value === expected)
          );
        },
        () => `to have ${name}=${expected}, has ${one()?.getAttribute(name)}`,
      ),
    toHaveClass: (expected: Text) =>
      check(
        () => {
          const value = strictOne()?.getAttribute("class") ?? "";
          return expected instanceof RegExp ? expected.test(value) : value === expected;
        },
        () => `to have class ${expected}`,
      ),
    toBeFocused: () =>
      check(
        () => !!one() && document.activeElement === strictOne(),
        () => `to be focused (focus is on ${document.activeElement?.outerHTML.slice(0, 120)})`,
      ),
    toBeChecked: (options?: { checked?: boolean }) =>
      check(
        () => {
          const element = strictOne();
          return !!element && isChecked(element) === (options?.checked ?? true);
        },
        () => "to be checked",
      ),
    toBeDisabled: () =>
      check(
        () => {
          const element = strictOne();
          return !!element && isDisabled(element);
        },
        () => "to be disabled",
      ),
    toBeEnabled: () =>
      check(
        () => {
          const element = strictOne();
          return !!element && !isDisabled(element);
        },
        () => "to be enabled",
      ),
    toBeEditable: () =>
      check(
        () => {
          const element = strictOne() as HTMLInputElement | undefined;
          return !!element && !isDisabled(element) && !element.readOnly;
        },
        () => "to be editable",
      ),
    toBeEmpty: () =>
      check(
        () => {
          const element: Element | undefined = strictOne();
          if (!element) return false;
          return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value === ""
            : normal(element.textContent ?? "") === "";
        },
        () => "to be empty",
      ),
    toHaveAccessibleName: (expected: Text) =>
      check(
        () => {
          const element = strictOne();
          return (
            !!element &&
            matches(computeAccessibleName(element), expected, typeof expected === "string")
          );
        },
        () => `to have the accessible name ${expected}`,
      ),
    toHaveId: (id: string) =>
      check(
        () => strictOne()?.id === id,
        () => `to have id ${id}`,
      ),
    toHaveCSS: async () => {
      throw new Error("toHaveCSS needs a real layout: keep this test in tests/browser");
    },
  };
  function locatorMatchersWait(pass: () => boolean, what: () => string) {
    return check(pass, what);
  }
}

function pageMatchers(_page: DomPage, negate: boolean) {
  const check = (pass: () => boolean, what: () => string) =>
    until(() =>
      pass() !== negate ? true : () => `expected the page ${negate ? "not " : ""}${what()}`,
    );
  return {
    toHaveURL: (expected: Text) =>
      check(
        () => {
          const here = window.location.href;
          return expected instanceof RegExp
            ? expected.test(here)
            : here === new URL(expected, "http://127.0.0.1:4000").href;
        },
        () => `to be at ${expected}, is at ${window.location.href}`,
      ),
    toHaveTitle: (expected: Text) =>
      check(
        () =>
          expected instanceof RegExp ? expected.test(document.title) : document.title === expected,
        () => `to have the title ${expected}, has "${document.title}"`,
      ),
  };
}

type Expect = {
  (
    value: DomLocator,
  ): ReturnType<typeof locatorMatchers> & { not: ReturnType<typeof locatorMatchers> };
  (value: DomPage): ReturnType<typeof pageMatchers> & { not: ReturnType<typeof pageMatchers> };
  <T>(value: T, message?: string): ReturnType<typeof bunExpect<T>>;
  poll<T>(
    fn: () => T | Promise<T>,
    options?: { timeout?: number; message?: string; intervals?: number[] },
  ): ReturnType<typeof bunExpect<T>>;
  soft: Expect;
  configure(options: { timeout?: number }): Expect;
};

function makeExpect(timeout?: number): Expect {
  const expect = ((value: unknown, options?: string | { timeout?: number }) => {
    const wait = typeof options === "object" ? options.timeout : timeout;
    if (value instanceof DomLocator) {
      const positive = locatorMatchers(value, false, wait);
      return Object.assign(positive, { not: locatorMatchers(value, true, wait) });
    }
    if (value instanceof DomPage)
      return Object.assign(pageMatchers(value, false), { not: pageMatchers(value, true) });
    if (typeof value === "function")
      return Object.assign(bunExpect(value), {
        // Run the block until it passes, as Playwright's toPass does.
        toPass: (pass: { timeout?: number } = {}) =>
          pollUntil(
            () => undefined,
            async () => (value as () => unknown)(),
            pass.timeout ?? wait ?? WAIT_MS,
          ),
      });
    if (typeof options !== "string") return bunExpect(value);
    // Playwright's custom message, said with the failure.
    const label = options;
    const said = (matchers: object): object =>
      new Proxy(matchers, {
        get(target, key) {
          const found = Reflect.get(target, key);
          if (key === "not" || key === "resolves" || key === "rejects")
            return said(found as object);
          if (typeof found !== "function") return found;
          return (...args: unknown[]) => {
            try {
              const result = (found as (...a: unknown[]) => unknown).apply(target, args);
              return result instanceof Promise
                ? result.catch((error: Error) => {
                    error.message = `${label}\n${error.message}`;
                    throw error;
                  })
                : result;
            } catch (error) {
              (error as Error).message = `${label}\n${(error as Error).message}`;
              throw error;
            }
          };
        },
      });
    return said(bunExpect(value));
  }) as Expect;
  expect.poll = <T>(fn: () => T | Promise<T>, options?: { timeout?: number }) =>
    new Proxy({} as ReturnType<typeof bunExpect<T>>, {
      get(_, matcher: string) {
        if (matcher === "not")
          return new Proxy(
            {},
            {
              get(__, inner: string) {
                return (...args: unknown[]) =>
                  pollUntil(
                    fn,
                    (value) =>
                      (bunExpect(value).not as unknown as Matchers)[inner]?.(...(args as never[])),
                    options?.timeout,
                  );
              },
            },
          );
        return (...args: unknown[]) =>
          pollUntil(
            fn,
            (value) => (bunExpect(value) as unknown as Matchers)[matcher]?.(...(args as never[])),
            options?.timeout,
          );
      },
    });
  expect.soft = expect;
  expect.configure = (options) => makeExpect(options.timeout);
  return expect;
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  assert: (value: T) => unknown,
  timeout = WAIT_MS,
) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    try {
      await assert(value);
      return;
    } catch (error) {
      if (performance.now() > deadline) throw error;
    }
    await wait(20);
  }
}

const domExpect = makeExpect();

// ---- test ---------------------------------------------------------------------------------------------------------

type Fixtures = {
  page: DomPage;
  request: DomRequest;
  context: ReturnType<DomPage["context"]>;
  baseURL: string;
  browserName: "chromium";
};
type Body = (fixtures: Fixtures, info: TestInfo) => unknown | Promise<unknown>;
type TestInfo = ReturnType<typeof testInfo>;

class Skip extends Error {}

const testInfo = () => ({
  project: { name: "dom", metadata: {} as Record<string, unknown> },
  annotations: [] as { type: string; description?: string }[],
  setTimeout: (_ms: number) => {},
  skip: (condition?: boolean | string, _reason?: string) => {
    if (condition === undefined || condition === true || typeof condition === "string")
      throw new Skip();
  },
  outputPath: (...parts: string[]) => [process.env.TMPDIR ?? "/tmp", ...parts].join("/"),
  title: "",
  retry: 0,
});

let book: Book | undefined;
let current: DomPage | undefined;
const fixtures = (): Fixtures => {
  if (!book || !current) throw new Error("the page is opened before each test");
  return {
    page: current,
    request: new DomRequest(book),
    context: current.context(),
    baseURL: book.origin,
    browserName: "chromium",
  };
};

// One book for the whole file, as each browser project has one server with a book of its own; a fresh page for
// every test, as Playwright gives one.
bunBeforeAll(async () => {
  book = await openBook();
});
bunAfterAll(async () => {
  await book?.close();
  book = undefined;
});
bunBeforeEach(() => {
  if (book) current = new DomPage(book);
});
bunAfterEach(async () => {
  await current?.close();
  current = undefined;
});

const wrap = (body: Body) => async () => {
  try {
    await body(fixtures(), testInfo());
  } catch (error) {
    if (error instanceof Skip) return;
    throw error;
  }
};

type TestFn = {
  (name: string, body: Body): void;
  (name: string, details: object, body: Body): void;
  only: TestFn;
  skip: ((name: string, body?: Body) => void) & ((condition: boolean, reason?: string) => void);
  fixme: (name: string, body?: Body) => void;
  slow: () => void;
  fail: TestFn;
  describe: typeof bunDescribe & {
    configure(options: object): void;
    serial: typeof bunDescribe;
    parallel: typeof bunDescribe;
    skip: typeof bunDescribe;
    only: typeof bunDescribe;
  };
  beforeAll(body: (fixtures: Omit<Fixtures, "page" | "context">) => unknown): void;
  afterAll(body: (fixtures: Omit<Fixtures, "page" | "context">) => unknown): void;
  beforeEach(body: Body): void;
  afterEach(body: Body): void;
  step<T>(name: string, body: () => T | Promise<T>): Promise<T>;
  use(options: object): void;
  setTimeout(ms: number): void;
  info(): TestInfo;
  extend<T>(extra: T): TestFn;
};

const define = (register: typeof bunTest) =>
  ((name: string, second: object | Body, third?: Body) => {
    const body = (typeof second === "function" ? second : third) as Body;
    register(name, wrap(body), TEST_MS);
  }) as TestFn;

const domTest = define(bunTest);
// Bun refuses even a read of `test.only` when CI is set, so it is looked up only when a test asks for it.
Object.defineProperty(domTest, "only", { get: () => define(bunTest.only), configurable: true });
domTest.fail = define(bunTest.failing);
domTest.skip = ((first: string | boolean, body?: Body) => {
  if (typeof first === "string") bunTest.skip(first, body ? wrap(body) : () => {});
  else if (first) throw new Skip();
}) as TestFn["skip"];
domTest.fixme = (name: string) => bunTest.skip(name, () => {});
domTest.slow = () => {};
domTest.describe = Object.assign((name: string, body: () => void) => bunDescribe(name, body), {
  configure: () => {},
  serial: bunDescribe,
  parallel: bunDescribe,
  skip: bunDescribe.skip,
}) as unknown as TestFn["describe"];
// The same for describe: Bun refuses a read of `.only` under CI, so it is looked up only when asked for.
Object.defineProperty(domTest.describe, "only", {
  get: () => bunDescribe.only,
  configurable: true,
});
domTest.beforeAll = (body) =>
  bunBeforeAll(async () => {
    if (!book) book = await openBook();
    await body({
      request: new DomRequest(book),
      baseURL: book.origin,
      browserName: "chromium",
    });
  });
domTest.afterAll = (body) =>
  bunAfterAll(async () => {
    if (book)
      await body({
        request: new DomRequest(book),
        baseURL: book.origin,
        browserName: "chromium",
      });
  });
domTest.beforeEach = (body) => bunBeforeEach(wrap(body));
domTest.afterEach = (body) => bunAfterEach(wrap(body));
domTest.step = async (_name, body) => body();
domTest.use = () => {};
domTest.setTimeout = () => {};
domTest.info = testInfo;
domTest.extend = () => domTest;

// What the tests see is Playwright's own API, typed as Playwright types it: a test moves between tests/browser and
// tests/dom with its imports the only change, and the typecheck reads it the same in both places.
export type {
  APIRequestContext,
  APIResponse,
  Download,
  Locator,
  Page,
  Route,
  TestInfo,
} from "@playwright/test";
export const expect = domExpect as unknown as typeof import("@playwright/test").expect;
export const test = domTest as unknown as typeof import("@playwright/test").test;

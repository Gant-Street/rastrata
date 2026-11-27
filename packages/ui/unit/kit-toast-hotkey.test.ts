import { describe, expect, test } from "bun:test";
import {
  isTextEntry,
  isToastHotkey,
  type ElementLike,
  type KeyPress,
} from "../src/kit/toast-hotkey";

const press = (change: Partial<KeyPress> = {}): KeyPress => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code: "KeyT",
  key: "t",
  repeat: false,
  isComposing: false,
  ...change,
});

describe("the toast hotkey", () => {
  test("Alt+T is the chord, on a PC and as Option+T on a Mac (which makes a different character)", () => {
    expect(isToastHotkey(press())).toBe(true);
    expect(isToastHotkey(press({ key: "†" }))).toBe(true);
    expect(isToastHotkey(press({ key: "T" }))).toBe(true);
  });

  test("a layout that has moved the T still finds it by the letter", () => {
    expect(isToastHotkey(press({ code: "KeyK", key: "t" }))).toBe(true);
  });

  test("any other modifier makes it another chord, and no Alt is no chord", () => {
    expect(isToastHotkey(press({ ctrlKey: true }))).toBe(false);
    expect(isToastHotkey(press({ ctrlKey: true, key: "t" }))).toBe(false);
    expect(isToastHotkey(press({ shiftKey: true }))).toBe(false);
    expect(isToastHotkey(press({ metaKey: true }))).toBe(false);
    expect(isToastHotkey(press({ altKey: false }))).toBe(false);
    expect(isToastHotkey(press({ altKey: false, key: "t" }))).toBe(false);
  });

  test("a held key does not repeat it, and a key pressed while composing text is not it", () => {
    expect(isToastHotkey(press({ repeat: true }))).toBe(false);
    expect(isToastHotkey(press({ isComposing: true }))).toBe(false);
  });

  test("another key is not it", () => {
    expect(isToastHotkey(press({ code: "KeyY", key: "y" }))).toBe(false);
    expect(isToastHotkey(press({ code: "Escape", key: "Escape" }))).toBe(false);
  });
});

const element = (
  tagName: string,
  attributes: Record<string, string> = {},
  more: { isContentEditable?: boolean; type?: string } = {},
): ElementLike => ({
  tagName,
  ...more,
  getAttribute: (name) => attributes[name] ?? null,
});

describe("where text is typed", () => {
  test("a text area, a list and every kind of text box are", () => {
    expect(isTextEntry(element("TEXTAREA"))).toBe(true);
    expect(isTextEntry(element("SELECT"))).toBe(true);
    for (const type of [
      "text",
      "search",
      "email",
      "tel",
      "url",
      "password",
      "number",
      "date",
      "datetime-local",
      "month",
      "time",
      "week",
    ])
      expect(isTextEntry(element("INPUT", {}, { type })), type).toBe(true);
  });

  test("an input with no type is a text box, whether the element says it or only the attribute", () => {
    expect(isTextEntry(element("INPUT"))).toBe(true);
    expect(isTextEntry(element("INPUT", { type: "text" }))).toBe(true);
    expect(isTextEntry(element("INPUT", { type: "checkbox" }))).toBe(false);
  });

  test("a checkbox, a radio button, a button and the like are not, so a row's checkbox keeps the hotkey", () => {
    for (const type of [
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "image",
      "file",
      "range",
      "color",
      "hidden",
    ])
      expect(isTextEntry(element("INPUT", {}, { type })), type).toBe(false);
    expect(isTextEntry(element("BUTTON"))).toBe(false);
    expect(isTextEntry(element("A"))).toBe(false);
    expect(isTextEntry(element("DIV"))).toBe(false);
  });

  test("anything editable is, and so is a custom widget that says it is typed into", () => {
    expect(isTextEntry(element("DIV", {}, { isContentEditable: true }))).toBe(true);
    expect(isTextEntry(element("DIV", { role: "textbox" }))).toBe(true);
    expect(isTextEntry(element("DIV", { role: "searchbox" }))).toBe(true);
    expect(isTextEntry(element("DIV", { role: "spinbutton" }))).toBe(true);
    expect(isTextEntry(element("DIV", { role: "TextBox" }))).toBe(true);
  });

  test("a list's button (role combobox on a button) is not typed into, so it keeps the hotkey", () => {
    expect(isTextEntry(element("BUTTON", { role: "combobox" }))).toBe(false);
  });

  test("nothing focused is not", () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(undefined)).toBe(false);
  });
});

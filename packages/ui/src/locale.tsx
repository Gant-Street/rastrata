import { LocaleProvider } from "@ark-ui/solid/locale";
import { createContext, createMemo, useContext, type JSX } from "solid-js";
import { mergeMessages, type DeepPartial, type Messages } from "./messages";

import { directionOf, type Direction } from "./direction";

export { directionOf, type Direction };

type Ui = { locale: string; dir: Direction; messages: Messages };

const fallback: Ui = { locale: "en-US", dir: "ltr", messages: mergeMessages() };
const UiContext = createContext<Ui>(fallback);

/** Components read copy and locale from here. Without a provider they speak US English. */
export function useUi(): Ui {
  return useContext(UiContext);
}

/**
 * Sets language, text direction and copy for everything inside it, including Ark's portaled
 * popups and dialogs (which otherwise default to left-to-right regardless of the page).
 *
 * `display: contents` keeps layout untouched; `lang` and `dir` still inherit.
 */
export function UiProvider(props: {
  locale?: string;
  messages?: DeepPartial<Messages>;
  children: JSX.Element;
}) {
  const locale = () => props.locale ?? "en-US";
  const value = createMemo<Ui>(() => ({
    locale: locale(),
    dir: directionOf(locale()),
    messages: mergeMessages(props.messages),
  }));
  return (
    <UiContext.Provider
      value={{
        get locale() {
          return value().locale;
        },
        get dir() {
          return value().dir;
        },
        get messages() {
          return value().messages;
        },
      }}
    >
      <LocaleProvider locale={locale()}>
        <div class="rt-ui" lang={value().locale} dir={value().dir}>
          {props.children}
        </div>
      </LocaleProvider>
    </UiContext.Provider>
  );
}

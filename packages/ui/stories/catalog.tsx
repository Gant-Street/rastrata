import { createSignal, onMount, type JSX } from "solid-js";
import { Logo } from "../src";

/** Workshop-only switch so the two themes can be compared on the page itself. */
export function ThemeToggle() {
  const [dark, setDark] = createSignal(false);
  onMount(() => setDark(document.documentElement.dataset.theme === "dark"));
  return (
    <button
      type="button"
      class="theme-toggle"
      aria-pressed={dark()}
      onClick={() => {
        const next = !dark();
        document.documentElement.dataset.theme = next ? "dark" : "light";
        setDark(next);
      }}
    >
      <span class="theme-toggle-swatch" aria-hidden="true" />
      Dark theme
    </button>
  );
}

// Each page takes one master color as its identity, keyed to its section number.
const tones = ["black", "orange", "blue", "black", "orange", "blue", "black"] as const;
const toneFor = (section: string) => tones[Number.parseInt(section, 10) % tones.length] ?? "black";

export function Catalog(props: {
  title: string;
  section: string;
  description: string;
  children: JSX.Element;
}) {
  return (
    <main class="rt-theme catalog" data-tone={toneFor(props.section)}>
      <header class="catalog-masthead">
        <Logo />
        <div class="catalog-masthead-end">
          <span class="catalog-meta">Color code 02 · Workshop</span>
          <ThemeToggle />
        </div>
      </header>
      <div class="catalog-intro">
        <span class="catalog-eyebrow">{props.section}</span>
        <h1>{props.title}</h1>
        <p>{props.description}</p>
      </div>
      {props.children}
      <footer class="catalog-footer">
        <span>Rastrata UI · Working Edition</span>
        <span>Deterministic review · Not connected to live books</span>
      </footer>
    </main>
  );
}

export function Specimen(props: { title: string; note: string; children: JSX.Element }) {
  return (
    <section class="catalog-specimen">
      <div class="catalog-specimen-header">
        <h2>{props.title}</h2>
        <p>{props.note}</p>
      </div>
      <div class="catalog-example">{props.children}</div>
    </section>
  );
}

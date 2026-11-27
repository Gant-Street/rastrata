import { createSignal, onCleanup } from "solid-js";
import Copy from "lucide-solid/icons/copy";
import { Button } from "../button";
import { Check } from "../icons";
import { writeToClipboard } from "../kit/copy";
import { words } from "./words";

/** Copy text to the clipboard and say whether it worked: the clipboard can be unavailable (an insecure
 * page, a denied permission), and the person is told rather than left to wonder. It is the kit's one way
 * to the clipboard (`kit/copy.ts`, which waits for the write; Ark's clipboard says "copied" before it knows). */
export async function copyText(text: string): Promise<boolean> {
  return (await writeToClipboard(text)) === "copied";
}

/** A button that copies `text`, with a polite confirmation. */
export function CopyButton(props: {
  text: string;
  label?: string;
  copiedLabel?: string;
  size?: "sm" | "md";
  variant?: "primary" | "secondary" | "quiet";
  /** Called with whether the copy worked, so a caller can offer another way. */
  onResult?: (copied: boolean) => void;
}) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    const ok = await copyText(props.text);
    props.onResult?.(ok);
    setCopied(ok);
    clearTimeout(timer);
    if (ok) timer = setTimeout(() => setCopied(false), 4000);
  };
  return (
    <>
      <Button
        type="button"
        label={props.label ?? words.copyCommand}
        variant={props.variant ?? "secondary"}
        size={props.size ?? "sm"}
        icon={copied() ? <Check /> : <Copy />}
        onClick={copy}
      />
      <span class="rt-sr-only" role="status">
        {copied() ? (props.copiedLabel ?? words.commandCopied) : ""}
      </span>
    </>
  );
}

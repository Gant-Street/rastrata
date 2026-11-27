/** The bot check on the sign-in page: Cloudflare Turnstile, loaded from Cloudflare when the control plane names a site key (`GET /auth/config`) and not otherwise. The widget makes a
 * token that is good for one code request; the page asks for a new one after each use. The service allows the script and its frame on the sign-in page and nowhere else. */
interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: "auto" | "light" | "dark";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(id: string): void;
  remove(id: string): void;
}

export interface Captcha {
  /** The token the widget has made and that has not been used, or null. */
  token(): string | null;
  /** A new token is needed: the last was used or failed. */
  reset(): void;
  remove(): void;
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

/** Load Cloudflare's script once. */
export function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const present = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (present) return resolve(present);
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else reject(new Error("The check did not load."));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error("The check did not load."));
    };
    document.head.append(script);
  });
  return loading;
}

/** Show the widget in `container`. `changed` is called when the token appears, runs out or fails. Rejects when the widget cannot be loaded (the page says so). */
export async function mountCaptcha(
  container: HTMLElement,
  siteKey: string,
  changed: () => void,
  load: () => Promise<TurnstileApi> = loadTurnstile,
): Promise<Captcha> {
  const api = await load();
  let token: string | null = null;
  const id = api.render(container, {
    sitekey: siteKey,
    theme: "auto",
    callback: (made) => {
      token = made;
      changed();
    },
    "expired-callback": () => {
      token = null;
      changed();
    },
    "error-callback": () => {
      token = null;
      changed();
    },
  });
  return {
    token: () => token,
    reset: () => {
      token = null;
      api.reset(id);
      changed();
    },
    remove: () => api.remove(id),
  };
}

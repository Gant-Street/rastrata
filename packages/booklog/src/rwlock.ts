/** A first-come first-served lock: any number of readers together, or one writer alone. A writer
 * that is waiting keeps later readers out, so a steady stream of reads cannot starve it. */
export class AsyncRwLock {
  #readers = 0;
  #writing = false;
  readonly #queue: { readonly kind: "r" | "w"; readonly go: () => void }[] = [];

  get waiting(): number {
    return this.#queue.length;
  }
  get busy(): boolean {
    return this.#writing || this.#readers > 0;
  }

  shared<T>(work: () => Promise<T> | T): Promise<T> {
    return this.#run("r", work);
  }
  exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    return this.#run("w", work);
  }

  async #run<T>(kind: "r" | "w", work: () => Promise<T> | T): Promise<T> {
    await new Promise<void>((resolve) => {
      this.#queue.push({ kind, go: resolve });
      this.#drain();
    });
    try {
      return await work();
    } finally {
      if (kind === "w") this.#writing = false;
      else this.#readers -= 1;
      this.#drain();
    }
  }

  #drain(): void {
    for (;;) {
      const next = this.#queue[0];
      if (!next) return;
      if (next.kind === "w") {
        if (this.#writing || this.#readers > 0) return;
        this.#writing = true;
      } else {
        if (this.#writing) return;
        this.#readers += 1;
      }
      this.#queue.shift();
      next.go();
    }
  }
}

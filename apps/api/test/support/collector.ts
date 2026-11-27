/** A stand-in OTLP collector for the storm test: it answers, answers late, or never answers. */
export interface StandIn {
  readonly url: string;
  /** The number of requests that reached it. */
  hits(): number;
  stop(): Promise<void>;
}

export async function standIn(mode: "ok" | "hang" | { slowMs: number }): Promise<StandIn> {
  let hits = 0;
  const pending = new Set<() => void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      hits += 1;
      await request.arrayBuffer();
      if (mode === "hang")
        return new Promise<Response>((resolve) => pending.add(() => resolve(new Response("late"))));
      if (typeof mode === "object") await Bun.sleep(mode.slowMs);
      return Response.json({ partialSuccess: {} });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits: () => hits,
    async stop() {
      for (const release of pending) release();
      await server.stop(true);
    },
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const { port } = server;
  await server.stop(true);
  return port as number;
}

// Test helper: a fetch that routes requests to handlers, so the agent can be tested without
// a network, a server, a sign-in server or Ollama.

export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[];
}

export function fakeFetch(route: (method: string, path: string) => Handler | undefined): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? "GET";
    const raw = typeof init.body === "string" ? init.body : null;
    let body: unknown = raw;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    calls.push({ method, url: url.href, body, headers: (init.headers as Record<string, string>) ?? {} });
    const handler = route(method, url.pathname);
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: `no fake for ${method} ${url.pathname}` } }), { status: 404 });
    return handler(url, init);
  };
  return { fetch: fn as typeof fetch, calls };
}

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A response body the test writes to, and which errors with AbortError when the request's signal aborts. */
export function controlledStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let closed = false;
  signal?.addEventListener("abort", () => {
    if (closed) return;
    closed = true;
    controller.error(new DOMException("aborted", "AbortError"));
  });
  return {
    body,
    write(text: string) {
      if (!closed) controller.enqueue(encoder.encode(text));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
    get aborted() {
      return signal?.aborted ?? false;
    },
  };
}

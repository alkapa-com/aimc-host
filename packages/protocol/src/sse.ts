// Server-Sent Events, the small subset both sides use: every event is one `data:` line with a
// JSON object, then an empty line. Lines starting with ":" are comments (keep-alives).
// Shared by the server (writes the agent's job stream) and the host agent (reads it).

const encoder = new TextEncoder();

export function encodeSseData(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

export function encodeSseComment(text: string): Uint8Array {
  return encoder.encode(`: ${text.replace(/[\r\n]/g, " ")}\n\n`);
}

/**
 * Reads a stream of SSE events and yields each event's data, parsed as JSON. Network packets can
 * cut an event anywhere, so it buffers until a full event (ending in an empty line) has arrived.
 * Comments and events whose data isn't JSON are skipped.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as unknown;
        } catch {
          // not JSON: ignore, like an unknown event type
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

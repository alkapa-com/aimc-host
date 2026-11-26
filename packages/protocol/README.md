# aimc-protocol

The messages between an aimc server and its host agents ([aimc-host](https://www.npmjs.com/package/aimc-host)),
as [zod](https://zod.dev) schemas. Both sides validate everything they receive with them.

```ts
import { helloRequest, parseStreamEvent, PROTOCOL_VERSION } from "aimc-protocol/agent";
import { encodeSseData, readSseData } from "aimc-protocol/sse";
```

ESM only, Node 22.12 or newer, TypeScript types included.

## The API (version 1)

| Call | Direction | Body |
|---|---|---|
| `GET /api/agent/v1/config` (no auth) | agent → server | `agentConfigResponse`: where to sign in (OpenID Connect device flow) |
| `POST /api/agent/v1/hosts` | agent → server | `registerHostRequest` → `registerHostResponse` |
| `POST /api/agent/v1/hosts/{id}/hello` | agent → server | `helloRequest` → `helloResponse` |
| `GET /api/agent/v1/hosts/{id}/stream` | server → agent (SSE) | `streamEvent`: `job`, `cancel`, `config`, `ping` |
| `POST /api/agent/v1/hosts/{id}/jobs/{jobId}/events` | agent → server | `jobEventsRequest` → `jobEventsResponse` |
| `POST /api/agent/v1/hosts/{id}/heartbeat` | agent → server | `heartbeatRequest` → `heartbeatResponse` |

Every non-2xx answer is `agentApiError`: `{ error: { code, message } }`, the message written for
the host's owner.

## Compatibility

`PROTOCOL_VERSION` is 1, and version 1 only grows:
- new fields are optional; unknown fields are stripped, so older peers ignore them;
- new stream events are ignored by older agents (`parseStreamEvent` returns null);
- new error codes are added, never renamed or removed.

Package versions follow that: additions are minor releases (1.x). A breaking change would be
protocol version 2, released as 2.0.0.

## License

MIT

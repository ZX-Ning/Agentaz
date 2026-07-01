# Protocol Smoke and Playwright Checks

## Purpose

Use these checks after changing the browser/server protocol, transcript event
handling, or first-message flow. They verify both the backend REST/SSE contract
and the browser behavior that previously allowed the first optimistic user
message to disappear briefly while the assistant streamed.

## Backend Smoke

The backend smoke coverage is now part of the Deno API test suite and starts an
in-process Hono server.

```bash
deno task test
```

The smoke test covers:

- unauthenticated HTTP and SSE rejection
- login/logout with the local admin password
- authenticated health reads
- static SPA fallback when `STATIC_FILE_DIR` is set

Expected result:

```txt
ok | 0 failed
```

## Playwright First-Message Regression

Use `playwright-cli` against a running frontend. That can be the Vite dev server
from `deno task dev:web-ui`, or the Hono server on `127.0.0.1:3000` when it is
serving built assets through `STATIC_FILE_DIR`.

```bash
playwright-cli open http://127.0.0.1:5173/
```

Log in with the local admin password, then create a new session and send a
unique prompt such as:

```txt
AGENTAZ_OBS_<timestamp> 请只回复 OK，不要调用工具。
```

For manual checks, the transcript should show the user message immediately,
continue showing it while assistant deltas stream, and keep it visible after
completion.

For a stronger dynamic check, inject a small DOM visibility probe before
submitting:

```js
const target = "AGENTAZ_OBS_<timestamp>";
window.__visibilityProbe = { target, samples: [], transitions: [] };
let last = null;
const sample = () => {
    const visible = document.body.innerText.includes(target);
    window.__visibilityProbe.samples.push({ t: Date.now(), visible });
    if (last !== visible) {
        window.__visibilityProbe.transitions.push({ t: Date.now(), visible });
        last = visible;
    }
};
sample();
window.__visibilityProbe.interval = setInterval(sample, 25);
```

After the assistant finishes:

```js
clearInterval(window.__visibilityProbe.interval);
window.__visibilityProbe.transitions;
```

Expected transition pattern:

```json
[{ "visible": false }, { "visible": true }]
```

There must be no later `{ "visible": false }` transition after the message first
appears.

## SSE / History Probe

When investigating protocol ordering, record SSE event types and agent fetches:

```js
window.__agentazProbe = { events: [], fetches: [] };

const OriginalEventSource = window.EventSource;
window.EventSource = class extends OriginalEventSource {
    constructor(url, init) {
        super(url, init);
        this.addEventListener("message", (ev) => {
            const parsed = JSON.parse(ev.data);
            window.__agentazProbe.events.push({
                t: Date.now(),
                type: parsed.type,
                sessionId: parsed.sessionId,
                turnId: parsed.turnId,
                revision: parsed.transcriptRevision,
            });
        });
    }
};

const originalFetch = window.fetch;
window.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    if (url.includes("/api/agent/")) {
        window.__agentazProbe.fetches.push({
            t: Date.now(),
            url,
            method: args[1]?.method ?? "GET",
        });
    }
    return originalFetch(...args);
};
```

Reload after injecting if the app has already opened the EventSource.

Expected protocol shape for a prompt:

```txt
turn_started
message_upsert
message_block_upsert
message_block_delta...
status
message_upsert
turn_completed
```

Expected HTTP behavior:

- one `POST /api/agent/sessions/:sessionId/messages`
- one `GET /api/agent/sessions/:sessionId/history` after `turn_completed`
- no transcript history refresh triggered merely by `status` or `state_snapshot`

## Cleanup

Close the browser and remove Playwright output before committing:

```bash
playwright-cli close
rm -rf .playwright-cli
```

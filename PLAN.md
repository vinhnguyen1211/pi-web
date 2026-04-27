# Pi Web Client — Architecture Plan

## Goal

Build a web UI that connects to the Pi coding agent via its RPC mode, allowing users to interact with Pi through a browser. The user can send prompts, see streaming responses in real-time, and manage sessions — all without WebSockets.

**Tech stack:** Go (backend), HTML/JS/CSS (frontend)

---

## Constraints & Decisions

| Decision | Rationale |
|----------|-----------|
| **Single Pi RPC session** | One `pi --mode rpc` subprocess per server instance. No multi-client or session multiplexing. |
| **Sessions are persisted** | Don't use `--no-session`. Sessions save to `~/.pi/agent/sessions/` so users can resume from the web UI *or* the CLI (`pi -c`, `pi --session <id>`). |
| **SSE, not WebSockets** | Streaming events from Go → browser uses Server-Sent Events. Commands go via regular POST requests. Simpler, works everywhere, no extra dependencies. |

---

## 1. Pi RPC Mode — Protocol Summary

Start with: `pi --mode rpc [options]`

### Commands (stdin — JSONL)

JSON objects sent to stdin, one per line, terminated by `\n`:

```json
{"type": "prompt", "message": "Hello!"}
{"type": "steer", "message": "Focus on error handling"}
{"type": "follow_up", "message": "After that, summarize"}
{"type": "abort"}
{"type": "get_state"}
{"type": "get_messages"}
{"type": "new_session"}
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```

Commands can include an optional `id` field for request/response correlation:

```json
{"type": "get_state", "id": "req-123"}
```

The server echoes the `id` back in the response.

### Events (stdout — JSONL)

Events and responses stream to stdout as JSONL. Key event types:

| Event | When |
|-------|------|
| `agent_start` | Agent begins processing a prompt |
| `message_update` | Streaming text/thinking/toolcall deltas |
| `tool_execution_start` | Tool call begins |
| `tool_execution_update` | Tool output streaming (e.g., bash) |
| `tool_execution_end` | Tool call completes with result |
| `agent_end` | Agent finishes all work |
| `queue_update` | Steering/follow-up queue changed |
| `compaction_start` / `compaction_end` | Context compaction |
| `extension_ui_request` | Extension needs user interaction (select, confirm, input) |
| `response` | Command acknowledgement/error (has matching `id`) |

### Streaming text example

```json
{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" world"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end"}}
```

### Framing rules (important)

- Split records on `\n` only — **not** on Unicode separators like `U+2028`/`U+2029` which are valid inside JSON strings.
- Strip trailing `\r` if present (optional CRLF input).

---

## 2. Streaming Without WebSockets: SSE

### Why SSE over WebSockets

| Factor | SSE | WebSocket |
|--------|-----|-----------|
| Browser API | Built-in `EventSource` | Manual framing + reconnection |
| Go implementation | `http.Flusher`, no deps | Need `gorilla/websocket` or similar |
| Firewalls/proxies | Plain HTTP, works everywhere | May be blocked |
| Direction | Server→client (perfect for event streaming) | Bidirectional (overkill) |
| Auto-reconnect | Built-in (3s default) | Manual implementation |

### Architecture

```
┌──────────────┐        ┌──────────────────┐        ┌────────────────┐
│   Browser    │        │   Go Backend     │        │  Pi Agent      │
│              │        │                  │        │  (subprocess)  │
│  ┌────────┐  │        │  ┌────────────┐  │        │                │
│  │ UI     │──┼─POST──▶┼──▶│ api/command│  │        │                │
│  │ HTML/  │  │        │  │ endpoint   │──┼─stdin──┼───────────────┼▶ stdin
│  │ JS/CSS │  │        │  │            │  │        │                │
│  └────────┘  │        │  └────────────┘  │        │                │
│              │        │                  │        │                │
│  EventSource │◀───────┼──SSE stream──────┼◀stdout─┼───────────────┼
│   /stream    │←events─┼──┤ GET /stream  │  │        │                │
│              │        │  └────────────┘  │        │                │
└──────────────┘        └──────────────────┘        └────────────────┘
```

- **Commands**: Browser → `POST /api/command` → Go writes to Pi's stdin
- **Events**: Pi's stdout → Go reads JSONL lines → SSE pushes to browser via `GET /stream`

### Go SSE endpoint

```go
mux.HandleFunc("GET /stream", func(w http.ResponseWriter, r *http.Request) {
    flusher := w.(http.Flusher)
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.WriteHeader(http.StatusOK)

    done := r.Context().Done()
    for {
        select {
        case line, ok := <-agent.Lines():
            if !ok { return }
            fmt.Fprintf(w, "data: %s\n\n", line)
            flusher.Flush()
        case <-done:
            return
        }
    }
})
```

### Frontend EventSource

```javascript
const es = new EventSource("/stream");
es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Route to UI handlers based on data.type
};
es.onerror = () => console.warn("SSE lost — auto-reconnecting...");
```

### Commands via fetch

```javascript
async function sendCommand(cmd) {
  await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
}
```

---

## 3. Project Structure

```
piweb/
├── go.mod
├── cmd/
│   └── server/
│       └── main.go               # Entry point: spawn agent, start HTTP server
├── internal/
│   ├── agent/
│   │   └── agent.go              # Pi subprocess wrapper (spawn, stdin writer, stdout reader)
│   ├── handler/
│   │   └── http.go               # HTTP routes (SSE stream + command POST endpoint)
│   └── session/
│       └── scanner.go            # Scan ~/.pi/agent/sessions/ for resume list
├── static/
│   ├── index.html                # Main page (chat UI, prompt input, session controls)
│   ├── css/
│   │   └── style.css             # Dark/light theme, chat bubbles, code blocks
│   └── js/
│       └── app.js                # PiClient class, EventSource handling, DOM rendering
├── PLAN.md                       # This file
└── README.md
```

---

## 4. Component Specifications

### 4a. Agent Wrapper — `internal/agent/agent.go`

Manages the single `pi --mode rpc` subprocess. Responsibilities:

- Spawn `pi --mode rpc [optional --session]` in the given working directory
- Pipe stdin/stdout via `Cmd.StdinPipe()` / `Cmd.StdoutPipe()`
- Read stdout line-by-line (split on `\n`, strip trailing `\r`), send JSON lines through a buffered channel
- Provide `SendCommand(obj map[string]any)` which marshals to JSON and writes to stdin with `\n`
- Provide `Lines() <-chan string` for the HTTP handler to consume

Key behaviors:
- Buffered channel (size 256) to prevent blocking when SSE client is slow
- On agent exit, close the stdout read goroutine → close the channel → SSE handler exits
- `Kill()` method sends SIGTERM + cleanup

### 4b. HTTP Handler — `internal/handler/http.go`

Two route groups:

**SSE stream** (`GET /stream`):
- Single client only (reject or overwrite if a second connects)
- Reads from `agent.Lines()` channel, writes each line as SSE `data: ... \n\n`
- Flushes immediately after each event
- Exits when client disconnects (ctx.Done) or agent exits (channel closed)

**Command endpoint** (`POST /api/command`):
- Accepts any valid Pi RPC command as JSON body
- Validates `type` field is present
- Writes to agent's stdin via `agent.SendCommand()`
- Returns 200 OK on success, 500 on error

**Session list** (`GET /api/sessions`):
- Scans Pi's session directory for available sessions
- Returns JSON array of `{ path, id, modTime }` entries
- Powers the "Resume" dropdown in the web UI

**Static files** (`/`):
- Serve from `./static/` directory

### 4c. Session Scanner — `internal/session/scanner.go`

Pi persists sessions to JSONL files under `~/.pi/agent/sessions/<cwd-hash>/`.

To build a resume list:
1. Resolve the cwd's session directory path (Pi hashes the cwd)
2. Glob for `*.jsonl` files in that directory
3. Read line 1 of each file (the header entry with `id`, `model`, etc.)
4. Return structured list sorted by modification time

```go
type SessionInfo struct {
    ID     string `json:"id"`
    Path   string `json:"path"`
    Name   string `json:"name,omitempty"`
    ModTime time.Time `json:"modTime"`
}
```

Note: Pi's session directory naming uses a hash of the cwd. Options to find it:
- Match on all session directories and filter by reading header metadata
- Use Pi's same hashing (inspect how Pi derives it) or shell out to list `~/.pi/agent/sessions/*/`
- Simple approach: glob all `~/.pi/agent/sessions/**/session.jsonl` files, read header

### 4d. Server Entry — `cmd/server/main.go`

```go
func main() {
    cwd := flag.String("cwd", "", "Working directory (default: $PWD)")
    session := flag.String("session", "", "Session file or ID to resume")
    addr := flag.String("addr", ":8080", "HTTP listen address")
    noTools := flag.Bool("no-tools", false, "Disable all built-in tools")
    flag.Parse()

    // Build agent args
    args := []string{"--mode", "rpc"}
    if *session != "" { args = append(args, "--session", *session) }
    if *noTools { args = append(args, "--no-tools") }

    agent, err := agent.New(*cwd, args...)
    if err != nil { log.Fatal(err) }

    handler.Start(agent, *addr)
}
```

### 4e. Frontend — `static/js/app.js`

#### PiClient class

```javascript
class PiClient {
  constructor() {
    this.streaming = false;
    this.currentText = "";
    this.eventSource = null;
    this.pendingResolvers = new Map(); // id -> resolve fn
    this.connect();
  }

  connect() {
    this.eventSource = new EventSource("/stream");
    this.eventSource.onmessage = (e) => this.handleEvent(JSON.parse(e.data));
    this.eventSource.onerror = () => console.warn("SSE lost — reconnecting...");
  }

  handleEvent(data) {
    // Route to appropriate handler based on data.type
    if (data.type === "response") {
      // Resolve pending command awaiting response by id
      const resolver = this.pendingResolvers.get(data.id);
      if (resolver) { resolver(data); this.pendingResolvers.delete(data.id); }
      return;
    }
    dispatchToUI(data);  // Forward to UI rendering logic
  }

  // --- Commands ---

  async prompt(message, images = null, streamingBehavior = null) {
    const cmd = { type: "prompt", message };
    if (images) cmd.images = images;
    if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
    await this.send(cmd);
  }

  async steer(message) { await this.send({ type: "steer", message }); }
  async followUp(message) { await this.send({ type: "follow_up", message }); }
  async abort() { await this.send({ type: "abort" }); }

  // State queries — send with id, wait for response via SSE
  async getState()         { return this.sendAwait("get_state"); }
  async getMessages()      { return this.sendAwait("get_messages"); }
  async getSessionStats()  { return this.sendAwait("get_session_stats"); }
  async getAvailableModels(){ return this.sendAwait("get_available_models"); }

  // Session operations
  async newSession()       { return this.sendAwait("new_session"); }
  async switchSession(path){ return this.send({ type: "switch_session", sessionPath: path }); }
  async fork(entryId)      { return this.sendAwait("fork", { entryId }); }
  async clone()            { return this.sendAwait("clone"); }

  // Model/thinking control
  async setModel(provider, modelId) {
    return this.sendAwait("set_model", { provider, modelId });
  }
  async setThinkingLevel(level) {
    return this.sendAwait("set_thinking_level", { level });
  }

  // Extension UI dialog responses
  async respondExtensionUI(id, payload) {
    await this.send({ type: "extension_ui_response", id, ...payload });
  }

  async send(cmd) {
    const resp = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    if (!resp.ok) throw new Error(`Command failed: ${resp.status}`);
  }

  // Send with id correlation, resolve when matching response arrives via SSE
  async sendAwait(type, extra = {}) {
    const id = crypto.randomUUID();
    await this.send({ type, id, ...extra });
    return new Promise((resolve) => {
      this.pendingResolvers.set(id, resolve);
      setTimeout(() => {
        if (this.pendingResolvers.has(id)) {
          this.pendingResolvers.delete(id);
          resolve(null);
        }
      }, 15000); // 15s timeout
    });
  }

  close() {
    this.eventSource.close();
  }
}
```

#### UI rendering concerns

- **Chat area**: User messages (right-aligned), assistant messages (left-aligned, streaming text)
- **Streaming text**: Append `text_delta` chunks in real-time. On `text_end`, finalize the bubble.
- **Thinking blocks**: Render `thinking_delta` in a collapsible section within the assistant message.
- **Tool calls**: Show tool name + args on `tool_execution_start`. Update with partial output on `tool_execution_update`. Show final result (collapsed by default) on `tool_execution_end`.
- **Loading indicator**: Show spinner/dots on `agent_start`, hide on `agent_end`.
- **Abort button**: Visible while streaming, sends `abort` command.
- **Queue display**: Update on `queue_update` — show pending steer/follow-up messages.
- **Compaction overlay**: Brief "Compacting context..." indicator during `compaction_start` → `compaction_end`.
- **Extension UI dialogs**: Render as modals for `select`, `confirm`, `input`, `editor` methods. Fire-and-forget for `notify`, `setStatus`, etc.
- **Session controls**: "New Session" button, "Resume" dropdown (populated from `/api/sessions`), model selector.

---

## 5. Session Resume Flow

### First launch (fresh session)

```bash
./piweb -cwd /path/to/project
# Pi creates a new persistent session in ~/.pi/agent/sessions/<hash>/xxxx.jsonl
```

### Resume from CLI (after web session)

```bash
cd /path/to/project
pi -c                          # Continue most recent session
# or
pi --session <session-id>      # Target specific session
```

### Resume from web (server restart with explicit session)

```bash
./piweb -cwd /path/to/project -session <session-file-or-id>
```

### Resume from web (while server is running — no restart)

User picks a session from the "Resume" dropdown:

```javascript
const sessions = await fetch("/api/sessions").then(r => r.json());
// User selects one:
await piClient.switchSession(selectedSession.path);
```

Or fork from a specific message in conversation history:

```javascript
await piClient.fork("entry-id-from-tree");
```

### Cross-environment continuity

Since sessions are standard Pi JSONL files with the tree structure (id/parentId), any session created or modified via the web UI is fully compatible with:
- `pi -c` / `pi --session <id>` from CLI
- Pi's `/resume`, `/tree`, `/fork` commands in interactive mode

---

## 6. Implementation Order

1. **Agent wrapper** (`internal/agent`) — spawn subprocess, pipe stdin/stdout, expose channel
2. **HTTP handler** (`internal/handler`) — SSE endpoint + command POST endpoint
3. **Server entry** (`cmd/server`) — wire it together, flag parsing
4. **Frontend skeleton** (`static/`) — HTML page with chat area, input box, EventSource connection
5. **Streaming text rendering** — `message_update` → `text_delta` display
6. **Tool call rendering** — `tool_execution_*` events
7. **Session scanner** (`internal/session`) — `/api/sessions` endpoint for resume dropdown
8. **Extension UI dialogs** — modal handling for select/confirm/input/editor
9. **Polish** — thinking blocks, compaction indicator, abort button, queue display, theming

---

## 7. Open Questions / Trade-offs

| Question | Notes |
|----------|-------|
| **Session directory discovery** | Pi hashes the cwd to create the session subdir name. We either replicate that hash logic or glob all directories under `~/.pi/agent/sessions/` and filter by reading file headers. |
| **Server lifecycle vs agent lifecycle** | If the Go server crashes, the Pi subprocess is orphaned. Options: run as a child process (killed on parent exit) or add a PID-file cleanup. |
| **Auth** | The server exposes full filesystem access through bash/read/write/edit. At minimum, require authentication before serving the UI. Could be API key, basic auth, or mTLS. |
| **cwd option** | Should `--cwd` flag default to `$PWD` at server start, or let users change it per-request? Simplest: fix cwd at server startup via flag. |
| **Extension support** | Extensions loaded by Pi in RPC mode will work, including extension UI dialogs. The web frontend just needs to handle `extension_ui_request` events and respond with `extension_ui_response`. |

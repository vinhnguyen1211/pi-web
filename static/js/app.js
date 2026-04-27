/* =====================================================================
   Pi Web Client — app.js
   Handles SSE events, commands, and DOM rendering.
   ===================================================================== */

// ── PiClient ──────────────────────────────────────────────────────────

class PiClient {
  constructor() {
    this.streaming = false;
    this.currentText = "";
    this.eventSource = null;
    this.pendingResolvers = new Map(); // id -> resolve fn
    this.connect();
  }

  connect() {
    if (this.eventSource) this.eventSource.close();
    this.eventSource = new EventSource("/stream");
    this.eventSource.onmessage = (e) => this.handleEvent(JSON.parse(e.data));
    this.eventSource.onerror = () => console.warn("SSE lost — reconnecting…");
  }

  handleEvent(data) {
    if (!data) return;
    // Handle SSE comment-only heartbeat
    if (data.type === undefined && data.event === "agent_exited") return;

    // Command responses (have matching id)
    if (data.type === "response") {
      const resolver = this.pendingResolvers.get(data.id);
      if (resolver) {
        resolver(data);
        this.pendingResolvers.delete(data.id);
      }
      return;
    }

    // Forward to UI handlers
    dispatchToUI(data);
  }

  // ── Commands ──

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
  async getState() { return this.sendAwait("get_state"); }
  async getMessages() { return this.sendAwait("get_messages"); }
  async getSessionStats() { return this.sendAwait("get_session_stats"); }
  async getAvailableModels() { return this.sendAwait("get_available_models"); }

  // Session operations
  async newSession() { return this.sendAwait("new_session"); }
  async switchSession(path) {
    await this.send({ type: "switch_session", sessionPath: path });
  }
  async fork(entryId) { return this.sendAwait("fork", { entryId }); }
  async clone() { return this.sendAwait("clone"); }

  // Model / thinking control
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

  // ── Helpers ──

  async send(cmd) {
    const resp = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    if (!resp.ok) throw new Error(`Command failed: ${resp.status}`);
  }

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
      }, 15000);
    });
  }

  close() {
    if (this.eventSource) this.eventSource.close();
  }
}

// ── DOM Helpers ───────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function scrollBottom() {
  const c = $("#chat-container");
  requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// Simple markdown renderer (no deps)
function renderMarkdown(text) {
  let html = text;

  // Code blocks: ```lang ... ```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold / Italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs and nested tags
  html = html.replace(/<p><(pre|ul|ol|h[1-3]|blockquote)/g, '<$1');
  html = html.replace(/<\/(pre|ul|ol|h[1-3]|blockquote)><\/p>/g, '</$1>');
  html = html.replace(/<p><\/p>/g, '');

  return html;
}

// ── UI State ──────────────────────────────────────────────────────────

let assistantEl = null;       // Current streaming message .bubble element
let currentTextEl = null;     // Current text segment receiving deltas (null when in tool/thinking block)
let thinkingEl = null;        // Current thinking content element
let toolEl = null;            // Current tool block element
let queueItems = [];
let pendingUIRequest = null;  // { id, method, resolve } for extension_ui_request

// ── Message Creation ──────────────────────────────────────────────────

function createMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "You" : "π";

  const wrapper = document.createElement("div");
  wrapper.className = "message-content";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (content !== null) {
    bubble.innerHTML = content;
  }

  wrapper.appendChild(bubble);
  div.appendChild(avatar);
  div.appendChild(wrapper);

  $("#messages").appendChild(div);
  scrollBottom();

  return { div, bubble, wrapper };
}

// ── Message History ───────────────────────────────────────────────────

async function loadMessageHistory() {
  try {
    const result = await client.getMessages();
    const messages = result?.messages || result?.items || [];
    if (!messages.length) return;

    $("#messages").innerHTML = "";

    for (const msg of messages) {
      const role = msg.role || msg.type || "assistant";
      const text = msg.content || msg.text || msg.message || "";
      if (text) {
        createMessage(
          role === "user" ? "user" : "assistant",
          role === "user" ? escapeHtml(text) : renderMarkdown(text)
        );
      }
    }
    scrollBottom();
  } catch (err) {
    console.warn("Failed to load message history:", err);
  }
}

// ── Event Router ──────────────────────────────────────────────────────

function dispatchToUI(data) {
  switch (data.type) {
    case "agent_start":
      onAgentStart(data);
      break;
    case "message_update":
      onMessageUpdate(data.assistantMessageEvent);
      break;
    case "agent_end":
      onAgentEnd(data);
      break;
    case "tool_execution_start":
      onToolExecutionStart(data.toolExecutionEvent);
      break;
    case "tool_execution_update":
      onToolExecutionUpdate(data.toolExecutionEvent);
      break;
    case "tool_execution_end":
      onToolExecutionEnd(data.toolExecutionEvent);
      break;
    case "queue_update":
      onQueueUpdate(data.queueUpdate || {});
      break;
    case "compaction_start":
      $("#compaction-overlay").classList.remove("hidden");
      scrollBottom();
      break;
    case "compaction_end":
      $("#compaction-overlay").classList.add("hidden");
      break;
    case "extension_ui_request":
      onExtensionUIRequest(data);
      break;
    default:
      // Ignore unknown events
      break;
  }
}

// ── Agent lifecycle ───────────────────────────────────────────────────

function onAgentStart(data) {
  // If we already have an assistant bubble streaming, finalize it first
  if (assistantEl) {
    const raw = currentTextEl ? currentTextEl.getAttribute("data-raw") : assistantEl.getAttribute("data-raw");
    if (raw) {
      if (currentTextEl) currentTextEl.removeAttribute("data-raw");
      else assistantEl.removeAttribute("data-raw");
    }
  }

  // Create new assistant message placeholder
  const msg = createMessage("assistant", null);
  assistantEl = msg.bubble;
  currentTextEl = null;

  thinkingEl = null;
  toolEl = null;
  $("#loading-indicator").classList.remove("hidden");
  scrollBottom();
}

function onAgentEnd(data) {
  $("#loading-indicator").classList.add("hidden");
  $("#btn-abort").classList.add("hidden");
  assistantEl = null;
  currentTextEl = null;
  thinkingEl = null;
  toolEl = null;
}

// ── Message update (streaming text / thinking) ────────────────────────

function onMessageUpdate(evt) {
  if (!evt) return;

  // Hide loading indicator on first content
  $("#loading-indicator").classList.add("hidden");
  $("#btn-abort").classList.remove("hidden");

  switch (evt.type) {
    case "text_start":
      // Ensure we have a bubble and text container to write into
      if (!assistantEl) {
        const msg = createMessage("assistant", null);
        assistantEl = msg.bubble;
      }
      if (!currentTextEl) {
        currentTextEl = document.createElement("div");
        currentTextEl.className = "assistant-text";
        assistantEl.appendChild(currentTextEl);
      }
      break;

    case "text_delta":
      if (evt.delta) {
        // Create a new text segment if one doesn't exist yet
        // (handles text_start not firing, or text resuming after a tool/thinking block)
        if (!currentTextEl) {
          currentTextEl = document.createElement("div");
          currentTextEl.className = "assistant-text";
          assistantEl.appendChild(currentTextEl);
        }
        let rawText = currentTextEl.getAttribute("data-raw") || "";
        rawText += evt.delta;
        currentTextEl.setAttribute("data-raw", rawText);
        currentTextEl.innerHTML = renderMarkdown(rawText);
      }
      scrollBottom();
      break;

    case "text_end":
      // Finalize — clear raw data attribute from text container
      if (currentTextEl) {
        currentTextEl.removeAttribute("data-raw");
      }
      scrollBottom();
      break;

    case "thinking_start":
      createThinkingBlock();
      break;

    case "thinking_delta":
      if (thinkingEl && evt.delta) {
        let raw = thinkingEl.getAttribute("data-raw") || "";
        raw += evt.delta;
        thinkingEl.setAttribute("data-raw", raw);
        thinkingEl.textContent = raw;
      }
      scrollBottom();
      break;

    case "thinking_end":
      if (thinkingEl) {
        thinkingEl.removeAttribute("data-raw");
      }
      scrollBottom();
      break;
  }
}

// ── Thinking blocks ───────────────────────────────────────────────────

function createThinkingBlock() {
  if (!assistantEl) return;

  const block = document.createElement("div");
  block.className = "thinking-block";
  thinkingEl = block;

  // Freeze current text segment so future deltas create a new one after this block
  currentTextEl = null;
  assistantEl.appendChild(block);
}

// ── Tool execution ────────────────────────────────────────────────────

function onToolExecutionStart(evt) {
  if (!evt) return;
  $("#loading-indicator").classList.add("hidden");

  if (!assistantEl) {
    const msg = createMessage("assistant", null);
    assistantEl = msg.bubble;
  }

  const block = document.createElement("div");
  block.className = "tool-block open";

  const toolName = evt.toolName || evt.name || "tool";
  const argsStr = evt.args ? (typeof evt.args === "string" ? evt.args : JSON.stringify(evt.args, null, 2)) : "";

  block.innerHTML = `
    <div class="tool-header">
      <span class="tool-arrow">▶</span>
      <span class="tool-name">🔧 ${escapeHtml(toolName)}</span>
      <span class="tool-status status-running">⟳ Running…</span>
    </div>
    <div class="tool-body">
      <div class="tool-label">Args:</div>
      <pre class="tool-args">${escapeHtml(argsStr)}</pre>
      <div class="tool-label" style="margin-top:6px;">Output:</div>
      <pre class="tool-output"></pre>
    </div>
  `;

  // Toggle on click
  block.querySelector(".tool-header").addEventListener("click", () => {
    block.classList.toggle("open");
  });

  // Freeze current text segment so future deltas create a new one after this block
  currentTextEl = null;
  assistantEl.appendChild(block);
  toolEl = block;
  scrollBottom();
}

function onToolExecutionUpdate(evt) {
  if (!evt || !toolEl) return;
  const outputEl = toolEl.querySelector(".tool-output");
  if (outputEl && evt.output) {
    let raw = outputEl.getAttribute("data-raw") || "";
    raw += evt.output;
    outputEl.setAttribute("data-raw", raw);
    outputEl.textContent = raw;
  }
  scrollBottom();
}

function onToolExecutionEnd(evt) {
  if (!evt || !toolEl) return;

  const statusEl = toolEl.querySelector(".tool-status");
  if (statusEl) {
    statusEl.textContent = evt.error ? "✗ Failed" : "✓ Done";
    statusEl.className = `tool-status status-${evt.error ? "error" : "success"}`;
    if (evt.error) statusEl.style.color = "var(--danger)";
    else statusEl.style.color = "var(--success)";
  }

  // Show final output if available
  const outputEl = toolEl.querySelector(".tool-output");
  if (outputEl && evt.result !== undefined && evt.result !== null) {
    const resultStr = typeof evt.result === "string" ? evt.result : JSON.stringify(evt.result, null, 2);
    outputEl.textContent = resultStr;
    outputEl.removeAttribute("data-raw");
  }

  toolEl = null;
  scrollBottom();
}

// ── Queue display ─────────────────────────────────────────────────────

function onQueueUpdate(update) {
  const items = update.messages || update.items || [];
  queueItems = items;

  const bar = $("#queue-bar");
  const container = $("#queue-items");
  container.innerHTML = "";

  if (items.length === 0) {
    bar.classList.add("hidden");
    return;
  }

  bar.classList.remove("hidden");

  for (const item of items) {
    const span = document.createElement("span");
    span.className = "queue-item";
    const msg = typeof item === "string" ? item : (item.message || item.text || JSON.stringify(item));
    span.textContent = msg.length > 40 ? msg.slice(0, 37) + "…" : msg;
    container.appendChild(span);
  }
}

// ── Extension UI dialogs ──────────────────────────────────────────────

function onExtensionUIRequest(data) {
  const req = data.extensionUIEvent || {};
  const id = data.id || req.id || "";
  const method = req.method || req.type || "";

  // Handle non-interactive methods
  if (method === "notify" || method === "notification") {
    showNotification(req.title || "", req.message || req.content || "");
    return;
  }
  if (method === "setStatus" || method === "status") {
    showNotification("Status", req.status || req.message || "");
    return;
  }

  // Interactive methods: select, confirm, input, editor
  const modal = $("#extension-modal");
  const titleEl = $("#modal-title");
  const messageEl = $("#modal-message");
  const bodyEl = $("#modal-body");
  const cancelBtn = $("#modal-btn-cancel");
  const confirmBtn = $("#modal-btn-confirm");

  titleEl.textContent = req.title || "Extension";
  messageEl.textContent = req.message || req.description || "";
  bodyEl.innerHTML = "";

  let inputEl = null;

  switch (method) {
    case "confirm":
    case "boolean":
      confirmBtn.textContent = req.confirmText || "Yes";
      cancelBtn.textContent = "No";
      cancelBtn.classList.remove("hidden");
      break;

    case "input":
    case "text":
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.value = req.defaultValue || req.default || "";
      inputEl.placeholder = req.placeholder || "Type your answer…";
      bodyEl.appendChild(inputEl);
      cancelBtn.classList.add("hidden");
      break;

    case "textarea":
    case "editor":
    case "text_area":
      inputEl = document.createElement("textarea");
      inputEl.value = req.defaultValue || req.default || "";
      inputEl.rows = 8;
      inputEl.placeholder = req.placeholder || "Type your answer…";
      bodyEl.appendChild(inputEl);
      cancelBtn.classList.add("hidden");
      break;

    case "select":
    case "choice":
      inputEl = document.createElement("select");
      const options = req.options || req.choices || [];
      for (const opt of options) {
        const o = document.createElement("option");
        o.value = typeof opt === "string" ? opt : (opt.value || opt.id || opt);
        o.textContent = typeof opt === "string" ? opt : (opt.label || opt.name || opt);
        inputEl.appendChild(o);
      }
      bodyEl.appendChild(inputEl);
      cancelBtn.classList.add("hidden");
      break;

    default:
      // Unknown method — show as notification + auto-acknowledge
      showNotification(req.title || "Extension", JSON.stringify(req, null, 2).slice(0, 200));
      return;
  }

  modal.showModal();
  if (inputEl) inputEl.focus();

  // Store pending request for resolution
  const resolve = (value, cancelled) => {
    pendingUIRequest = null;
    modal.close();
    const payload = {};
    if (cancelled) {
      payload.cancelled = true;
    } else if (method === "confirm" || method === "boolean") {
      payload.value = value;
    } else {
      payload.response = value;
    }
    client.respondExtensionUI(id, payload).catch(console.error);
  };

  pendingUIRequest = { id, method, resolve };

  confirmBtn.onclick = () => {
    if (inputEl) resolve(inputEl.value || inputEl.checked);
    else resolve(true);
  };

  cancelBtn.onclick = () => {
    if (method === "confirm" || method === "boolean") resolve(false);
    else resolve(null, true);
  };

  // Enter key submits text inputs
  bodyEl.addEventListener("keydown", function handler(e) {
    if (e.key === "Enter" && !e.shiftKey && method === "input") {
      e.preventDefault();
      confirmBtn.click();
      bodyEl.removeEventListener("keydown", handler);
    }
  });
}

function showNotification(title, message) {
  const el = $("#extension-notify");
  let html = "";
  if (title) html += `<strong>${escapeHtml(title)}</strong><br>`;
  html += escapeHtml(message);
  el.innerHTML = html;
  el.classList.remove("hidden");

  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => { el.classList.add("hidden"); }, 5000);
}

// ── Init & Event Wiring ───────────────────────────────────────────────

const client = new PiClient();

document.addEventListener("DOMContentLoaded", () => {
  const input = $("#prompt-input");
  const sendBtn = $("#btn-send");
  const abortBtn = $("#btn-abort");
  const themeToggle = $("#btn-theme-toggle");
  const newSessionBtn = $("#btn-new-session");
  const sessionSelect = $("#session-select");

  // ── Send message ──
  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    createMessage("user", escapeHtml(text));
    await client.prompt(text);
  }

  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });

  // ── Abort ──
  abortBtn.addEventListener("click", () => {
    client.abort().catch(console.error);
    abortBtn.classList.add("hidden");
  });

  // ── Theme toggle ──
  const savedTheme = localStorage.getItem("piweb-theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);

  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("piweb-theme", next);
  });

  // ── New session ──
  newSessionBtn.addEventListener("click", async () => {
    await client.newSession();
    sessionSelect.value = "";
    // Clear chat area for fresh start
    $("#messages").innerHTML = "";
    addSystemMessage("New session started");
    assistantEl = null;
    thinkingEl = null;
    toolEl = null;
  });

  // ── Session select ──
  sessionSelect.addEventListener("change", async () => {
    const path = sessionSelect.value;
    if (!path) return;
    await client.switchSession(path);
    $("#messages").innerHTML = "";
    addSystemMessage(`Switched to session: ${sessionSelect.selectedOptions[0].text}`);
    await loadMessageHistory();
  });

  // Load sessions on startup
  loadSessions();

  // Load message history for the current session
  loadMessageHistory();

  // ── Scroll on load ──
  scrollBottom();
});

// ── Session loading ───────────────────────────────────────────────────

async function loadSessions() {
  try {
    const resp = await fetch("/api/sessions");
    if (!resp.ok) return;
    const sessions = await resp.json();
    const select = $("#session-select");

    // Keep the first option (+ New Session), replace rest
    select.innerHTML = '<option value="">+ New Session</option>';

    for (const s of sessions.slice(0, 50)) { // Limit to 50 most recent
      const opt = document.createElement("option");
      opt.value = s.path;
      const age = timeSince(s.modTime);
      opt.textContent = `${s.name} (${age})`;
      opt.title = `${s.entries} entries, ${s.model || "unknown"}`;
      select.appendChild(opt);
    }
  } catch (err) {
    console.warn("Failed to load sessions:", err);
  }
}

function timeSince(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ── System message helper ─────────────────────────────────────────────

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.style.textAlign = "center";
  div.style.color = "var(--text-muted)";
  div.style.fontSize = "0.8rem";
  div.style.padding = "6px 0";
  div.textContent = `— ${text} —`;
  $("#messages").appendChild(div);
  scrollBottom();
}

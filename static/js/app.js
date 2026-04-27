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

// Markdown renderer via marked library (loaded from CDN in index.html)
function renderMarkdown(text) {
  if (!text) return '';
  marked.setOptions({
    breaks: true,  // single newlines → <br>
    gfm: true,     // GitHub Flavored Markdown
  });
  return marked.parse(text);
}

// ── UI State ──────────────────────────────────────────────────────────

let assistantEl = null;             // Current streaming message .bubble element
let currentTextEl = null;           // Current text segment receiving deltas (null when in tool/thinking block)
let thinkingEl = null;              // Current thinking content element
let toolBlocks = new Map();         // toolCallId -> { block, outputEl, statusEl, name, argsStr }
let activeToolCallId = null;        // Currently streaming tool execution
let pendingToolCalls = new Map();   // toolUseId -> { name, args } (from toolcall_start/end before execution)
let queueItems = [];
let pendingUIRequest = null;        // { id, method, resolve } for extension_ui_request

// ── Content Helpers ───────────────────────────────────────────────────

/** Extract plain text from a content array: [{ type: "text", text: "..." }, ...] */
function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  }
  // Fallback: try to serialize
  return JSON.stringify(content, null, 2);
}

/** Create a closed tool block DOM element (for history or toolcall_end without execution). */
function buildToolBlock(toolName, argsStr, outputText, status, open) {
  const block = document.createElement("div");
  block.className = `tool-block${open ? " open" : ""}`;

  let statusHtml;
  if (status === "running") {
    statusHtml = '<span class="tool-status status-running">⟳ Running…</span>';
  } else if (status === "error") {
    statusHtml = '<span class="tool-status" style="color:var(--danger)">✗ Failed</span>';
  } else if (status === "success") {
    statusHtml = '<span class="tool-status" style="color:var(--success)">✓ Done</span>';
  } else {
    statusHtml = '';
  }

  const outputContent = outputText !== undefined && outputText !== null
    ? `<div class="tool-label" style="margin-top:6px;">Output:</div><pre class="tool-output">${escapeHtml(outputText)}</pre>`
    : '';

  block.innerHTML = `
    <div class="tool-header">
      <span class="tool-arrow">▶</span>
      <span class="tool-name">🔧 ${escapeHtml(toolName)}</span>
      ${statusHtml}
    </div>
    <div class="tool-body">
      <div class="tool-label">Args:</div>
      <pre class="tool-args">${escapeHtml(argsStr || "")}</pre>
      ${outputContent}
    </div>
  `;

  // Toggle on click
  block.querySelector(".tool-header").addEventListener("click", () => {
    block.classList.toggle("open");
  });

  return block;
}

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

      // Handle array content (can mix text + toolCall blocks)
      if (Array.isArray(msg.content)) {
        const displayRole = role === "user" ? "user" : "assistant";
        if (displayRole === "assistant") {
          const { bubble } = createMessage("assistant", null);
          for (const block of msg.content) {
            if (!block) continue;
            if (block.type === "text" && block.text) {
              const textEl = document.createElement("div");
              textEl.className = "assistant-text";
              textEl.innerHTML = renderMarkdown(block.text);
              bubble.appendChild(textEl);
            } else if (block.type === "toolCall") {
              const toolName = block.name || block.toolName || "tool";
              const argsStr = typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments, null, 2);
              const resultText = block.result !== undefined
                ? (typeof block.result === "string" ? block.result : extractTextFromContent(block.result))
                : undefined;
              const isError = !!block.isError || !!block.error;
              const toolBlock = buildToolBlock(toolName, argsStr, resultText, isError ? "error" : "success", false);
              bubble.appendChild(toolBlock);
            }
          }
        } else {
          // User message: join text blocks
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) createMessage("user", escapeHtml(text));
        }
      } else {
        // Legacy: content is a plain string
        const text = msg.content || msg.text || msg.message || "";
        if (text) {
          createMessage(
            role === "user" ? "user" : "assistant",
            role === "user" ? escapeHtml(text) : renderMarkdown(text)
          );
        }
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
      onToolExecutionStart(data);          // data IS the event
      break;
    case "tool_execution_update":
      onToolExecutionUpdate(data);         // data IS the event
      break;
    case "tool_execution_end":
      onToolExecutionEnd(data);            // data IS the event
      break;
    case "queue_update":
      onQueueUpdate(data);                 // data has steering/followUp directly
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
  toolBlocks.clear();
  activeToolCallId = null;
  pendingToolCalls.clear();
  $("#loading-indicator").classList.remove("hidden");
  scrollBottom();
}

function onAgentEnd(data) {
  $("#loading-indicator").classList.add("hidden");
  $("#btn-abort").classList.add("hidden");
  assistantEl = null;
  currentTextEl = null;
  thinkingEl = null;
  toolBlocks.clear();
  activeToolCallId = null;
  pendingToolCalls.clear();
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

    // ── Tool call deltas (LLM announcing tool use, before execution) ──

    case "toolcall_start":
      // LLM is starting to call a tool. Store the pending call.
      const startId = evt.toolCall?.id || evt.id || `tc_${Date.now()}`;
      pendingToolCalls.set(startId, {
        name: evt.toolCall?.name || evt.name || "tool",
        args: "",
      });
      break;

    case "toolcall_delta":
      // Streaming arguments for the tool call.
      if (evt.delta && evt.toolUseId) {
        const pending = pendingToolCalls.get(evt.toolUseId);
        if (pending) {
          pending.args += typeof evt.delta === "string" ? evt.delta : JSON.stringify(evt.delta);
        }
      }
      break;

    case "toolcall_end":
      // LLM finished announcing the tool call. If we haven't seen execution yet,
      // show a collapsed placeholder that will be replaced when execution starts.
      const endTool = evt.toolCall || {};
      const endId = endTool.id || evt.toolUseId;
      const pending = endId ? pendingToolCalls.get(endId) : null;
      const tcName = endTool.name || pending?.name || "tool";
      const tcArgs = endTool.arguments !== undefined
        ? (typeof endTool.arguments === "string" ? endTool.arguments : JSON.stringify(endTool.arguments, null, 2))
        : pending?.args || "";

      // Only show placeholder if no execution block exists yet for this call
      if (!toolBlocks.has(endId) && assistantEl) {
        const placeholder = buildToolBlock(tcName, tcArgs, undefined, "running", false);
        assistantEl.appendChild(placeholder);
        toolBlocks.set(endId, {
          block: placeholder,
          outputEl: placeholder.querySelector(".tool-output"),
          statusEl: placeholder.querySelector(".tool-status"),
          name: tcName,
          argsStr: tcArgs,
        });
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

  const toolCallId = evt.toolCallId || `tc_${Date.now()}`;
  const toolName = evt.toolName || evt.name || "tool";
  const argsStr = evt.args ? (typeof evt.args === "string" ? evt.args : JSON.stringify(evt.args, null, 2)) : "";

  // If a placeholder already exists from toolcall_end, replace it
  if (toolBlocks.has(toolCallId)) {
    const existing = toolBlocks.get(toolCallId);
    existing.block.classList.add("open");
    return; // Already rendered, just open it
  }

  const block = buildToolBlock(toolName, argsStr, undefined, "running", true);
  assistantEl.appendChild(block);

  toolBlocks.set(toolCallId, {
    block,
    outputEl: block.querySelector(".tool-output"),
    statusEl: block.querySelector(".tool-status"),
    name: toolName,
    argsStr,
  });

  activeToolCallId = toolCallId;
  currentTextEl = null;  // Freeze text so future deltas create a new segment after this block
  scrollBottom();
}

function onToolExecutionUpdate(evt) {
  if (!evt) return;

  const toolCallId = evt.toolCallId || activeToolCallId;
  if (!toolCallId) return;  // No way to correlate this update

  const entry = toolBlocks.get(toolCallId);
  if (!entry || !entry.outputEl) {
    // Try to create the block on-the-fly (start event might have been missed)
    if (!toolBlocks.has(toolCallId)) {
      return; // Can't render without a block
    }
    return;
  }

  // partialResult is an accumulated object: { content: [{ type: "text", text: "..." }] }
  const partialResult = evt.partialResult || evt.output;
  if (partialResult) {
    const text = extractTextFromContent(partialResult);
    if (text) {
      entry.outputEl.textContent = text;  // Replace (it's accumulated, not delta)
    }
  }

  scrollBottom();
}

function onToolExecutionEnd(evt) {
  if (!evt) return;

  const toolCallId = evt.toolCallId || activeToolCallId;
  if (!toolCallId) return;

  const entry = toolBlocks.get(toolCallId);
  if (entry) {
    // isError is a boolean (not evt.error)
    const failed = !!evt.isError;

    if (entry.statusEl) {
      entry.statusEl.textContent = failed ? "✗ Failed" : "✓ Done";
      entry.statusEl.className = `tool-status status-${failed ? "error" : "success"}`;
      entry.statusEl.style.color = failed ? "var(--danger)" : "var(--success)";
    }

    // result is { content: [{ type: "text", text: "..." }], details: {...} }
    if (entry.outputEl && evt.result !== undefined && evt.result !== null) {
      const text = extractTextFromContent(evt.result);
      if (text) {
        entry.outputEl.textContent = text;
        entry.outputEl.removeAttribute("data-raw");
      }
    }
  } else {
    // Fallback: start event was missed, create a complete closed block
    if (!assistantEl) return;
    const toolName = evt.toolName || evt.name || "tool";
    const argsStr = evt.args ? (typeof evt.args === "string" ? evt.args : JSON.stringify(evt.args, null, 2)) : "";
    const outputText = evt.result !== undefined && evt.result !== null
      ? extractTextFromContent(evt.result)
      : undefined;
    const status = evt.isError ? "error" : "success";
    const block = buildToolBlock(toolName, argsStr, outputText, status, false);
    assistantEl.appendChild(block);
  }

  activeToolCallId = null;
  scrollBottom();
}

// ── Queue display ─────────────────────────────────────────────────────

function onQueueUpdate(update) {
  // RPC event has steering and followUp arrays directly (not nested in queueUpdate)
  const steering = Array.isArray(update.steering) ? update.steering.map(formatQueueItem).filter(Boolean) : [];
  const followUp = Array.isArray(update.followUp) ? update.followUp.map(formatQueueItem).filter(Boolean) : [];
  // Also try legacy fields for safety
  const legacyItems = (Array.isArray(update.messages) ? update.messages : [])
    .concat(Array.isArray(update.items) ? update.items : [])
    .map(formatQueueItem).filter(Boolean);

  queueItems = [...steering, ...followUp, ...legacyItems];

  const bar = $("#queue-bar");
  const container = $("#queue-items");
  container.innerHTML = "";

  if (queueItems.length === 0) {
    bar.classList.add("hidden");
    return;
  }

  bar.classList.remove("hidden");

  for (const msg of queueItems) {
    const span = document.createElement("span");
    span.className = "queue-item";
    span.textContent = msg.length > 40 ? msg.slice(0, 37) + "…" : msg;
    container.appendChild(span);
  }
}

function formatQueueItem(item) {
  if (!item) return null;
  if (typeof item === "string") return item;
  // Try common field names for queue items
  if (item.message) return item.message;
  if (item.text) return item.text;
  if (item.prompt) return item.prompt;
  if (item.content) {
    if (typeof item.content === "string") return item.content;
    // content might be [{ type: "text", text: "..." }]
    return extractTextFromContent(item.content);
  }
  return null;
}

// ── Extension UI dialogs ──────────────────────────────────────────────

function onExtensionUIRequest(data) {
  // Event fields are top-level; try nested extensionUIEvent as fallback
  const req = data.extensionUIEvent || data;
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
    toolBlocks.clear();
    activeToolCallId = null;
    pendingToolCalls.clear();
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

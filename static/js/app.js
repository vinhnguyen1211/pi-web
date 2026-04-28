/* =====================================================================
   Pi Web Client — app.js
   Handles SSE events, commands, and DOM rendering.
   ===================================================================== */

// ── Connection ID (unique per tab) ────────────────────────────────────

const CONN_ID = crypto.randomUUID();

// ── PiClient ──────────────────────────────────────────────────────────

class PiClient {
  constructor() {
    this.streaming = false;
    this.currentText = "";
    this.eventSource = null;
    this.pendingResolvers = new Map(); // id -> resolve fn
    this.connected = false;
  }

  connect(connId) {
    if (this.eventSource) this.eventSource.close();
    this.eventSource = new EventSource(`/stream?connId=${encodeURIComponent(connId)}`);
    this.eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        this.handleEvent(data);
      } catch (err) {
        // Skip non-JSON lines from the agent (status messages, etc.)
        console.warn("SSE: non-JSON line:", e.data?.slice(0, 80));
      }
    };
    this.eventSource.onerror = () => console.warn("SSE lost — reconnecting…");
  }

  handleEvent(data) {
    if (!data || typeof data !== "object") return;
    // Handle SSE comment-only heartbeat
    if (data.type === undefined && data.event === "agent_exited") return;

    // Awaiting session — no agent yet, client should pick one
    if (data.type === "awaiting_session") {
      console.log("[sse] awaiting_session — showing selection screen");
      showSessionScreen();
      return;
    }

    // Command responses — match by id, or by known response types
    if (data.type === "response" || data.id) {
      const resolver = this.pendingResolvers.get(data.id);
      if (resolver) {
        console.log(`[cmd] got response: type=${data.type} id=${data.id}`);
        resolver(data);
        this.pendingResolvers.delete(data.id);
      } else if (data.id) {
        console.warn("[cmd] unmatched response id=", data.id, "type=", data.type);
      }
      return;
    }

    // Forward to UI handlers
    dispatchToUI(data);
  }

  // ── Connect / Disconnect ──

  /** Spawn a new agent: either fresh or resume from session path. */
  async connectAgent(sessionPath) {
    const body = sessionPath
      ? { type: "resume", sessionPath }
      : { type: "new" };

    const resp = await fetch("/api/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Conn-Id": CONN_ID,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Connect failed: ${resp.status}`);
    const result = await resp.json();
    console.log("[connect] agent spawned:", result);

    // Now connect SSE with the connId
    this.connected = true;
    this.connect(CONN_ID);
  }

  /** Disconnect and return to session selection screen. */
  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.pendingResolvers.clear();
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
      headers: {
        "Content-Type": "application/json",
        "X-Conn-Id": CONN_ID,
      },
      body: JSON.stringify(cmd),
    });
    if (!resp.ok) throw new Error(`Command failed: ${resp.status}`);
  }

  async sendAwait(type, extra = {}) {
    const id = crypto.randomUUID();
    console.log(`[cmd] sending: ${type} id=${id}`);
    await this.send({ type, id, ...extra });
    return new Promise((resolve) => {
      this.pendingResolvers.set(id, resolve);
      setTimeout(() => {
        if (this.pendingResolvers.has(id)) {
          this.pendingResolvers.delete(id);
          console.warn(`[cmd] TIMEOUT: ${type} id=${id}`);
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

/** Threshold (px): if user's scroll position is within this distance of the bottom, treat them as "at the bottom". */
const SCROLL_THRESHOLD = 50;

/** Check whether the chat container is scrolled near the bottom. */
function isNearBottom() {
  const c = $("#chat-container");
  if (!c) return true;
  // scrollHeight - (scrollTop + clientHeight) = remaining pixels to the bottom edge
  const remaining = c.scrollHeight - (c.scrollTop + c.clientHeight);
  return remaining <= SCROLL_THRESHOLD;
}

/** Scroll to bottom — only if the user is already near the bottom. */
function scrollBottom() {
  const c = $("#chat-container");
  requestAnimationFrame(() => {
    if (isNearBottom()) {
      c.scrollTop = c.scrollHeight;
    }
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ── Image Helpers ─────────────────────────────────────────────────────

/** Convert a File/blob to base64 ImageContent format for the RPC protocol. */
function fileToImageContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Strip "data:image/png;base64," prefix
      const base64 = reader.result.split(",")[1];
      resolve({ type: "image", data: base64, mimeType: file.type || "image/png" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Show staged images as thumbnail previews above the textarea. */
function showImagePreviews(images) {
  const strip = $("#image-preview-strip");
  if (!strip) return;
  strip.innerHTML = "";

  for (const img of images) {
    const wrapper = document.createElement("div");
    wrapper.className = "preview-thumb-wrapper";

    const imgEl = document.createElement("img");
    imgEl.src = `data:${img.mimeType};base64,${img.data}`;
    imgEl.className = "preview-thumb";

    const removeBtn = document.createElement("button");
    removeBtn.className = "preview-remove";
    removeBtn.textContent = "\u2715"; // ✕
    removeBtn.title = "Remove image";
    removeBtn.onclick = () => {
      wrapper.remove();
      pendingImages = pendingImages.filter(i => i !== img);
      if (pendingImages.length === 0) clearImagePreviews();
    };

    wrapper.appendChild(imgEl);
    wrapper.appendChild(removeBtn);
    strip.appendChild(wrapper);
  }
  strip.classList.remove("hidden");
}

/** Clear the image preview strip. */
function clearImagePreviews() {
  const strip = $("#image-preview-strip");
  if (!strip) return;
  strip.innerHTML = "";
  strip.classList.add("hidden");
}

/** Update UI to reflect whether the current model supports images. */
function updatePasteHint() {
  const hint = $("#btn-paste-hint");
  if (hint) {
    hint.classList.toggle("hidden", !modelSupportsImages);
  }
}

/** Check current model capabilities and set paste-hint visibility. */
async function checkModelImageSupport() {
  try {
    const state = await client.getState();
    const data = state?.data || state;
    const model = data?.model;
    modelSupportsImages = Array.isArray(model?.input) && model.input.includes("image");
    updatePasteHint();
  } catch {
    // If we can't check, assume support (most models do)
    modelSupportsImages = true;
    updatePasteHint();
  }
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

// ── Screen management ─────────────────────────────────────────────────

function showSessionScreen() {
  $("#session-screen").style.display = "flex";
  $("#header").classList.add("hidden");
  $("#chat-container").classList.add("hidden");
  $("#input-area").classList.add("hidden");
  $("#queue-bar").classList.add("hidden");
  $("#btn-abort").classList.add("hidden");
}

function showChatScreen() {
  $("#session-screen").style.display = "none";
  $("#header").classList.remove("hidden");
  $("#chat-container").classList.remove("hidden");
  $("#input-area").classList.remove("hidden");
}

// ── UI State ──────────────────────────────────────────────────────────

let assistantEl = null;             // Current streaming message .bubble element
let currentTextEl = null;           // Current text segment receiving deltas (null when in tool/thinking block)
let thinkingEl = null;              // Current thinking content element
let streamingDotsEl = null;         // Inline three-dot indicator inside the assistant bubble
let toolBlocks = new Map();         // toolCallId -> { block, outputEl, statusEl, name, argsStr }
let activeToolCallId = null;        // Currently streaming tool execution
let pendingToolCalls = new Map();   // toolUseId -> { name, args } (from toolcall_start/end before execution)
let queueItems = [];
let pendingUIRequest = null;        // { id, method, resolve } for extension_ui_request
let pendingImages = [];             // Images staged for the next prompt ({ type, data, mimeType })
let modelSupportsImages = false;    // Whether current model accepts images

// ── Streaming Dots Helper ─────────────────────────────────────────────

function createStreamingDots() {
  const el = document.createElement("span");
  el.className = "streaming-dots";
  el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  return el;
}

function showStreamingDots(bubble) {
  if (!bubble) return;
  // Remove any existing dots first
  removeStreamingDots(bubble);
  streamingDotsEl = createStreamingDots();
  appendAtEnd(bubble, streamingDotsEl);
}

/** Re-append the streaming dots so they stay at the bottom of the bubble after new content. */
function moveStreamingDotsToEnd(bubble) {
  if (!bubble || !streamingDotsEl) return;
  appendAtEnd(bubble, streamingDotsEl);
}

/** Append el as the last child of parent (moves it if already inside). */
function appendAtEnd(parent, el) {
  if (el.parentElement) el.parentElement.removeChild(el);
  parent.appendChild(el);
}

function removeStreamingDots(bubble) {
  if (streamingDotsEl && streamingDotsEl.parentElement) {
    streamingDotsEl.parentElement.removeChild(streamingDotsEl);
  }
  // Also clean up if there's a stray dots element in the bubble
  const stray = bubble?.querySelector(".streaming-dots");
  if (stray && stray !== streamingDotsEl) {
    stray.parentElement.removeChild(stray);
  }
  streamingDotsEl = null;
}

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

/** Build a display title like "Bash: grep" or "Read: index.html" from tool name and args. */
function getToolDisplayTitle(toolName, argsStr) {
  let detail = "";
  try {
    if (toolName === "bash") {
      // Extract the command: could be a raw string or JSON { command: "..." }
      const parsed = typeof argsStr === "string" ? (() => { try { return JSON.parse(argsStr); } catch { return null; } })() : null;
      if (parsed && typeof parsed.command === "string") {
        // First word of the command
        detail = parsed.command.trim().split(/\s+/)[0].split("/").pop();
      } else if (typeof argsStr === "string" && argsStr.trim()) {
        detail = argsStr.trim().split(/\s+/)[0].split("/").pop();
      }
    } else if (toolName === "read" || toolName === "edit") {
      const parsed = typeof argsStr === "string" ? (() => { try { return JSON.parse(argsStr); } catch { return null; } })() : null;
      if (parsed && typeof parsed.path === "string") {
        detail = parsed.path.split("/").pop();
      } else if (typeof argsStr === "string" && argsStr.trim()) {
        detail = argsStr.trim().split(/\s+/)[0].split("/").pop();
      }
    } else if (toolName === "write") {
      const parsed = typeof argsStr === "string" ? (() => { try { return JSON.parse(argsStr); } catch { return null; } })() : null;
      if (parsed && typeof parsed.path === "string") {
        detail = parsed.path.split("/").pop();
      }
    }
  } catch {}
  const label = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  return detail ? `${label}: ${detail}` : label;
}

/** Try to parse a JSON string; return null on failure. */
function tryParseJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null;
 }
}

/** Compute a side-by-side diff and return HTML for the two-column view. */
function buildDiffHtml(oldText, newText) {
  // Use the global Diff object (loaded from CDN)
  if (typeof Diff === "undefined") {
    // Fallback: just show old/new as plain text
    return `<div class="tool-label">Old:</div><pre class="tool-output">${escapeHtml(oldText)}</pre>
            <div class="tool-label" style="margin-top:6px;">New:</div><pre class="tool-output">${escapeHtml(newText)}</pre>`;
  }

  const diff = Diff.diffLines(oldText, newText);
  if (!diff || diff.length === 0) {
    return '<div class="tool-label" style="color:var(--text-muted)">No changes</div>';
  }

  // Build paired rows for side-by-side alignment
  const rows = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (let i = 0; i < diff.length; i++) {
    const part = diff[i];
    const lines = part.value.split("\n");
    // Remove trailing empty element from final newline split
    if (lines[lines.length - 1] === "") lines.pop();

    if (part.removed) {
      // Lines being removed — show in old column, blank in new
      for (const line of lines) {
        rows.push({
          oldNum: oldLineNum++,
          oldPrefix: "-",
          oldContent: line,
          oldClass: "removed",
          newNum: null,
          newPrefix: " ",
          newContent: "",
          newClass: "blank",
        });
      }
    } else if (part.added) {
      // Lines being added — blank in old, show in new
      for (const line of lines) {
        rows.push({
          oldNum: null,
          oldPrefix: " ",
          oldContent: "",
          oldClass: "blank",
          newNum: newLineNum++,
          newPrefix: "+",
          newContent: line,
          newClass: "added",
        });
      }
    } else {
      // Context lines — show in both
      for (const line of lines) {
        rows.push({
          oldNum: oldLineNum++,
          oldPrefix: " ",
          oldContent: line,
          oldClass: "context",
          newNum: newLineNum++,
          newPrefix: " ",
          newContent: line,
          newClass: "context",
        });
      }
    }
  }

  // Build HTML table-like structure with flexbox
  let html = '<div class="diff-container">';

  // Header row
  html += '<div class="diff-row" style="display:flex;">';
  html += '<div class="diff-column"><div class="diff-header-cell">Original</div>';
  const oldRowsHtml = rows.map(r => {
    const num = r.oldNum != null ? escapeHtml(String(r.oldNum)) : "";
    return `<div class="diff-line ${r.oldClass}"><span class="diff-line-num">${num}</span><span class="diff-line-prefix">${r.oldPrefix}</span><span class="diff-line-content">${escapeHtml(r.oldContent)}</span></div>`;
  }).join("");
  html += oldRowsHtml + '</div>';

  // Separator (thin line between columns)
  html += '<div class="diff-separator"></div>';

  // New column
  html += '<div class="diff-column"><div class="diff-header-cell">Modified</div>';
  const newRowsHtml = rows.map(r => {
    const num = r.newNum != null ? escapeHtml(String(r.newNum)) : "";
    return `<div class="diff-line ${r.newClass}"><span class="diff-line-num">${num}</span><span class="diff-line-prefix">${r.newPrefix}</span><span class="diff-line-content">${escapeHtml(r.newContent)}</span></div>`;
  }).join("");
  html += newRowsHtml + '</div>';

  html += '</div></div>';
  return html;
}

/** Create a closed tool block DOM element (for history or toolcall_end without execution). */
function buildToolBlock(toolName, argsStr, outputText, status, open) {
  const block = document.createElement("div");
  const isEditTool = toolName.toLowerCase() === "edit";
  // Edit tool blocks are always expanded by default
  const isOpen = open || isEditTool;
  block.className = `tool-block${isOpen ? " open" : ""}`;

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

  // ── Special rendering for the Edit tool: show a git diff UI ──
  let bodyContent;
  if (isEditTool) {
    const parsed = tryParseJSON(argsStr);
    // Support two arg shapes:
    //   A) { edits: [{ oldText, newText }, ...] } — Pi's multi-edit format
    //   B) { oldText, newText } — single flat format
    let diffHtmls = [];
    if (parsed && Array.isArray(parsed.edits) && parsed.edits.length > 0) {
      for (const edit of parsed.edits) {
        if (edit.oldText !== undefined && edit.newText !== undefined) {
          const label = parsed.path ? `path="${escapeHtml(parsed.path)}"` : "";
          diffHtmls.push(`<div class="tool-label">Edit ${label}</div>${buildDiffHtml(edit.oldText, edit.newText)}`);
        }
      }
    } else if (parsed && parsed.oldText !== undefined && parsed.newText !== undefined) {
      diffHtmls.push(buildDiffHtml(parsed.oldText, parsed.newText));
    }

    if (diffHtmls.length > 0) {
      bodyContent = diffHtmls.join("");
    } else {
      // Fallback to default rendering
      console.log(`[edit-tool] fallback for ${toolName}: parsed=`, parsed, "argsStr preview:", argsStr?.slice(0, 120));
      bodyContent = `
        <div class="tool-label">Args:</div>
        <pre class="tool-args">${escapeHtml(argsStr || "")}</pre>
        <div class="tool-label" style="margin-top:6px;">Output:</div>
        <pre class="tool-output">${outputText !== undefined && outputText !== null ? escapeHtml(outputText) : ""}</pre>
      `;
    }
  } else {
    // Default rendering for non-edit tools
    bodyContent = `
      <div class="tool-label">Args:</div>
      <pre class="tool-args">${escapeHtml(argsStr || "")}</pre>
      <div class="tool-label" style="margin-top:6px;">Output:</div>
      <pre class="tool-output">${outputText !== undefined && outputText !== null ? escapeHtml(outputText) : ""}</pre>
    `;
  }

  block.innerHTML = `
    <div class="tool-header">
      <span class="tool-arrow">▶</span>
      <span class="tool-name">🔧 ${escapeHtml(getToolDisplayTitle(toolName, argsStr || ""))}</span>
      ${statusHtml}
    </div>
    <div class="tool-body">
      ${bodyContent}
    </div>
  `;

  // Toggle on click
  block.querySelector(".tool-header").addEventListener("click", () => {
    block.classList.toggle("open");
  });

  return block;
}

// ── Message Creation ──────────────────────────────────────────────────

function createMessage(role, content, images) {
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

  // Render attached images in user bubbles
  if (images && images.length > 0) {
    const imgGrid = document.createElement("div");
    imgGrid.className = "message-images";
    for (const img of images) {
      const imgEl = document.createElement("img");
      imgEl.src = `data:${img.mimeType};base64,${img.data}`;
      imgEl.className = "message-image-thumb";
      imgGrid.appendChild(imgEl);
    }
    bubble.appendChild(imgGrid);
  }

  wrapper.appendChild(bubble);
  div.appendChild(avatar);
  div.appendChild(wrapper);

  $("#messages").appendChild(div);
  scrollBottom();

  return { div, bubble, wrapper };
}

// ── Message History ───────────────────────────────────────────────────

/** Find the last EMPTY tool output <pre> in the last assistant bubble (tool results come as separate messages). */
function findLastToolOutputEl() {
  const bubbles = $$("#messages .message.assistant .bubble");
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const outputs = bubbles[i].querySelectorAll(".tool-output");
    for (let j = outputs.length - 1; j >= 0; j--) {
      if (!outputs[j].textContent.trim()) return outputs[j]; // empty → fillable
    }
  }
  console.warn("[history] no empty tool-output found to fill");
  return null;
}

async function loadMessageHistory() {
  try {
    const result = await client.getMessages();
    console.log("[history] getMessages result:", JSON.stringify(result).slice(0, 300));
    // Support multiple response shapes from Pi RPC
    let messages = result?.messages || result?.items || result?.data?.messages || [];
    if (!Array.isArray(messages) && Array.isArray(result)) {
      messages = result;  // result itself is the array
    }
    console.log("[history] messages count:", messages.length);
    if (!messages.length) return;

    $("#messages").innerHTML = "";

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const role = msg.role || msg.type || "assistant";
      console.log(`[history][${i}] role="${role}" content=`, Array.isArray(msg.content) ? `array[${msg.content.length}]` : typeof msg.content, msg.content?.slice(0, 80));

      // Tool result messages — inject into the preceding tool call block
      // Pi uses role "toolResult" (camelCase)
      if (role === "toolResult" || role === "tool") {
        const outputText = typeof msg.content === "string"
          ? msg.content
          : extractTextFromContent(msg.content);
        if (outputText) {
          const el = findLastToolOutputEl();
          if (el) {
            el.textContent = outputText;
          } else {
            console.warn("[history] tool result with no preceding tool block:", msg);
          }
        }
        continue;  // Don't render as a separate message
      }

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
          // User message: join text blocks + render image attachments
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const images = (msg.content || [])
            .filter((b) => b.type === "image")
            .map((b) => ({ type: "image", data: b.data, mimeType: b.mimeType || "image/png" }));
          // Also check attachments array
          const attachImages = Array.isArray(msg.attachments)
            ? msg.attachments.filter((a) => a.type === "image")
            : [];
          const allImages = [...images, ...attachImages.map((a) => ({ type: "image", data: a.content, mimeType: a.mimeType || "image/png" }))];
          if (text || allImages.length > 0) createMessage("user", text ? escapeHtml(text) : null, allImages);
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
      updateTokenInfo();
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
  // Cancel any pending refresh from the previous turn
  if (tokenUpdateTimer) {
    clearTimeout(tokenUpdateTimer);
    tokenUpdateTimer = null;
  }

  // Update token info at the start of each agent run
  updateTokenInfo();

  // If we already have an assistant bubble streaming, finalize it first
  if (assistantEl) {
    removeStreamingDots(assistantEl);
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
  showStreamingDots(assistantEl);
  scrollBottom();
}

function onAgentEnd(data) {
  $("#loading-indicator").classList.add("hidden");
  $("#btn-abort").classList.add("hidden");
  if (assistantEl) removeStreamingDots(assistantEl);
  assistantEl = null;
  currentTextEl = null;
  thinkingEl = null;
  toolBlocks.clear();
  activeToolCallId = null;
  pendingToolCalls.clear();

  // Schedule a delayed refresh — Pi needs time to finalize token counters after agent_end.
  // Immediate queries can return all-zeros, causing the header display to flash to 0.
  scheduleTokenRefresh();
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
        showStreamingDots(assistantEl);
      }
      if (!currentTextEl) {
        currentTextEl = document.createElement("div");
        currentTextEl.className = "assistant-text";
        assistantEl.appendChild(currentTextEl);
        moveStreamingDotsToEnd(assistantEl);
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
          moveStreamingDotsToEnd(assistantEl);
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
        moveStreamingDotsToEnd(assistantEl);
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
  moveStreamingDotsToEnd(assistantEl);
}

// ── Tool execution ────────────────────────────────────────────────────

function onToolExecutionStart(evt) {
  if (!evt) return;
  $("#loading-indicator").classList.add("hidden");

  if (!assistantEl) {
    const msg = createMessage("assistant", null);
    assistantEl = msg.bubble;
    showStreamingDots(assistantEl);
  }

  const toolCallId = evt.toolCallId || `tc_${Date.now()}`;
  const toolName = evt.toolName || evt.name || "tool";
  const argsStr = evt.args ? (typeof evt.args === "string" ? evt.args : JSON.stringify(evt.args, null, 2)) : "";

  // If a placeholder already exists from toolcall_end, replace it
  if (toolBlocks.has(toolCallId)) {
    return; // Already rendered, keep collapsed
  }

  const block = buildToolBlock(toolName, argsStr, undefined, "running", false);
  assistantEl.appendChild(block);
  moveStreamingDotsToEnd(assistantEl);

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
    moveStreamingDotsToEnd(assistantEl);
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
  const disconnectBtn = $("#btn-disconnect");
  const newSessionBtn = $("#btn-new-session");

  // ── Send message ──
  async function sendMessage() {
    const text = input.value.trim();
    if (!text && pendingImages.length === 0) return;

    const images = [...pendingImages];
    createMessage("user", text ? escapeHtml(text) : null, images);
    await client.prompt(text || "Please analyze these images", images);

    // Clear
    input.value = "";
    input.style.height = "auto";
    pendingImages = [];
    clearImagePreviews();
  }

  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── Paste images from clipboard ──
  input.addEventListener("paste", async (e) => {
    try {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;

      e.preventDefault(); // Don't paste raw clipboard data as text

      const images = await Promise.all(imageFiles.map(fileToImageContent));
      pendingImages = [...pendingImages, ...images];
      showImagePreviews(pendingImages);
    } catch (err) {
      console.error("[paste] failed to process image:", err);
    }
  });

  // ── Drag-and-drop images onto input area ──
  const inputArea = $("#input-area");

  ["dragenter", "dragover"].forEach((evt) => {
    inputArea.addEventListener(evt, (e) => {
      e.preventDefault();
      inputArea.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    inputArea.addEventListener(evt, (e) => {
      e.preventDefault();
      inputArea.classList.remove("drag-over");
    });
  });

  inputArea.addEventListener("drop", async (e) => {
    try {
      const files = [...(e.dataTransfer?.files || [])];
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;

      const images = await Promise.all(imageFiles.map(fileToImageContent));
      pendingImages = [...pendingImages, ...images];
      showImagePreviews(pendingImages);
    } catch (err) {
      console.error("[drop] failed to process image:", err);
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

  // ── Disconnect (return to session selection screen) ──
  disconnectBtn.addEventListener("click", () => {
    client.disconnect();
    clearChatState();
    showSessionScreen();
    loadSessions();
  });

  // ── New session from selection screen ──
  newSessionBtn.addEventListener("click", async () => {
    await client.connectAgent(""); // empty = new session
    showChatScreen();
    $("#messages").innerHTML = "";
    addSystemMessage("New session started");
    clearChatState();

    // Load message history, token info, and check model capabilities
    setTimeout(() => {
      loadMessageHistory();
      updateTokenInfo();
      checkModelImageSupport();
    }, 500);
  });

  // ── Load sessions on startup ──
  showSessionScreen();
  loadSessions();

  // ── Scroll on load ──
  scrollBottom();
});

function clearChatState() {
  assistantEl = null;
  thinkingEl = null;
  toolBlocks.clear();
  activeToolCallId = null;
  pendingToolCalls.clear();
  pendingImages = [];
  clearImagePreviews();
}

// ── Token info display ────────────────────────────────────────────────

let lastTokenRefresh = 0;
const TOKEN_REFRESH_INTERVAL = 3000; // ms between refreshes during streaming
let tokenUpdateTimer = null;        // Debounce timer for post-agent-end updates
let cachedTokens = { input: null, output: null, contextWindow: null, percent: null };

/** Format token count with K/M suffix. */
function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Check whether the fetched stats are clearly invalid (all zeros where we expect real values). */
function isTokenStatsStale(tokens, ctx) {
  const inputIsZero = tokens.input === 0 && cachedTokens.input != null;
  const outputIsZero = tokens.output === 0 && cachedTokens.output != null;
  const ctxIsMissing = (ctx.contextWindow == null) && cachedTokens.contextWindow != null;
  return (inputIsZero || outputIsZero || ctxIsMissing);
}

/** Render the token info HTML and set it on the header element. */
function renderTokenInfo(tokens, ctx) {
  const el = $("#token-info");
  el.classList.remove("hidden");

  // Build segments: IN / OUT + context usage bar
  let html = `<span class="token-segment">IN: ${fmtTokens(tokens.input)}</span>`;
  html += `<span class="token-segment">OUT: ${fmtTokens(tokens.output)}</span>`;

  if (ctx.contextWindow != null) {
    const pct = ctx.percent != null ? Math.round(ctx.percent) : 0;
    const total = fmtTokens(ctx.contextWindow);
    let barColor = "var(--success)";
    if (pct >= 85) barColor = "var(--danger)";
    else if (pct >= 70) barColor = "#cc963a"; // amber

    html += `<span class="token-segment">${pct}%/${total}
      <span class="token-bar"><span class="token-bar-fill" style="width:${pct}%;background:${barColor}"></span></span>
    </span>`;
  }

  el.innerHTML = html;
}

/** Fetch session stats and update the token info display in the header. */
async function updateTokenInfo() {
  const now = Date.now();
  if (now - lastTokenRefresh < TOKEN_REFRESH_INTERVAL) return;
  lastTokenRefresh = now;

  try {
    const result = await client.getSessionStats();
    if (!result) return;

    // Support nested data shapes from Pi RPC
    const data = result?.data || result;
    const tokens = data.tokens || {};
    const ctx = data.contextUsage || {};

    // Guard against stale zero-values: if we have real cached values and the new
    // query returns all zeros, skip this update. This happens when updateTokenInfo()
    // fires right after agent_end before Pi has finalized its token counters.
    if (isTokenStatsStale(tokens, ctx)) {
      console.log("[token] stats appear stale (all zeros), skipping update");
      return;
    }

    // Cache valid values so future stale checks work correctly
    cachedTokens.input = tokens.input ?? cachedTokens.input;
    cachedTokens.output = tokens.output ?? cachedTokens.output;
    cachedTokens.contextWindow = ctx.contextWindow ?? cachedTokens.contextWindow;
    cachedTokens.percent = ctx.percent ?? cachedTokens.percent;

    renderTokenInfo(tokens, ctx);
  } catch (err) {
    console.warn("Failed to fetch session stats:", err);
  }
}

/** Schedule a delayed token refresh after agent turns.
 *  Pi needs ~800ms after agent_end to finalize token counters internally.
 *  If the first poll still returns zeros, retry once after another delay. */
function scheduleTokenRefresh() {
  // Cancel any pending refresh
  if (tokenUpdateTimer) {
    clearTimeout(tokenUpdateTimer);
  }

  let retries = 0;
  const MAX_RETRIES = 3;
  const BASE_DELAY = 800; // ms — enough time for Pi to finalize stats

  function poll() {
    try {
      client.getSessionStats().then((result) => {
        if (!result) return;
        const data = result?.data || result;
        const tokens = data.tokens || {};
        const ctx = data.contextUsage || {};

        // If stats look valid (not all zeros when we expect real values), use them
        if (!isTokenStatsStale(tokens, ctx) || (tokens.input == null && tokens.output == null)) {
          cachedTokens.input = tokens.input ?? cachedTokens.input;
          cachedTokens.output = tokens.output ?? cachedTokens.output;
          cachedTokens.contextWindow = ctx.contextWindow ?? cachedTokens.contextWindow;
          cachedTokens.percent = ctx.percent ?? cachedTokens.percent;
          renderTokenInfo(tokens, ctx);
          tokenUpdateTimer = null;
          return;
        }

        // Stats are stale — retry once more
        retries++;
        if (retries < MAX_RETRIES) {
          tokenUpdateTimer = setTimeout(poll, BASE_DELAY * retries);
        } else {
          console.log("[token] stats still stale after retries, giving up");
          tokenUpdateTimer = null;
        }
      }).catch((err) => {
        console.warn("[token] refresh poll failed:", err);
        tokenUpdateTimer = null;
      });
    } catch (err) {
      console.warn("[token] refresh error:", err);
      tokenUpdateTimer = null;
    }
  }

  // Initial delay before first poll
  tokenUpdateTimer = setTimeout(poll, BASE_DELAY);
}

// ── Session loading ───────────────────────────────────────────────────

async function loadSessions() {
  try {
    const resp = await fetch("/api/sessions");
    if (!resp.ok) return;
    const sessions = await resp.json();
    const container = $("#session-list");
    const listContainer = $("#session-list-container");
    container.innerHTML = "";

    if (!sessions || sessions.length === 0) {
      listContainer.classList.add("hidden");
      return;
    }

    listContainer.classList.remove("hidden");

    for (const s of sessions.slice(0, 50)) { // Limit to 50 most recent
      const item = document.createElement("div");
      item.className = "session-item";
      // Use first user message excerpt as the primary label; fall back to session name
      const displayLabel = s.firstUserMessage || s.name || `Session ${s.id?.slice(0, 8) || "?"}`;
      // Show project folder basename
      const projDir = s.cwd ? s.cwd.split("/").pop() : "";
      item.innerHTML = `
        <span class="session-item-name">${escapeHtml(displayLabel)}</span>
        ${projDir ? `<span class="session-item-project">${escapeHtml(projDir)}</span>` : ``}
        <span class="session-item-meta">${timeSince(s.modTime)}</span>
      `;
      item.title = `${s.entries} entries, ${s.model || "unknown"}`;
      item.addEventListener("click", async () => {
        await client.connectAgent(s.path);
        showChatScreen();
        $("#messages").innerHTML = "";
        addSystemMessage(`Connected to session: ${s.name}`);
        clearChatState();

        // Brief pause, then load history and check model capabilities
        setTimeout(async () => {
          await loadMessageHistory();
          updateTokenInfo();
          checkModelImageSupport();
        }, 500);
      });
      container.appendChild(item);
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
/// <reference types="bun-types" />
// smtp-sink — minimal but real SMTP server (port 2525) + HTTP inspection API (port 2526).
// In-memory only (cap 200 messages, FIFO). Intended for local E2E testing of the app's
// SMTP email sender without external credentials. NOT for production use.

type StoredMessage = {
  id: string;
  from: string;
  to: string[];
  raw: string;
  receivedAt: string;
};

const SMTP_PORT = 2525;
const HTTP_PORT = 2526;
const MAX_MESSAGES = 200;

const messages: StoredMessage[] = [];
let msgCounter = 0;

// ---------------------------------------------------------------------------
// SMTP server (port 2525) — per-connection state machine
// ---------------------------------------------------------------------------

type ConnState = {
  lineBuf: string;
  inData: boolean;
  dataLines: string[];
  from: string | null;
  to: string[];
  closed: boolean;
};

const connStates = new WeakMap<object, ConnState>();

function getState(socket: object): ConnState {
  let s = connStates.get(socket);
  if (!s) {
    s = { lineBuf: "", inData: false, dataLines: [], from: null, to: [], closed: false };
    connStates.set(socket, s);
  }
  return s;
}

function reply(socket: any, text: string) {
  try {
    socket.write(text);
  } catch {
    // socket already gone — nothing to do
  }
}

function closeGracefully(socket: any) {
  try {
    socket.end();
  } catch {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

function extractAddress(arg: string): string {
  const angle = arg.match(/<([^>]*)>/);
  if (angle) return angle[1].trim();
  return arg.trim().split(/\s+/)[0] ?? "";
}

function handleCommand(socket: any, state: ConnState, line: string) {
  const sp = line.indexOf(" ");
  const verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
  const arg = sp === -1 ? "" : line.slice(sp + 1).trim();

  switch (verb) {
    case "EHLO":
      state.from = null;
      state.to = [];
      reply(socket, "250-smtp-sink\r\n250-8BITMIME\r\n250-SIZE 10485760\r\n250 OK\r\n");
      break;
    case "HELO":
      state.from = null;
      state.to = [];
      reply(socket, "250 smtp-sink\r\n");
      break;
    case "MAIL": {
      const m = arg.match(/^FROM:\s*(.*)$/i);
      if (!m) {
        reply(socket, "501 Syntax: MAIL FROM:<address>\r\n");
        break;
      }
      state.from = extractAddress(m[1]);
      state.to = []; // MAIL FROM starts a new mail transaction
      reply(socket, "250 OK\r\n");
      break;
    }
    case "RCPT": {
      const m = arg.match(/^TO:\s*(.*)$/i);
      if (!m) {
        reply(socket, "501 Syntax: RCPT TO:<address>\r\n");
        break;
      }
      state.to.push(extractAddress(m[1]));
      reply(socket, "250 OK\r\n");
      break;
    }
    case "DATA":
      state.inData = true;
      state.dataLines = [];
      reply(socket, "354 End data with <CR><LF>.<CR><LF>\r\n");
      break;
    case "RSET":
      state.from = null;
      state.to = [];
      state.inData = false;
      state.dataLines = [];
      reply(socket, "250 OK\r\n");
      break;
    case "NOOP":
      reply(socket, "250 OK\r\n");
      break;
    case "QUIT":
      state.closed = true;
      reply(socket, "221 Bye\r\n");
      closeGracefully(socket);
      break;
    default:
      reply(socket, "500 Unknown command\r\n");
  }
}

function handleLine(socket: any, state: ConnState, line: string) {
  if (state.inData) {
    if (line === ".") {
      // End of data — store the message (FIFO cap) and reset the transaction.
      const msg: StoredMessage = {
        id: `msg-${++msgCounter}`,
        from: state.from ?? "",
        to: [...state.to],
        raw: state.dataLines.join("\r\n"),
        receivedAt: new Date().toISOString(),
      };
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) messages.shift();
      state.inData = false;
      state.dataLines = [];
      state.from = null;
      state.to = [];
      reply(socket, `250 OK: queued as ${msg.id}\r\n`);
    } else {
      // SMTP dot-stuffing: a line starting with ".." un-stuffs to ".".
      state.dataLines.push(line.startsWith("..") ? line.slice(1) : line);
    }
    return;
  }
  handleCommand(socket, state, line);
}

const decoder = new TextDecoder();

function onData(socket: any, chunk: Uint8Array) {
  const state = getState(socket);
  state.lineBuf += decoder.decode(chunk);
  // Extract complete lines (tolerate CRLF / bare LF / bare CR).
  for (;;) {
    const m = state.lineBuf.match(/^([^\r\n]*)(\r\n|\n|\r)/);
    if (!m) break;
    const line = m[1];
    state.lineBuf = state.lineBuf.slice(m[0].length);
    handleLine(socket, state, line);
    if (state.closed) break;
  }
}

Bun.listen({
  hostname: "0.0.0.0",
  port: SMTP_PORT,
  socket: {
    open(socket) {
      getState(socket);
      reply(socket, "220 smtp-sink ESMTP ready\r\n");
    },
    data(socket, chunk) {
      onData(socket, chunk);
    },
    close(socket) {
      connStates.delete(socket);
    },
    error(socket, err) {
      console.error("[smtp-sink] socket error:", err?.message ?? err);
      closeGracefully(socket);
    },
  },
});

// ---------------------------------------------------------------------------
// HTTP inspection API (port 2526)
// ---------------------------------------------------------------------------

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Best-effort Subject extraction from the raw message headers (handles folding).
function extractSubject(raw: string): string | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const m = headerBlock.match(/(?:^|\r?\n)Subject:([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/i);
  if (!m) return null;
  return m[1].replace(/\r?\n[ \t]+/g, " ").trim();
}

Bun.serve({
  hostname: "0.0.0.0",
  port: HTTP_PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return json({ ok: true });
    }
    if (req.method === "GET" && path === "/messages") {
      return json({
        count: messages.length,
        messages: messages.map((m) => ({ ...m, subject: extractSubject(m.raw) })),
      });
    }
    if (req.method === "POST" && path === "/clear") {
      messages.length = 0;
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(`[smtp-sink] SMTP listening on :${SMTP_PORT} | HTTP listening on :${HTTP_PORT}`);

// Make this file an ES module so top-level declarations stay file-scoped.
export {};

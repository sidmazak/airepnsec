// SMTP round-trip smoke client for smtp-sink — real raw-socket SMTP conversation.
// Usage: bun mini-services/smtp-sink/smoke-client.ts
import net from "node:net";

const sock = net.connect(2525, "127.0.0.1");
sock.setEncoding("utf8");

let buf = "";
let pending: ((reply: string) => void) | null = null;

sock.on("data", (chunk: string) => {
  buf += chunk;
  tryFeed();
});

function tryFeed() {
  if (!pending) return;
  let idx = 0;
  let reply = "";
  for (;;) {
    const nl = buf.indexOf("\r\n", idx);
    if (nl === -1) return; // incomplete line yet
    const line = buf.slice(idx, nl + 2);
    reply += line;
    idx = nl + 2;
    // Final line of an SMTP reply: "NNN <text>" or bare "NNN"
    if (/^\d{3}([ ]|$)/.test(line)) {
      buf = buf.slice(idx);
      const p = pending;
      pending = null;
      p(reply);
      return;
    }
  }
}

function readReply(): Promise<string> {
  return new Promise((res) => {
    pending = res;
    tryFeed();
  });
}

function send(cmd: string) {
  sock.write(cmd + "\r\n");
}

const t = setTimeout(() => {
  console.error("SMOKE TIMEOUT");
  process.exit(1);
}, 8000);

async function main() {
  console.log("S:", (await readReply()).trim()); // 220 greeting
  send("EHLO tester.local");
  console.log("S:", JSON.stringify((await readReply()).trim())); // multiline 250
  send("MAIL FROM:<sender@test.local>");
  console.log("S:", (await readReply()).trim()); // 250 OK
  send("RCPT TO:<alice@test.local>");
  console.log("S:", (await readReply()).trim()); // 250 OK
  send("RCPT TO:<bob@test.local>");
  console.log("S:", (await readReply()).trim()); // 250 OK
  send("NOOP");
  console.log("S:", (await readReply()).trim()); // 250 OK
  send("DATA");
  console.log("S:", (await readReply()).trim()); // 354
  const msg = [
    "From: Sender <sender@test.local>",
    "To: alice@test.local, bob@test.local",
    "Subject: Sink smoke test 42",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello from the smoke client.",
    "..this line started with a dot and must be unstuffed to a single dot",
    ".",
  ].join("\r\n");
  sock.write(msg + "\r\n");
  console.log("S:", (await readReply()).trim()); // 250 OK: queued as msg-N
  send("QUIT");
  console.log("S:", (await readReply()).trim()); // 221 Bye
  sock.end();
  clearTimeout(t);
  setTimeout(() => process.exit(0), 150);
}

main();

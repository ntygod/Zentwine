/** Fixed test-only peers. Never executes supplied code, shell commands or repository files. */
import { createServer } from "node:http";
import { once } from "node:events";
import { handoffFixture, handoffHash, handoffId } from "./runtime-handoff-data.mjs";

const mode = process.argv[2];
if (mode === "producer") {
  const scenario = process.argv[3];
  const data = handoffFixture();
  if (scenario === "no_success") data.events.pop();
  if (scenario === "wrong_manifest")
    data.events[2].payload.manifest_id = handoffId(999);
  const actual = data.bytes.slice();
  if (scenario === "corrupt") actual[0] ^= 1;
  let byteRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const event of data.events) response.write(JSON.stringify(event) + "\n");
      response.end();
    } else if (request.url === "/manifest") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data.manifest));
    } else if (request.url === "/artifact") {
      byteRequests++;
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(actual.subarray(0, 7));
      response.end(actual.subarray(7));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.send({ port: server.address().port, pid: process.pid });
  process.on("message", (message) => {
    if (message === "stats") process.send({ byteRequests });
  });
} else if (mode === "consumer") {
  process.once("message", (message) => {
    try {
      if (!Array.isArray(message.bytes) || message.bytes.length > 1024)
        throw new Error("Invalid fixed peer bytes");
      const bytes = Uint8Array.from(message.bytes);
      const digest = handoffHash(bytes);
      if (digest !== message.expected_sha256) throw new Error("Peer integrity mismatch");
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!Array.isArray(parsed.values) || parsed.values.length !== 3)
        throw new Error("Invalid fixed peer input");
      const total = parsed.values.reduce((sum, value) => sum + value, 0);
      if (total !== parsed.total) throw new Error("Peer computation mismatch");
      process.send({ pid: process.pid, consumed_sha256: digest, total, count: parsed.values.length });
      setImmediate(() => process.disconnect());
    } catch {
      process.exitCode = 1;
      setImmediate(() => process.disconnect());
    }
  });
} else {
  throw new Error("Fixed handoff peer mode required");
}

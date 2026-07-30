#!/usr/bin/env node
/**
 * Smoke-test MCP transports: stdio, local HTTP, docker HTTP.
 * Loads credentials from .env via dotenv (no secrets on the command line).
 *
 * Usage:
 *   node scripts/smoke-transports.mjs stdio
 *   node scripts/smoke-transports.mjs http http://127.0.0.1:8001/mcp
 *   node scripts/smoke-transports.mjs http http://127.0.0.1:7000/mcp
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env") });

const mode = process.argv[2] || "stdio";
const httpUrl = process.argv[3] || "http://127.0.0.1:8001/mcp";

const username = process.env.ADO_MCP_USERNAME;
const password = process.env.ADO_MCP_PASSWORD;
const serverUrl = (process.env.AZURE_DEVOPS_SERVER_URL || "").replace(/\/+$/, "");

if (!username || !password) {
  console.error("FAIL: ADO_MCP_USERNAME / ADO_MCP_PASSWORD missing in .env");
  process.exit(1);
}
if (!serverUrl) {
  console.error("FAIL: AZURE_DEVOPS_SERVER_URL missing in .env");
  process.exit(1);
}

const authHeaders = {
  "X-ADO-MCP-Username": username,
  "X-ADO-MCP-Password": password,
};

function parseJsonRpcLines(text) {
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON lines (logs)
    }
  }
  return results;
}

async function testHttp(url) {
  console.log(`\n=== HTTP smoke: ${url} ===`);

  const healthUrl = url.replace(/\/mcp\/?$/, "/health");
  const health = await fetch(healthUrl);
  const healthBody = await health.text();
  console.log(`health: ${health.status} ${healthBody}`);
  if (!health.ok) throw new Error(`health check failed: ${health.status}`);

  const initRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.1.0" },
      },
    }),
  });

  const sessionId = initRes.headers.get("mcp-session-id");
  const initText = await initRes.text();
  console.log(`initialize: ${initRes.status} session=${sessionId || "(none)"}`);
  if (!initRes.ok) throw new Error(`initialize failed: ${initText}`);

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...authHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  const callRes = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "core_list_collections",
        arguments: { top: 5 },
      },
    }),
  });

  const callText = await callRes.text();
  console.log(`tools/call core_list_collections: ${callRes.status}`);
  if (!callRes.ok) throw new Error(`tools/call failed: ${callText}`);

  let payload = callText;
  if (callText.includes("data:")) {
    const dataLines = callText
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    payload = dataLines.join("\n");
  }

  const parsed = JSON.parse(payload.includes("\n") ? dataLinesLastJson(callText) : payload);
  if (parsed.error) throw new Error(`tool error: ${JSON.stringify(parsed.error)}`);

  const text = parsed.result?.content?.[0]?.text || JSON.stringify(parsed.result);
  const preview = text.length > 400 ? text.slice(0, 400) + "..." : text;
  console.log(`result preview:\n${preview}`);
  console.log("HTTP PASS");
}

function dataLinesLastJson(sseText) {
  const dataLines = sseText
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  return dataLines[dataLines.length - 1];
}

async function testStdio() {
  console.log("\n=== STDIO smoke ===");

  const child = spawn(process.execPath, [resolve(root, "dist/index.js"), "_", "-a", "ntlm", "--server-url", serverUrl, "--transport", "stdio"], {
    cwd: root,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const send = (msg) => {
    child.stdin.write(JSON.stringify(msg) + "\n");
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test-stdio", version: "0.1.0" },
    },
  });

  await waitFor(() => parseJsonRpcLines(stdout).some((m) => m.id === 1), 15000, "initialize response");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "core_list_collections", arguments: { top: 5 } },
  });

  await waitFor(() => parseJsonRpcLines(stdout).some((m) => m.id === 2), 30000, "tools/call response");

  const messages = parseJsonRpcLines(stdout);
  const initMsg = messages.find((m) => m.id === 1);
  const callMsg = messages.find((m) => m.id === 2);

  if (!initMsg?.result) throw new Error(`initialize failed: ${JSON.stringify(initMsg)}`);
  if (callMsg?.error) throw new Error(`tools/call error: ${JSON.stringify(callMsg.error)}`);

  const text = callMsg.result?.content?.[0]?.text || JSON.stringify(callMsg.result);
  const preview = text.length > 400 ? text.slice(0, 400) + "..." : text;
  console.log(`initialize server: ${initMsg.result.serverInfo?.name || "ok"}`);
  console.log(`result preview:\n${preview}`);
  if (stderr.trim()) console.log(`stderr (truncated):\n${stderr.slice(0, 300)}`);

  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));
  console.log("STDIO PASS");
}

function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

try {
  if (mode === "stdio") {
    await testStdio();
  } else if (mode === "http") {
    await testHttp(httpUrl);
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`FAIL (${mode}):`, error instanceof Error ? error.message : error);
  process.exit(1);
}

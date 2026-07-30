// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Custom/on-prem CLI options. Do not redefine Microsoft options (domains, authentication, tenant).
 * Authentication "ntlm" is added via a one-line choices edit in src/index.ts.
 */
import type { Argv } from "yargs";

export function applyCustomCliOptions<T>(yargsInstance: Argv<T>): Argv<T> {
  return yargsInstance
    .option("server-url", {
      alias: "u",
      describe: "Azure DevOps server URL, defaults to https://dev.azure.com/{organization}.",
      type: "string",
    })
    .option("transport", {
      alias: "T",
      describe: "Transport mode: stdio for local clients (Cursor), http for remote hosting (Copilot Studio).",
      type: "string",
      choices: ["stdio", "http"],
      default: "stdio",
    })
    .option("port", {
      alias: "p",
      describe: "HTTP port when using --transport http.",
      type: "number",
      default: 8000,
    })
    .option("https-port", {
      describe: "HTTPS port when using --transport http with --tls-cert and --tls-key.",
      type: "number",
      default: 8080,
    })
    .option("tls-cert", {
      describe: "TLS certificate file path for the HTTPS listener.",
      type: "string",
    })
    .option("tls-key", {
      describe: "TLS private key file path for the HTTPS listener.",
      type: "string",
    })
    .option("host", {
      describe: "HTTP bind address when using --transport http. Use 0.0.0.0 for remote access.",
      type: "string",
      default: "127.0.0.1",
    })
    .option("path", {
      describe: "HTTP MCP endpoint path when using --transport http.",
      type: "string",
      default: "/mcp",
    })
    .option("allowed-hosts", {
      describe: "Comma-separated Host header allowlist for DNS rebinding protection (recommended with --host 0.0.0.0).",
      type: "string",
    })
    .option("http-stateless", {
      describe: "Use stateless HTTP mode (POST only, one server per request). Simpler for load-balanced deployments.",
      type: "boolean",
      default: false,
    }) as Argv<T>;
}

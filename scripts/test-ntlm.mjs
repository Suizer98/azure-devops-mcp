#!/usr/bin/env node
/**
 * Manual NTLM auth test for Azure DevOps Server.
 *
 * Usage:
 *   npm run build
 *   node scripts/test-ntlm.mjs
 *
 * Credentials (pick one):
 *   1. Set ADO_MCP_USERNAME and ADO_MCP_PASSWORD in the environment
 *   2. Or leave unset — script reads them from ~/.cursor/mcp.json (ado server env)
 *
 * Optional env:
 *   ADO_ORG_URL       default: https://devops.esrisa.com/PUB
 *   MCP_CONFIG_PATH   default: %USERPROFILE%\.cursor\mcp.json
 *   ADO_MCP_TOP       max projects to fetch (default: 100)
 */

import { readFileSync, existsSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { NtlmClient } from "@node-ntlm/axios";
import { WebApi } from "azure-devops-node-api";
import {
  installNtlmFetchInterceptor,
  readNtlmCredentialsFromEnvironment,
  createNtlmAuthHandler,
  parseDomainUsername,
} from "../dist/ntlm-auth.js";

const orgUrl = process.env.ADO_ORG_URL ?? "https://devops.esrisa.com/PUB";
const projectTop = Number(process.env.ADO_MCP_TOP ?? "100");

function loadMcpEnv() {
  if (process.env.ADO_MCP_USERNAME && process.env.ADO_MCP_PASSWORD) {
    return;
  }

  const mcpConfigPath = process.env.MCP_CONFIG_PATH ?? join(process.env.USERPROFILE ?? "", ".cursor", "mcp.json");
  if (!existsSync(mcpConfigPath)) {
    console.error("Set ADO_MCP_USERNAME and ADO_MCP_PASSWORD, or provide", mcpConfigPath);
    process.exit(1);
  }

  const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const adoEnv = mcpConfig.mcpServers?.ado?.env;
  if (!adoEnv) {
    console.error("ado MCP env not found in", mcpConfigPath);
    process.exit(1);
  }

  for (const [key, value] of Object.entries(adoEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  console.log("Loaded credentials from", mcpConfigPath);
}

function maskUsername(value) {
  const { domain, username } = parseDomainUsername(value);
  return domain ? `${domain}\\${username}` : username;
}

async function probeAuthHeader() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${orgUrl}/_apis/projects?api-version=7.0&$top=1`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        headers: { Accept: "application/json" },
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode,
          wwwAuthenticate: res.headers["www-authenticate"],
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function testAxiosNtlm(credentials) {
  const client = NtlmClient(
    {
      username: credentials.username,
      password: credentials.password,
      domain: credentials.domain ?? "",
      workstation: credentials.workstation ?? "",
    },
    { timeout: 30_000 }
  );

  const url = `${orgUrl}/_apis/projects?api-version=7.0&$top=3`;
  const response = await client.get(url, { headers: { Accept: "application/json" } });
  const projects = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

  return {
    status: response.status,
    projects: (projects.value ?? []).map((p) => ({ id: p.id, name: p.name })),
  };
}

async function testSdkNtlm(credentials) {
  installNtlmFetchInterceptor(credentials);

  const connection = new WebApi(orgUrl, createNtlmAuthHandler(credentials), undefined, {
    productName: "AzureDevOps.MCP.Test",
    productVersion: "test",
    userAgent: "ntlm-test",
  });

  const coreApi = await connection.getCoreApi();
  const projects = await coreApi.getProjects("wellFormed", projectTop, 0, undefined, false);

  return (projects ?? []).map((p) => ({ id: p.id, name: p.name }));
}

async function main() {
  loadMcpEnv();

  const credentials = readNtlmCredentialsFromEnvironment();
  const usernameRaw = process.env.ADO_MCP_USERNAME?.trim() ?? "";

  console.log("Org URL:", orgUrl);
  console.log("User:", maskUsername(usernameRaw));
  console.log();

  console.log("1) Unauthenticated probe");
  const probe = await probeAuthHeader();
  console.log(JSON.stringify(probe, null, 2));
  console.log();

  console.log("2) Direct axios NTLM (top 3)");
  const axiosResult = await testAxiosNtlm(credentials);
  console.log(JSON.stringify(axiosResult, null, 2));
  console.log();

  console.log(`3) SDK WebApi NTLM (top ${projectTop})`);
  const sdkProjects = await testSdkNtlm(credentials);
  console.log(`Success: ${sdkProjects.length} project(s)`);
  console.log(JSON.stringify(sdkProjects, null, 2));
}

main().catch((error) => {
  console.error("Failed:", error?.message ?? error);
  if (error?.response) {
    console.error("Response status:", error.response.status);
    console.error("Response headers:", error.response.headers);
  }
  process.exit(1);
});

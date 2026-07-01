// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AsyncLocalStorage } from "node:async_hooks";

import type { NtlmCredentials } from "./ntlm-auth.js";
import { parseDomainUsername } from "./ntlm-auth.js";

const ntlmCredentialsStorage = new AsyncLocalStorage<NtlmCredentials>();

export function runWithNtlmCredentials<T>(credentials: NtlmCredentials, fn: () => T): T {
  return ntlmCredentialsStorage.run(credentials, fn);
}

export function runWithNtlmCredentialsAsync<T>(credentials: NtlmCredentials, fn: () => Promise<T>): Promise<T> {
  return ntlmCredentialsStorage.run(credentials, fn);
}

export function getCurrentNtlmCredentials(): NtlmCredentials | undefined {
  return ntlmCredentialsStorage.getStore();
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getCredentialHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  return getHeaderValue(headers, `x-${name}`) ?? getHeaderValue(headers, name);
}

export function readNtlmCredentialsFromHeaders(headers: Record<string, string | string[] | undefined>): NtlmCredentials {
  const usernameRaw = getCredentialHeader(headers, "ado-mcp-username")?.trim();
  const password = getCredentialHeader(headers, "ado-mcp-password");

  if (!usernameRaw) {
    throw new Error('HTTP NTLM auth requires X-ADO-MCP-Username header (for example ESRISA\\your.user). Set it in Cursor mcp.json "headers".');
  }
  if (!password) {
    throw new Error('HTTP NTLM auth requires X-ADO-MCP-Password header. Set it in Cursor mcp.json "headers".');
  }

  const { domain, username } = parseDomainUsername(usernameRaw);
  if (!username) {
    throw new Error("HTTP NTLM auth requires a valid username in X-ADO-MCP-Username.");
  }

  return {
    domain,
    username,
    password,
    workstation: getCredentialHeader(headers, "ado-mcp-workstation")?.trim() ?? "",
  };
}

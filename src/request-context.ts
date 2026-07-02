// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AsyncLocalStorage } from "node:async_hooks";

import type { NtlmCredentials } from "./ntlm-auth.js";
import { parseDomainUsername } from "./ntlm-auth.js";
import { buildCollectionUrl } from "./utils.js";

export interface RequestScope {
  credentials?: NtlmCredentials;
  collection?: string;
  sessionId?: string;
}

const requestScopeStorage = new AsyncLocalStorage<RequestScope>();
const sessionCollections = new Map<string, string>();
let stdioCollection = "";

let defaultCollection = "";
let serverBaseUrl = "";

export function initializeOrganizationSettings(settings: { defaultCollection: string; serverBaseUrl: string }): void {
  defaultCollection = settings.defaultCollection;
  serverBaseUrl = settings.serverBaseUrl;
}

export function runWithRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return requestScopeStorage.run(scope, fn);
}

export function runWithRequestScopeAsync<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T> {
  return requestScopeStorage.run(scope, fn);
}

export function getCurrentNtlmCredentials(): NtlmCredentials | undefined {
  return requestScopeStorage.getStore()?.credentials;
}

export function getCurrentCollection(): string {
  const scope = requestScopeStorage.getStore();
  const fromHeader = scope?.collection?.trim();
  if (fromHeader) {
    return fromHeader;
  }
  if (scope?.sessionId) {
    const fromSession = sessionCollections.get(scope.sessionId)?.trim();
    if (fromSession) {
      return fromSession;
    }
  }
  if (stdioCollection) {
    return stdioCollection;
  }
  const fromEnv = process.env.ADO_MCP_COLLECTION?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return defaultCollection;
}

export function setSessionCollection(collection: string): void {
  const scope = requestScopeStorage.getStore();
  const name = collection.trim();
  if (scope?.sessionId) {
    sessionCollections.set(scope.sessionId, name);
    return;
  }
  stdioCollection = name;
}

export function clearSessionCollection(sessionId: string): void {
  sessionCollections.delete(sessionId);
}

export function getConnectionUrl(): string {
  const collection = getCurrentCollection();
  if (collection) {
    return buildCollectionUrl(serverBaseUrl, collection);
  }
  return serverBaseUrl;
}

export function getOrganizationUrl(): string {
  const collection = getCurrentCollection();
  if (!collection) {
    throw new Error("No collection selected. Call core_list_collections (with a filter) or core_set_collection first.");
  }
  return buildCollectionUrl(serverBaseUrl, collection);
}

export function getOrganizationName(): string {
  return getCurrentCollection();
}

export function getServerBaseUrl(): string {
  return serverBaseUrl;
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

export function readRequestScopeFromHeaders(headers: Record<string, string | string[] | undefined>): RequestScope {
  const usernameRaw = getCredentialHeader(headers, "ado-mcp-username")?.trim();
  const password = getCredentialHeader(headers, "ado-mcp-password");
  const collection = getCredentialHeader(headers, "ado-mcp-collection")?.trim();

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
    collection,
    credentials: {
      domain,
      username,
      password,
      workstation: getCredentialHeader(headers, "ado-mcp-workstation")?.trim() ?? "",
    },
  };
}

export function runWithNtlmCredentials<T>(credentials: NtlmCredentials, fn: () => T): T {
  return runWithRequestScope({ credentials }, fn);
}

export function runWithNtlmCredentialsAsync<T>(credentials: NtlmCredentials, fn: () => Promise<T>): Promise<T> {
  return runWithRequestScopeAsync({ credentials }, fn);
}

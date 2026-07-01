// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import http from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { Url } from "node:url";
import type { AxiosInstance, AxiosResponse } from "axios";
import { NtlmClient } from "@node-ntlm/axios";
import { logger } from "./logger.js";

export interface NtlmCredentials {
  domain: string;
  username: string;
  password: string;
  workstation: string;
}

type NtlmRequestInfo = {
  options: RequestOptions;
  parsedUrl: Url;
  httpModule: typeof http | typeof import("node:https");
};

type NtlmHttpClientResponse = {
  message: IncomingMessage;
  readBody(): Promise<string>;
};

type NtlmRequestHandler = {
  prepareRequest(options: RequestOptions): void;
  canHandleAuthentication(response: NtlmHttpClientResponse): boolean;
  handleAuthentication(httpClient: unknown, requestInfo: NtlmRequestInfo, data: string | NodeJS.ReadableStream): Promise<NtlmHttpClientResponse>;
};

const NTLM_REQUEST_TIMEOUT_MS = 30_000;

let sharedNtlmAxiosClient: AxiosInstance | undefined;

export function parseDomainUsername(value: string): { domain: string; username: string } {
  const slashIndex = value.indexOf("\\");
  if (slashIndex === -1) {
    const domain = process.env["ADO_MCP_DOMAIN"]?.trim() ?? "";
    return { domain, username: value };
  }

  return {
    domain: value.slice(0, slashIndex),
    username: value.slice(slashIndex + 1),
  };
}

export function readNtlmCredentialsFromEnvironment(): NtlmCredentials {
  const usernameRaw = process.env["ADO_MCP_USERNAME"]?.trim();
  const password = process.env["ADO_MCP_PASSWORD"];

  if (!usernameRaw) {
    throw new Error("NTLM auth requires ADO_MCP_USERNAME (for example DOMAIN\\your.user). Set it in the environment or in a .env file (see .env.sample).");
  }
  if (!password) {
    throw new Error("NTLM auth requires ADO_MCP_PASSWORD with your domain password. Set it in the environment or in a .env file (see .env.sample).");
  }

  const { domain, username } = parseDomainUsername(usernameRaw);
  if (!username) {
    throw new Error("NTLM auth requires a valid username in ADO_MCP_USERNAME.");
  }

  return {
    domain,
    username,
    password,
    workstation: process.env["ADO_MCP_WORKSTATION"]?.trim() ?? "",
  };
}

function createNtlmAxiosClient(credentials: NtlmCredentials): AxiosInstance {
  return NtlmClient(
    {
      username: credentials.username,
      password: credentials.password,
      domain: credentials.domain ?? "",
      workstation: credentials.workstation ?? "",
    },
    {
      timeout: NTLM_REQUEST_TIMEOUT_MS,
    }
  );
}

function getNtlmAxiosClient(credentials: NtlmCredentials): AxiosInstance {
  if (!sharedNtlmAxiosClient) {
    sharedNtlmAxiosClient = createNtlmAxiosClient(credentials);
  }
  return sharedNtlmAxiosClient;
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) {
    return record;
  }

  const headerBag = new Headers(headers);
  headerBag.forEach((value, key) => {
    if (key.toLowerCase() !== "authorization") {
      record[key] = value;
    }
  });

  return record;
}

function shouldUseNtlmFetch(url: string): boolean {
  return url.includes("_apis/") || url.includes("devops") || url.includes("visualstudio.com");
}

function axiosHeadersToFetchHeaders(headers: AxiosResponse["headers"]): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return result;
}

function requestInfoToUrl(requestInfo: NtlmRequestInfo): string {
  const isHttps = requestInfo.httpModule !== http;
  const protocol = isHttps ? "https" : "http";
  const hostname = requestInfo.parsedUrl.hostname ?? requestInfo.options.hostname ?? "";
  const port = requestInfo.parsedUrl.port ?? (requestInfo.options.port ? String(requestInfo.options.port) : "");
  const defaultPort = isHttps ? "443" : "80";
  const hostWithPort = port && port !== defaultPort ? `${hostname}:${port}` : hostname;
  const path = requestInfo.parsedUrl.path ?? requestInfo.options.path ?? "/";
  return `${protocol}://${hostWithPort}${path}`;
}

function createHttpClientResponse(response: AxiosResponse<string>): NtlmHttpClientResponse {
  const message = {
    statusCode: response.status,
    statusMessage: response.statusText,
    headers: response.headers as Record<string, string | string[] | undefined>,
  } as http.IncomingMessage;

  const body = response.data ?? "";

  return {
    message,
    readBody: async () => body,
  };
}

class AxiosNtlmCredentialHandler implements NtlmRequestHandler {
  constructor(private client: AxiosInstance) {}

  prepareRequest(options: http.RequestOptions): void {
    if (options.agent) {
      delete options.agent;
    }
  }

  canHandleAuthentication(response: NtlmHttpClientResponse): boolean {
    if (response?.message?.statusCode === 401) {
      const wwwAuthenticate = response.message.headers["www-authenticate"];
      const authHeader = String(wwwAuthenticate ?? "").toUpperCase();
      return authHeader.includes("NTLM") || authHeader.includes("NEGOTIATE");
    }
    return false;
  }

  async handleAuthentication(httpClient: unknown, requestInfo: NtlmRequestInfo, data: string | NodeJS.ReadableStream): Promise<NtlmHttpClientResponse> {
    const url = requestInfoToUrl(requestInfo);
    const method = (requestInfo.options.method ?? "GET").toUpperCase();
    const headers = { ...(requestInfo.options.headers as Record<string, string> | undefined) };
    delete headers.Authorization;
    delete headers.authorization;

    logger.debug("NTLM SDK request", {
      method,
      url,
      transport: "@node-ntlm/axios",
    });

    try {
      const response = await this.client.request<string>({
        url,
        method,
        headers,
        data: typeof data === "string" ? data : undefined,
        responseType: "text",
      });

      logger.debug("NTLM SDK response", {
        method,
        url,
        status: response.status,
        transport: "@node-ntlm/axios",
      });

      return createHttpClientResponse(response);
    } catch (error) {
      if (typeof error === "object" && error !== null && "response" in error) {
        const axiosError = error as { response?: AxiosResponse<string> };
        if (axiosError.response) {
          logger.debug("NTLM SDK response", {
            method,
            url,
            status: axiosError.response.status,
            transport: "@node-ntlm/axios",
          });
          return createHttpClientResponse(axiosError.response);
        }
      }
      throw error;
    }
  }
}

function axiosErrorToFetchResponse(error: unknown): Response {
  if (typeof error === "object" && error !== null && "response" in error) {
    const axiosError = error as { response?: AxiosResponse<string> };
    if (axiosError.response) {
      return new Response(axiosError.response.data ?? "", {
        status: axiosError.response.status,
        headers: axiosHeadersToFetchHeaders(axiosError.response.headers),
      });
    }
  }
  throw error;
}

export function installNtlmFetchInterceptor(credentials: NtlmCredentials): void {
  const client = getNtlmAxiosClient(credentials);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveFetchUrl(input);
    if (!shouldUseNtlmFetch(url)) {
      return originalFetch(input, init);
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const additionalHeaders = headersToRecord(init?.headers);
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : undefined;

    logger.debug("NTLM HTTP request", {
      method,
      url,
      username: credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username,
      transport: "@node-ntlm/axios",
    });

    try {
      const response = await client.request<string>({
        url,
        method,
        headers: additionalHeaders,
        data: body,
        responseType: "text",
      });

      logger.debug("NTLM HTTP response", {
        method,
        url,
        status: response.status,
        transport: "@node-ntlm/axios",
      });

      return new Response(response.data, {
        status: response.status,
        headers: axiosHeadersToFetchHeaders(response.headers),
      });
    } catch (error) {
      logger.debug("NTLM HTTP request failed", {
        method,
        url,
        transport: "@node-ntlm/axios",
        error: error instanceof Error ? error.message : String(error),
      });
      return axiosErrorToFetchResponse(error);
    }
  };

  logger.debug("NTLM fetch interceptor enabled for Azure DevOps HTTP requests");
}

export function createNtlmAuthHandler(credentials: NtlmCredentials): NtlmRequestHandler {
  return new AxiosNtlmCredentialHandler(getNtlmAxiosClient(credentials));
}

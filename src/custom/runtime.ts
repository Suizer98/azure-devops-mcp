// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBearerHandler, getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";

import { startHttpTransport } from "../http-transport.js";
import { logger } from "../logger.js";
import { installNtlmFetchInterceptor, installNtlmFetchInterceptorFromContext, readNtlmCredentialsFromEnvironment, createNtlmAuthHandler, type NtlmCredentials } from "../ntlm-auth.js";
import { getCurrentNtlmCredentials, getConnectionUrl } from "../request-context.js";
import { configureAllTools } from "../tools.js";
import { UserAgentComposer } from "../useragent.js";
import { packageVersion } from "../version.js";
import { createCustomAuthenticator } from "./auth.js";
import { isAzureDevOpsServicesUrl } from "./organization.js";

function getNtlmCredentialsForRequest(): NtlmCredentials {
  const fromRequest = getCurrentNtlmCredentials();
  if (fromRequest) {
    return fromRequest;
  }
  return readNtlmCredentialsFromEnvironment();
}

export function createCustomAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer, authType: string): () => Promise<WebApi> {
  return async () => {
    const collectionUrl = getConnectionUrl();
    if (authType === "ntlm") {
      const credentials = getNtlmCredentialsForRequest();
      const authHandler = createNtlmAuthHandler(credentials);
      return new WebApi(collectionUrl, authHandler, undefined, {
        productName: "Azure DevOps.MCP",
        productVersion: packageVersion,
        userAgent: userAgentComposer.userAgent,
      });
    }

    const accessToken = await getAzureDevOpsToken();
    const authHandler = authType === "pat" ? getPersonalAccessTokenHandler(Buffer.from(accessToken, "base64").toString("utf8").split(":").slice(1).join(":")) : getBearerHandler(accessToken);
    return new WebApi(collectionUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
  };
}

export async function configureCustomAuthentication(authType: string, tenantId: string | undefined, transport: string): Promise<() => Promise<string>> {
  const authenticator = createCustomAuthenticator(authType, tenantId);

  if (authType === "ntlm") {
    if (transport === "http") {
      installNtlmFetchInterceptorFromContext(getCurrentNtlmCredentials);
      logger.info("NTLM authentication configured for HTTP transport (credentials from client headers per request)");
    } else {
      const credentials = readNtlmCredentialsFromEnvironment();
      installNtlmFetchInterceptor(credentials);
      await authenticator();
      logger.info("NTLM authentication configured", {
        username: credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username,
        ntlmImplementation: "@node-ntlm/axios",
      });
    }
  }

  if (authType === "pat") {
    const basicValue = await authenticator();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.headers) {
        const headers = new Headers(init.headers as HeadersInit);
        if (headers.get("Authorization")?.startsWith("Bearer ")) {
          headers.set("Authorization", `Basic ${basicValue}`);
          init = { ...init, headers };
        }
      }
      return originalFetch(input, init);
    };
    logger.debug("PAT mode: global fetch interceptor installed to rewrite Bearer -> Basic auth headers");
  }

  return authenticator;
}

export async function createCustomConfiguredServer(authenticator: () => Promise<string>, userAgentComposer: UserAgentComposer, authType: string, enabledDomains: Set<string>): Promise<McpServer> {
  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [
      {
        src: "https://cdn.vsassets.io/content/icons/favicon.ico",
      },
    ],
  });

  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  configureAllTools(server, authenticator, createCustomAzureDevOpsClient(authenticator, userAgentComposer, authType), () => userAgentComposer.userAgent, enabledDomains);

  return server;
}

export type CustomHttpTransportArgs = {
  host: string;
  port: number;
  httpsPort: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  path: string;
  allowedHosts?: string[];
  stateless: boolean;
  authType: string;
  organizationUrl: string;
  authenticator: () => Promise<string>;
  userAgentComposer: UserAgentComposer;
  enabledDomains: Set<string>;
};

export async function startCustomHttpTransport(args: CustomHttpTransportArgs): Promise<void> {
  if (args.authType === "ntlm" && isAzureDevOpsServicesUrl(args.organizationUrl)) {
    logger.warn("NTLM authentication is intended for Azure DevOps Server on-prem deployments", {
      organizationUrl: args.organizationUrl,
    });
  }

  if ((args.host === "0.0.0.0" || args.host === "::") && !args.allowedHosts?.length) {
    logger.warn("HTTP server binding to all interfaces without --allowed-hosts. Consider restricting allowed hosts before exposing publicly.");
  }

  await startHttpTransport({
    host: args.host,
    port: args.port,
    httpsPort: args.httpsPort,
    tlsCertPath: args.tlsCertPath,
    tlsKeyPath: args.tlsKeyPath,
    path: args.path,
    allowedHosts: args.allowedHosts,
    stateless: args.stateless,
    createServer: () => createCustomConfiguredServer(args.authenticator, args.userAgentComposer, args.authType, args.enabledDomains),
  });
}

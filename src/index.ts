#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "./env.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBearerHandler, getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createAuthenticator } from "./auth.js";
import { startHttpTransport } from "./http-transport.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
//import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";
import { resolveOrganizationConfig, isAzureDevOpsServicesUrl } from "./utils.js";
import { installNtlmFetchInterceptor, readNtlmCredentialsFromEnvironment, createNtlmAuthHandler } from "./ntlm-auth.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .scriptName("mcp-server-azuredevops")
  .usage("Usage: $0 <organization> [options]")
  .version(packageVersion)
  .command("$0 <organization> [options]", "Azure DevOps MCP Server", (yargs) => {
    yargs.positional("organization", {
      describe: "Azure DevOps organization name",
      type: "string",
      demandOption: true,
    });
  })
  .option("domains", {
    alias: "d",
    describe: "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: "Type of authentication to use",
    type: "string",
    choices: ["interactive", "azcli", "env", "envvar", "pat", "ntlm"],
    default: defaultAuthenticationType,
  })
  .option("tenant", {
    alias: "t",
    describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
    type: "string",
  })
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
  })
  .help()
  .parseSync();

const organizationConfig = resolveOrganizationConfig(argv.organization as string, argv["server-url"] as string | undefined);
export const orgName = organizationConfig.organizationName;
export const orgUrl = organizationConfig.organizationUrl;

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer, authType: string): () => Promise<WebApi> {
  return async () => {
    if (authType === "ntlm") {
      const credentials = readNtlmCredentialsFromEnvironment();
      const authHandler = createNtlmAuthHandler(credentials);
      return new WebApi(orgUrl, authHandler, undefined, {
        productName: "AzureDevOps.MCP",
        productVersion: packageVersion,
        userAgent: userAgentComposer.userAgent,
      });
    }

    const accessToken = await getAzureDevOpsToken();
    // For pat, accessToken is base64("{email}:{token}"). Decode to extract the token part,
    // since getPersonalAccessTokenHandler prepends ":" internally and just needs the raw token.
    const authHandler = authType === "pat" ? getPersonalAccessTokenHandler(Buffer.from(accessToken, "base64").toString("utf8").split(":").slice(1).join(":")) : getBearerHandler(accessToken);
    const connection = new WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

async function configureAuthentication(authType: string, tenantId: string | undefined): Promise<() => Promise<string>> {
  const authenticator = createAuthenticator(authType, tenantId);

  if (authType === "ntlm") {
    const credentials = readNtlmCredentialsFromEnvironment();
    installNtlmFetchInterceptor(credentials);
    await authenticator();
    logger.info("NTLM authentication configured", {
      username: credentials.domain ? `${credentials.domain}\\${credentials.username}` : credentials.username,
      ntlmImplementation: "@node-ntlm/axios",
    });
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

async function createConfiguredServer(authenticator: () => Promise<string>, userAgentComposer: UserAgentComposer): Promise<McpServer> {
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

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer, argv.authentication), () => userAgentComposer.userAgent, enabledDomains);

  return server;
}

async function main() {
  logger.info("Starting Azure DevOps MCP Server", {
    organization: orgName,
    organizationUrl: orgUrl,
    authentication: argv.authentication,
    tenant: argv.tenant,
    domains: argv.domains,
    enabledDomains: Array.from(enabledDomains),
    transport: argv.transport,
    version: packageVersion,
    isCodespace: isGitHubCodespaceEnv(),
    isAzureDevOpsServices: isAzureDevOpsServicesUrl(orgUrl),
  });

  if (argv.authentication === "ntlm" && isAzureDevOpsServicesUrl(orgUrl)) {
    logger.warn("NTLM authentication is intended for Azure DevOps Server on-prem deployments", {
      organizationUrl: orgUrl,
    });
  }

  const userAgentComposer = new UserAgentComposer(packageVersion);
  const tenantId = (await getOrgTenant(orgName)) ?? argv.tenant;
  const authenticator = await configureAuthentication(argv.authentication, tenantId);

  if (argv.transport === "http") {
    const allowedHosts = argv["allowed-hosts"]
      ?.split(",")
      .map((host) => host.trim())
      .filter(Boolean);

    if ((argv.host === "0.0.0.0" || argv.host === "::") && !allowedHosts?.length) {
      logger.warn("HTTP server binding to all interfaces without --allowed-hosts. Consider restricting allowed hosts before exposing publicly.");
    }

    await startHttpTransport({
      host: argv.host as string,
      port: argv.port as number,
      httpsPort: argv["https-port"] as number,
      tlsCertPath: argv["tls-cert"] as string | undefined,
      tlsKeyPath: argv["tls-key"] as string | undefined,
      path: argv.path as string,
      allowedHosts,
      stateless: argv["http-stateless"] as boolean,
      createServer: () => createConfiguredServer(authenticator, userAgentComposer),
    });
    return;
  }

  const server = await createConfiguredServer(authenticator, userAgentComposer);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});

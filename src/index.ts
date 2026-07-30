#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "./env.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";

import { applyCustomCliOptions } from "./custom/cli.js";
import { isAzureDevOpsServicesUrl, resolveOrganizationConfig } from "./custom/organization.js";
import { configureCustomAuthentication, createCustomConfiguredServer, startCustomHttpTransport } from "./custom/runtime.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
import { initializeOrganizationSettings } from "./request-context.js";
import { DomainsManager } from "./shared/domains.js";
import { UserAgentComposer } from "./useragent.js";
import { getCliArgs } from "./utils.js";
import { packageVersion } from "./version.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// Parse command line arguments using yargs
const argv = applyCustomCliOptions(
  yargs(getCliArgs())
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
      // Custom hook: add "ntlm" for on-prem Azure DevOps Server
      choices: ["interactive", "azcli", "env", "envvar", "pat", "ntlm"],
      default: defaultAuthenticationType,
    })
    .option("tenant", {
      alias: "t",
      describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
      type: "string",
    })
)
  .help()
  .parseSync();

const organizationConfig = resolveOrganizationConfig(argv.organization as string, argv["server-url"] as string | undefined);
initializeOrganizationSettings({
  defaultCollection: organizationConfig.defaultCollection,
  serverBaseUrl: organizationConfig.serverBaseUrl,
});
export const orgName = organizationConfig.organizationName;
export const orgUrl = organizationConfig.organizationUrl;

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

async function main() {
  logger.info("Starting Azure DevOps MCP Server", {
    organization: orgName,
    defaultCollection: organizationConfig.defaultCollection,
    serverBaseUrl: organizationConfig.serverBaseUrl,
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

  const userAgentComposer = new UserAgentComposer(packageVersion);
  const tenantId = argv.tenant ?? (await getOrgTenant(orgName));
  const authenticator = await configureCustomAuthentication(argv.authentication as string, tenantId, argv.transport as string);

  if (argv.transport === "http") {
    const allowedHostsRaw = argv["allowed-hosts"] as string | undefined;
    const allowedHosts = allowedHostsRaw
      ?.split(",")
      .map((host: string) => host.trim())
      .filter(Boolean);

    await startCustomHttpTransport({
      host: argv.host as string,
      port: argv.port as number,
      httpsPort: argv["https-port"] as number,
      tlsCertPath: argv["tls-cert"] as string | undefined,
      tlsKeyPath: argv["tls-key"] as string | undefined,
      path: argv.path as string,
      allowedHosts,
      stateless: argv["http-stateless"] as boolean,
      authType: argv.authentication as string,
      organizationUrl: orgUrl,
      authenticator,
      userAgentComposer,
      enabledDomains,
    });
    return;
  }

  const server = await createCustomConfiguredServer(authenticator, userAgentComposer, argv.authentication as string, enabledDomains);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});

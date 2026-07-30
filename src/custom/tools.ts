// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";

import { configureOnPremCollectionTools } from "../tools/on-prem-collections.js";

/** Register custom/on-prem-only tools. Call from Microsoft tools.ts with a one-line hook. */
export function registerCustomCoreTools(server: McpServer, connectionProvider: () => Promise<WebApi>): void {
  configureOnPremCollectionTools(server, connectionProvider);
}

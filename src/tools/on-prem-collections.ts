// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";
import { z } from "zod";

import { getCurrentCollection, getServerBaseUrl, setSessionCollection } from "../request-context.js";
import { isAzureDevOpsServicesUrl } from "../utils.js";

function configureOnPremCollectionTools(server: McpServer, connectionProvider: () => Promise<WebApi>) {
  server.tool(
    "core_set_collection",
    "Set the active Azure DevOps Server collection for this session. Other tools use this collection until changed. On-prem only.",
    {
      collection: z.string().describe("Collection name, for example EsriSingapore or PUB."),
    },
    async ({ collection }) => {
      setSessionCollection(collection);
      return { content: [{ type: "text", text: JSON.stringify({ activeCollection: getCurrentCollection() }, null, 2) }] };
    }
  );

  server.tool(
    "core_list_collections",
    "List Azure DevOps Server project collections. If collectionNameFilter matches exactly one collection, it becomes the active collection for this session. On-prem only.",
    {
      top: z.coerce.number().optional().describe("Maximum number of collections to return. Defaults to 1000."),
      collectionNameFilter: z.string().optional().describe("Filter collections by name. Supports partial matches."),
    },
    async ({ top, collectionNameFilter }) => {
      try {
        const serverBaseUrl = getServerBaseUrl();
        if (isAzureDevOpsServicesUrl(serverBaseUrl)) {
          throw new Error("Project collection discovery is for Azure DevOps Server on-prem. On Azure DevOps Services, use core_list_projects for the connected organization.");
        }

        const base = serverBaseUrl.replace(/\/+$/, "");
        const response = await (await connectionProvider()).rest.get(`${base}/_apis/projectCollections?$top=${top ?? 1000}&api-version=7.0`);

        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`Failed to list project collections: ${response.statusCode}`);
        }

        const filter = collectionNameFilter?.toLowerCase();
        const value = ((response.result as { value?: Array<{ id: string; name: string; url: string }> }).value ?? [])
          .filter((collection) => !filter || collection.name.toLowerCase().includes(filter))
          .map((collection) => ({ ...collection, collectionUrl: `${base}/${collection.name}` }));

        if (value.length === 0) {
          return { content: [{ type: "text", text: "No project collections found" }], isError: true };
        }

        let activeCollection = getCurrentCollection() || undefined;
        if (value.length === 1) {
          setSessionCollection(value[0]!.name);
          activeCollection = value[0]!.name;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: value.length, activeCollection, value }, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        return { content: [{ type: "text", text: `Error fetching project collections: ${errorMessage}` }], isError: true };
      }
    }
  );
}

export { configureOnPremCollectionTools };

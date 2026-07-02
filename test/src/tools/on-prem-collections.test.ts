// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";

const mockSetSessionCollection = jest.fn();
const mockGetCurrentCollection = jest.fn(() => "");

jest.mock("../../../src/request-context", () => ({
  getServerBaseUrl: jest.fn(() => "https://devops.esrisa.com"),
  getCurrentCollection: (...args: unknown[]) => mockGetCurrentCollection(...args),
  setSessionCollection: (...args: unknown[]) => mockSetSessionCollection(...args),
}));

jest.mock("../../../src/utils", () => ({
  isAzureDevOpsServicesUrl: jest.fn(() => false),
}));

import { configureOnPremCollectionTools } from "../../../src/tools/on-prem-collections";

describe("configureOnPremCollectionTools", () => {
  let server: McpServer;
  let mockRestGet: jest.Mock;

  beforeEach(() => {
    server = { tool: jest.fn() } as unknown as McpServer;
    mockRestGet = jest.fn().mockResolvedValue({
      statusCode: 200,
      result: { value: [{ id: "1", name: "EsriSingapore", url: "https://devops.esrisa.com/_apis/projectCollections/1" }] },
    });
    mockGetCurrentCollection.mockReturnValue("");
    jest.clearAllMocks();
  });

  it("registers collection tools", () => {
    configureOnPremCollectionTools(server, async () => ({ rest: { get: mockRestGet } }) as unknown as WebApi);
    const toolNames = (server.tool as jest.Mock).mock.calls.map(([name]) => name);
    expect(toolNames).toEqual(["core_set_collection", "core_list_collections"]);
  });

  it("auto-sets collection when filter matches one collection", async () => {
    configureOnPremCollectionTools(server, async () => ({ rest: { get: mockRestGet } }) as unknown as WebApi);
    mockGetCurrentCollection.mockReturnValueOnce("").mockReturnValueOnce("EsriSingapore");

    const handler = (server.tool as jest.Mock).mock.calls.find(([name]) => name === "core_list_collections")?.[3];
    const result = await handler({ collectionNameFilter: "EsriSingapore" });

    expect(mockSetSessionCollection).toHaveBeenCalledWith("EsriSingapore");
    expect(result.content[0].text).toContain('"activeCollection": "EsriSingapore"');
  });
});

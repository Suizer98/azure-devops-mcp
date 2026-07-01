// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";

import { logger } from "./logger.js";

export interface HttpTransportOptions {
  host: string;
  port: number;
  httpsPort: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  path: string;
  allowedHosts?: string[];
  stateless: boolean;
  createServer: () => Promise<McpServer>;
}

async function handleStatelessRequest(req: Request, res: Response, createServer: () => Promise<McpServer>): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = await createServer();

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

async function handleStatefulRequest(req: Request, res: Response, sessions: Map<string, StreamableHTTPServerTransport>, createServer: () => Promise<McpServer>): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        logger.info("MCP session initialized", { sessionId: id, activeSessions: sessions.size });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        logger.info("MCP session closed", { sessionId: transport.sessionId, activeSessions: sessions.size });
      }
    };

    const server = await createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: Session ID required" },
    id: null,
  });
}

function mountMcpRoutes(app: ReturnType<typeof createMcpExpressApp>, path: string, stateless: boolean, createServer: () => Promise<McpServer>): void {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  const handleMcpRequest = async (req: Request, res: Response) => {
    try {
      if (stateless) {
        if (req.method !== "POST") {
          res.status(405).json({ error: "Method not allowed in stateless mode" });
          return;
        }
        await handleStatelessRequest(req, res, createServer);
        return;
      }

      await handleStatefulRequest(req, res, sessions, createServer);
    } catch (error) {
      logger.error("HTTP MCP request failed", { error });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  };

  app.post(path, handleMcpRequest);
  app.get(path, handleMcpRequest);
  app.delete(path, handleMcpRequest);
}

export async function startHttpTransport(options: HttpTransportOptions): Promise<void> {
  const { host, port, httpsPort, tlsCertPath, tlsKeyPath, path, allowedHosts, stateless, createServer } = options;
  const app = createMcpExpressApp({ host, allowedHosts });
  mountMcpRoutes(app, path, stateless, createServer);

  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;

  await new Promise<void>((resolve, reject) => {
    const httpServer = createHttpServer(app);
    httpServer.listen(port, host, () => {
      logger.info("Azure DevOps MCP HTTP server listening", {
        host,
        port,
        path,
        mode: stateless ? "stateless" : "stateful",
        url: `http://${displayHost}:${port}${path}`,
        healthUrl: `http://${displayHost}:${port}/health`,
      });
      resolve();
    });
    httpServer.on("error", reject);
  });

  if (!tlsCertPath || !tlsKeyPath) {
    logger.info("HTTPS listener not started; provide --tls-cert and --tls-key to listen on the HTTPS port", {
      httpsPort,
    });
    return;
  }

  const cert = readFileSync(tlsCertPath);
  const key = readFileSync(tlsKeyPath);

  await new Promise<void>((resolve, reject) => {
    const httpsServer = createHttpsServer({ cert, key }, app);
    httpsServer.listen(httpsPort, host, () => {
      logger.info("Azure DevOps MCP HTTPS server listening", {
        host,
        port: httpsPort,
        path,
        mode: stateless ? "stateless" : "stateful",
        url: `https://${displayHost}:${httpsPort}${path}`,
        healthUrl: `https://${displayHost}:${httpsPort}/health`,
      });
      resolve();
    });
    httpsServer.on("error", reject);
  });
}

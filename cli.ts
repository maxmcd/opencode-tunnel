#!/usr/bin/env node
/**
 * OpenCode Tunnel CLI
 *
 * Connects to a Durable Object via WebSocket and proxies HTTP requests
 * to a local opencode server.
 *
 * Usage: bun cli.ts --port 8080 --worker-host localhost:5173
 */

import { spawn } from "child_process";
import { TunnelClient } from "./worker/lib/tunnel-client.js";
import qrcode from "qrcode-terminal";
import WebSocket from "ws";

interface Config {
  port: string;
  tunnelUrl: string;
  workerUrl: string;
}

class CLIManager {
  private config: Config;
  private tunnelClient: TunnelClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private opcodeProcess: any = null;

  constructor(config: Config) {
    this.config = config;
  }

  async start() {
    console.log("(this project is not associated with opencode)");
    console.log("Starting OpenCode process and connecting to tunnel...");

    // Handle graceful shutdown
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
    // Connect to tunnel and start opencode serve
    await Promise.all([this.startOpencodeServer(), this.connect()]);

    console.log(``);
    console.log(`OpenCode tunnel is live at: ${this.config.workerUrl}`);
    qrcode.generate(this.config.workerUrl, { small: true });
  }

  private async startOpencodeServer() {
    return new Promise<void>((resolve, reject) => {
      this.opcodeProcess = spawn(
        "opencode",
        ["serve", "--port", this.config.port.toString()],
        { stdio: "pipe" }
      );
      this.opcodeProcess.stdout?.on("data", (data: Buffer) => {
        const logString = data.toString();
        if (logString.includes("opencode server listening")) resolve();
        console.log(`[opencode] ${logString.trim()}`);
      });

      this.opcodeProcess.stderr?.on("data", (data: Buffer) =>
        console.error(`[opencode] ${data.toString().trim()}`)
      );

      this.opcodeProcess.on("error", (error: Error) => {
        reject(
          new Error(`Failed to start opencode server: ${error.message}`, {
            cause: error,
          })
        );
      });

      this.opcodeProcess.on("close", (code: number) => {
        console.log(`   [opencode] Process exited with code ${code}`);
        if (!this.isShuttingDown) {
          console.error("OpenCode server stopped unexpectedly");
          process.exit(1);
        }
      });
    });
  }

  private async connect() {
    if (this.isShuttingDown) return;

    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      // Create TunnelClient with custom fetch that proxies to localhost
      this.tunnelClient = new TunnelClient({
        wsUrl: this.config.tunnelUrl,
        fetch: ((url: string, init?: RequestInit) => {
          const localUrl = `http://localhost:${this.config.port}${url}`;
          return fetch(localUrl, init);
        }) as any, // Cast to avoid type mismatch between Bun and Workers fetch
        createWebSocket: (url: string) => {
          return new WebSocket(url, {
            headers: { "User-Agent": "OpenCode-Tunnel-CLI" },
          }) as any;
        },
        onDisconnect: () => {
          this.tunnelClient = null;

          // Schedule reconnect if not already scheduled
          if (!this.isShuttingDown && !this.reconnectTimer) {
            console.log(" Reconnecting in 3 seconds...");
            this.reconnectTimer = setTimeout(() => this.connect(), 3000);
          }
        },
        onLog: (message: string) => {
          console.log(` ${message}`);
        },
      });

      await this.tunnelClient.connect();
      console.log("Connected to tunnel");
    } catch (error: unknown) {
      console.error(
        " Failed to connect:",
        error instanceof ErrorEvent ? error.message : error
      );
      this.tunnelClient = null;

      // Schedule reconnect if not already scheduled
      if (!this.isShuttingDown && !this.reconnectTimer) {
        console.log(" Retrying in 3 seconds...");
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    }
  }

  private async shutdown() {
    if (this.isShuttingDown) return;

    console.log("\nShutting down...");
    this.isShuttingDown = true;

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Close tunnel client
    if (this.tunnelClient) {
      this.tunnelClient.disconnect();
      this.tunnelClient = null;
    }

    // Kill opencode process
    if (this.opcodeProcess) {
      this.opcodeProcess.kill();
    }

    console.log("Shutdown complete");
    process.exit(0);
  }
}

// Parse command line arguments
async function main() {
  const args = process.argv.slice(2);

  let port = "8080";
  let workerHost = "phew.network";
  let local = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--local") {
      local = true;
      workerHost = "localhost:5173";
    }
  }

  const response = await fetch(
    `${local ? "http" : "https"}://${workerHost}/api/tunnels/create`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );

  if (!response.ok) {
    console.error("Failed to create tunnel:", await response.text());
    process.exit(1);
  }

  const tunnel = (await response.json()) as {
    subdomain: string;
    url: string;
  };

  // Construct public URL
  const hostParts = workerHost.split(":");
  const hostname = hostParts[0]; // localhost or yourdomain.com
  const portPart = hostParts[1] ? `:${hostParts[1]}` : "";
  const publicUrl = tunnel.subdomain
    ? `${local ? "http" : "https"}://${tunnel.subdomain}.${hostname}${portPart}`
    : `${local ? "http" : "https"}://${workerHost}`;
  // Start CLI manager
  const manager = new CLIManager({
    port,
    tunnelUrl: `${local ? "ws" : "wss"}://${workerHost}/tunnel/${tunnel.subdomain}/connect`,
    workerUrl: publicUrl,
  });

  await manager.start();
}

main().catch(console.error);

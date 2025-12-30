/**
 * TunnelClient - Handles WebSocket connection and HTTP proxying
 * 
 * This class can be used both in the CLI and in tests by providing
 * a custom fetch function.
 */

import type {
  ProxyMessage,
  ProxyRequest,
} from "./protocol";
import {
  createResponseStart,
  createResponseChunk,
  createResponseEnd,
  createResponseError,
  decodeBase64,
  chunkData,
} from "./protocol";

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  chunks: Uint8Array[];
  headers?: Record<string, string>;
  status?: number;
}

export interface TunnelClientConfig {
  /** WebSocket URL to connect to */
  wsUrl: string;
  /** Function to make HTTP requests to the target server */
  fetch: typeof fetch;
  /** Factory function to create WebSocket - allows custom WebSocket implementations (Node.js vs Workers) */
  createWebSocket?: (url: string) => WebSocket;
  /** Callback when connected */
  onConnect?: () => void;
  /** Callback when disconnected */
  onDisconnect?: () => void;
  /** Callback for logging */
  onLog?: (message: string) => void;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private config: TunnelClientConfig;
  private isShuttingDown = false;

  constructor(config: TunnelClientConfig) {
    this.config = config;
  }

  /**
   * Connect to the tunnel WebSocket
   */
  async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    this.log("Connecting to tunnel...");

    return new Promise((resolve, reject) => {
      try {
        // Use custom WebSocket factory if provided, otherwise use native WebSocket
        this.ws = this.config.createWebSocket
          ? this.config.createWebSocket(this.config.wsUrl)
          : new WebSocket(this.config.wsUrl);

        this.ws.onopen = () => {
          this.log("Connected to tunnel");
          this.config.onConnect?.();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
          this.log("WebSocket connection closed");
          this.ws = null;
          this.config.onDisconnect?.();
          
          // Reject all pending requests
          const entries = Array.from(this.pendingRequests.entries());
          for (const [id, pending] of entries) {
            pending.reject(new Error("WebSocket connection closed"));
            this.pendingRequests.delete(id);
          }
        };

        this.ws.onerror = (error) => {
          this.log(`WebSocket error: ${error}`);
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the tunnel
   */
  disconnect(): void {
    this.isShuttingDown = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private log(message: string): void {
    this.config.onLog?.(message);
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const message: ProxyMessage = JSON.parse(data);

      if (message.type === "request") {
        await this.handleProxyRequest(message);
      }
    } catch (error) {
      this.log(`Error handling message: ${error}`);
    }
  }

  private async handleProxyRequest(proxyReq: ProxyRequest): Promise<void> {
    this.log(`-> ${proxyReq.method} ${proxyReq.url}`);

    try {
      // Decode body if present
      let body: string | undefined;
      if (proxyReq.body) {
        body = atob(proxyReq.body);
      }

      // Make request using provided fetch function
      const response = await this.config.fetch(proxyReq.url, {
        method: proxyReq.method,
        headers: proxyReq.headers,
        body: body,
      });

      this.log(`<- ${response.status} ${proxyReq.url}`);

      // Send response headers
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      this.sendMessage(createResponseStart(proxyReq.id, response.status, headers));

      // Stream response body in chunks
      if (response.body) {
        const reader = response.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Send chunk in smaller pieces if needed
          const chunks = Array.from(chunkData(value));
          for (const chunk of chunks) {
            this.sendMessage(createResponseChunk(proxyReq.id, chunk));
          }
        }
      }

      // Send response end
      this.sendMessage(createResponseEnd(proxyReq.id));
    } catch (error) {
      this.log(`ERROR proxying request: ${error}`);

      // Send error response
      this.sendMessage(
        createResponseError(
          proxyReq.id,
          error instanceof Error ? error.message : "Unknown error"
        )
      );
    }
  }

  private sendMessage(message: ProxyMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.log("Cannot send message: WebSocket not connected");
    }
  }
}

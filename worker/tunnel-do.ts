import { DurableObject } from "cloudflare:workers";

// Durable Object that manages WebSocket connections and proxies HTTP requests
// Simple streaming protocol to stay under 1MB WebSocket message limit

interface PendingRequest {
  resolve: (value: { status: number; headers: Record<string, string> }) => void;
  reject: (error: Error) => void;
  controller: ReadableStreamDefaultController<Uint8Array>;
  headers?: Record<string, string>;
  status?: number;
}

export class TunnelDO extends DurableObject<Env> {
  private clientWs: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade from CLI client
    if (
      request.headers.get("User-Agent") === "OpenCode-Tunnel-CLI" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      return this.handleWebSocketConnect(request);
    }

    return this.handleProxyRequest(request);
  }

  private handleWebSocketConnect(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    server.accept();

    // Close existing connection if any
    if (this.clientWs) {
      this.clientWs.close(1000, "New connection established");
    }

    this.clientWs = server;

    // Handle incoming messages from CLI client
    server.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data as string);
        this.handleClientMessage(message);
      } catch (error) {
        console.error("Error handling client message:", error);
      }
    });

    // Handle WebSocket close
    server.addEventListener("close", () => {
      this.clientWs = null;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error("WebSocket connection closed"));
        this.pendingRequests.delete(id);
      }
    });

    // Handle WebSocket error
    server.addEventListener("error", (event) => {
      console.error("WebSocket error:", event);
      this.clientWs = null;
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleProxyRequest(request: Request): Promise<Response> {
    // Check if client is connected
    if (!this.clientWs || this.clientWs.readyState !== WebSocket.OPEN) {
      console.log("Proxy request rejected: no client connected", {
        hasClient: !!this.clientWs,
        readyState: this.clientWs?.readyState,
      });
      return new Response(
        "Tunnel client not connected. Make sure the CLI is running.",
        {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }
      );
    }

    const requestId = crypto.randomUUID();

    // Read request body in chunks to handle large payloads
    const bodyChunks: Uint8Array[] = [];
    if (request.body) {
      const reader = request.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyChunks.push(value);
      }
    }

    // Convert body chunks to base64 for JSON transport
    const bodyBase64 =
      bodyChunks.length > 0
        ? btoa(
            String.fromCharCode(
              ...bodyChunks.flatMap((chunk) => Array.from(chunk))
            )
          )
        : undefined;

    // Send request to CLI client via WebSocket
    // Strip /proxy prefix to get the original path
    const url = new URL(request.url);
    const originalPath = url.pathname.replace(/^\/proxy/, "") || "/";

    const proxyRequest = {
      type: "request",
      id: requestId,
      method: request.method,
      url: originalPath + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      body: bodyBase64,
    };

    // Create response promise that resolves when headers are received
    const responsePromise = new Promise<Response>((resolve, reject) => {
      let resolveHeaders:
        | ((value: { status: number; headers: Record<string, string> }) => void)
        | null = null;
      const headersPromise = new Promise<{
        status: number;
        headers: Record<string, string>;
      }>((res) => {
        resolveHeaders = res;
      });

      // Create streaming response with ReadableStream
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          // Store controller for streaming chunks
          const pending: PendingRequest = {
            resolve: resolveHeaders!,
            reject: (error) => {
              controller.error(error);
              reject(error);
            },
            controller,
          };
          this.pendingRequests.set(requestId, pending);
        },
        cancel: () => {
          // Client cancelled the request
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
          }
        },
      });

      // Set timeout for initial response headers
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          const pending = this.pendingRequests.get(requestId);
          this.pendingRequests.delete(requestId);
          pending?.reject(new Error("Request timeout - no response received"));
        }
      }, 30000);

      // Wait for headers, then create Response with streaming body
      headersPromise.then(({ status, headers }) => {
        clearTimeout(timeoutId);
        resolve(new Response(stream, { status, headers }));
      });

      // Send request
      try {
        this.clientWs?.send(JSON.stringify(proxyRequest));
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(error);
      }
    });

    return responsePromise;
  }

  private handleClientMessage(message: any) {
    if (message.type === "response-start") {
      // Response headers received - resolve the headers promise to create Response
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        pending.status = message.status;
        pending.headers = message.headers;
        // Resolve headers promise so Response can be created with status/headers
        pending.resolve({ status: message.status, headers: message.headers });
      }
    } else if (message.type === "response-chunk") {
      // Response body chunk received - stream it immediately
      const pending = this.pendingRequests.get(message.id);
      if (pending && message.chunk) {
        try {
          // Decode base64 chunk
          const binaryString = atob(message.chunk);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          // Stream chunk immediately to the response body
          pending.controller.enqueue(bytes);
        } catch (error) {
          console.error("Error streaming chunk:", error);
          pending.controller.error(error);
          this.pendingRequests.delete(message.id);
        }
      }
    } else if (message.type === "response-end") {
      // Response complete - close the stream
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        try {
          pending.controller.close();
        } catch (error) {
          console.error("Error closing stream:", error);
        }
        this.pendingRequests.delete(message.id);
      }
    } else if (message.type === "response-error") {
      // Error occurred - error the stream
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        pending.reject(new Error(message.error || "Unknown error"));
        this.pendingRequests.delete(message.id);
      }
    }
  }
}

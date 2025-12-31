import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  createProxyRequest,
  createResponseStart,
  createResponseChunk,
  createResponseEnd,
  createResponseError,
  decodeBase64,
  combineChunks,
  chunkData,
  encodeBase64,
} from "../worker/lib/protocol";

describe("WebSocket Proxy Protocol", () => {
  describe("Protocol Library", () => {
    it("should encode and decode base64", () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const encoded = encodeBase64(data);
      const decoded = decodeBase64(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(data));
    });

    it("should chunk large data correctly", () => {
      const largeData = new Uint8Array(1024 * 1024); // 1MB
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      const chunks = Array.from(chunkData(largeData, 500 * 1024));

      // Should create 3 chunks: 500KB, 500KB, 24KB
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBe(500 * 1024);
      expect(chunks[1].length).toBe(500 * 1024);
      expect(chunks[2].length).toBe(24 * 1024);

      // Recombine and verify
      const combined = combineChunks(chunks);
      expect(combined.length).toBe(largeData.length);
      expect(Array.from(combined)).toEqual(Array.from(largeData));
    });

    it("should create valid protocol messages", () => {
      const proxyReq = createProxyRequest("id-1", "POST", "/api/test", {
        "content-type": "application/json",
      });
      expect(proxyReq.type).toBe("request");
      expect(proxyReq.id).toBe("id-1");
      expect(proxyReq.method).toBe("POST");
      expect(proxyReq.url).toBe("/api/test");

      const resStart = createResponseStart("id-1", 200, {
        "content-type": "text/html",
      });
      expect(resStart.type).toBe("response-start");
      expect(resStart.status).toBe(200);

      const resChunk = createResponseChunk("id-1", new Uint8Array([1, 2, 3]));
      expect(resChunk.type).toBe("response-chunk");
      expect(resChunk.chunk).toBeDefined();

      const resEnd = createResponseEnd("id-1");
      expect(resEnd.type).toBe("response-end");
    });
  });

  describe("End-to-End Proxy Test", () => {
    // Mock fetch function that returns canned responses
    const mockFetch = (url: string): Promise<Response> => {
      if (url === "/") {
        return Promise.resolve(
          new Response("Hello from mock server!", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          })
        );
      } else if (url === "/json") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ message: "test", nested: { value: 123 } }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      } else if (url === "/headers") {
        return Promise.resolve(
          new Response(JSON.stringify({ headers: "test" }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Custom-Header": "custom-value",
              "Cache-Control": "max-age=3600",
            },
          })
        );
      } else if (url === "/large") {
        const largeData = "x".repeat(1024 * 1024);
        return Promise.resolve(
          new Response(largeData, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          })
        );
      } else if (url === "/utf8") {
        // Test various UTF-8 characters including smart quotes, emoji, and international characters
        // Use Unicode escapes to ensure actual smart quotes are preserved
        const utf8Text = `Hello \u201Csmart quotes\u201D and \u2018single quotes\u2019 \u2014 emoji \u{1F389} 中文 café`;
        return Promise.resolve(
          new Response(utf8Text, {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };

    it("should create a tunnel and proxy requests through Durable Object", async () => {
      // Step 1: Create a tunnel
      const createRes = await SELF.fetch(
        "http://localhost:5173/api/tunnels/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );

      expect(createRes.ok).toBe(true);
      const tunnel = (await createRes.json()) as {
        id: string;
        subdomain: string;
        url: string;
      };
      expect(tunnel.subdomain).toBeDefined();

      // Step 2: Connect CLI WebSocket to Durable Object
      const wsUrl = `http://localhost:5173/tunnel/${tunnel.subdomain}/connect`;
      const wsRes = await SELF.fetch(wsUrl, {
        headers: {
          Upgrade: "websocket",
          "User-Agent": "OpenCode-Tunnel-CLI",
        },
      });

      expect(wsRes.status).toBe(101);
      const ws = wsRes.webSocket;
      if (!ws) throw new Error("WebSocket not created");
      ws.accept();

      // Step 3: Set up message handler to simulate CLI client
      ws.addEventListener("message", async (event) => {
        const message = JSON.parse(event.data as string);

        if (message.type === "request") {
          const { id, method, url } = message;

          try {
            // Make mocked request
            const response = await mockFetch(url);

            // Send response-start
            const resHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              resHeaders[key] = value;
            });

            ws.send(
              JSON.stringify(
                createResponseStart(id, response.status, resHeaders)
              )
            );

            // Send response body in chunks
            if (response.body) {
              const reader = response.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                for (const chunk of chunkData(value)) {
                  ws.send(JSON.stringify(createResponseChunk(id, chunk)));
                }
              }
            }

            // Send response-end
            ws.send(JSON.stringify(createResponseEnd(id)));
          } catch (error) {
            ws.send(
              JSON.stringify(
                createResponseError(
                  id,
                  error instanceof Error ? error.message : "Unknown error"
                )
              )
            );
          }
        }
      });

      // Step 4: Wait for WebSocket to be ready
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Step 5: Make proxied request through the tunnel
      const proxyRes = await SELF.fetch(
        `http://${tunnel.subdomain}.localhost:5173/`,
        {
          headers: {
            "X-Tunnel-Secret": "test-secret",
          },
        }
      );

      expect(proxyRes.ok).toBe(true);
      const text = await proxyRes.text();
      expect(text).toBe("Hello from mock server!");

      // Test JSON endpoint
      const jsonRes = await SELF.fetch(
        `http://${tunnel.subdomain}.localhost:5173/json`,
        {
          headers: {
            "X-Tunnel-Secret": "test-secret",
          },
        }
      );

      expect(jsonRes.ok).toBe(true);
      const json = await jsonRes.json();
      expect(json).toEqual({ message: "test", nested: { value: 123 } });

      // Test headers
      const headersRes = await SELF.fetch(
        `http://${tunnel.subdomain}.localhost:5173/headers`,
        {
          headers: {
            "X-Tunnel-Secret": "test-secret",
          },
        }
      );

      expect(headersRes.ok).toBe(true);
      expect(headersRes.headers.get("X-Custom-Header")).toBe("custom-value");
      expect(headersRes.headers.get("Cache-Control")).toBe("max-age=3600");

      // Clean up
      ws.close();
    });

    it("should handle large responses with chunking", async () => {
      // Create tunnel
      const createRes = await SELF.fetch(
        "http://localhost:5173/api/tunnels/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );

      const tunnel = (await createRes.json()) as {
        subdomain: string;
      };

      // Connect WebSocket
      const wsRes = await SELF.fetch(
        `http://localhost:5173/tunnel/${tunnel.subdomain}/connect`,
        {
          headers: {
            Upgrade: "websocket",
            "User-Agent": "OpenCode-Tunnel-CLI",
          },
        }
      );

      const ws = wsRes.webSocket!;
      ws.accept();

      // Set up CLI simulator
      ws.addEventListener("message", async (event) => {
        const message = JSON.parse(event.data as string);

        if (message.type === "request") {
          const response = await mockFetch(message.url);
          const resHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            resHeaders[key] = value;
          });

          ws.send(
            JSON.stringify(
              createResponseStart(message.id, response.status, resHeaders)
            )
          );

          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              for (const chunk of chunkData(value)) {
                ws.send(JSON.stringify(createResponseChunk(message.id, chunk)));
              }
            }
          }

          ws.send(JSON.stringify(createResponseEnd(message.id)));
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Request large response
      const largeRes = await SELF.fetch(
        `http://${tunnel.subdomain}.localhost:5173/large`,
        {
          headers: {
            "X-Tunnel-Secret": "test-secret",
          },
        }
      );

      expect(largeRes.ok).toBe(true);
      const largeText = await largeRes.text();
      expect(largeText.length).toBe(1024 * 1024);
      expect(largeText).toBe("x".repeat(1024 * 1024));

      ws.close();
    });

    it("should return 503 when no client is connected", async () => {
      // Create tunnel but don't connect WebSocket
      const createRes = await SELF.fetch(
        "http://localhost:5173/api/tunnels/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );

      const tunnel = (await createRes.json()) as {
        id: string;
        subdomain: string;
      };

      // Try to make request without connecting CLI
      const proxyRes = await SELF.fetch(
        `http://${tunnel.subdomain}.localhost:5173/`,
        {
          headers: {
            "X-Tunnel-Secret": "test-secret",
          },
        }
      );

      expect(proxyRes.status).toBe(503);
      const errorText = await proxyRes.text();
      expect(errorText).toContain("Tunnel client not connected");
    });

    it("should preserve UTF-8 encoding in both request and response bodies", async () => {
      // Create tunnel
      const createRes = await SELF.fetch(
        "http://localhost:5173/api/tunnels/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );

      const tunnel = (await createRes.json()) as {
        id: string;
        subdomain: string;
      };

      // Connect WebSocket
      const wsRes = await SELF.fetch(
        `http://localhost:5173/tunnel/${tunnel.subdomain}/connect`,
        {
          headers: {
            Upgrade: "websocket",
            "User-Agent": "OpenCode-Tunnel-CLI",
          },
        }
      );

      const ws = wsRes.webSocket!;
      ws.accept();

      // Track what request body the mock server receives
      let receivedRequestBody: string | null = null;

      // Set up CLI simulator that echoes request body and serves UTF-8 content
      ws.addEventListener("message", async (event) => {
        const message = JSON.parse(event.data as string);

        if (message.type === "request") {
          // Capture the request body (simulate what OpenCode would receive)
          if (message.body) {
            const binaryString = atob(message.body);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const decoder = new TextDecoder();
            receivedRequestBody = decoder.decode(bytes);
          }

          // Route requests to different handlers
          if (message.url === "/echo") {
            // Echo back the request body in response
            ws.send(
              JSON.stringify(
                createResponseStart(message.id, 200, {
                  "Content-Type": "application/json; charset=utf-8",
                })
              )
            );

            const responseBody = JSON.stringify({ echoed: receivedRequestBody });
            const responseBytes = new TextEncoder().encode(responseBody);
            
            for (const chunk of chunkData(responseBytes)) {
              ws.send(JSON.stringify(createResponseChunk(message.id, chunk)));
            }

            ws.send(JSON.stringify(createResponseEnd(message.id)));
          } else if (message.url === "/utf8") {
            // Serve UTF-8 content (from mockFetch)
            const response = await mockFetch(message.url);
            const resHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              resHeaders[key] = value;
            });

            ws.send(
              JSON.stringify(
                createResponseStart(message.id, response.status, resHeaders)
              )
            );

            if (response.body) {
              const reader = response.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                for (const chunk of chunkData(value)) {
                  ws.send(JSON.stringify(createResponseChunk(message.id, chunk)));
                }
              }
            }

            ws.send(JSON.stringify(createResponseEnd(message.id)));
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Test 1: UTF-8 in GET response (response body encoding)
      const getRes = await SELF.fetch(
        `http://${tunnel.subdomain}.localhost:5173/utf8`,
        {
          headers: {
            "X-Tunnel-Secret": "test-secret",
          },
        }
      );

      expect(getRes.ok).toBe(true);
      const getText = await getRes.text();
      
      // Verify response UTF-8 characters are preserved
      expect(getText).toContain('\u201C'); // Left double quotation mark "
      expect(getText).toContain('\u201D'); // Right double quotation mark "
      expect(getText).toContain('\u2018'); // Left single quotation mark '
      expect(getText).toContain('\u2019'); // Right single quotation mark '
      expect(getText).toContain('\u2014'); // Em dash —
      expect(getText).toContain('🎉'); // Emoji
      expect(getText).toContain('中文'); // Chinese characters
      expect(getText).toContain('café'); // Accented character
      expect(getText).toBe(`Hello \u201Csmart quotes\u201D and \u2018single quotes\u2019 \u2014 emoji \u{1F389} 中文 café`);

      // Test 2: UTF-8 in POST request body (request body encoding)
      const requestBody = JSON.stringify({
        message: "Hello \u201Csmart quotes\u201D",
        emoji: "\u{1F389}",
        chinese: "中文",
        accented: "café",
        special: "\u2014", // em dash
      });

      const postRes = await SELF.fetch(
        `http://${tunnel.subdomain}.localhost:5173/echo`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tunnel-Secret": "test-secret",
          },
          body: requestBody,
        }
      );

      expect(postRes.ok).toBe(true);
      const postData = await postRes.json();

      // Verify the request body was received correctly (full round-trip)
      expect(receivedRequestBody).toBe(requestBody);
      expect(receivedRequestBody).toContain("\u201C"); // Smart quote
      expect(receivedRequestBody).toContain("\u201D"); // Smart quote
      expect(receivedRequestBody).toContain("\u{1F389}"); // Emoji
      expect(receivedRequestBody).toContain("中文"); // Chinese
      expect(receivedRequestBody).toContain("café"); // Accented
      expect(receivedRequestBody).toContain("\u2014"); // Em dash
      
      // Verify the response echoed back the request correctly
      expect(postData.echoed).toBe(requestBody);

      ws.close();
    });
  });
});

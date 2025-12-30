/**
 * WebSocket Proxy Protocol
 * 
 * This protocol allows HTTP requests to be proxied over a WebSocket connection.
 * Responses are streamed in chunks to avoid WebSocket message size limits (1MB).
 */

// Maximum chunk size for streaming responses (500KB to stay under 1MB limit)
export const CHUNK_SIZE = 500 * 1024;

// Message Types
export type ProxyMessage =
  | ProxyRequest
  | ResponseStart
  | ResponseChunk
  | ResponseEnd
  | ResponseError;

/**
 * Request from Durable Object to CLI client
 */
export interface ProxyRequest {
  type: "request";
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string; // base64 encoded
}

/**
 * Response headers from CLI to Durable Object
 */
export interface ResponseStart {
  type: "response-start";
  id: string;
  status: number;
  headers: Record<string, string>;
}

/**
 * Response body chunk from CLI to Durable Object
 */
export interface ResponseChunk {
  type: "response-chunk";
  id: string;
  chunk: string; // base64 encoded
}

/**
 * Response completion from CLI to Durable Object
 */
export interface ResponseEnd {
  type: "response-end";
  id: string;
}

/**
 * Error response from CLI to Durable Object
 */
export interface ResponseError {
  type: "response-error";
  id: string;
  error: string;
}

/**
 * Encode binary data to base64 for JSON transport
 */
export function encodeBase64(data: Uint8Array): string {
  return btoa(String.fromCharCode.apply(null, Array.from(data)));
}

/**
 * Decode base64 string to binary data
 */
export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a proxy request message
 */
export function createProxyRequest(
  id: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Uint8Array
): ProxyRequest {
  return {
    type: "request",
    id,
    method,
    url,
    headers,
    body: body ? encodeBase64(body) : undefined,
  };
}

/**
 * Create response start message
 */
export function createResponseStart(
  id: string,
  status: number,
  headers: Record<string, string>
): ResponseStart {
  return {
    type: "response-start",
    id,
    status,
    headers,
  };
}

/**
 * Create response chunk message
 */
export function createResponseChunk(id: string, chunk: Uint8Array): ResponseChunk {
  return {
    type: "response-chunk",
    id,
    chunk: encodeBase64(chunk),
  };
}

/**
 * Create response end message
 */
export function createResponseEnd(id: string): ResponseEnd {
  return {
    type: "response-end",
    id,
  };
}

/**
 * Create response error message
 */
export function createResponseError(id: string, error: string): ResponseError {
  return {
    type: "response-error",
    id,
    error,
  };
}

/**
 * Split a large Uint8Array into chunks for streaming
 */
export function* chunkData(data: Uint8Array, chunkSize: number = CHUNK_SIZE): Generator<Uint8Array> {
  for (let i = 0; i < data.length; i += chunkSize) {
    yield data.slice(i, Math.min(i + chunkSize, data.length));
  }
}

/**
 * Combine chunks back into a single Uint8Array
 */
export function combineChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

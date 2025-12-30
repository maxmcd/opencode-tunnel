import { createRequestHandler } from "react-router";
import { TunnelDO } from "./tunnel-do";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export { TunnelDO };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Extract subdomain
    // For localhost: "abc123.localhost" -> subdomain = "abc123"
    // For production: "abc123.opencode-tunnel.com" -> subdomain = "abc123"
    const hostname = url.hostname;
    const parts = hostname.split(".");

    let subdomain: string | null = null;
    if (parts.length > 1 && parts[parts.length - 1] === "localhost") {
      // Development: abc123.localhost -> subdomain is abc123
      subdomain = parts.length > 1 ? parts[0] : null;
    } else if (parts.length > 2) {
      // Production: abc123.opencode-tunnel.com -> subdomain is abc123
      subdomain = parts[0];
    }

    // Handle subdomain requests - proxy through Durable Object
    if (subdomain) {
      // Get Durable Object stub by tunnel ID
      const id = env.TUNNEL_DO.idFromName(subdomain);
      const stub = env.TUNNEL_DO.get(id);
      return stub.fetch(request);
    }
    if (request.headers.get("User-Agent") === "OpenCode-Tunnel-CLI") {
      const subdomain = url.pathname.split("/")[2];

      const doId = env.TUNNEL_DO.idFromName(subdomain);
      const stub = env.TUNNEL_DO.get(doId);
      return stub.fetch(request);
    }

    // Route API requests
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    // Handle all other requests with React Router
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // POST /api/tunnels/create - Create a new tunnel
  if (url.pathname === "/api/tunnels/create" && request.method === "POST") {
    try {
      const subdomain = generateRandomSubdomain();

      const session = env.DB.withSession("first-primary");
      // Check if subdomain is available
      const existing = await session
        .prepare("SELECT subdomain FROM tunnels WHERE subdomain = ?")
        .bind(subdomain)
        .first();

      if (existing?.subdomain) {
        return jsonResponse({ error: "Subdomain already taken" }, 400);
      }

      // Create tunnel record
      const now = Date.now();
      await session
        .prepare(
          `INSERT INTO tunnels (subdomain, created_at)
         VALUES (?, ?)`
        )
        .bind(subdomain, now)
        .run();
      const wsUrl = `wss://${url.host}/tunnel/${subdomain}/connect`;
      return jsonResponse({
        subdomain,
        url: `https://${subdomain}.${url.host}`,
        wsUrl,
      });
    } catch (error) {
      return jsonResponse({ error: "Failed to create tunnel" }, 500);
    }
  }

  return jsonResponse({ error: "API endpoint not found" }, 404);
}

function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function generateRandomSubdomain(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

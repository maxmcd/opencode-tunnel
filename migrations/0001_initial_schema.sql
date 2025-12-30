-- Initial schema for opencode-tunnel
-- This stores tunnel metadata and manages subdomain routing
-- Status is handled by Durable Object (connected/disconnected)

CREATE TABLE tunnels (
  subdomain TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Index for fast subdomain lookups (primary use case)
CREATE INDEX idx_subdomain ON tunnels(subdomain);


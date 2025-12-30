import type { Tunnel } from "../types/tunnel";

/**
 * Check if a subdomain is available
 */
export async function isSubdomainAvailable(
	db: D1Database,
	subdomain: string
): Promise<boolean> {
	const result = await db
		.prepare("SELECT id FROM tunnels WHERE subdomain = ?")
		.bind(subdomain)
		.first();

	return result === null;
}

/**
 * Get tunnel by subdomain
 */
export async function getTunnelBySubdomain(
	db: D1Database,
	subdomain: string
): Promise<Tunnel | null> {
	const result = await db
		.prepare("SELECT * FROM tunnels WHERE subdomain = ?")
		.bind(subdomain)
		.first<Tunnel>();

	return result;
}

/**
 * Get tunnel by ID
 */
export async function getTunnelById(
	db: D1Database,
	id: string
): Promise<Tunnel | null> {
	const result = await db
		.prepare("SELECT * FROM tunnels WHERE id = ?")
		.bind(id)
		.first<Tunnel>();

	return result;
}

/**
 * Create a new tunnel record
 */
export async function createTunnel(
	db: D1Database,
	data: {
		id: string;
		tunnel_id: string;
		tunnel_token: string;
		subdomain: string;
		user_id?: string;
	}
): Promise<Tunnel> {
	const now = Date.now();

	await db
		.prepare(
			`INSERT INTO tunnels (id, user_id, tunnel_id, tunnel_token, subdomain, created_at, last_active, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			data.id,
			data.user_id || null,
			data.tunnel_id,
			data.tunnel_token,
			data.subdomain,
			now,
			now,
			"inactive"
		)
		.run();

	return {
		id: data.id,
		user_id: data.user_id || null,
		tunnel_id: data.tunnel_id,
		tunnel_token: data.tunnel_token,
		subdomain: data.subdomain,
		created_at: now,
		last_active: now,
		status: "inactive",
	};
}

/**
 * Update tunnel's last active timestamp
 */
export async function updateTunnelActivity(
	db: D1Database,
	id: string
): Promise<void> {
	const now = Date.now();

	await db
		.prepare(
			"UPDATE tunnels SET last_active = ?, status = ? WHERE id = ?"
		)
		.bind(now, "active", id)
		.run();
}

/**
 * Delete a tunnel
 */
export async function deleteTunnel(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM tunnels WHERE id = ?").bind(id).run();
}

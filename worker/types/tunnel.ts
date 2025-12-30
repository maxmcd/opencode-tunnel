export interface Tunnel {
	id: string;
	user_id: string | null;
	tunnel_id: string;
	tunnel_token: string;
	subdomain: string;
	created_at: number;
	last_active: number;
	status: "active" | "inactive" | "expired";
}

export interface CreateTunnelRequest {
	name?: string; // Optional friendly name for the tunnel
	subdomain?: string; // Optional preferred subdomain
	target?: string; // Optional target URL (for future use)
}

export interface CreateTunnelResponse {
	id: string;
	tunnel_id: string;
	tunnel_token: string;
	subdomain: string;
	url: string;
	status: "inactive";
	created_at: number;
}

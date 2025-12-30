export interface ApiResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: {
		message: string;
		code?: string;
	};
}

export interface ApiError {
	status: number;
	message: string;
	code?: string;
}

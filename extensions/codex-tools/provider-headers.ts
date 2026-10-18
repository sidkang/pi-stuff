/** Project Pi ProviderHeaders while preserving null deletion markers until request build. */
export function rawProviderHeaders(value: unknown): Record<string, string | null> {
	const result: Record<string, string | null> = {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return result;
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		if (typeof headerValue === "string") result[key] = headerValue;
		else if (headerValue === null) result[key] = null;
	}
	return result;
}

/**
 * Build outbound fetch headers from Pi ProviderHeaders plus optional apiKey fallback.
 *
 * Null header values are deletion markers: they are omitted from the result. A null
 * `Authorization` also suppresses the Bearer fallback derived from `apiKey`, so gateway
 * auth can delete placeholder credentials without them being reintroduced.
 */
export function buildRequestHeaders(
	headers: unknown,
	apiKey?: string,
	extra?: Record<string, string>,
): Record<string, string> {
	const result: Record<string, string> = {};
	let suppressAuthorization = false;
	if (typeof headers === "object" && headers !== null && !Array.isArray(headers)) {
		for (const [key, headerValue] of Object.entries(headers as Record<string, unknown>)) {
			if (headerValue === null) {
				if (key.toLowerCase() === "authorization") suppressAuthorization = true;
				continue;
			}
			if (typeof headerValue === "string") result[key] = headerValue;
		}
	}
	const hasAuthorization = Object.keys(result).some((key) => key.toLowerCase() === "authorization");
	if (!hasAuthorization && !suppressAuthorization && typeof apiKey === "string" && apiKey.length > 0) {
		result.Authorization = `Bearer ${apiKey}`;
	}
	return extra ? { ...result, ...extra } : result;
}

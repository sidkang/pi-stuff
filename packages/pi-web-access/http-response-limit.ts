/**
 * Shared 1 MiB HTTP response envelope used by Responses and hosted HTTP clients.
 * CDP discovery JSON uses the same envelope; 64 MiB HTML / 128 MiB WS caps are
 * separate payload classes (document capture vs WebSocket frames).
 */
export const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;

export class HttpResponseTooLargeError extends Error {
	constructor(message = `HTTP response exceeded the ${MAX_HTTP_RESPONSE_BYTES / (1024 * 1024)} MiB size limit`) {
		super(message);
		this.name = "HttpResponseTooLargeError";
	}
}

/** Read a fetch Response body with a UTF-8 byte ceiling; cancel the reader on overflow. */
export async function readBoundedHttpResponseText(
	response: Response,
	maxBytes: number = MAX_HTTP_RESPONSE_BYTES,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let completed = false;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				completed = true;
				break;
			}
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				throw new HttpResponseTooLargeError();
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		try {
			if (!completed) await reader.cancel().catch(() => undefined);
		} finally {
			reader.releaseLock();
		}
	}
}

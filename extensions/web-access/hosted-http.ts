import { isRecord, SearchBackendError, type SearchErrorCode } from "./responses-client.ts";

export const EXA_SEARCH_URL = "https://api.exa.ai/search";
export const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
export const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

const MAX_RAW_RESPONSE_BYTES = 1024 * 1024;
const MAX_BACKEND_ERROR_MESSAGE_CHARS = 1000;

function boundedMessage(message: string): string {
	return message.slice(0, MAX_BACKEND_ERROR_MESSAGE_CHARS);
}

function errorCodeForHttpStatus(status: number): SearchErrorCode {
	if (status === 401 || status === 403) return "auth_failed";
	if (status === 402 || status === 429) return "rate_limited";
	if (status === 408) return "timeout";
	if (status === 400 || status === 422) return "invalid_input";
	return "backend_error";
}

async function readResponseText(response: Response): Promise<string> {
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
			if (bytes > MAX_RAW_RESPONSE_BYTES) {
				throw new SearchBackendError("invalid_response", "hosted API response exceeded the 1 MiB size limit");
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

function errorMessageFromBody(body: string, fallback: string): string {
	if (!body) return fallback;
	try {
		const parsed = JSON.parse(body) as unknown;
		if (isRecord(parsed)) {
			if (isRecord(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message;
			if (typeof parsed.message === "string") return parsed.message;
			if (typeof parsed.error === "string") return parsed.error;
		}
	} catch {
		// Use raw body below.
	}
	return body;
}

async function responseError(response: Response): Promise<SearchBackendError> {
	const body = await readResponseText(response);
	const message = boundedMessage(errorMessageFromBody(body, response.statusText || "hosted API request failed"));
	return new SearchBackendError(errorCodeForHttpStatus(response.status), `HTTP ${response.status}: ${message}`, response.status);
}

export async function postHostedJson(
	url: string,
	body: Record<string, unknown>,
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
		const response = await fetch(url, {
			method: "POST",
			signal: options.signal,
			headers,
			body: JSON.stringify(body),
		});
		if (!response.ok) throw await responseError(response);
		const text = await readResponseText(response);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new SearchBackendError("invalid_response", "hosted API returned non-JSON response");
		}
	} catch (error) {
		if (error instanceof SearchBackendError) {
			if (!options.apiKey) return Promise.reject(error);
			const redacted = error.message.split(options.apiKey).join("[redacted]");
			if (redacted === error.message) throw error;
			throw new SearchBackendError(error.code, boundedMessage(redacted), error.status);
		}
		if ((error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "TimeoutError")) {
			throw error;
		}
		if (error instanceof Error) {
			throw new SearchBackendError("backend_error", boundedMessage(error.message));
		}
		throw error;
	}
}

export type HostedPage = {
	url: string;
	title: string;
	content: string;
};

export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asRecordArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord);
}

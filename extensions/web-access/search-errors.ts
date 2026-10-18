import { SearchBackendError, type SearchErrorCode } from "./responses-client.ts";
import type { WebSearchSourceName } from "./settings.ts";

export type SourceAttempt = {
	source: WebSearchSourceName;
	ok: boolean;
	code?: SearchErrorCode;
	status?: number;
	error?: string;
	provider?: string;
	model?: string;
	api?: string;
	elapsedMs?: number;
};

export function classifySearchFailure(error: unknown): { code: SearchErrorCode; status?: number; message: string } {
	if (error instanceof DOMException && error.name === "AbortError") {
		return { code: "aborted", message: "web search was aborted" };
	}
	if (error instanceof Error && error.name === "TimeoutError") {
		return { code: "timeout", message: "web search timed out" };
	}
	if (error instanceof SearchBackendError) {
		return { code: error.code, status: error.status, message: error.message };
	}
	return { code: "backend_error", message: error instanceof Error ? error.message : String(error) };
}

export function formatXSearchFailureMessage(message: string): string {
	const prefix = "X search failed: ";
	if (message.startsWith(prefix)) return message;
	return `${prefix}${message}`;
}

export function formatWebSearchFailureMessage(message: string): string {
	const prefix = "Web search failed: ";
	if (message.startsWith(prefix)) return message;
	const httpWrapped = /^(HTTP \d+):\s*(.*)$/s.exec(message);
	if (httpWrapped) {
		const statusLabel = httpWrapped[1]!;
		const rest = httpWrapped[2]!;
		if (rest.startsWith(prefix)) return `${prefix}${statusLabel}: ${rest.slice(prefix.length)}`;
	}
	return `${prefix}${message}`;
}

import {
	isRecord,
	isRetryableToolChoiceError,
	messageInput,
	ResponsesClient,
	SearchBackendError,
	type SearchBackendResponse,
} from "./responses-client.ts";

export const X_SEARCH_INSTRUCTIONS = "Search X and answer only from retrieved X posts. Cite X URLs.";

export type XSearchRequest = {
	query: string;
	model: string;
	from_date?: string;
	to_date?: string;
	/** Mapped Responses reasoning.effort; omit when thinking is off. */
	reasoningEffort?: string;
	signal?: AbortSignal;
};

function normalizedSearchDate(value: string | undefined, field: "from_date" | "to_date"): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
	if (!match) {
		throw new SearchBackendError("invalid_input", `${field} must be a valid date in YYYY-MM-DD format.`);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
		throw new SearchBackendError("invalid_input", `${field} must be a valid date in YYYY-MM-DD format.`);
	}
	return normalized;
}

export function buildXSearchRequest(request: XSearchRequest, includeToolChoice: boolean): Record<string, unknown> {
	const fromDate = normalizedSearchDate(request.from_date, "from_date");
	const toDate = normalizedSearchDate(request.to_date, "to_date");
	if (fromDate && toDate && fromDate > toDate) {
		throw new SearchBackendError("invalid_input", "from_date must be on or before to_date.");
	}
	const tool: Record<string, unknown> = { type: "x_search" };
	if (fromDate) tool.from_date = fromDate;
	if (toDate) tool.to_date = toDate;

	const body: Record<string, unknown> = {
		model: request.model,
		input: messageInput(request.query),
		instructions: X_SEARCH_INSTRUCTIONS,
		tools: [tool],
		stream: false,
		store: false,
	};
	if (includeToolChoice) body.tool_choice = { type: "x_search" };
	if (request.reasoningEffort !== undefined) {
		body.reasoning = { effort: request.reasoningEffort };
	}
	return body;
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function isXHost(hostname: string | undefined): boolean {
	if (!hostname) return false;
	return hostname === "x.com" || hostname === "www.x.com" || hostname === "twitter.com" || hostname === "www.twitter.com";
}

function hasXSearchCall(response: SearchBackendResponse): boolean {
	for (const item of response.outputItems ?? []) {
		if (isRecord(item) && item.type === "x_search_call") return true;
	}
	return false;
}

function structuredCitationUrls(response: SearchBackendResponse): string[] {
	if (response.citationUrls && response.citationUrls.length > 0) return response.citationUrls;
	return (response.citations ?? []).map((citation) => citation.url);
}

function hasXCitation(response: SearchBackendResponse): boolean {
	return structuredCitationUrls(response).some((url) => isXHost(hostOf(url)));
}

export function isXSearchSuccess(response: SearchBackendResponse): boolean {
	return Boolean(response.answer?.trim()) && (hasXSearchCall(response) || hasXCitation(response));
}

export function isUnsupportedToolChoiceError(error: unknown): boolean {
	return isRetryableToolChoiceError(error);
}

export class XSearchSource {
	readonly client: ResponsesClient;

	constructor(client: ResponsesClient) {
		this.client = client;
	}

	async search(request: XSearchRequest): Promise<SearchBackendResponse> {
		const options = { signal: request.signal, model: request.model };
		let normalized: SearchBackendResponse;
		try {
			normalized = await this.client.post(buildXSearchRequest(request, true), options);
		} catch (error) {
			if (!isUnsupportedToolChoiceError(error)) throw error;
			normalized = await this.client.post(buildXSearchRequest(request, false), options);
		}
		if (!isXSearchSuccess(normalized)) {
			throw new SearchBackendError("invalid_response", "x search backend returned no X result");
		}
		return normalized;
	}
}

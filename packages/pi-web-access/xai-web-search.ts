import {
	cleanedStringList,
	hasWebSearchSuccess,
	isRetryableToolChoiceError,
	messageInput,
	ResponsesClient,
	SearchBackendError,
	type SearchBackendResponse,
} from "./responses-client.ts";

export const XAI_MAX_ALLOWED_DOMAINS = 5;
export const WEB_SEARCH_INSTRUCTIONS = "Search the web and answer only from the retrieved results. Cite sources.";

export type XaiWebSearchRequest = {
	query: string;
	model: string;
	limit?: number;
	allowed_domains?: string[];
	/** Mapped Responses reasoning.effort; omit when thinking is off. */
	reasoningEffort?: string;
	signal?: AbortSignal;
};

export function buildXaiWebSearchRequest(request: XaiWebSearchRequest, includeToolChoice = true): Record<string, unknown> {
	const allowedDomains = cleanedStringList(request.allowed_domains);
	if (allowedDomains && allowedDomains.length > XAI_MAX_ALLOWED_DOMAINS) {
		throw new SearchBackendError(
			"invalid_input",
			`xAI web search accepts at most ${XAI_MAX_ALLOWED_DOMAINS} allowed domains; received ${allowedDomains.length}.`,
		);
	}

	const tool: Record<string, unknown> = { type: "web_search" };
	if (allowedDomains) tool.filters = { allowed_domains: allowedDomains };

	const body: Record<string, unknown> = {
		model: request.model,
		input: messageInput(request.query),
		instructions: WEB_SEARCH_INSTRUCTIONS,
		tools: [tool],
		stream: false,
		store: false,
	};
	if (includeToolChoice) body.tool_choice = { type: "web_search" };
	if (request.reasoningEffort !== undefined) {
		body.reasoning = { effort: request.reasoningEffort };
	}
	return body;
}

function isUnsupportedToolChoiceError(error: unknown): boolean {
	return isRetryableToolChoiceError(error);
}

export class XaiWebSearchSource {
	readonly client: ResponsesClient;

	constructor(client: ResponsesClient) {
		this.client = client;
	}

	async search(request: XaiWebSearchRequest): Promise<SearchBackendResponse> {
		const options = { signal: request.signal, limit: request.limit, model: request.model };
		let normalized: SearchBackendResponse;
		try {
			normalized = await this.client.post(buildXaiWebSearchRequest(request), options);
		} catch (error) {
			if (!isUnsupportedToolChoiceError(error)) throw error;
			normalized = await this.client.post(buildXaiWebSearchRequest(request, false), options);
		}
		if (!hasWebSearchSuccess(normalized)) {
			throw new SearchBackendError("invalid_response", "web search backend returned no answer or sources");
		}
		return normalized;
	}
}

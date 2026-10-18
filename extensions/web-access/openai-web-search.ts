import {
	cleanedLocation,
	cleanedStringList,
	hasWebSearchSuccess,
	messageInput,
	ResponsesClient,
	SearchBackendError,
	type SearchBackendResponse,
	type SearchContextSize,
	type WebSearchUserLocation,
} from "./responses-client.ts";

export const WEB_SEARCH_INSTRUCTIONS = "Search the web and answer only from the retrieved results. Cite sources.";

export type OpenAIWebSearchRequest = {
	query: string;
	model: string;
	limit?: number;
	search_context_size?: SearchContextSize;
	allowed_domains?: string[];
	user_location?: WebSearchUserLocation;
	/** Mapped Responses reasoning.effort; omit when thinking is off. */
	reasoningEffort?: string;
	signal?: AbortSignal;
};

export function buildOpenAIWebSearchRequest(request: OpenAIWebSearchRequest): Record<string, unknown> {
	const tool: Record<string, unknown> = {
		type: "web_search",
		external_web_access: true,
	};
	if (request.search_context_size) tool.search_context_size = request.search_context_size;

	const allowedDomains = cleanedStringList(request.allowed_domains);
	if (allowedDomains) tool.filters = { allowed_domains: allowedDomains };

	const userLocation = cleanedLocation(request.user_location);
	if (userLocation) tool.user_location = userLocation;

	const body: Record<string, unknown> = {
		model: request.model,
		input: messageInput(request.query),
		instructions: WEB_SEARCH_INSTRUCTIONS,
		tools: [tool],
		tool_choice: { type: "web_search" },
		stream: false,
		store: false,
	};
	if (request.reasoningEffort !== undefined) {
		body.reasoning = { effort: request.reasoningEffort };
	}
	return body;
}

export class OpenAIWebSearchSource {
	readonly client: ResponsesClient;

	constructor(client: ResponsesClient) {
		this.client = client;
	}

	async search(request: OpenAIWebSearchRequest): Promise<SearchBackendResponse> {
		const normalized = await this.client.post(buildOpenAIWebSearchRequest(request), {
			signal: request.signal,
			limit: request.limit,
			model: request.model,
		});
		if (!hasWebSearchSuccess(normalized)) {
			throw new SearchBackendError("invalid_response", "web search backend returned no answer or sources");
		}
		return normalized;
	}
}

import { asRecordArray, EXA_CONTENTS_URL, EXA_SEARCH_URL, nonEmptyString, postHostedJson, type HostedPage } from "./hosted-http.ts";
import { isRecord, SearchBackendError, type SearchBackendResponse, type WebSearchSource } from "./responses-client.ts";
import { resolveExaApiKey } from "./settings.ts";

export type ExaSearchParams = {
	query: string;
	limit?: number;
	allowed_domains?: string[];
	signal?: AbortSignal;
};

function requireExaKey(env: NodeJS.ProcessEnv): string {
	const apiKey = resolveExaApiKey(env);
	if (!apiKey) throw new SearchBackendError("missing_config", "No Exa search source is configured. Set EXA_API_KEY.");
	return apiKey;
}

function snippetFromResult(record: Record<string, unknown>): string | undefined {
	if (Array.isArray(record.highlights)) {
		const highlights = record.highlights.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		if (highlights.length > 0) return highlights.join("\n");
	}
	return nonEmptyString(record.text) ?? nonEmptyString(record.summary);
}

function sourceFromResult(record: Record<string, unknown>): WebSearchSource | undefined {
	const url = nonEmptyString(record.url);
	if (!url) return undefined;
	return {
		title: nonEmptyString(record.title) ?? url,
		url,
		snippet: snippetFromResult(record),
		publishedDate: nonEmptyString(record.publishedDate) ?? nonEmptyString(record.published_date),
	};
}

export async function searchWithExa(params: ExaSearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchBackendResponse> {
	const apiKey = requireExaKey(env);
	const body: Record<string, unknown> = {
		query: params.query,
		type: "auto",
		numResults: params.limit ?? 10,
		contents: { highlights: true },
	};
	const domains = params.allowed_domains?.map((item) => item.trim()).filter(Boolean);
	if (domains && domains.length > 0) body.includeDomains = domains;
	const raw = await postHostedJson(EXA_SEARCH_URL, body, { apiKey, signal: params.signal });
	if (!isRecord(raw)) throw new SearchBackendError("invalid_response", "Exa search returned a non-object response");
	const sources = asRecordArray(raw.results).map(sourceFromResult).filter((item): item is WebSearchSource => item !== undefined);
	if (sources.length === 0) throw new SearchBackendError("invalid_response", "Exa search returned no results");
	return { sources };
}

export async function fetchWithExa(url: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<HostedPage> {
	const apiKey = requireExaKey(env);
	const raw = await postHostedJson(EXA_CONTENTS_URL, { urls: [url], text: true }, { apiKey, signal });
	if (!isRecord(raw)) throw new SearchBackendError("invalid_response", "Exa contents returned a non-object response");
	const result = asRecordArray(raw.results)[0];
	if (!result) throw new SearchBackendError("invalid_response", "Exa contents returned no page");
	const content = nonEmptyString(result.text) ?? nonEmptyString(result.highlights && Array.isArray(result.highlights) ? result.highlights.join("\n") : undefined);
	if (!content) throw new SearchBackendError("invalid_response", "Exa contents returned empty text");
	const resolvedUrl = nonEmptyString(result.url) ?? url;
	return {
		url: resolvedUrl,
		title: nonEmptyString(result.title) ?? resolvedUrl,
		content,
	};
}

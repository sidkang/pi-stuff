import { asRecordArray, FIRECRAWL_SCRAPE_URL, FIRECRAWL_SEARCH_URL, nonEmptyString, postHostedJson, type HostedPage } from "./hosted-http.ts";
import { isRecord, SearchBackendError, type SearchBackendResponse, type WebSearchSource } from "./responses-client.ts";
import { resolveFirecrawlApiKey } from "./settings.ts";

export type FirecrawlSearchParams = {
	query: string;
	limit?: number;
	allowed_domains?: string[];
	signal?: AbortSignal;
};

function hostnameFromDomain(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return parsed.hostname || undefined;
	} catch {
		return trimmed.replace(/^https?:\/\//i, "").split("/")[0] || undefined;
	}
}

function webResults(raw: Record<string, unknown>): Record<string, unknown>[] {
	if (isRecord(raw.data) && Array.isArray(raw.data.web)) return asRecordArray(raw.data.web);
	if (Array.isArray(raw.web)) return asRecordArray(raw.web);
	if (Array.isArray(raw.data)) return asRecordArray(raw.data);
	return [];
}

function sourceFromResult(record: Record<string, unknown>): WebSearchSource | undefined {
	const url = nonEmptyString(record.url);
	if (!url) return undefined;
	return {
		title: nonEmptyString(record.title) ?? url,
		url,
		snippet: nonEmptyString(record.description) ?? nonEmptyString(record.markdown) ?? nonEmptyString(record.snippet),
	};
}

export async function searchWithFirecrawl(params: FirecrawlSearchParams, env: NodeJS.ProcessEnv = process.env): Promise<SearchBackendResponse> {
	const body: Record<string, unknown> = {
		query: params.query,
		limit: params.limit ?? 10,
	};
	const domains = params.allowed_domains?.map(hostnameFromDomain).filter((item): item is string => Boolean(item));
	if (domains && domains.length > 0) body.includeDomains = [...new Set(domains)];
	const raw = await postHostedJson(FIRECRAWL_SEARCH_URL, body, {
		apiKey: resolveFirecrawlApiKey(env),
		signal: params.signal,
	});
	if (!isRecord(raw)) throw new SearchBackendError("invalid_response", "Firecrawl search returned a non-object response");
	if (raw.success === false) {
		throw new SearchBackendError("backend_error", nonEmptyString(raw.error) ?? "Firecrawl search failed");
	}
	const sources = webResults(raw).map(sourceFromResult).filter((item): item is WebSearchSource => item !== undefined);
	if (sources.length === 0) throw new SearchBackendError("invalid_response", "Firecrawl search returned no results");
	return { sources };
}

export async function fetchWithFirecrawl(url: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<HostedPage> {
	const raw = await postHostedJson(FIRECRAWL_SCRAPE_URL, { url, formats: ["markdown"] }, {
		apiKey: resolveFirecrawlApiKey(env),
		signal,
	});
	if (!isRecord(raw)) throw new SearchBackendError("invalid_response", "Firecrawl scrape returned a non-object response");
	if (raw.success === false) {
		throw new SearchBackendError("backend_error", nonEmptyString(raw.error) ?? "Firecrawl scrape failed");
	}
	const data = isRecord(raw.data) ? raw.data : raw;
	const content = nonEmptyString(data.markdown);
	if (!content) throw new SearchBackendError("invalid_response", "Firecrawl scrape returned empty markdown");
	const metadata = isRecord(data.metadata) ? data.metadata : {};
	const resolvedUrl = nonEmptyString(metadata.sourceURL) ?? nonEmptyString(data.url) ?? url;
	return {
		url: resolvedUrl,
		title: nonEmptyString(metadata.title) ?? nonEmptyString(data.title) ?? resolvedUrl,
		content,
	};
}

import { buildRequestHeaders } from "./provider-headers.ts";
import type { Static } from "typebox";
import type { SearchOutputSchema } from "./result-schema.ts";

export type SearchContextSize = "low" | "medium" | "high";

export type WebSearchUserLocation = {
	type?: "approximate";
	country?: string;
	region?: string;
	city?: string;
	timezone?: string;
};

export type WebSearchSource = {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
};

export type WebSearchCitation = {
	title: string;
	url: string;
	citedText?: string;
};

export type WebSearchUsage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
};

export type SearchBackendResponse = {
	answer?: string;
	sources: WebSearchSource[];
	citations?: WebSearchCitation[];
	/** Structured citation/annotation URLs only; excludes answer-scraped links. */
	citationUrls?: string[];
	model?: string;
	requestId?: string;
	usage?: WebSearchUsage;
	outputItems?: unknown[];
};

export type SearchToolResult = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Static<typeof SearchOutputSchema>;
	details: {
		ok?: boolean;
		query?: string;
		model?: string;
		sourceCount?: number;
		code?: SearchErrorCode;
		[key: string]: unknown;
	};
};

export type SearchErrorCode =
	| "missing_config"
	| "auth_failed"
	| "rate_limited"
	| "unsupported_model"
	| "unsupported_tool"
	| "unsupported_tool_choice"
	| "backend_error"
	| "timeout"
	| "aborted"
	| "invalid_input"
	| "invalid_response";

export class SearchBackendError extends Error {
	readonly code: SearchErrorCode;
	readonly status?: number;

	constructor(code: SearchErrorCode, message: string, status?: number) {
		super(message);
		this.name = "SearchBackendError";
		this.code = code;
		this.status = status;
	}
}

export type ResponsesClientConfig = {
	baseUrl: string;
	apiKey?: string;
	/** Raw Pi ProviderHeaders; null values are deletion markers until request build. */
	headers?: Record<string, string | null>;
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

type NormalizeOptions = {
	answer?: string;
	limit?: number;
	model?: string;
	config?: ResponsesClientConfig;
};

const MAX_RAW_RESPONSE_BYTES = 1024 * 1024;
const MAX_BACKEND_ERROR_MESSAGE_CHARS = 1000;
const SAFE_CONFIGURED_HEADER_NAMES = new Set([
	"accept",
	"accept-encoding",
	"accept-language",
	"cache-control",
	"connection",
	"content-length",
	"content-type",
	"host",
	"pragma",
	"user-agent",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerLimit(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.trunc(value);
}

export function responsesUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/responses")) return normalized;
	return `${normalized}/responses`;
}

export function normalizeUrlForKey(url: string): string {
	const trimmed = url.trim();
	try {
		const parsed = new URL(trimmed);
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return trimmed;
	}
}

function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.hostname || url;
	} catch {
		return url;
	}
}

function tokenCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.trunc(value);
}

function usageFromRecord(record: Record<string, unknown>): WebSearchUsage | undefined {
	const inputTokens = tokenCount(record.inputTokens ?? record.input_tokens);
	const outputTokens = tokenCount(record.outputTokens ?? record.output_tokens);
	const totalTokens = tokenCount(record.totalTokens ?? record.total_tokens);
	if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
	return { inputTokens, outputTokens, totalTokens };
}

function requestHeaders(config: ResponsesClientConfig, extra: Record<string, string>): Record<string, string> {
	return buildRequestHeaders(config.headers, config.apiKey, extra);
}

export function cleanedStringList(values: string[] | undefined): string[] | undefined {
	const cleaned = (values ?? [])
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return cleaned.length > 0 ? cleaned : undefined;
}

export function cleanedLocation(value: WebSearchUserLocation | undefined): Record<string, string> | undefined {
	if (!value) return undefined;
	const result: Record<string, string> = {};
	const country = nonEmptyString(value.country);
	if (country && /^[a-z]{2}$/i.test(country)) result.country = country.toUpperCase();
	for (const key of ["region", "city", "timezone"] as const) {
		const text = nonEmptyString(value[key]);
		if (text) result[key] = text;
	}
	return Object.keys(result).length > 0 ? { type: "approximate", ...result } : undefined;
}

export function messageInput(query: string): Array<Record<string, unknown>> {
	return [{
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: query }],
	}];
}

function isWeakTitle(title: string | undefined, url: string): boolean {
	if (!title || title === url) return true;
	try {
		return title === new URL(url).hostname;
	} catch {
		return false;
	}
}

function addSource(map: Map<string, WebSearchSource>, source: WebSearchSource): void {
	const url = source.url.trim();
	if (!url) return;
	const key = normalizeUrlForKey(url);
	const existing = map.get(key);
	if (!existing) {
		map.set(key, { ...source, url });
		return;
	}
	if (isWeakTitle(existing.title, existing.url) && source.title && !isWeakTitle(source.title, source.url)) existing.title = source.title;
	if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
	if (!existing.publishedDate && source.publishedDate) existing.publishedDate = source.publishedDate;
}

function addCitation(map: Map<string, WebSearchCitation>, citation: WebSearchCitation): void {
	const url = citation.url.trim();
	if (!url) return;
	const key = normalizeUrlForKey(url);
	const existing = map.get(key);
	if (!existing) {
		map.set(key, { ...citation, url });
		return;
	}
	if (isWeakTitle(existing.title, existing.url) && citation.title && !isWeakTitle(citation.title, citation.url)) existing.title = citation.title;
	if (!existing.citedText && citation.citedText) existing.citedText = citation.citedText;
}

function sourceFromRecord(record: Record<string, unknown>): WebSearchSource | undefined {
	const url = nonEmptyString(record.url);
	if (!url) return undefined;
	return {
		title: nonEmptyString(record.title ?? record.name) ?? url,
		url,
		snippet: nonEmptyString(record.snippet ?? record.description),
		publishedDate: nonEmptyString(record.publishedDate ?? record.published_date),
	};
}

function citationFromRecord(record: Record<string, unknown>): WebSearchCitation | undefined {
	const url = nonEmptyString(record.url);
	if (!url) return undefined;
	return {
		title: nonEmptyString(record.title ?? record.name) ?? url,
		url,
		citedText: nonEmptyString(record.citedText ?? record.cited_text ?? record.text),
	};
}

function collectSourceNode(value: unknown, sources: Map<string, WebSearchSource>): void {
	if (!isRecord(value)) return;
	const source = sourceFromRecord(value);
	if (source) addSource(sources, source);
}

function citationFromUrlString(value: unknown): WebSearchCitation | undefined {
	const url = nonEmptyString(value);
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return { title: titleFromUrl(url), url };
	} catch {
		return undefined;
	}
}

function collectCitationNode(value: unknown, sources: Map<string, WebSearchSource>, citations: Map<string, WebSearchCitation>): void {
	const fromString = citationFromUrlString(value);
	const citation = fromString ?? (isRecord(value) ? citationFromRecord(value) : undefined);
	if (!citation) return;
	addCitation(citations, citation);
	addSource(sources, citation.citedText
		? { title: citation.title, url: citation.url, snippet: citation.citedText }
		: { title: citation.title, url: citation.url });
}

function collectAnnotation(value: unknown, sources: Map<string, WebSearchSource>, citations: Map<string, WebSearchCitation>): void {
	if (!isRecord(value)) return;
	if (value.type === "url_citation") {
		collectCitationNode(value, sources, citations);
		return;
	}
	if (isRecord(value.url_citation)) collectCitationNode(value.url_citation, sources, citations);
}

function collectTextLinks(text: string, sources: Map<string, WebSearchSource>): void {
	const markdown = /\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g;
	for (const match of text.matchAll(markdown)) {
		const title = match[1]?.trim() || match[2]!;
		addSource(sources, { title, url: match[2]! });
	}

	const bare = /https?:\/\/[^\s<>)\]]+/g;
	for (const match of text.matchAll(bare)) {
		const url = match[0].replace(/[.,;:!?]+$/g, "");
		addSource(sources, { title: titleFromUrl(url), url });
	}
}

function dedupeTexts(texts: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const text of texts) {
		const trimmed = text.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void, seen = new Set<unknown>()): void {
	if (!isRecord(value) && !Array.isArray(value)) return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit, seen);
		return;
	}
	visit(value);
	for (const child of Object.values(value)) walk(child, visit, seen);
}

export function normalizeBackendResponse(raw: unknown, options: NormalizeOptions = {}): SearchBackendResponse {
	const texts: string[] = [];
	const sources = new Map<string, WebSearchSource>();
	const citations = new Map<string, WebSearchCitation>();
	const outputItems: unknown[] = [];
	let model = options.model;
	// JSON uses the root envelope; streams wrap the completed response in `response`.
	// Output items also have IDs, but those are not request metadata.
	const envelope = isRecord(raw) && isRecord(raw.response) ? raw.response : raw;
	const requestId = isRecord(envelope) ? nonEmptyString(envelope.id) : undefined;
	let usage: WebSearchUsage | undefined;

	walk(raw, (record) => {
		if (typeof record.output_text === "string") texts.push(record.output_text);
		if (record.type === "output_text" && typeof record.text === "string") {
			texts.push(record.text);
			if (Array.isArray(record.annotations)) {
				for (const annotation of record.annotations) collectAnnotation(annotation, sources, citations);
			}
		}
		if (record.type === "url_citation") collectAnnotation(record, sources, citations);
		if (Array.isArray(record.sources)) {
			for (const source of record.sources) collectSourceNode(source, sources);
		}
		if (Array.isArray(record.citations)) {
			for (const citation of record.citations) collectCitationNode(citation, sources, citations);
		}
		if (Array.isArray(record.output)) {
			for (const item of record.output) outputItems.push(item);
		}
		if (!model && typeof record.model === "string") model = record.model;
		if (!usage && isRecord(record.usage)) usage = usageFromRecord(record.usage);
	});

	const walkedAnswer = dedupeTexts(texts).join("\n").trim();
	const answer = options.answer?.trim() || walkedAnswer || undefined;
	if (answer) collectTextLinks(answer, sources);

	const limit = integerLimit(options.limit);
	const sourceList = [...sources.values()];
	const citationList = [...citations.values()];
	const citationUrls = citationList.map((citation) => citation.url);
	return {
		answer,
		sources: limit ? sourceList.slice(0, limit) : sourceList,
		citations: limit ? citationList.slice(0, limit) : citationList,
		citationUrls: limit ? citationUrls.slice(0, limit) : citationUrls,
		model,
		requestId,
		usage,
		outputItems,
	};
}

function isToolChoiceShapeFailure(text: string): boolean {
	return /tool[_\s-]?choice|modeltoolchoice/i.test(text);
}

function isUnsupportedToolWording(text: string): boolean {
	return /unsupported[_\s-]*tool|unknown tool|tool[^\n]{0,80}(not supported|unsupported)/i.test(text)
		|| /(?:web_search|x_search)[^\n]{0,80}(not supported|unsupported)/i.test(text);
}

function isUnsupportedModelWording(text: string): boolean {
	return /unsupported[_\s-]*model|unknown model|model[^\n]{0,80}(not supported|unsupported|not found|does not exist)/i.test(text);
}

export function isRetryableToolChoiceError(error: unknown): boolean {
	if (!(error instanceof SearchBackendError)) return false;
	if (error.status !== 400 && error.status !== 422) return false;
	if (error.code === "unsupported_tool_choice") return true;
	return isToolChoiceShapeFailure(error.message);
}

function errorCodeForHttpStatus(status: number, body: string): SearchErrorCode {
	const text = body.toLowerCase();
	if (status === 401 || status === 403) return "auth_failed";
	if (status === 408) return "timeout";
	if (status === 429) return "rate_limited";
	if (status === 400 || status === 422) {
		if (isToolChoiceShapeFailure(text)) return "unsupported_tool_choice";
		if (isUnsupportedToolWording(text)) return "unsupported_tool";
		if (isUnsupportedModelWording(text)) return "unsupported_model";
		return "invalid_input";
	}
	if (status === 404 && /model/.test(text)) return "unsupported_model";
	return "backend_error";
}

function boundedBackendErrorMessage(message: string): string {
	return message.slice(0, MAX_BACKEND_ERROR_MESSAGE_CHARS);
}

function collectConfiguredSecrets(config: ResponsesClientConfig): string[] {
	const secrets = new Set<string>();
	addConfiguredSecret(secrets, config.apiKey);
	addConfiguredUrlCredentials(secrets, config.baseUrl);
	for (const [name, value] of Object.entries(config.headers ?? {})) {
		if (typeof value !== "string" || value.length === 0) continue;
		if (SAFE_CONFIGURED_HEADER_NAMES.has(name.toLowerCase())) continue;
		addConfiguredSecret(secrets, value);
	}
	return [...secrets];
}

function addConfiguredUrlCredentials(secrets: Set<string>, baseUrl: string): void {
	try {
		const parsed = new URL(baseUrl);
		if (!parsed.username && !parsed.password) return;
		const encodedUserinfo = parsed.href.match(/^https?:\/\/([^@/]+)@/i)?.[1];
		if (encodedUserinfo) secrets.add(encodedUserinfo);
		if (parsed.username) secrets.add(parsed.username);
		if (parsed.password) secrets.add(parsed.password);
	} catch {
		// Ignore unparseable configured URLs; they cannot contribute userinfo secrets.
	}
}

function addConfiguredSecret(secrets: Set<string>, value: unknown): void {
	if (typeof value !== "string" || value.length === 0) return;
	secrets.add(value);
	const schemeMatch = /^(Bearer|Basic)\s+(\S+)$/i.exec(value.trim());
	if (schemeMatch?.[2]) {
		secrets.add(schemeMatch[2]);
		return;
	}
	if (!/^Bearer\s+/i.test(value) && value.trim()) {
		secrets.add(`Bearer ${value.trim()}`);
	}
}

export function redactSensitiveText(text: string, config: ResponsesClientConfig): string {
	let result = text;
	const secrets = collectConfiguredSecrets(config).sort((left, right) => right.length - left.length);
	for (const secret of secrets) {
		result = result.split(secret).join("[redacted]");
	}
	result = result.replace(/(Bearer|Basic)\s+\S+/gi, "$1 [redacted]");
	result = result.replace(
		/(['"]?(?:authorization|api[_-]?key|token|secret|cookie|credential)['"]?\s*[:=]\s*)(['"])([^'"]*)\2/gi,
		"$1$2[redacted]$2",
	);
	result = result.replace(
		/\b((?:authorization|api[_-]?key|token|secret|cookie|credential)\s*[:=]\s*)(?!['"])(\S+)/gi,
		"$1[redacted]",
	);
	return result;
}

function redactSearchBackendError(error: SearchBackendError, config: ResponsesClientConfig): SearchBackendError {
	const redacted = redactSensitiveText(error.message, config);
	const message = boundedBackendErrorMessage(redacted);
	if (message === error.message) return error;
	return new SearchBackendError(error.code, message, error.status);
}

function responseTooLargeError(): SearchBackendError {
	return new SearchBackendError("invalid_response", "web search response exceeded the 1 MiB size limit");
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
			if (bytes > MAX_RAW_RESPONSE_BYTES) throw responseTooLargeError();
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

async function responseError(response: Response): Promise<SearchBackendError> {
	const body = await readResponseText(response);
	let message = body || response.statusText || "web search request failed";
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed?.error?.message === "string") message = parsed.error.message;
		else if (typeof parsed?.message === "string") message = parsed.message;
	} catch {
		// Use raw body above.
	}
	const code = errorCodeForHttpStatus(response.status, message);
	return new SearchBackendError(code, `HTTP ${response.status}: ${message}`, response.status);
}

function extractEventData(frame: string): string | undefined {
	const payload = frame
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!payload || payload === "[DONE]") return undefined;
	return payload;
}

function eventErrorMessage(event: Record<string, unknown>): string {
	if (typeof event.message === "string") return event.message;
	if (isRecord(event.error) && typeof event.error.message === "string") return event.error.message;
	if (isRecord(event.response) && isRecord(event.response.error) && typeof event.response.error.message === "string") return event.response.error.message;
	return "web search stream failed";
}

export async function readSearchStream(response: Response, options: NormalizeOptions = {}): Promise<SearchBackendResponse> {
	if (!response.body) throw new SearchBackendError("invalid_response", "web search stream response did not include a body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const outputItems: unknown[] = [];
	let completedResponse: unknown;
	let text = "";
	let buffer = "";
	let bytes = 0;
	let completed = false;
	const processSearchStreamFrame = (frame: string) => {
		const data = extractEventData(frame);
		if (!data) return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			throw new SearchBackendError("invalid_response", "web search stream returned non-JSON event data");
		}
		if (!isRecord(event)) throw new SearchBackendError("invalid_response", "web search stream returned non-object event data");
		if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
		else if (event.type === "response.output_item.done") outputItems.push(event.item);
		else if (event.type === "response.completed" || event.type === "response.done") completedResponse = event.response ?? event;
		else if (event.type === "response.failed" || event.type === "error") {
			throw redactSearchBackendError(
				new SearchBackendError("backend_error", eventErrorMessage(event)),
				options.config ?? { baseUrl: "" },
			);
		}
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				completed = true;
				break;
			}
			bytes += value.byteLength;
			if (bytes > MAX_RAW_RESPONSE_BYTES) throw responseTooLargeError();
			buffer += decoder.decode(value, { stream: true });
			let separator = /\r?\n\r?\n/.exec(buffer);
			while (separator) {
				processSearchStreamFrame(buffer.slice(0, separator.index));
				buffer = buffer.slice(separator.index + separator[0].length);
				separator = /\r?\n\r?\n/.exec(buffer);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) processSearchStreamFrame(buffer);

		const raw = { output: outputItems, response: completedResponse };
		return normalizeBackendResponse(raw, { ...options, answer: text.trim() || options.answer });
	} finally {
		try {
			if (!completed) await reader.cancel().catch(() => undefined);
		} finally {
			reader.releaseLock();
		}
	}
}

export function formatSearchToolText(answer: string | undefined, sources: WebSearchSource[]): string {
	const sections: string[] = [];
	if (answer?.trim()) sections.push(answer.trim());
	if (sources.length > 0) {
		const entries = sources.map((source, index) => {
			const lines = [`[${index + 1}] ${source.title}`, source.url];
			const snippet = source.snippet?.trim();
			if (snippet) lines.push(snippet);
			return lines.join("\n");
		});
		sections.push(["Sources:", ...entries].join("\n"));
	}
	return sections.join("\n\n") || "No answer or sources returned.";
}

export function searchToolResult(query: string, response: SearchBackendResponse, details: Record<string, unknown> = {}): SearchToolResult {
	return {
		content: [{ type: "text", text: formatSearchToolText(response.answer, response.sources) }],
		structuredContent: {
			query, answer: response.answer ?? "", sources: response.sources,
			citations: response.citations ?? [], citationUrls: response.citationUrls ?? [],
			...Object.fromEntries(["source", "provider", "model", "api", "elapsedMs", "timeoutMs"]
				.filter((key) => details[key] !== undefined).map((key) => [key, details[key]])),
			...(response.model && !details.model ? { model: response.model } : {}),
			...(response.requestId ? { requestId: response.requestId } : {}),
			...(response.usage ? { usage: response.usage } : {}),
		},
		details: {
			...details,
			sourceCount: response.sources.length,
			ok: true,
		},
	};
}

export function hasWebSearchSuccess(response: SearchBackendResponse): boolean {
	return Boolean(response.answer?.trim()) || response.sources.length > 0;
}

export class ResponsesClient {
	readonly config: ResponsesClientConfig;

	constructor(config: ResponsesClientConfig) {
		this.config = config;
	}

	async post(body: Record<string, unknown>, options: { signal?: AbortSignal; limit?: number; model?: string } = {}): Promise<SearchBackendResponse> {
		try {
			const fetchImpl = this.config.fetchImpl ?? fetch;
			const model = options.model ?? (typeof body.model === "string" ? body.model : undefined);
			const response = await fetchImpl(responsesUrl(this.config.baseUrl), {
				method: "POST",
				signal: options.signal,
				headers: requestHeaders(this.config, { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
				body: JSON.stringify(body),
			});
			if (!response.ok) throw await responseError(response);

			const contentType = response.headers.get("content-type") ?? "";
			if (/text\/event-stream/i.test(contentType)) {
				return await readSearchStream(response, { model, limit: options.limit, config: this.config });
			}

			const text = await readResponseText(response);
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				throw new SearchBackendError("invalid_response", "web search backend returned non-JSON response");
			}
			return normalizeBackendResponse(raw, { model, limit: options.limit });
		} catch (error) {
			if (error instanceof SearchBackendError) throw redactSearchBackendError(error, this.config);
			if ((error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "TimeoutError")) {
				throw error;
			}
			if (error instanceof Error) {
				throw new SearchBackendError(
					"backend_error",
					boundedBackendErrorMessage(redactSensitiveText(error.message, this.config)),
				);
			}
			throw error;
		}
	}
}

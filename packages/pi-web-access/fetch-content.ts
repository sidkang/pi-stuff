import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { capturePageWithCdp, type CapturePageOptions, type CapturedPage } from "./cdp-fetch.ts";
import { fetchWithExa } from "./exa.ts";
import {
	ExtractionKernelError,
	isAbortError,
	isTimeoutError,
	resolveExtractionKernel,
	runExtractionKernels,
	type ExtractionKernelName,
	type KernelExtraction,
	type RunExtractionKernelsOptions,
} from "./extract-kernels.ts";
import { fetchWithFirecrawl } from "./firecrawl.ts";
import { createFetchRenderers } from "./fetch-presentation.ts";
import { SearchBackendError } from "./responses-client.ts";
import {
	DEFAULT_FETCH_EXTRACT_KERNEL,
	DEFAULT_FETCH_SOURCE,
	DEFAULT_MAX_INLINE_CHARS,
	FETCH_TIMEOUT_MS,
	fetchSourceMissingMessage,
	isFetchSourceConfigured,
	normalizeMaxInlineChars,
	processEnvFromContext,
	readWebAccessSettings,
	resolveCdpApiKey,
	resolveCdpEndpoint,
	type FetchSourceName,
	type PluginSettingsContext,
} from "./settings.ts";
import { createSourceDeadline } from "./source-deadline.ts";
import { createToolErrorDetailsBridge } from "./tool-error-details.ts";
import { parseFetchUrl } from "./url-guard.ts";
import { createCompleteOutputStore } from "./complete-output.ts";
import { FetchOutputSchema, WEB_READ_ANNOTATIONS } from "./result-schema.ts";

type CapturePageFn = (options: CapturePageOptions) => Promise<CapturedPage>;
type RunKernelsFn = (options: RunExtractionKernelsOptions) => Promise<KernelExtraction>;

let testCapturePage: CapturePageFn | undefined;
let testRunKernels: RunKernelsFn | undefined;

export function setFetchContentDepsForTests(deps?: {
	capturePage?: CapturePageFn;
	runKernels?: RunKernelsFn;
}): void {
	testCapturePage = deps?.capturePage;
	testRunKernels = deps?.runKernels;
}

const FETCH_EXTRACTION_KERNELS = ["defuddle", "html-extractor", "llm"] as const;
const FETCH_SOURCES = ["cdp", "exa", "firecrawl"] as const;

const FetchContentParams = Type.Object({
	url: Type.String({ minLength: 1, description: "HTTP(S) URL to fetch and extract as markdown." }),
	provider: Type.Optional(StringEnum(FETCH_SOURCES, {
		description: "Fetch source: cdp, exa, or firecrawl. Omit to use webAccess.fetch.defaultProvider or cdp.",
	})),
	kernel: Type.Optional(StringEnum(FETCH_EXTRACTION_KERNELS, {
		description: "Extraction kernel to try first for cdp: defuddle, html-extractor, or llm. Overrides the configured default. Ignored for exa and firecrawl.",
	})),
}, { additionalProperties: false });

type FetchContentParams = Static<typeof FetchContentParams>;

export type FetchContentDetails = {
	requestedUrl: string;
	url: string;
	title: string;
	totalChars: number;
	returnedChars: number;
	truncated: boolean;
	source: FetchSourceName;
	kernel?: ExtractionKernelName;
	totalBytes?: number;
	structuredChars?: number;
	structuredTruncated?: boolean;
	fullOutputPath?: string;
	retrievedAt?: string;
	elapsedMs?: number;
};

export type FetchContentPartialDetails = {
	requestedUrl: string;
	url: string;
	title: string;
	totalChars: number;
	returnedChars: number;
	truncated: boolean;
	source: FetchSourceName;
	kernel?: ExtractionKernelName;
	phase: string;
	startedAt: number;
	elapsedMs: number;
	timeoutMs: number;
};

export type FetchContentToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: FetchContentDetails | FetchContentPartialDetails;
};

class FetchContentError extends Error {
	code: string;

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options?.cause instanceof Error ? { cause: options.cause } : undefined);
		this.name = "FetchContentError";
		this.code = code;
	}
}

function settingsContext(ctx?: ExtensionContext): PluginSettingsContext | undefined {
	if (!ctx) return undefined;
	const result: PluginSettingsContext = {};
	if (typeof ctx.cwd === "string") result.cwd = ctx.cwd;
	if (typeof ctx.isProjectTrusted === "function") result.isProjectTrusted = () => ctx.isProjectTrusted();
	return result;
}

export function initialContentSlice(content: string, maxChars: number): {
	text: string;
	endOffset: number;
	totalChars: number;
	returnedChars: number;
	truncated: boolean;
} {
	const limit = normalizeMaxInlineChars(maxChars);
	let endOffset = Math.min(content.length, limit);
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(limit * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalChars: content.length,
		returnedChars: text.length,
		truncated: endOffset < content.length,
	};
}

function hostedFetchError(error: unknown): FetchContentError {
	if (error instanceof FetchContentError) return error;
	if (error instanceof SearchBackendError) return new FetchContentError(error.code, error.message, { cause: error });
	return new FetchContentError("backend_error", error instanceof Error ? error.message : String(error), { cause: error });
}

export default function fetchContent(pi: ExtensionAPI) {
	const errorDetails = createToolErrorDetailsBridge("fetch_content");
	errorDetails.install(pi);
	const renderers = createFetchRenderers();
	const completeOutput = createCompleteOutputStore();
	pi.on("session_shutdown", () => completeOutput.clear());

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch and extract readable markdown from a URL through CDP, Exa, or Firecrawl.",
		promptSnippet: "Fetch one URL and extract main readable markdown. CDP uses a logged-in browser; Exa and Firecrawl fetch public pages.",
		promptGuidelines: [
			"Use fetch_content to read a web page.",
			"Always provide a single http(s) URL.",
			"Set provider to cdp when a logged-in browser is required. Set provider to exa or firecrawl for public pages.",
			"kernel only applies to cdp.",
			"There is no fetch fallback across sources.",
		],
		parameters: FetchContentParams,
		outputSchema: FetchOutputSchema,
		annotations: WEB_READ_ANNOTATIONS,
		renderShell: "self",
		async execute(
			toolCallId: string,
			params: FetchContentParams,
			signal: AbortSignal | undefined,
			onUpdate: ((result: FetchContentToolResult) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const startedAt = Date.now();
			const deadlineAt = startedAt + FETCH_TIMEOUT_MS;
			// One shared deadline for discovery, capture, and every kernel attempt.
			// Use remaining budget so pre-capture work still consumes the 60s window.
			const remainingTimeoutMs = Math.max(1, deadlineAt - Date.now());
			const operationSignal = createSourceDeadline(signal, { timeoutMs: remainingTimeoutMs });
			const { settings } = readWebAccessSettings(settingsContext(ctx));
			const maxInlineChars = settings.fetchMaxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
			const selectedKernel = resolveExtractionKernel(params.kernel ?? settings.fetchExtractKernel ?? DEFAULT_FETCH_EXTRACT_KERNEL);
			const env = processEnvFromContext(ctx);
			const fetchSource = params.provider ?? settings.fetchDefaultProvider ?? DEFAULT_FETCH_SOURCE;
			const endpoint = resolveCdpEndpoint(settings, env);
			const apiKey = resolveCdpApiKey(env);
			const publishPartial = (phase: string) => onUpdate?.({
				content: [{ type: "text", text: phase }],
				details: {
					requestedUrl: params.url,
					url: params.url,
					title: "",
					totalChars: 0,
					returnedChars: 0,
					truncated: false,
					source: fetchSource,
					...(fetchSource === "cdp" ? { kernel: selectedKernel } : {}),
					phase,
					startedAt,
					elapsedMs: Date.now() - startedAt,
					timeoutMs: FETCH_TIMEOUT_MS,
				},
			});
			publishPartial("Fetching...");
			const ticker = setInterval(() => publishPartial("Fetching..."), 1000);

			try {
				if (operationSignal.aborted) {
					throw operationSignal.reason instanceof Error
						? operationSignal.reason
						: new DOMException("This operation was aborted", "AbortError");
				}
				if (!isFetchSourceConfigured(fetchSource, settings, env)) {
					throw new FetchContentError("missing_config", fetchSourceMissingMessage(fetchSource));
				}

				const parsedUrl = parseFetchUrl(params.url);
				if (parsedUrl.ok !== true) {
					throw new FetchContentError("invalid_input", parsedUrl.message);
				}

				let pageUrl = parsedUrl.url.toString();
				let title = "";
				let content: string;
				let kernel: ExtractionKernelName | undefined;

				if (fetchSource === "cdp") {
					publishPartial("Connecting to browser...");
					const capture = testCapturePage ?? capturePageWithCdp;
					const page = await capture({
						connection: {
							endpoint: endpoint!,
							...(apiKey ? { apiKey } : {}),
						},
						url: params.url,
						signal: operationSignal,
						deadlineAt,
					});
					publishPartial("Extracting...");
					const runKernels = testRunKernels ?? runExtractionKernels;
					const extracted = await runKernels({
						selected: selectedKernel,
						html: page.html,
						url: page.url,
						requestedUrl: page.requestedUrl,
						titleHint: page.title,
						signal: operationSignal,
						deadlineAt,
						extractModel: settings.fetchExtractModel,
						modelRegistry: ctx.modelRegistry,
						llmSelectedDirectly: selectedKernel === "llm",
					});
					pageUrl = page.url;
					title = extracted.title || page.title || "";
					content = extracted.content;
					kernel = extracted.kernel;
				} else {
					publishPartial("Fetching...");
					try {
						const page = fetchSource === "exa"
							? await fetchWithExa(parsedUrl.url.toString(), env, operationSignal)
							: await fetchWithFirecrawl(parsedUrl.url.toString(), env, operationSignal);
						pageUrl = page.url;
						title = page.title;
						content = page.content;
					} catch (error) {
						throw hostedFetchError(error);
					}
				}
				const complete = await completeOutput.prepare(content, operationSignal);
				if (operationSignal.aborted) throw operationSignal.reason;
				const slice = initialContentSlice(content, maxInlineChars);
				let text = slice.text;
				if (slice.truncated) {
					text += `\n\n---\nShowing ${slice.returnedChars} of ${slice.totalChars} characters. ${complete.fullOutputPath ? `Complete markdown: ${complete.fullOutputPath} (temporary, available until session shutdown).` : "Complete markdown is available in structuredContent.markdown to programmatic callers."}`;
				}
				const details: FetchContentDetails = {
					requestedUrl: params.url,
					url: pageUrl,
					title,
					totalChars: slice.totalChars,
					returnedChars: slice.returnedChars,
					truncated: slice.truncated,
					source: fetchSource,
					...(kernel ? { kernel } : {}),
					totalBytes: complete.totalBytes,
					structuredChars: complete.structuredChars,
					structuredTruncated: complete.structuredTruncated,
					...(complete.fullOutputPath ? { fullOutputPath: complete.fullOutputPath } : {}),
					retrievedAt: new Date().toISOString(),
					elapsedMs: Date.now() - startedAt,
				};
				return {
					content: [{ type: "text", text }],
					details,
					structuredContent: { ...details, markdown: complete.markdown },
				};
			} catch (error) {
				const timedOut = isTimeoutError(error)
					|| isTimeoutError(operationSignal.reason)
					|| (operationSignal.aborted && isTimeoutError(operationSignal.reason));
				const aborted = isAbortError(error)
					|| signal?.aborted
					|| (operationSignal.aborted && isAbortError(operationSignal.reason));
				const typed = error instanceof FetchContentError || error instanceof ExtractionKernelError
					? error
					: undefined;
				const message = aborted
					? "fetch_content was aborted"
					: timedOut
						? "fetch_content timed out"
						: typed?.message
							?? (error instanceof Error ? error.message : String(error));
				const code = aborted
					? "aborted"
					: timedOut
						? "timeout"
						: typed?.code ?? "backend_error";
				errorDetails.record(toolCallId, {
					ok: false,
					error: message,
					code,
					elapsedMs: Date.now() - startedAt,
					timeoutMs: FETCH_TIMEOUT_MS,
				});
				throw new Error(message, { cause: error instanceof Error ? error : undefined });
			} finally {
				clearInterval(ticker);
			}
		},
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
	});
}

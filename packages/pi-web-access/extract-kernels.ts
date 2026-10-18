import { normalizeMarkdown } from "./extract-defuddle.ts";
import { ExtractionKernelError } from "./extract-error.ts";
import {
	extractWithLlm,
	type LlmModelRegistry,
} from "./extract-llm.ts";
import { runLocalExtractionJob } from "./extract-local-job.ts";
import type { QualifiedModel } from "./models.ts";
import { raceWithSignal } from "./source-deadline.ts";

export { ExtractionKernelError } from "./extract-error.ts";

export type ExtractionKernelName = "defuddle" | "html-extractor" | "llm";
export type RunnableLocalKernel = "defuddle" | "html-extractor";
export type RunnableKernel = RunnableLocalKernel | "llm";

export type KernelExtraction = {
	kernel: RunnableKernel;
	title: string;
	content: string;
};

export type LocalKernelRunner = (html: string, url: string) => Promise<{ title?: string; content: string }>;

export type LlmKernelRunner = (input: {
	html: string;
	url: string;
	requestedUrl?: string;
	titleHint?: string;
	model: QualifiedModel;
	modelRegistry: LlmModelRegistry;
	signal?: AbortSignal;
	deadlineAt?: number;
}) => Promise<{ title?: string; content: string }>;

export type RunExtractionKernelsOptions = {
	selected: ExtractionKernelName;
	html: string;
	url: string;
	requestedUrl?: string;
	titleHint?: string;
	signal?: AbortSignal;
	/** Absolute deadline from the original fetch_content call. */
	deadlineAt?: number;
	/** Provider-qualified extract model; required for a runnable llm kernel. */
	extractModel?: QualifiedModel;
	/** Model Registry used only when the llm kernel runs. */
	modelRegistry?: LlmModelRegistry;
	/** When true, llm was selected directly and missing model fails clearly. */
	llmSelectedDirectly?: boolean;
	runners?: Partial<Record<RunnableLocalKernel, LocalKernelRunner>>;
	llmRunner?: LlmKernelRunner;
};

const MAX_KERNEL_AGGREGATE_CHARS = 1000;

/** Safe labels for aggregate diagnostics; never echo provider/library/page text. */
function kernelEmptyLabel(kernel: string): string {
	return `${kernel}: empty markdown`;
}

function kernelFailedLabel(kernel: string): string {
	return `${kernel}: failed`;
}

function publicKernelError(error: unknown, fallbackCode = "backend_error"): ExtractionKernelError {
	if (error instanceof ExtractionKernelError) {
		// Only trust already-classified kernel errors with non-page-derived codes.
		return error;
	}
	return new ExtractionKernelError(fallbackCode, "llm completion failed", {
		cause: error instanceof Error ? error : undefined,
	});
}

export function isAbortError(error: unknown): boolean {
	// Only true AbortError names stop fallback. Ordinary local exceptions that
	// mention "aborted" in the message must fall through to the next kernel.
	return (error instanceof Error || error instanceof DOMException) && error.name === "AbortError";
}

export function isTimeoutError(error: unknown): boolean {
	// AbortSignal.timeout() uses TimeoutError; do not match bare message text.
	return (error instanceof Error || error instanceof DOMException) && error.name === "TimeoutError";
}

function shouldStopKernelFallback(error: unknown, signal: AbortSignal | undefined): boolean {
	if (isAbortError(error) || isTimeoutError(error)) return true;
	if (!signal?.aborted) return false;
	const reason = signal.reason;
	return isAbortError(reason) || isTimeoutError(reason) || reason === undefined;
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("This operation was aborted", "AbortError");
}

export function parseExtractionKernel(value: unknown): ExtractionKernelName | "invalid" | undefined {
	if (value === undefined) return undefined;
	if (value === "defuddle" || value === "html-extractor" || value === "llm") return value;
	return "invalid";
}

export function resolveExtractionKernel(value: ExtractionKernelName | undefined): ExtractionKernelName {
	return value ?? "defuddle";
}

export function kernelsFromSelection(selected: ExtractionKernelName): ExtractionKernelName[] {
	if (selected === "html-extractor") return ["html-extractor", "llm"];
	if (selected === "llm") return ["llm"];
	return ["defuddle", "html-extractor", "llm"];
}

/**
 * Default local normalize/extract runs in a dedicated worker thread so AbortSignal
 * can terminate synchronous parseHTML/Defuddle(useAsync:false)/Han typography work.
 * Custom `runners` stay in-process for tests. LLM stays on the main thread.
 */
async function normalizeHtmlInterruptibly(html: string, signal: AbortSignal | undefined): Promise<string> {
	throwIfSignalAborted(signal);
	const { hasHanTypographyWrappers } = await import("./extract-html-normalize.ts");
	// Cheap no-op stays on the main thread; only DOM-heavy Han unwrap needs a killable worker.
	if (!hasHanTypographyWrappers(html)) return html;
	const result = await runLocalExtractionJob<{ html: string }>({ op: "normalize", html }, { signal });
	return result.html;
}

async function runDefaultLocalKernelInterruptibly(
	kernel: RunnableLocalKernel,
	html: string,
	url: string,
	signal: AbortSignal | undefined,
): Promise<{ title?: string; content: string }> {
	return await runLocalExtractionJob<{ title?: string; content: string }>(
		{ op: "extract", kernel, html, url },
		{ signal },
	);
}

async function defaultLlmRunner(input: {
	html: string;
	url: string;
	requestedUrl?: string;
	titleHint?: string;
	model: QualifiedModel;
	modelRegistry: LlmModelRegistry;
	signal?: AbortSignal;
	deadlineAt?: number;
}): Promise<{ title?: string; content: string }> {
	const result = await extractWithLlm({
		html: input.html,
		url: input.url,
		requestedUrl: input.requestedUrl,
		titleHint: input.titleHint,
		model: input.model,
		modelRegistry: input.modelRegistry,
		signal: input.signal,
		deadlineAt: input.deadlineAt,
	});
	return { title: result.title, content: result.content };
}

function missingExtractModelMessage(direct: boolean): string {
	return direct
		? "No extract model is configured for the llm Extraction Kernel. Set webAccess.fetch.extract.model to a provider-qualified model."
		: "llm Extraction Kernel is not configured (missing webAccess.fetch.extract.model).";
}

export async function runExtractionKernels(options: RunExtractionKernelsOptions): Promise<KernelExtraction> {
	const chain = kernelsFromSelection(options.selected);
	const attempted: string[] = [];
	const failures: string[] = [];
	const llmDirect = options.llmSelectedDirectly ?? options.selected === "llm";
	// Abort before any HTML parse/normalize work so an already-expired signal cannot spend time on linkedom.
	throwIfSignalAborted(options.signal);
	// Normalize once for all kernels in a killable worker (sync linkedom work is otherwise unpreemptable).
	const html = await normalizeHtmlInterruptibly(options.html, options.signal);

	for (const kernel of chain) {
		throwIfSignalAborted(options.signal);

		if (kernel === "llm") {
			if (!options.extractModel) {
				if (llmDirect) {
					throw new ExtractionKernelError("missing_config", missingExtractModelMessage(true));
				}
				// Reached from a local selection: skip unconfigured llm.
				failures.push(missingExtractModelMessage(false));
				continue;
			}
			if (!options.modelRegistry && !options.llmRunner) {
				if (llmDirect) {
					throw new ExtractionKernelError(
						"missing_config",
						"Model Registry is unavailable for the llm Extraction Kernel.",
					);
				}
				failures.push("llm: Model Registry is unavailable");
				continue;
			}

			attempted.push(kernel);
			const runner = options.llmRunner ?? defaultLlmRunner;
			try {
				const result = await raceWithSignal(
					Promise.resolve().then(() => runner({
						html,
						url: options.url,
						requestedUrl: options.requestedUrl,
						titleHint: options.titleHint,
						model: options.extractModel,
						modelRegistry: options.modelRegistry as LlmModelRegistry,
						signal: options.signal,
						deadlineAt: options.deadlineAt,
					})),
					options.signal,
				);
				const content = normalizeMarkdown(result.content);
				if (!content) {
					// Empty llm output is a failed llm attempt.
					if (llmDirect) {
						throw new ExtractionKernelError("backend_error", "llm returned empty markdown.");
					}
					failures.push(kernelEmptyLabel("llm"));
					continue;
				}
				const title = typeof result.title === "string" && result.title.trim()
					? result.title.trim()
					: (options.titleHint ?? "");
				return {
					kernel: "llm",
					title,
					content,
				};
			} catch (error) {
				if (shouldStopKernelFallback(error, options.signal)) {
					if (options.signal?.aborted) throwIfSignalAborted(options.signal);
					throw error;
				}
				// llm-only selection: surface the failure; do not fall back to local kernels.
				if (llmDirect) {
					throw publicKernelError(error);
				}
				// Never echo provider/library text into aggregate diagnostics.
				failures.push(kernelFailedLabel("llm"));
				continue;
			}
		}

		attempted.push(kernel);
		const customRunner = options.runners?.[kernel];
		try {
			const result = customRunner
				? await raceWithSignal(Promise.resolve().then(() => customRunner(html, options.url)), options.signal)
				: await runDefaultLocalKernelInterruptibly(kernel, html, options.url, options.signal);
			const content = normalizeMarkdown(result.content);
			if (!content) {
				failures.push(kernelEmptyLabel(kernel));
				continue;
			}
			const title = typeof result.title === "string" && result.title.trim()
				? result.title.trim()
				: (options.titleHint ?? "");
			return {
				kernel,
				title,
				content,
			};
		} catch (error) {
			if (shouldStopKernelFallback(error, options.signal)) {
				// Prefer the combined operation signal reason when it already aborted.
				if (options.signal?.aborted) throwIfSignalAborted(options.signal);
				throw error;
			}
			// Generic labels only: local extractors may echo page-derived text.
			failures.push(kernelFailedLabel(kernel));
		}
	}

	const detail = failures.length > 0 ? failures.join("; ") : attempted.join(", ");
	const boundedDetail = detail.length > MAX_KERNEL_AGGREGATE_CHARS
		? `${detail.slice(0, MAX_KERNEL_AGGREGATE_CHARS)}…`
		: detail;
	throw new ExtractionKernelError(
		"backend_error",
		`No Extraction Kernel produced markdown (${boundedDetail}).`,
	);
}

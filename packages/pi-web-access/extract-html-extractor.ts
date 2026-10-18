import { normalizeMarkdown } from "./extract-defuddle.ts";

export type HtmlExtractorExtraction = {
	title: string;
	content: string;
};

type ExtractFn = (
	html: string,
	options?: {
		url?: string;
		outputText?: boolean;
		includeMetadata?: boolean;
	},
) => Promise<{
	markdown?: unknown;
	metadata?: { title?: unknown } | null;
	errorReason?: unknown;
} | null | undefined>;

function resolveExtractExport(mod: unknown): ExtractFn {
	const record = (mod && typeof mod === "object") ? mod as Record<string, unknown> : {};
	if (typeof record.extract === "function") return record.extract as ExtractFn;
	const defaultExport = record.default;
	if (typeof defaultExport === "function") return defaultExport as ExtractFn;
	if (defaultExport && typeof defaultExport === "object") {
		const nested = defaultExport as Record<string, unknown>;
		if (typeof nested.extract === "function") return nested.extract as ExtractFn;
	}
	throw new Error("html-extractor runtime module did not export a callable extractor.");
}

export async function extractWithHtmlExtractor(html: string, url: string): Promise<HtmlExtractorExtraction> {
	// Defer the native package so extension registration can load without node_modules.
	const [{ normalizeHanTypographyHtml }, mod] = await Promise.all([
		import("./extract-html-normalize.ts"),
		import("@firecrawl/html-extractor"),
	]);
	const extract = resolveExtractExport(mod);
	// Same Han.css unwrap as Defuddle so kernel choice does not change CJK punctuation layout.
	const normalized = await normalizeHanTypographyHtml(html);
	const result = await extract(normalized, {
		url,
		includeMetadata: true,
	});
	const content = normalizeMarkdown(result?.markdown);
	if (!content) {
		const reason = typeof result?.errorReason === "string" && result.errorReason.trim()
			? result.errorReason.trim()
			: "html-extractor returned empty markdown.";
		throw new Error(reason);
	}
	const title = typeof result?.metadata?.title === "string" ? result.metadata.title.trim() : "";
	return { title, content };
}

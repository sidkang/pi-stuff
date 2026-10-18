export type DefuddleExtraction = {
	title: string;
	content: string;
};

type DefuddleFn = (
	input: unknown,
	url?: string,
	options?: { markdown?: boolean; useAsync?: boolean },
) => Promise<{ content?: unknown; title?: unknown } | null | undefined>;

export function normalizeMarkdown(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/\r\n/g, "\n").trim();
}

function resolveDefuddleExport(mod: unknown): DefuddleFn {
	const record = (mod && typeof mod === "object") ? mod as Record<string, unknown> : {};
	if (typeof record.Defuddle === "function") return record.Defuddle as DefuddleFn;
	const defaultExport = record.default;
	if (typeof defaultExport === "function") return defaultExport as DefuddleFn;
	if (defaultExport && typeof defaultExport === "object") {
		const nested = defaultExport as Record<string, unknown>;
		if (typeof nested.Defuddle === "function") return nested.Defuddle as DefuddleFn;
	}
	throw new Error("Defuddle runtime module did not export a callable extractor.");
}

export async function extractWithDefuddle(html: string, url: string): Promise<DefuddleExtraction> {
	// Defer runtime deps so extension registration can load without node_modules.
	const [linkedomMod, defuddleMod] = await Promise.all([
		import("linkedom"),
		import("defuddle/node"),
	]);
	const parseHTML = (linkedomMod as { parseHTML: (html: string) => { document: Document } }).parseHTML;
	const Defuddle = resolveDefuddleExport(defuddleMod);
	// Unwrap Han.css typography wrappers before Defuddle so CJK punctuation stays inline.
	const { normalizeHanTypographyHtmlWithParser } = await import("./extract-html-normalize.ts");
	const normalized = normalizeHanTypographyHtmlWithParser(html, parseHTML);
	const { document } = parseHTML(normalized);
	const result = await Defuddle(document, url, {
		markdown: true,
		useAsync: false,
	});
	// Empty normalized output is a failed-kernel signal for Kernel Fallback.
	const content = normalizeMarkdown(result?.content);
	const title = typeof result?.title === "string" ? result.title.trim() : "";
	return { title, content };
}

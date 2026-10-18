/**
 * Generic pre-kernel HTML normalization.
 *
 * Some CJK sites (e.g. Xueqiu via Han.css / 漢字標準格式) wrap every punctuation
 * character in non-semantic custom elements such as:
 *
 *   <h-char unicode="ff0c" class="biaodian ..."><h-inner>，</h-inner></h-char>
 *
 * Defuddle treats unknown custom elements as block-level, which splits each
 * punctuation mark onto its own markdown paragraph. html-extractor can also
 * reorder text around those wrappers.
 *
 * This normalizer:
 * - unwraps known non-semantic Han typography wrappers (preserve child text)
 * - drops synthetic spacing/control nodes (h-cs, h-hws) entirely
 * - preserves semantic ruby/annotation tags
 * - returns the original HTML byte-identical when no matching DOM nodes exist
 */

/** Non-semantic Han.css wrappers whose children should be preserved. */
export const HAN_TYPOGRAPHY_UNWRAP_TAGS = [
	"h-char",
	"h-inner",
	"h-char-group",
	"h-word",
	"h-jinze",
] as const;

/**
 * Synthetic Han.css spacing/control nodes.
 * These often carry only hidden whitespace; drop the whole node (no child preserve).
 */
export const HAN_TYPOGRAPHY_DROP_TAGS = [
	"h-hws",
	"h-cs",
] as const;

export const HAN_TYPOGRAPHY_WRAPPER_TAGS = [
	...HAN_TYPOGRAPHY_UNWRAP_TAGS,
	...HAN_TYPOGRAPHY_DROP_TAGS,
] as const;

const HAN_UNWRAP_SET = new Set<string>(HAN_TYPOGRAPHY_UNWRAP_TAGS);
const HAN_DROP_SET = new Set<string>(HAN_TYPOGRAPHY_DROP_TAGS);
const HAN_ANY_SET = new Set<string>(HAN_TYPOGRAPHY_WRAPPER_TAGS);

/** Cheap presence check so ordinary English HTML skips parsing. */
const HAN_WRAPPER_RE = /<h-(?:char(?:-group)?|inner|word|jinze|hws|cs)\b/i;

export function hasHanTypographyWrappers(html: string): boolean {
	return HAN_WRAPPER_RE.test(html);
}

function isHanUnwrapTag(tagName: string): boolean {
	return HAN_UNWRAP_SET.has(tagName.toLowerCase());
}

function isHanDropTag(tagName: string): boolean {
	return HAN_DROP_SET.has(tagName.toLowerCase());
}

function isHanAnyTag(tagName: string): boolean {
	return HAN_ANY_SET.has(tagName.toLowerCase());
}

export type HanTypographyAction = "unwrap" | "drop";

export type HanTypographyNodeAction = {
	element: Element;
	action: HanTypographyAction;
};

/**
 * Collect Han typography nodes deepest-first so nested h-char > h-inner
 * (and nested control wrappers) process cleanly.
 */
export function collectHanTypographyNodes(root: ParentNode): HanTypographyNodeAction[] {
	const nodes: HanTypographyNodeAction[] = [];
	const walk = (node: Node) => {
		if (node.nodeType !== 1) return;
		const el = node as Element;
		for (const child of [...el.childNodes]) walk(child);
		if (isHanDropTag(el.tagName)) {
			nodes.push({ element: el, action: "drop" });
			return;
		}
		if (isHanUnwrapTag(el.tagName)) {
			nodes.push({ element: el, action: "unwrap" });
		}
	};
	for (const child of [...root.childNodes]) walk(child);
	return nodes;
}

/**
 * Apply drop/unwrap actions in place.
 * Semantic ruby/annotation tags (h-ruby, h-ru, h-yin, h-zhuyin, h-diao) are kept.
 * Returns the number of nodes modified.
 */
export function applyHanTypographyActions(nodes: HanTypographyNodeAction[]): number {
	let changed = 0;
	for (const { element: el, action } of nodes) {
		const parent = el.parentNode;
		if (!parent) continue;
		if (action === "drop") {
			// Synthetic spacing/control: remove the entire node, including any child spaces.
			parent.removeChild(el);
			changed += 1;
			continue;
		}
		// unwrap: preserve children in order
		while (el.firstChild) {
			parent.insertBefore(el.firstChild, el);
		}
		parent.removeChild(el);
		changed += 1;
	}
	return changed;
}

/**
 * Unwrap/drop known Han typography wrappers in place.
 * Returns how many nodes were modified.
 */
export function unwrapHanTypographyNodes(root: ParentNode): number {
	return applyHanTypographyActions(collectHanTypographyNodes(root));
}

/**
 * True only when the parsed DOM actually contains matching Han elements.
 * Prevents script/style/raw-text false positives from forcing serialize.
 */
export function documentHasHanTypographyElements(root: ParentNode): boolean {
	const walk = (node: Node): boolean => {
		if (node.nodeType === 1) {
			const el = node as Element;
			if (isHanAnyTag(el.tagName)) return true;
			for (const child of el.childNodes) {
				if (walk(child)) return true;
			}
		}
		return false;
	};
	for (const child of root.childNodes) {
		if (walk(child)) return true;
	}
	return false;
}

export type ParseHtmlFn = (html: string) => { document: Document };

/**
 * Synchronous normalizer when a parseHTML implementation is already available
 * (e.g. Defuddle path that already imported linkedom).
 *
 * Byte-identical original is returned when:
 * - cheap precheck fails, or
 * - parse succeeds but no matching DOM elements exist (regex false positive).
 */
export function normalizeHanTypographyHtmlWithParser(html: string, parseHTML: ParseHtmlFn): string {
	if (!html || !hasHanTypographyWrappers(html)) return html;
	const { document } = parseHTML(html);
	if (!documentHasHanTypographyElements(document)) {
		// Regex hit text/script only; do not re-serialize.
		return html;
	}
	const changed = unwrapHanTypographyNodes(document);
	if (changed === 0) return html;
	const root = document.documentElement;
	if (root) return root.outerHTML;
	return document.toString();
}

/**
 * Async entry used by kernels that do not already hold linkedom.
 * No-op (same string) when no matching tags/elements are present.
 */
export async function normalizeHanTypographyHtml(html: string): Promise<string> {
	if (!html || !hasHanTypographyWrappers(html)) return html;
	const linkedomMod = await import("linkedom");
	const parseHTML = (linkedomMod as { parseHTML: ParseHtmlFn }).parseHTML;
	return normalizeHanTypographyHtmlWithParser(html, parseHTML);
}

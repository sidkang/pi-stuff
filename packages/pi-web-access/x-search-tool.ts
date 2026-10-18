import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { classifySearchFailure, formatXSearchFailureMessage } from "./search-errors.ts";
import { createSearchRenderers } from "./presentation.ts";
import { ResponsesClient, searchToolResult, SearchBackendError, type SearchToolResult } from "./responses-client.ts";
import { readWebAccessSettings, SOURCE_TIMEOUT_MS, type PluginSettingsContext } from "./settings.ts";
import { resolveSourceConfig } from "./source-config.ts";
import { createSourceDeadline } from "./source-deadline.ts";
import { createToolErrorDetailsBridge } from "./tool-error-details.ts";
import { XSearchSource } from "./x-search.ts";
import { SearchOutputSchema, WEB_READ_ANNOTATIONS } from "./result-schema.ts";

const XSearchParams = Type.Object({
	query: Type.String({ minLength: 1, description: "Natural-language X/Twitter search query." }),
	from_date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Inclusive start date in YYYY-MM-DD format." })),
	to_date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Inclusive end date in YYYY-MM-DD format." })),
}, { additionalProperties: false });

type XSearchParams = Static<typeof XSearchParams>;

function settingsContext(ctx?: ExtensionContext): PluginSettingsContext | undefined {
	if (!ctx) return undefined;
	const result: PluginSettingsContext = {};
	if (typeof ctx.cwd === "string") result.cwd = ctx.cwd;
	if (typeof ctx.isProjectTrusted === "function") result.isProjectTrusted = () => ctx.isProjectTrusted();
	return result;
}

export default function xSearch(pi: ExtensionAPI) {
	const errorDetails = createToolErrorDetailsBridge("x_search");
	errorDetails.install(pi);
	const renderers = createSearchRenderers("x");

	pi.registerTool({
		name: "x_search",
		label: "X Search",
		description: "Search X/Twitter for current posts and return a concise answer with source URLs.",
		promptSnippet: "Search X/Twitter. Returns normalized answer text and X source URLs.",
		promptGuidelines: [
			"Use x_search only when the user asks for X or Twitter posts.",
			"Always include a clear natural-language query.",
			"Use from_date and to_date when the user requests a specific date range.",
			"Do not use x_search as a general web fallback.",
		],
		parameters: XSearchParams,
		outputSchema: SearchOutputSchema,
		annotations: WEB_READ_ANNOTATIONS,
		renderShell: "self",
		async execute(toolCallId: string, params: XSearchParams, signal: AbortSignal | undefined, onUpdate: ((result: SearchToolResult) => void) | undefined, ctx: ExtensionContext) {
			const startedAt = Date.now();
			const { settings, errors } = readWebAccessSettings(settingsContext(ctx));
			const xaiError = errors.find((error) => error.source === "xai");
			if (xaiError) {
				errorDetails.record(toolCallId, {
					ok: false,
					error: xaiError.message,
					code: "missing_config",
					elapsedMs: Date.now() - startedAt,
					timeoutMs: SOURCE_TIMEOUT_MS,
				});
				throw new Error(xaiError.message);
			}
			if (!settings.xai) {
				const message = "No xAI source is configured. Set webAccess.xai.model.";
				errorDetails.record(toolCallId, {
					ok: false,
					error: message,
					code: "missing_config",
					elapsedMs: Date.now() - startedAt,
					timeoutMs: SOURCE_TIMEOUT_MS,
				});
				throw new Error(message);
			}

			const publishPartial = () => onUpdate?.({
				content: [{ type: "text", text: "Searching X..." }],
				details: { phase: "Searching X...", source: "xai", startedAt, elapsedMs: Date.now() - startedAt, timeoutMs: SOURCE_TIMEOUT_MS },
			});
			publishPartial();
			const ticker = setInterval(publishPartial, 1000);

			try {
				const sourceSignal = createSourceDeadline(signal);
				const resolved = await resolveSourceConfig(ctx, "xai", settings.xai, sourceSignal);
				const client = new ResponsesClient({ baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, headers: resolved.headers });
				const response = await new XSearchSource(client).search({
					query: params.query,
					model: resolved.model,
					...(params.from_date !== undefined ? { from_date: params.from_date } : {}),
					...(params.to_date !== undefined ? { to_date: params.to_date } : {}),
					...(resolved.reasoningEffort !== undefined ? { reasoningEffort: resolved.reasoningEffort } : {}),
					signal: sourceSignal,
				});
				return searchToolResult(params.query, response, {
					provider: resolved.provider,
					model: resolved.model,
					api: resolved.api,
					source: "xai",
					elapsedMs: Date.now() - startedAt,
					timeoutMs: SOURCE_TIMEOUT_MS,
				});
			} catch (error) {
				if (signal?.aborted) {
					const classified = classifySearchFailure(new SearchBackendError("aborted", "x search was aborted"));
					const message = formatXSearchFailureMessage(classified.message);
					errorDetails.record(toolCallId, {
						ok: false,
						error: message,
						code: classified.code,
						elapsedMs: Date.now() - startedAt,
						timeoutMs: SOURCE_TIMEOUT_MS,
					});
					throw new Error(message, { cause: error });
				}
				const classified = classifySearchFailure(error);
				const message = formatXSearchFailureMessage(classified.message);
				errorDetails.record(toolCallId, {
					ok: false,
					error: message,
					code: classified.code,
					status: classified.status,
					source: "xai",
					elapsedMs: Date.now() - startedAt,
					timeoutMs: SOURCE_TIMEOUT_MS,
				});
				throw new Error(message, { cause: error });
			} finally {
				clearInterval(ticker);
			}
		},
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
	});
}

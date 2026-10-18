import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatQualifiedModel,
	resolveThinkingAwareModel,
	responsesReasoningEffort,
	type QualifiedModel,
	type ThinkingCapableModel,
	type ThinkingLevel,
} from "./models.ts";
import {
	messageInput,
	ResponsesClient,
	SearchBackendError,
	type ResponsesClientConfig,
} from "./responses-client.ts";
import { resolveModelAccess } from "./source-config.ts";

export const RESPONSES_COMPLETION_API = "openai-responses";

/** Re-export shared mapper so existing completion tests keep a single import path. */
export { responsesReasoningEffort };

export type CompletionAccessContext = Pick<ExtensionContext, "modelRegistry">;

export type CompleteResponsesTextOptions = {
	ctx: CompletionAccessContext;
	configured: QualifiedModel;
	/** Fixed system/developer instruction. Sent as Responses `instructions`. */
	instructions: string;
	/** User payload text. Sent as tool-free message input. */
	userText: string;
	signal?: AbortSignal;
	label: string;
	/** Optional fetch override for tests. */
	fetchImpl?: ResponsesClientConfig["fetchImpl"];
};

export type ResponsesTextCompletion = {
	text: string;
	provider: string;
	modelId: string;
	api: string;
	requestedThinkingLevel: ThinkingLevel;
	thinkingLevel: ThinkingLevel;
	baseUrl: string;
};

export function buildResponsesTextCompletionBody(options: {
	modelId: string;
	instructions: string;
	userText: string;
	reasoningEffort?: string;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: options.modelId,
		instructions: options.instructions,
		input: messageInput(options.userText),
		stream: false,
		store: false,
	};
	if (options.reasoningEffort !== undefined) {
		body.reasoning = { effort: options.reasoningEffort };
	}
	// Explicit empty tools array is unnecessary; absence means no tools.
	return body;
}

/**
 * Resolve a thinking-aware completion model through Pi Model Registry auth,
 * require openai-responses, and complete via the existing bounded ResponsesClient.
 */
export async function completeResponsesText(
	options: CompleteResponsesTextOptions,
): Promise<ResponsesTextCompletion> {
	const { ctx, configured, instructions, userText, signal, label, fetchImpl } = options;
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("This operation was aborted", "AbortError");
	}
	if (!ctx?.modelRegistry || typeof ctx.modelRegistry.find !== "function") {
		throw new SearchBackendError("missing_config", `Model Registry is unavailable for the ${label} model.`);
	}

	const resolved = resolveThinkingAwareModel(
		(provider, modelId) => {
			try {
				return ctx.modelRegistry.find(provider, modelId) as ThinkingCapableModel | undefined;
			} catch {
				return undefined;
			}
		},
		configured,
	);
	if (resolved.status === "invalid_thinking") {
		throw new SearchBackendError(
			"missing_config",
			`Invalid thinking level in ${label} model (${resolved.suffix}). Use off, minimal, low, medium, high, xhigh, or max.`,
		);
	}
	if (resolved.status === "missing") {
		const formatted = formatQualifiedModel(configured);
		throw new SearchBackendError(
			"missing_config",
			label === "extract"
				? `Extract model ${formatted} was not found in the Model Registry.`
				: `Missing ${label} model ${formatted}.`,
		);
	}

	const access = await resolveModelAccess(
		ctx as ExtensionContext,
		{ provider: resolved.provider, modelId: resolved.modelId },
		{ label, signal },
	);
	if (access.api !== RESPONSES_COMPLETION_API && access.api !== "custom-response") {
		throw new SearchBackendError(
			"unsupported_model",
			`${label[0]!.toUpperCase()}${label.slice(1)} model ${formatQualifiedModel({ provider: access.provider, modelId: access.model })} must use ${RESPONSES_COMPLETION_API}.`,
		);
	}

	const reasoningEffort = responsesReasoningEffort(resolved.model, resolved.thinkingLevel);
	const client = new ResponsesClient({
		baseUrl: access.baseUrl,
		apiKey: access.apiKey,
		headers: access.headers,
		...(fetchImpl ? { fetchImpl } : {}),
	});
	const body = buildResponsesTextCompletionBody({
		modelId: access.model,
		instructions,
		userText,
		reasoningEffort,
	});
	const response = await client.post(body, { signal, model: access.model });
	const text = response.answer?.trim() ?? "";
	if (!text) {
		throw new SearchBackendError("invalid_response", `${label} model returned no answer`);
	}
	return {
		text,
		provider: access.provider,
		modelId: access.model,
		api: access.api,
		requestedThinkingLevel: resolved.requestedThinkingLevel,
		thinkingLevel: resolved.thinkingLevel,
		baseUrl: access.baseUrl,
	};
}

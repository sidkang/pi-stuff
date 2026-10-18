import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DISABLED_API = "provider-model-filter-disabled" as Api;
const DISABLED_BASE_URL = "http://127.0.0.1";

type ProviderRule = {
	disabled?: boolean;
	block?: string[];
	allow?: string[];
	allowVariantsOf?: string[];
};

type ProviderFilterSettings = Record<string, ProviderRule>;

const SETTINGS: ProviderFilterSettings = {
	huggingface: { disabled: true },
	"openai-codex": { disabled: true },
};

const CURSOR_RULE: ProviderRule = {
	allow: [
		"opus-5.5@300k",
		"grok-4.5",
		"grok-4.6",
		"grok-4.7@256k",
		"composer-2.5",
	],
};

function isModelAllowed(modelId: string, rule: ProviderRule): boolean {
	if (rule.allowVariantsOf !== undefined && !rule.allowVariantsOf.includes(modelId.split(/[@:]/, 1)[0])) {
		return false;
	}
	if (rule.allow !== undefined && !rule.allow.includes(modelId)) return false;
	return !rule.block?.includes(modelId);
}

function filterModels(models: readonly Model<Api>[], rule: ProviderRule): Model<Api>[] {
	return models.filter((model) => isModelAllowed(model.id, rule));
}

function policyErrorStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const message: AssistantMessage = { ...partial, stopReason: "error", errorMessage };

	queueMicrotask(() => {
		stream.push({ type: "start", partial });
		stream.push({ type: "error", reason: "error", error: message });
		stream.end();
	});

	return stream;
}

function disabledModel(providerId: string): Model<Api> {
	return {
		id: "__provider_disabled__",
		name: `${providerId} disabled by provider-model-filter`,
		provider: providerId,
		api: DISABLED_API,
		baseUrl: DISABLED_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1,
	};
}

function createDisabledProvider(source: Provider<Api>): Provider<Api> {
	const model = disabledModel(source.id);
	const reject = (requestedModel: Model<Api>) =>
		policyErrorStream(requestedModel, `Provider "${source.id}" is disabled by provider-model-filter.`);

	return {
		id: source.id,
		name: `${source.name} (disabled)`,
		baseUrl: DISABLED_BASE_URL,
		auth: {
			apiKey: {
				name: "Disabled by provider-model-filter",
				async check() {
					return { type: "api_key", source: "provider-model-filter" };
				},
				async resolve() {
					return {
						auth: { apiKey: "disabled", baseUrl: DISABLED_BASE_URL },
						source: "provider-model-filter",
					};
				},
			},
		},
		getModels: () => [model],
		stream: reject,
		streamSimple: reject,
	};
}

function createFilteredProvider(source: Provider<Api>, rule: ProviderRule): Provider<Api> {
	const rejection = (model: Model<Api>) =>
		policyErrorStream(
			model,
			`Model "${model.id}" is blocked for provider "${source.id}" by provider-model-filter.`,
		);
	const ensureAllowed = (model: Model<Api>): AssistantMessageEventStream | undefined =>
		isModelAllowed(model.id, rule) ? undefined : rejection(model);

	return {
		id: source.id,
		name: source.name,
		baseUrl: source.baseUrl,
		headers: source.headers,
		auth: source.auth,
		getModels: () => filterModels(source.getModels(), rule),
		...(source.refreshModels
			? { refreshModels: (context) => source.refreshModels!(context) }
			: {}),
		filterModels: (models, credential) => {
			const available = source.filterModels ? source.filterModels(models, credential) : models;
			return filterModels(available, rule);
		},
		stream: (model, context, options) => ensureAllowed(model) ?? source.stream(model, context, options),
		streamSimple: (model, context, options) =>
			ensureAllowed(model) ?? source.streamSimple(model, context, options),
		...(source.fetchDeferred
			? {
					fetchDeferred: (model, handle, options) =>
						ensureAllowed(model) ?? source.fetchDeferred!(model, handle, options),
				}
			: {}),
		...(source.cancelDeferred
			? {
					cancelDeferred: async (model, handle, options) => {
						if (!isModelAllowed(model.id, rule)) {
							throw new Error(
								`Model "${model.id}" is blocked for provider "${source.id}" by provider-model-filter.`,
							);
						}
						await source.cancelDeferred!(model, handle, options);
					},
				}
			: {}),
	};
}

export const __test = {
	CURSOR_RULE,
	createDisabledProvider,
	createFilteredProvider,
	disabledModel,
	filterModels,
	isModelAllowed,
	policyErrorStream,
};

export default function providerModelFilter(pi: ExtensionAPI): void {
	const sourceProviders = new Map(builtinProviders().map((provider) => [provider.id, provider]));
	const registered = new Set<string>();

	for (const [providerId, rule] of Object.entries(SETTINGS)) {
		const source = sourceProviders.get(providerId);
		if (!source) {
			console.warn(`[provider-model-filter] ${providerId}: not a built-in provider; skipping.`);
			continue;
		}

		const hasModelFilter = rule.allow !== undefined || rule.block !== undefined;
		let replacement: Provider<Api> | undefined;
		if (rule.disabled) {
			replacement = createDisabledProvider(source);
		} else if (hasModelFilter) {
			const filtered = createFilteredProvider(source, rule);
			replacement = filtered.getModels().length === 0 ? createDisabledProvider(source) : filtered;
		}

		if (!replacement) continue;
		pi.registerProvider(replacement);
		registered.add(providerId);
	}

	// Cursor is extension-provided, so it is only available after extension loading.
	// Reapply if /cursor-refresh-models replaces the provider during the session.
	let filteredCursor: Provider<Api> | undefined;
	const filterCursor = (ctx: ExtensionContext) => {
		if (filteredCursor && ctx.modelRegistry.getRegisteredNativeProvider("cursor") === filteredCursor) return;
		const source = ctx.modelRegistry.getProvider("cursor");
		if (!source) return;
		filteredCursor = createFilteredProvider(source as Provider<Api>, CURSOR_RULE);
		pi.registerProvider(filteredCursor);
		registered.add("cursor");
	};
	pi.on("session_start", (_event, ctx) => filterCursor(ctx));
	pi.on("model_select", (_event, ctx) => filterCursor(ctx));
	pi.on("before_agent_start", (_event, ctx) => filterCursor(ctx));

	pi.on("session_shutdown", () => {
		for (const providerId of registered) pi.unregisterProvider(providerId);
		registered.clear();
	});
}

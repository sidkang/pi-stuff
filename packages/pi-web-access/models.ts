import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Pi-native thinking levels, including off. Re-exported from pi-ai. */
export type ThinkingLevel = ModelThinkingLevel;

export type { ModelThinkingLevel };
export { clampThinkingLevel, getSupportedThinkingLevels };

export type QualifiedModel = {
	provider: string;
	modelId: string;
};

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/**
 * Minimal model shape needed for registry find + thinking resolution.
 * Capability clamp uses Pi-native helpers which accept the full Model shape;
 * find stubs only need these fields.
 */
export type ThinkingCapableModel = {
	id: string;
	provider: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type ParseQualifiedModelResult =
	| { status: "ok"; model: QualifiedModel }
	| { status: "missing" }
	| { status: "invalid" };

export type ResolveThinkingAwareModelResult =
	| {
		status: "ok";
		provider: string;
		/** Registry model id after thinking-suffix resolution. */
		modelId: string;
		/** Requested level before capability clamp. Unsuffixed specs use off. */
		requestedThinkingLevel: ThinkingLevel;
		/** Capability-clamped effective level (Pi-native clampThinkingLevel). */
		thinkingLevel: ThinkingLevel;
		model: ThinkingCapableModel;
	}
	| { status: "missing" }
	| { status: "invalid_thinking"; suffix: string };

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVEL_SET.has(value);
}

function asClampModel(model: ThinkingCapableModel): Model<Api> {
	// Registry find stubs and real Model objects both carry the fields clamp needs.
	return model as Model<Api>;
}

export function parseQualifiedModel(value: unknown): ParseQualifiedModelResult {
	if (value === undefined || value === null) return { status: "missing" };
	if (typeof value !== "string") return { status: "invalid" };
	const trimmed = value.trim();
	if (!trimmed) return { status: "missing" };
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return { status: "invalid" };
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) return { status: "invalid" };
	// Keep colon-bearing model IDs intact. Thinking suffixes are resolved only
	// against the Model Registry at use time (full id first, then optional suffix).
	return { status: "ok", model: { provider, modelId } };
}

export function formatQualifiedModel(model: QualifiedModel): string {
	return `${model.provider}/${model.modelId}`;
}

/**
 * Map a capability-clamped thinking level to OpenAI Responses `reasoning.effort`.
 * Omit reasoning entirely when effective level is off.
 * Shared by Extract completion and hosted search request builders.
 */
export function responsesReasoningEffort(
	model: ThinkingCapableModel,
	effective: ThinkingLevel,
): string | undefined {
	if (effective === "off") return undefined;
	const mapped = model.thinkingLevelMap?.[effective];
	if (mapped === null) return undefined;
	return mapped ?? effective;
}

/**
 * Resolve a thinking-aware model setting against the registry.
 *
 * Used by Extract completion models and hosted search source models.
 *
 * 1. Prefer the full `provider/modelId` (including any colons).
 * 2. Only if that id is absent, interpret a final `:` suffix as a Pi thinking level
 *    when the suffix is a known level and the stripped id exists.
 * 3. Unsuffixed models use thinking level `off`.
 * 4. Effective levels are clamped with Pi-native `clampThinkingLevel`.
 */
export function resolveThinkingAwareModel(
	find: (provider: string, modelId: string) => ThinkingCapableModel | undefined,
	configured: QualifiedModel,
): ResolveThinkingAwareModelResult {
	const full = find(configured.provider, configured.modelId);
	if (full) {
		const requestedThinkingLevel: ThinkingLevel = "off";
		return {
			status: "ok",
			provider: full.provider,
			modelId: full.id,
			requestedThinkingLevel,
			thinkingLevel: clampThinkingLevel(asClampModel(full), requestedThinkingLevel),
			model: full,
		};
	}

	const colon = configured.modelId.lastIndexOf(":");
	if (colon <= 0 || colon === configured.modelId.length - 1) {
		return { status: "missing" };
	}

	const prefix = configured.modelId.slice(0, colon);
	const suffix = configured.modelId.slice(colon + 1);
	if (!prefix) return { status: "missing" };
	if (!isThinkingLevel(suffix)) {
		return { status: "invalid_thinking", suffix };
	}

	const base = find(configured.provider, prefix);
	if (!base) return { status: "missing" };

	return {
		status: "ok",
		provider: base.provider,
		modelId: base.id,
		requestedThinkingLevel: suffix,
		thinkingLevel: clampThinkingLevel(asClampModel(base), suffix),
		model: base,
	};
}

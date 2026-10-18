import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GATE_STATES = Symbol.for("sid.pi.codex-tools.apply-patch-gate-states");

export interface ModelLike {
	provider?: string;
	id?: string;
	name?: string;
}

type GateState = {
	preference?: boolean;
	removedByGate: boolean;
	removedToolIndex?: number;
};

function sharedGateStates(): Map<string, GateState> {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[GATE_STATES];
	if (existing instanceof Map) return existing as Map<string, GateState>;
	const states = new Map<string, GateState>();
	host[GATE_STATES] = states;
	return states;
}

function gateStateFor(ctx: Pick<ExtensionContext, "sessionManager">): GateState {
	const states = sharedGateStates();
	const sessionId = ctx.sessionManager.getSessionId();
	let state = states.get(sessionId);
	if (!state) {
		state = { removedByGate: false };
		states.set(sessionId, state);
	}
	return state;
}

function modelIdentifiers(model: ModelLike | undefined): string[] {
	return [model?.id, model?.name]
		.filter((value): value is string => typeof value === "string")
		.flatMap((value) => value.toLowerCase().split(/[/:]/).filter(Boolean));
}

export function isGptLikeModel(model: ModelLike | undefined): boolean {
	const provider = (model?.provider ?? "").toLowerCase();
	if (provider === "openai-codex" || provider.endsWith("-codex")) return true;
	return modelIdentifiers(model).some((identifier) =>
		/^gpt(?:[-_.\d]|$)/.test(identifier)
		|| /^o\d(?:[-_.\d]|$)/.test(identifier)
		|| identifier.includes("codex"),
	);
}

export function syncApplyPatchVisibility(
	activeTools: readonly string[],
	model: ModelLike | undefined,
	state: GateState = { removedByGate: false },
): { activeTools: string[]; state: GateState } {
	const hasTool = activeTools.includes("apply_patch");
	if (!isGptLikeModel(model)) {
		return {
			activeTools: activeTools.filter((name) => name !== "apply_patch"),
			state: {
				...state,
				removedByGate: state.removedByGate || hasTool,
				...(hasTool ? { removedToolIndex: activeTools.indexOf("apply_patch") } : {}),
			},
		};
	}
	if (state.preference === false) {
		return {
			activeTools: activeTools.filter((name) => name !== "apply_patch"),
			state: { ...state, removedByGate: false },
		};
	}
	if (state.removedByGate && !hasTool) {
		const restoredTools = [...activeTools];
		// Older in-process gate states have no saved position. Preserve their fallback.
		restoredTools.splice(state.removedToolIndex ?? restoredTools.length, 0, "apply_patch");
		return {
			activeTools: restoredTools,
			state: { preference: state.preference ?? true, removedByGate: false },
		};
	}
	return {
		activeTools: [...activeTools],
		state: { preference: state.preference ?? (hasTool ? true : undefined), removedByGate: false },
	};
}

export function registerApplyPatchVisibility(pi: ExtensionAPI): void {
	const activeTools = (): string[] => pi.getActiveTools?.() ?? [];
	const capturePreference = (ctx: Pick<ExtensionContext, "sessionManager">, model: ModelLike | undefined): void => {
		if (isGptLikeModel(model)) gateStateFor(ctx).preference = activeTools().includes("apply_patch");
	};
	const sync = (ctx: Pick<ExtensionContext, "model" | "sessionManager">, captureCurrentPreference = false): void => {
		const model = ctx.model as ModelLike | undefined;
		const state = gateStateFor(ctx);
		if (captureCurrentPreference) capturePreference(ctx, model);
		const active = activeTools();
		const next = syncApplyPatchVisibility(active, model, state);
		Object.assign(state, next.state);
		if (next.activeTools.join("\0") !== active.join("\0")) pi.setActiveTools?.(next.activeTools);
	};

	pi.on("session_start", (_event, ctx) => sync(ctx));
	pi.on("model_select", (event, ctx) => {
		capturePreference(ctx, event.previousModel as ModelLike | undefined);
		sync(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		capturePreference(ctx, ctx.model as ModelLike | undefined);
		sync(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => sync(ctx, true));
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "apply_patch" && !isGptLikeModel(ctx.model as ModelLike | undefined)) {
			return { block: true, reason: "apply_patch is available only for GPT, o-series, and Codex models." };
		}
	});
	pi.on("session_shutdown", (_event, ctx) => capturePreference(ctx, ctx.model as ModelLike | undefined));
}

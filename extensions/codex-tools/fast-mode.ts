import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCodexToolsSettings, type FastModeSettings, type PluginSettingsContext } from "./settings.ts";

const FOOTER_ITEM_ID = "codex-tools.fast";
const BETTER_FOOTER_READY = "better-footer:ready";
const BETTER_FOOTER_REQUEST_API = "better-footer:request-api";
const BETTER_FOOTER_REGISTER = "better-footer:register";
const BETTER_FOOTER_UNREGISTER = "better-footer:unregister";
const FAST_SERVICE_TIER = "priority";
const FAST_APIS = new Set<Api>(["openai-codex-responses", "openai-responses", "custom-response"]);

type FastModel = Pick<Model<Api>, "provider" | "id" | "api">;
type BetterFooterApi = {
	register(item: BetterFooterItem): void;
	unregister(id: string): void;
};
type BetterFooterItem = {
	id: string;
	side: "right";
	position: "before" | "core";
	order: number;
	render: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsContext(ctx?: ExtensionContext): PluginSettingsContext | undefined {
	if (!ctx) return undefined;
	const result: PluginSettingsContext = {};
	if (typeof ctx.cwd === "string") result.cwd = ctx.cwd;
	if (typeof ctx.isProjectTrusted === "function") result.isProjectTrusted = () => ctx.isProjectTrusted();
	return result;
}

function configuredFastMode(ctx?: ExtensionContext): FastModeSettings {
	return readCodexToolsSettings(settingsContext(ctx)).fastMode;
}

function modelKey(model: FastModel | null | undefined): string {
	if (!model) return "none";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function supportsFast(model: FastModel | null | undefined, fastMode = configuredFastMode()): boolean {
	return !!model && FAST_APIS.has(model.api) && fastMode.eligibleModels.has(model.id);
}

export function applyFastServiceTier(payload: unknown, model: FastModel | null | undefined, fastModeEnabled: boolean, fastMode: FastModeSettings): Record<string, unknown> | undefined {
	if (!fastModeEnabled) return undefined;
	if (!model) return undefined;
	if (!supportsFast(model, fastMode)) return undefined;
	if (!isRecord(payload)) return undefined;
	if (payload.model !== model.id) return undefined;
	if ("service_tier" in payload) return undefined;
	return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function statusText(ctx: ExtensionContext, model: FastModel | null | undefined): string | undefined {
	if (!supportsFast(model, configuredFastMode(ctx))) return undefined;
	return "fast";
}

export default function fastMode(pi: ExtensionAPI) {
	const overrides = new Map<string, boolean>();
	let lastCtx: ExtensionContext | undefined;

	function isFastModeEnabled(ctx: ExtensionContext, model = ctx.model as FastModel | undefined): boolean {
		if (!model) return false;
		return overrides.get(model.id) ?? configuredFastMode(ctx).defaultEnabledModels.has(model.id);
	}

	function footerItem(ctx: ExtensionContext): BetterFooterItem | undefined {
		const text = statusText(ctx, ctx.model as FastModel | undefined);
		if (!text) return undefined;
		return {
			id: FOOTER_ITEM_ID,
			side: "right",
			position: "before",
			order: 0,
			render: text,
		};
	}

	function updateBetterFooter(ctx?: ExtensionContext): void {
		const item = ctx?.hasUI && isFastModeEnabled(ctx) ? footerItem(ctx) : undefined;
		if (item) {
			pi.events.emit(BETTER_FOOTER_REGISTER, item);
			pi.events.emit(BETTER_FOOTER_REQUEST_API, (api: BetterFooterApi) => api.register(item));
			return;
		}
		pi.events.emit(BETTER_FOOTER_UNREGISTER, FOOTER_ITEM_ID);
		pi.events.emit(BETTER_FOOTER_REQUEST_API, (api: BetterFooterApi) => api.unregister(FOOTER_ITEM_ID));
	}

	function setFastMode(ctx: ExtensionContext, enabled: boolean): void {
		const model = ctx.model as FastModel | undefined;
		if (model) overrides.set(model.id, enabled);
		updateFooter(ctx);
	}

	function updateFooter(ctx: ExtensionContext): void {
		lastCtx = ctx;
		updateBetterFooter(ctx);
	}

	function notifyStatus(ctx: ExtensionContext): void {
		const model = ctx.model as FastModel | undefined;
		const key = modelKey(model);
		if (!isFastModeEnabled(ctx, model)) {
			ctx.ui.notify("Fast mode is off.", "info");
			return;
		}
		if (supportsFast(model, configuredFastMode(ctx))) {
			ctx.ui.notify(`Fast mode is on: service_tier=${FAST_SERVICE_TIER} for ${key}.`, "info");
			return;
		}
		ctx.ui.notify(`Fast mode is on, but ${key} is unsupported.`, "warning");
	}

	pi.on("session_start", (_event, ctx) => {
		updateFooter(ctx);
	});

	pi.events.on(BETTER_FOOTER_READY, (api: BetterFooterApi) => {
		if (lastCtx?.hasUI && isFastModeEnabled(lastCtx)) {
			const item = footerItem(lastCtx);
			if (item) api.register(item);
			else api.unregister(FOOTER_ITEM_ID);
		}
		else api.unregister(FOOTER_ITEM_ID);
	});

	pi.on("model_select", (_event, ctx) => {
		const model = ctx.model as FastModel | undefined;
		updateFooter(ctx);
		if (isFastModeEnabled(ctx, model) && !supportsFast(model, configuredFastMode(ctx))) ctx.ui.notify(`Fast mode is unsupported for ${modelKey(model)}.`, "warning");
	});

	pi.on("session_shutdown", () => {
		overrides.clear();
		updateBetterFooter();
	});

	pi.registerCommand("fast", {
		description: `Enable fast mode for configured GPT models by requesting service_tier=${FAST_SERVICE_TIER}`,
		handler: async (_args, ctx) => {
			setFastMode(ctx, true);
			notifyStatus(ctx);
		},
	});

	pi.registerCommand("unfast", {
		description: "Disable fast mode",
		handler: async (_args, ctx) => {
			setFastMode(ctx, false);
			notifyStatus(ctx);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model as FastModel | undefined;
		return applyFastServiceTier(event.payload, model, isFastModeEnabled(ctx, model), configuredFastMode(ctx));
	});
}

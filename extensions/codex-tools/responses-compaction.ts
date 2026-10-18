/**
 * Codex Compaction Policy lifecycle.
 *
 * Domain modules (locality inside this file; one external registration seam):
 * - Compaction Router: select exactly one policy for an attempt
 * - Frozen Compaction Input + Pending Compaction Attempt: freeze identity, retain partials, retry missing only
 * - Portable Projection Generator + Provider Artifact generation: independent components from one freeze
 * - Provider Replay: before_provider_request uses Provider History under Replay Identity + session parity
 *
 * ADR 0001 invariants stay here: no selected-policy fallback, generators independent,
 * complete pair commit only, credential-free Request Semantic Envelope, strict replay.
 */
import { createHash } from "node:crypto";
import { normalizeContext, type Api, type Model, type ProviderStreams, type TranscriptContext } from "@earendil-works/pi-ai";
import { buildSessionProjection, compact, convertToLlm, type CompactionResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rawProviderHeaders } from "./provider-headers.ts";
import { readCodexToolsSettings, type PluginSettingsContext, type ResponsesCompactionSettings } from "./settings.ts";

// ---------------------------------------------------------------------------
// Shared protocol types and resource bounds
// ---------------------------------------------------------------------------

const DETAILS_KIND = "codex-tools.responses-compaction";
const DETAILS_VERSION = 2;
const MAX_PROVIDER_EVENT_BYTES = 40 * 1024 * 1024;
const REMOTE_COMPACTION_TIMEOUT_MS = 180_000;
const RETAINED_USER_MESSAGE_TOKEN_BUDGET = 20_000;
const RETAINED_INPUT_IMAGE_BYTES_BUDGET = 1024 * 1024;
const MAX_PERSISTED_HISTORY_BYTES = 42 * 1024 * 1024;
const MAX_REQUEST_SHAPE_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type ResponsesItem = JsonRecord;

/** Replay Identity fields required for a Valid Provider Artifact. */
type ResponsesIdentity = {
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
};

type ResponsesCompactionDetails = {
	kind: typeof DETAILS_KIND;
	version: typeof DETAILS_VERSION;
	identity: ResponsesIdentity;
	history: ResponsesItem[];
	telemetry?: RemoteCompactionTelemetry;
};

/** Artifact Quality Signal — observational only, never a runtime validity gate. */
type RemoteCompactionTelemetry = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	latencyMs: number;
};

type RemoteCompactionResult = {
	artifact: ResponsesItem;
	telemetry: RemoteCompactionTelemetry;
};

type Runtime = ResponsesIdentity & {
	/** Raw Pi ProviderHeaders; null values are deletion markers until request build. */
	headers: Record<string, string | null>;
	apiKey?: string;
	modelConfig: Model<Api>;
	adapter: Pick<ProviderStreams, "stream" | "streamSimple">;
	env?: Record<string, string>;
};

/** Credential-free Request Semantic Envelope (observed or reconstructed). */
type ResponsesRequestShape = {
	identity: ResponsesIdentity;
	instructions?: string;
	inputPrefix?: ResponsesItem[];
	tools?: ResponsesItem[];
	toolChoice?: unknown;
	parallelToolCalls?: boolean;
	reasoning?: JsonRecord;
	text?: JsonRecord;
};

type RemoteCompactionRequestOptions = {
	context?: TranscriptContext;
	instructions?: string;
	inputPrefix?: ResponsesItem[];
	tools?: ResponsesItem[];
	toolChoice?: unknown;
	parallelToolCalls?: boolean;
	reasoning?: JsonRecord;
	text?: JsonRecord;
};

type SessionBeforeCompactEvent = {
	preparation: any;
	branchEntries: unknown[];
	customInstructions?: string;
	reason?: "manual" | "threshold" | "overflow";
	willRetry?: boolean;
	signal: AbortSignal;
};

type SessionEntryLike = {
	type?: unknown;
	id?: unknown;
	details?: unknown;
	message?: unknown;
	provider?: unknown;
	modelId?: unknown;
	targetId?: unknown;
};

type ProjectedSessionEntryLike = {
	sourceEntry: SessionEntryLike;
	messages: unknown[];
};

type SessionProjectionLike = {
	entries: readonly ProjectedSessionEntryLike[];
	messages: unknown[];
};

/** Portable Projection component produced by the Portable Projection Generator. */
type PortableCompaction = Pick<CompactionResult, "summary" | "firstKeptEntryId" | "tokensBefore" | "usage" | "details">;

type CompactionPair<TLocal, TRemote> = {
	local?: TLocal;
	remote?: TRemote;
};

/** Pending Compaction Attempt: process-local partial retention under one freeze identity. */
type PendingCompactionAttempt = {
	fingerprint: string;
	local?: PortableCompaction;
	remote?: RemoteCompactionResult;
};

// ---------------------------------------------------------------------------
// Shared pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizeBaseUrl(value: unknown): string | undefined {
	if (!isNonEmptyString(value)) return undefined;
	try {
		const url = new URL(value.trim());
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return undefined;
		return url.toString().replace(/\/+$/, "") || undefined;
	} catch {
		return undefined;
	}
}

function jsonValue(value: unknown): boolean {
	if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(jsonValue);
	return isRecord(value) && Object.values(value).every(jsonValue);
}
function strictJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(strictJsonValue);
	return isRecord(value) && Object.values(value).every(strictJsonValue);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sameIdentity(left: ResponsesIdentity, right: ResponsesIdentity): boolean {
	return left.provider === right.provider && left.api === right.api && left.model === right.model && left.baseUrl === right.baseUrl;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function settingsContext(ctx: ExtensionContext): PluginSettingsContext {
	return {
		cwd: ctx.cwd,
		isProjectTrusted: () => ctx.isProjectTrusted(),
	};
}

// ---------------------------------------------------------------------------
// Compaction Router
// Selects exactly one Compaction Policy for an attempt; no fallback chain.
// ---------------------------------------------------------------------------

export function supportsResponsesCompaction(model: unknown, settings: ResponsesCompactionSettings): model is { provider: string; api: string; id: string; baseUrl: string } {
	if (!settings.enabled || !isRecord(model)) return false;
	return typeof model.provider === "string"
		&& settings.providers.includes(model.provider)
		&& (model.api === "openai-responses" || model.api === "custom-response")
		&& typeof model.id === "string"
		&& model.id.toLowerCase().includes("gpt")
		&& !!normalizeBaseUrl(model.baseUrl);
}

function routeMatches(ctx: ExtensionContext): boolean {
	return supportsResponsesCompaction(ctx.model, readCodexToolsSettings(settingsContext(ctx)).responsesCompaction);
}

async function resolveRuntime(ctx: ExtensionContext): Promise<Runtime | undefined> {
	if (!routeMatches(ctx)) return undefined;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) return undefined;
		const adapter = ctx.modelRegistry.getProvider(ctx.model.provider);
		if (!adapter) return undefined;
		const baseUrl = normalizeBaseUrl(auth.baseUrl ?? ctx.model.baseUrl);
		if (!baseUrl) return undefined;
		return {
			provider: ctx.model.provider,
			api: ctx.model.api,
			model: ctx.model.id,
			baseUrl,
			headers: rawProviderHeaders(auth.headers),
			apiKey: typeof auth.apiKey === "string" ? auth.apiKey : undefined,
			modelConfig: { ...ctx.model, baseUrl },
			adapter,
			env: auth.env,
		};
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Component View serialization (image filtering + private-reasoning stripping)
// ---------------------------------------------------------------------------

function stripLeadingInstructionItems(items: ResponsesItem[]): ResponsesItem[] {
	let firstSessionItem = 0;
	for (; firstSessionItem < items.length; firstSessionItem++) {
		const item = items[firstSessionItem];
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
	}
	return items.slice(firstSessionItem);
}

/** Let the configured adapter encode history, then stop before dispatch. No private converter or network I/O. */
async function serializeResponsesMessages(messages: readonly unknown[], runtime: Runtime): Promise<ResponsesItem[] | undefined> {
	let input: ResponsesItem[] | undefined;
	try {
		const transcript = normalizeContext({ messages: convertToLlm(messages as any) });
		const stream = runtime.adapter.stream(runtime.modelConfig, transcript, {
			apiKey: runtime.apiKey,
			headers: runtime.headers,
			env: runtime.env,
			samplingParams: runtime.modelConfig.samplingParams,
			cacheRetention: "none",
			maxRetries: 0,
			fetch: async () => { throw new Error("Compaction preparation must not dispatch a request"); },
			onPayload: (payload) => {
				if (isRecord(payload) && payload.model === runtime.model && Array.isArray(payload.input)
					&& payload.input.every((item) => isRecord(item) && jsonValue(item))) {
					input = stripLeadingInstructionItems(cloneJson(payload.input) as ResponsesItem[]);
				}
				throw new Error("Compaction preparation complete");
			},
		});
		await stream.result();
	} catch {
		// Adapters may throw directly or return an error event after the deliberate pre-dispatch stop.
	}
	return input;
}

/** Serializes persisted/provider history without exposing foreign private reasoning or signatures. */
export async function serializePiMessages(messages: readonly unknown[], runtime: Runtime): Promise<ResponsesItem[] | undefined> {
	const target = { provider: runtime.provider, api: runtime.api, model: runtime.model };
	const portableMessages = messages.map((message) => {
		if (!isRecord(message) || message.role !== "assistant" || (message.provider === target.provider && message.api === target.api && message.model === target.model) || !Array.isArray(message.content)) return message;
		return {
			...message,
			content: message.content.flatMap((part) => {
				if (!isRecord(part) || part.type === "thinking") return [];
				if (part.type === "text") {
					const { textSignature: _textSignature, ...text } = part;
					return [text];
				}
				return [part];
			}),
		};
	});
	return serializeResponsesMessages(portableMessages, runtime);
}

/** Mirrors Pi's outbound Responses payload. */
export async function serializePiMessagesForParity(messages: readonly unknown[], runtime: Runtime): Promise<ResponsesItem[] | undefined> {
	return serializeResponsesMessages(messages, runtime);
}

/** Pi 1.2 projection of one root-to-leaf snapshot. Projection errors fail closed. */
function projectBranchSnapshot(snapshot: readonly SessionEntryLike[]): SessionProjectionLike | undefined {
	try {
		return buildSessionProjection(snapshot as any);
	} catch {
		return undefined;
	}
}

function latestCompactionIndex(snapshot: readonly SessionEntryLike[]): number {
	for (let index = snapshot.length - 1; index >= 0; index--) {
		if (snapshot[index]?.type === "compaction") return index;
	}
	return -1;
}

function entryIds(entries: readonly SessionEntryLike[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (typeof entry.id === "string") ids.add(entry.id);
	}
	return ids;
}

/**
 * Post-Compaction Tail: projected messages whose sourceEntry appears after the
 * latest compaction on the original root-to-leaf snapshot (not projection order).
 */
function postCompactionTailMessages(snapshot: readonly SessionEntryLike[], projection: SessionProjectionLike): unknown[] | undefined {
	const latestIndex = latestCompactionIndex(snapshot);
	if (latestIndex < 0) return undefined;
	const tailIds = entryIds(snapshot.slice(latestIndex + 1));
	const messages: unknown[] = [];
	for (const projected of projection.entries) {
		const id = projected.sourceEntry?.id;
		if (typeof id === "string" && tailIds.has(id)) messages.push(...projected.messages);
	}
	return messages;
}

/**
 * Fail-closed for opaque Provider Artifacts: a post-checkpoint context_edit that
 * targets the checkpoint or any earlier entry on this snapshot disables replay.
 */
function hasUnsafePostCheckpointContextEdit(snapshot: readonly SessionEntryLike[]): boolean {
	const latestIndex = latestCompactionIndex(snapshot);
	if (latestIndex < 0) return false;
	const earlierOrCheckpointIds = entryIds(snapshot.slice(0, latestIndex + 1));
	for (const entry of snapshot.slice(latestIndex + 1)) {
		if (entry?.type !== "context_edit") continue;
		if (typeof entry.targetId === "string" && earlierOrCheckpointIds.has(entry.targetId)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Provider Artifact persistence: Valid Provider Artifact + retained users
// ---------------------------------------------------------------------------

function canonicalCompactionItem(value: unknown): ResponsesItem | undefined {
	if (!isRecord(value) || value.type !== "compaction" || !isNonEmptyString(value.encrypted_content)) return undefined;
	if (!jsonValue(value)) return undefined;
	return { type: "compaction", encrypted_content: value.encrypted_content };
}

function validRetainedUserMessage(value: unknown): value is ResponsesItem {
	if (!isRecord(value) || !jsonValue(value) || (value.type !== undefined && value.type !== "message") || value.role !== "user" || !Array.isArray(value.content) || value.content.length === 0) return false;
	return value.content.every((item) => isRecord(item) && (
		(item.type === "input_text" && typeof item.text === "string")
		|| (item.type === "input_image" && typeof item.image_url === "string" && (item.detail === undefined || typeof item.detail === "string"))
	));
}

function canonicalRetainedUserMessage(value: unknown): ResponsesItem | undefined {
	if (!validRetainedUserMessage(value)) return undefined;
	const content = (value.content as JsonRecord[]).map((part) => part.type === "input_text"
		? { type: "input_text", text: part.text }
		: {
			type: "input_image",
			image_url: part.image_url,
			...(typeof part.detail === "string" ? { detail: part.detail } : {}),
		});
	return {
		...(value.type === "message" ? { type: "message" } : {}),
		role: "user",
		content,
	};
}

function retainedMessageTokens(items: readonly ResponsesItem[]): number {
	return items.reduce((total, item) => {
		const textCharacters = (item.content as JsonRecord[])
			.filter((part) => part.type === "input_text")
			.reduce((sum, part) => sum + (part.text as string).length, 0);
		return total + Math.max(1, Math.ceil(textCharacters / 4));
	}, 0);
}

function inputImagePartBytes(part: JsonRecord): number {
	return Buffer.byteLength(JSON.stringify(part), "utf8");
}

function retainedInputImageBytes(items: readonly ResponsesItem[]): number {
	let bytes = 0;
	for (const item of items) {
		if (!validRetainedUserMessage(item)) continue;
		for (const part of item.content as JsonRecord[]) if (part.type === "input_image") bytes += inputImagePartBytes(part);
	}
	return bytes;
}

function parseRemoteTelemetry(value: unknown): RemoteCompactionTelemetry | undefined {
	if (!isRecord(value)) return undefined;
	const latencyMs = nonNegativeNumber(value.latencyMs);
	if (latencyMs === undefined) return undefined;
	const inputTokens = nonNegativeNumber(value.inputTokens);
	const outputTokens = nonNegativeNumber(value.outputTokens);
	const totalTokens = nonNegativeNumber(value.totalTokens);
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		latencyMs,
	};
}

export function parseResponsesCompactionDetails(value: unknown): ResponsesCompactionDetails | undefined {
	if (!isRecord(value) || value.kind !== DETAILS_KIND || value.version !== DETAILS_VERSION || !isRecord(value.identity) || !Array.isArray(value.history)) return undefined;
	const identity = value.identity;
	const baseUrl = normalizeBaseUrl(identity.baseUrl);
	if (!isNonEmptyString(identity.provider) || !isNonEmptyString(identity.api) || !isNonEmptyString(identity.model) || !baseUrl) return undefined;
	const artifacts = value.history.filter((item) => canonicalCompactionItem(item) !== undefined);
	const artifact = canonicalCompactionItem(value.history.at(-1));
	if (value.history.length === 0 || artifacts.length !== 1 || !artifact) return undefined;
	const retained = value.history.slice(0, -1).map(canonicalRetainedUserMessage);
	if (retained.some((item) => !item)) return undefined;
	const canonicalRetained = retained as ResponsesItem[];
	if (retainedMessageTokens(canonicalRetained) > RETAINED_USER_MESSAGE_TOKEN_BUDGET) return undefined;
	if (retainedInputImageBytes(canonicalRetained) > RETAINED_INPUT_IMAGE_BYTES_BUDGET) return undefined;
	if (Buffer.byteLength(JSON.stringify([...canonicalRetained, artifact]), "utf8") > MAX_PERSISTED_HISTORY_BYTES) return undefined;
	const telemetry = parseRemoteTelemetry(value.telemetry);
	return {
		kind: DETAILS_KIND,
		version: DETAILS_VERSION,
		identity: {
			provider: identity.provider,
			api: identity.api,
			model: identity.model,
			baseUrl,
		},
		history: [...canonicalRetained, artifact],
		...(telemetry ? { telemetry } : {}),
	};
}

function isRealUserMessage(item: ResponsesItem): boolean {
	if (!validRetainedUserMessage(item)) return false;
	return (item.content as JsonRecord[]).some((part) => (
		(part.type === "input_text" && isNonEmptyString(part.text))
		|| (part.type === "input_image" && isNonEmptyString(part.image_url))
	));
}

function truncateMessageToBudgets(item: ResponsesItem, maxTokens: number, maxImageBytes: number): { item?: ResponsesItem; usedTokens: number; usedImageBytes: number } {
	if (!validRetainedUserMessage(item)) return { usedTokens: 0, usedImageBytes: 0 };
	let remainingCharacters = Math.max(0, maxTokens * 4);
	let remainingImageBytes = Math.max(0, maxImageBytes);
	let usedTextCharacters = 0;
	let usedImageBytes = 0;
	const content = (item.content as JsonRecord[]).flatMap<JsonRecord>((part) => {
		if (part.type === "input_image") {
			const canonical = {
				type: "input_image",
				image_url: part.image_url,
				...(typeof part.detail === "string" ? { detail: part.detail } : {}),
			};
			const bytes = inputImagePartBytes(canonical);
			if (bytes > remainingImageBytes) return [];
			remainingImageBytes -= bytes;
			usedImageBytes += bytes;
			return [canonical];
		}
		if (remainingCharacters === 0) return [];
		const text = (part.text as string).slice(0, remainingCharacters);
		remainingCharacters -= text.length;
		usedTextCharacters += text.length;
		return text ? [{ type: "input_text", text }] : [];
	});
	const retained = content.length > 0 ? {
		...(item.type === "message" ? { type: "message" } : {}),
		role: "user",
		content,
	} : undefined;
	return {
		...(retained ? { item: retained } : {}),
		usedTokens: retained ? Math.max(1, Math.ceil(usedTextCharacters / 4)) : 0,
		usedImageBytes,
	};
}

/** Builds Responses compaction v2 replacement history from the input actually sent to remote. */
export function buildResponsesCompactionV2History(input: readonly ResponsesItem[], artifact: ResponsesItem): ResponsesItem[] | undefined {
	const canonicalArtifact = canonicalCompactionItem(artifact);
	if (!canonicalArtifact) return undefined;
	let remainingTokens = RETAINED_USER_MESSAGE_TOKEN_BUDGET;
	let remainingImageBytes = RETAINED_INPUT_IMAGE_BYTES_BUDGET;
	const retainedReversed: ResponsesItem[] = [];
	for (const item of [...input].reverse()) {
		if (remainingTokens === 0) break;
		if (!isRealUserMessage(item)) continue;
		const retained = truncateMessageToBudgets(item, remainingTokens, remainingImageBytes);
		if (retained.item) retainedReversed.push(retained.item);
		remainingTokens -= retained.usedTokens;
		remainingImageBytes -= retained.usedImageBytes;
	}
	return [...retainedReversed.reverse(), canonicalArtifact];
}

export function buildResponsesCompactionDetails(identity: ResponsesIdentity, artifact: ResponsesItem, input: readonly ResponsesItem[], telemetry?: RemoteCompactionTelemetry): ResponsesCompactionDetails | undefined {
	const history = buildResponsesCompactionV2History(input, artifact);
	const baseUrl = normalizeBaseUrl(identity.baseUrl);
	if (!history || !baseUrl || Buffer.byteLength(JSON.stringify(history), "utf8") > MAX_PERSISTED_HISTORY_BYTES) return undefined;
	return {
		kind: DETAILS_KIND,
		version: DETAILS_VERSION,
		identity: {
			provider: identity.provider,
			api: identity.api,
			model: identity.model,
			baseUrl,
		},
		history,
		...(telemetry ? { telemetry: cloneJson(telemetry) } : {}),
	};
}

// ---------------------------------------------------------------------------
// Provider History reconstruction (artifact checkpoint + Post-Compaction Tail)
// ---------------------------------------------------------------------------

export async function reconstructResponsesCompactionHistory(entries: readonly SessionEntryLike[], identity: ResponsesIdentity, runtime: Runtime): Promise<ResponsesItem[] | undefined> {
	const latestIndex = latestCompactionIndex(entries);
	if (latestIndex < 0) return undefined;
	const entryDetails = entries[latestIndex]!.details;
	const details = parseResponsesCompactionDetails(isRecord(entryDetails) ? entryDetails.remoteResponsesCompaction : undefined);
	if (!details || !sameIdentity(details.identity, identity)) return undefined;
	if (hasUnsafePostCheckpointContextEdit(entries)) return undefined;
	const projection = projectBranchSnapshot(entries);
	if (!projection) return undefined;
	const trailing = postCompactionTailMessages(entries, projection);
	if (!trailing) return undefined;
	const serialized = await serializePiMessages(trailing, runtime);
	return serialized ? [...details.history, ...serialized] : undefined;
}

// ---------------------------------------------------------------------------
// Provider Artifact generation (transport-independent provider events)
// ---------------------------------------------------------------------------

/** Bounded ordered event collector. Only the provider adapter parses response bytes. */
function createCompactionCollector() {
	let bytes = 0;
	let terminal = false;
	let invalid = false;
	let outputItem: ResponsesItem | undefined;
	let completedArtifact: ResponsesItem | undefined;
	let usage: Omit<RemoteCompactionTelemetry, "latencyMs"> | undefined;
	const fail = (message: string): never => {
		invalid = true;
		throw new Error(message);
	};
	return {
		observe(event: unknown) {
			if (invalid) return fail("Compaction stream is invalid");
			if (!isRecord(event) || !isNonEmptyString(event.type) || !jsonValue(event)) {
				return fail("Invalid provider compaction event");
			}
			bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
			if (bytes > MAX_PROVIDER_EVENT_BYTES) return fail("Compaction events exceeded their size limit");
			if (terminal) return fail("Provider event followed terminal compaction event");
			if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
				return fail("Provider compaction did not complete");
			}
			if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "compaction") {
				const item = canonicalCompactionItem(event.item);
				if (!item || outputItem) return fail("Expected one valid completed compaction item");
				outputItem = item;
			}
			if (event.type !== "response.completed") return;
			terminal = true;
			const response = event.response;
			if (!isRecord(response) || response.status !== "completed" || !Array.isArray(response.output)) {
				return fail("Provider did not complete a valid compaction response");
			}
			const artifacts = response.output.filter((item) => isRecord(item) && item.type === "compaction");
			if (artifacts.length !== 1) return fail("Expected exactly one compaction artifact");
			const artifact = canonicalCompactionItem(artifacts[0]);
			if (!artifact || (outputItem && !sameJson(outputItem, artifact))) return fail("Inconsistent compaction artifact");
			completedArtifact = artifact;
			if (isRecord(response.usage)) {
				const inputTokens = nonNegativeNumber(response.usage.input_tokens);
				const outputTokens = nonNegativeNumber(response.usage.output_tokens);
				const totalTokens = nonNegativeNumber(response.usage.total_tokens);
				usage = {
					...(inputTokens !== undefined ? { inputTokens } : {}),
					...(outputTokens !== undefined ? { outputTokens } : {}),
					...(totalTokens !== undefined ? { totalTokens } : {}),
				};
			}
		},
		result() {
			return !invalid && terminal && completedArtifact ? { artifact: completedArtifact, usage } : undefined;
		},
	};
}

/** Observe public events without replacing the selected provider's transport. */
export async function requestResponsesCompaction(runtime: Runtime, input: readonly ResponsesItem[], signal: AbortSignal | undefined, options: RemoteCompactionRequestOptions = {}): Promise<RemoteCompactionResult | undefined> {
	const startedAt = Date.now();
	const controller = new AbortController();
	const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const collector = createCompactionCollector();
	let deadline: AbortSignal | undefined;
	let prepared = false;
	const abortDeadline = () => controller.abort(deadline?.reason);
	try {
		signal?.throwIfAborted();
		const stream = runtime.adapter.stream(runtime.modelConfig, options.context ?? normalizeContext({ messages: [] }), {
			apiKey: runtime.apiKey,
			headers: runtime.headers,
			env: runtime.env,
			samplingParams: runtime.modelConfig.samplingParams,
			signal: requestSignal,
			cacheRetention: "none",
			timeoutMs: REMOTE_COMPACTION_TIMEOUT_MS,
			maxRetries: 0,
			onPayload: (payload) => {
				requestSignal.throwIfAborted();
				if (prepared || !isRecord(payload) || payload.model !== runtime.model || !Array.isArray(payload.input)) {
					throw new Error("Provider did not expose one valid Responses payload");
				}
				const request: JsonRecord = {
					...payload,
					input: [...(options.inputPrefix ?? []), ...input, { type: "compaction_trigger" }],
					stream: true,
					store: false,
					include: [...new Set([...(Array.isArray(payload.include) ? payload.include : []), "reasoning.encrypted_content"])],
					...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
					...(options.tools ? { tools: cloneJson(options.tools) } : {}),
					...(options.toolChoice !== undefined ? { tool_choice: cloneJson(options.toolChoice) } : {}),
					...(options.parallelToolCalls !== undefined ? { parallel_tool_calls: options.parallelToolCalls } : {}),
					...(options.reasoning ? { reasoning: cloneJson(options.reasoning) } : {}),
					...(options.text ? { text: cloneJson(options.text) } : {}),
				};
				if (options.inputPrefix?.length && options.instructions === undefined) delete request.instructions;
				delete request.previous_response_id;
				// Freeze local JSON before the deadline; final wire encoding and connection setup belong to the adapter.
				const frozen = cloneJson(request);
				prepared = true;
				deadline = AbortSignal.timeout(REMOTE_COMPACTION_TIMEOUT_MS);
				deadline.addEventListener("abort", abortDeadline, { once: true });
				if (deadline.aborted) abortDeadline();
				requestSignal.throwIfAborted();
				return frozen;
			},
			onProviderStreamEvent: (event) => {
				requestSignal.throwIfAborted();
				if (!prepared) throw new Error("Provider did not prepare a compaction payload");
				collector.observe(event);
			},
		});
		const result = await stream.result();
		signal?.throwIfAborted();
		const parsed = collector.result();
		if (requestSignal.aborted || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length" || !parsed) return undefined;
		return { artifact: parsed.artifact, telemetry: { ...(parsed.usage ?? {}), latencyMs: Date.now() - startedAt } };
	} catch {
		signal?.throwIfAborted();
		return undefined;
	} finally {
		deadline?.removeEventListener("abort", abortDeadline);
		controller.abort();
	}
}

// ---------------------------------------------------------------------------
// Independent component execution (Portable Projection + Provider Artifact)
// ---------------------------------------------------------------------------

export async function runCompactionPair<TLocal, TRemote>(localCall: () => Promise<TLocal>, remoteCall: (signal: AbortSignal) => Promise<TRemote>, parentSignal?: AbortSignal): Promise<CompactionPair<TLocal, TRemote>> {
	const signal = parentSignal ?? new AbortController().signal;
	const localSettled = localCall().then(
		(value) => ({ ok: true as const, value }),
		() => ({ ok: false as const }),
	);
	const remoteSettled = remoteCall(signal).then(
		(value) => ({ ok: true as const, value }),
		() => ({ ok: false as const }),
	);
	const [local, remote] = await Promise.all([localSettled, remoteSettled]);
	return {
		...(local.ok ? { local: local.value } : {}),
		...(remote.ok ? { remote: remote.value } : {}),
	};
}

// ---------------------------------------------------------------------------
// Request Semantic Envelope (credential-free capture + reconstruction)
// ---------------------------------------------------------------------------

function providerInputPrefix(input: unknown): ResponsesItem[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const prefix: ResponsesItem[] = [];
	for (const item of input) {
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
		if (!strictJsonValue(item)) return undefined;
		prefix.push(cloneJson(item));
	}
	return prefix;
}

export function captureResponsesRequestShape(payload: unknown, identity: ResponsesIdentity): ResponsesRequestShape | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.model === "string" && payload.model !== identity.model) return undefined;
	const instructions = isNonEmptyString(payload.instructions) ? payload.instructions : undefined;
	const inputPrefix = providerInputPrefix(payload.input);
	const tools = Array.isArray(payload.tools) && payload.tools.every((tool) => isRecord(tool) && strictJsonValue(tool))
		? cloneJson(payload.tools) as ResponsesItem[]
		: undefined;
	const toolChoice = strictJsonValue(payload.tool_choice) ? cloneJson(payload.tool_choice) : undefined;
	const parallelToolCalls = typeof payload.parallel_tool_calls === "boolean" ? payload.parallel_tool_calls : undefined;
	const reasoning = isRecord(payload.reasoning) && strictJsonValue(payload.reasoning) ? cloneJson(payload.reasoning) : undefined;
	const text = isRecord(payload.text) && strictJsonValue(payload.text) ? cloneJson(payload.text) : undefined;
	const shape: ResponsesRequestShape = {
		identity: {
			provider: identity.provider,
			api: identity.api,
			model: identity.model,
			baseUrl: identity.baseUrl,
		},
		...(instructions ? { instructions } : {}),
		...(inputPrefix?.length ? { inputPrefix } : {}),
		...(tools ? { tools } : {}),
		...(toolChoice !== undefined ? { toolChoice } : {}),
		...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
		...(reasoning ? { reasoning } : {}),
		...(text ? { text } : {}),
	};
	return Buffer.byteLength(JSON.stringify(shape), "utf8") <= MAX_REQUEST_SHAPE_BYTES ? shape : undefined;
}

function activeToolsPayload(pi: ExtensionAPI): ResponsesItem[] | undefined {
	try {
		const active = new Set(pi.getActiveTools());
		const allTools = pi.getAllTools() as Array<{ name: string; description?: string; parameters: unknown }>;
		const tools = allTools
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
		return tools.every(strictJsonValue) ? cloneJson(tools) : undefined;
	} catch {
		return undefined;
	}
}

function fallbackRequestShape(pi: ExtensionAPI, ctx: ExtensionContext, runtime: Runtime): ResponsesRequestShape | undefined {
	const tools = activeToolsPayload(pi);
	const thinkingLevel = pi.getThinkingLevel();
	const reasoning = isRecord(runtime.modelConfig)
		&& runtime.modelConfig.reasoning
		&& typeof thinkingLevel === "string"
		&& thinkingLevel !== "off"
		? { effort: thinkingLevel, summary: "auto" }
		: undefined;
	const shape: ResponsesRequestShape = {
		identity: { provider: runtime.provider, api: runtime.api, model: runtime.model, baseUrl: runtime.baseUrl },
		instructions: ctx.getSystemPrompt(),
		...(tools ? { tools } : {}),
		toolChoice: "auto",
		parallelToolCalls: true,
		...(reasoning ? { reasoning } : {}),
	};
	return Buffer.byteLength(JSON.stringify(shape), "utf8") <= MAX_REQUEST_SHAPE_BYTES ? shape : undefined;
}

function mergeRequestShapes(fallback: ResponsesRequestShape, observed: ResponsesRequestShape | undefined): ResponsesRequestShape {
	if (!observed) return fallback;
	const merged: ResponsesRequestShape = {
		...fallback,
		...observed,
		identity: fallback.identity,
	};
	if (observed.inputPrefix?.length && observed.instructions === undefined) delete merged.instructions;
	return merged;
}

// ---------------------------------------------------------------------------
// Provider Replay (strict Replay Identity + session parity)
// ---------------------------------------------------------------------------

export function replayResponsesCompactionPayload(payload: unknown, history: readonly ResponsesItem[], expectedSessionInput: readonly ResponsesItem[], expectedModel: string): JsonRecord | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.input) || payload.model !== expectedModel) return undefined;
	const prefix: unknown[] = [];
	let firstSessionItem = 0;
	for (; firstSessionItem < payload.input.length; firstSessionItem++) {
		const item = payload.input[firstSessionItem];
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
		prefix.push(item);
	}
	if (!sameJson(payload.input.slice(firstSessionItem), expectedSessionInput)) return undefined;
	return { ...payload, input: [...prefix, ...cloneJson(history)] };
}

// ---------------------------------------------------------------------------
// Frozen Compaction Input identity
// ---------------------------------------------------------------------------

function compactionFingerprint(event: SessionBeforeCompactEvent, runtime: Runtime, source: readonly ResponsesItem[], shape: ResponsesRequestShape): string | undefined {
	try {
		return createHash("sha256").update(JSON.stringify({
			identity: { provider: runtime.provider, api: runtime.api, model: runtime.model, baseUrl: runtime.baseUrl },
			branchEntries: event.branchEntries,
			preparation: event.preparation,
			customInstructions: event.customInstructions,
			source,
			shape,
		}), "utf8").digest("hex");
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Codex Compaction Policy lifecycle (deep module behind registration seam)
// Owns Frozen Input, Pending Attempt, dual generators, and Provider Replay.
// ---------------------------------------------------------------------------

type CodexCompactionPolicyDependencies = {
	compact: typeof compact;
	request: typeof requestResponsesCompaction;
};

/**
 * Process-local Codex Compaction Policy lifecycle.
 * Exclusive owner for matched routes: freeze, pending retry, generators, replay.
 */
function createCodexCompactionPolicyLifecycle(pi: ExtensionAPI, dependencies: CodexCompactionPolicyDependencies) {
	let lastRequestShape: ResponsesRequestShape | undefined;
	const pendingBySession = new Map<string, PendingCompactionAttempt>();

	const clearEphemeral = () => {
		lastRequestShape = undefined;
		pendingBySession.clear();
	};

	/** Provider Replay: observe envelope, rewrite with Provider History when parity holds. */
	const beforeProviderRequest = async (event: { payload: unknown }, ctx: ExtensionContext): Promise<JsonRecord | undefined> => {
		const runtime = await resolveRuntime(ctx);
		if (!runtime) return undefined;
		lastRequestShape = captureResponsesRequestShape(event.payload, runtime);
		try {
			const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
			const projection = projectBranchSnapshot(branch);
			if (!projection) return undefined;
			const history = await reconstructResponsesCompactionHistory(branch, runtime, runtime);
			const expectedSessionInput = await serializePiMessagesForParity(projection.messages, runtime);
			return history && expectedSessionInput
				? replayResponsesCompactionPayload(event.payload, history, expectedSessionInput, runtime.model)
				: undefined;
		} catch {
			return undefined;
		}
	};

	/** Frozen Compaction Input: Component View source + Request Semantic Envelope + fingerprint. */
	const freezeCompactionInput = async (
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
		runtime: Runtime,
	): Promise<
		| { ok: true; source: ResponsesItem[]; shape: ResponsesRequestShape; context: TranscriptContext; fingerprint: string }
		| { ok: false; message: string }
	> => {
		const branch = event.branchEntries as SessionEntryLike[];
		const projection = projectBranchSnapshot(branch);
		if (!projection) return { ok: false, message: "Codex compaction requires Pi 1.2.0 session projection." };
		const replayed = await reconstructResponsesCompactionHistory(branch, runtime, runtime);
		const source = replayed ?? await serializePiMessages(projection.messages, runtime);
		if (!source || source.length === 0) return { ok: false, message: "Codex compaction could not build a valid provider input." };

		const capturedShape = lastRequestShape && sameIdentity(lastRequestShape.identity, runtime) ? lastRequestShape : undefined;
		const fallbackShape = fallbackRequestShape(pi, ctx, runtime);
		if (!fallbackShape) return { ok: false, message: "Codex compaction could not build a bounded request shape." };
		const shape = mergeRequestShapes(fallbackShape, capturedShape);
		const fingerprint = compactionFingerprint(event, runtime, source, shape);
		if (!fingerprint) return { ok: false, message: "Codex compaction could not freeze the current session input." };
		const context = normalizeContext({ systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(projection.messages as any) });
		return { ok: true, source, shape, context, fingerprint };
	};

	/** Component Retry only while freeze identity is unchanged. */
	const resumePendingAttempt = (sessionId: string, fingerprint: string): PendingCompactionAttempt | undefined => {
		const cached = pendingBySession.get(sessionId);
		const pending = cached?.fingerprint === fingerprint ? cached : undefined;
		if (cached && !pending) pendingBySession.delete(sessionId);
		return pending;
	};

	const retainPartialAttempt = (sessionId: string, fingerprint: string, pair: CompactionPair<PortableCompaction, RemoteCompactionResult>): void => {
		if (pair.local || pair.remote) pendingBySession.set(sessionId, { fingerprint, local: pair.local, remote: pair.remote });
		else pendingBySession.delete(sessionId);
	};

	/** Portable Projection Generator + Provider Artifact generation, independent. */
	const runIndependentGenerators = (
		event: SessionBeforeCompactEvent,
		runtime: Runtime,
		frozen: { source: ResponsesItem[]; shape: ResponsesRequestShape; context: TranscriptContext },
		pending: PendingCompactionAttempt | undefined,
	): Promise<CompactionPair<PortableCompaction, RemoteCompactionResult>> => {
		const compactFn = dependencies.compact;
		const requestFn = dependencies.request;
		const { source, shape } = frozen;
		return runCompactionPair<PortableCompaction, RemoteCompactionResult>(
			() => pending?.local
				? Promise.resolve(pending.local)
				: (compactFn(event.preparation, runtime.modelConfig, runtime.apiKey, runtime.headers, event.customInstructions, event.signal, pi.getThinkingLevel(),
					(model, context, options) => runtime.adapter.streamSimple(model, normalizeContext(context), {
						...options, headers: runtime.headers, env: runtime.env, maxRetries: 0,
					}), runtime.env) as Promise<PortableCompaction>).then((local) => {
					// An empty Portable Projection is a local Component Failure, not a committable pair member.
					if (typeof local?.summary !== "string" || !local.summary.trim()) throw new Error("portable projection unavailable");
					return local;
				}),
			(remoteSignal) => pending?.remote
				? Promise.resolve(pending.remote)
				: requestFn(runtime, source, remoteSignal, {
					context: frozen.context,
					instructions: shape.instructions,
					inputPrefix: shape.inputPrefix,
					tools: shape.tools,
					toolChoice: shape.toolChoice,
					parallelToolCalls: shape.parallelToolCalls,
					reasoning: shape.reasoning,
					text: shape.text,
				}).then((result) => {
					if (!result) throw new Error("remote compaction unavailable");
					return result;
				}),
			event.signal,
		);
	};

	/**
	 * Compaction attempt under the selected Codex Compaction Policy.
	 * Policy Failure never falls back to Pi Compaction Policy.
	 */
	const beforeCompact = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		let sessionId: string | undefined;
		try {
			if (!routeMatches(ctx)) return undefined;
			sessionId = ctx.sessionManager.getSessionId();
			const cancel = (message?: string) => {
				if (message && ctx.hasUI) ctx.ui.notify(message, "warning");
				return { cancel: true as const };
			};
			if (event.signal.aborted) {
				pendingBySession.delete(sessionId);
				return cancel();
			}
			const runtime = await resolveRuntime(ctx);
			if (!runtime) return cancel("Codex compaction could not resolve provider authentication. Fix the provider and run /compact again.");

			const frozen = await freezeCompactionInput(event, ctx, runtime);
			if (frozen.ok === false) return cancel(frozen.message);

			const pending = resumePendingAttempt(sessionId, frozen.fingerprint);
			const pair = await runIndependentGenerators(event, runtime, frozen, pending);

			if (event.signal.aborted) {
				pendingBySession.delete(sessionId);
				return cancel();
			}
			if (!pair.local || !pair.remote) {
				retainPartialAttempt(sessionId, frozen.fingerprint, pair);
				const missing = pair.local ? "provider artifact" : pair.remote ? "portable projection" : "portable projection and provider artifact";
				return cancel(`Codex compaction is incomplete (${missing} failed). Run /compact again without changing the session to retry the missing component.`);
			}
			const details = buildResponsesCompactionDetails(runtime, pair.remote.artifact, frozen.source, pair.remote.telemetry);
			if (!details) {
				pendingBySession.delete(sessionId);
				return cancel("Codex compaction produced a result that could not be persisted safely.");
			}
			pendingBySession.delete(sessionId);
			return {
				compaction: {
					summary: pair.local.summary,
					firstKeptEntryId: pair.local.firstKeptEntryId,
					tokensBefore: pair.local.tokensBefore,
					usage: pair.local.usage,
					details: {
						...(pair.local.details !== undefined ? { localSummaryDetails: pair.local.details } : {}),
						remoteResponsesCompaction: details,
					},
				},
			};
		} catch {
			if (sessionId) pendingBySession.delete(sessionId);
			try {
				if (ctx.hasUI) ctx.ui.notify("Codex compaction failed unexpectedly. Pi default compaction was blocked; run /compact again.", "warning");
			} catch {}
			return { cancel: true as const };
		}
	};

	return {
		clearEphemeral,
		beforeProviderRequest,
		beforeCompact,
	};
}

// ---------------------------------------------------------------------------
// External registration seam (only public integration used by index.ts)
// ---------------------------------------------------------------------------

/** Registers the only public integration point used by codex-tools/index.ts. */
export function registerResponsesCompaction(pi: ExtensionAPI, dependencies: {
	compact?: typeof compact;
	request?: typeof requestResponsesCompaction;
} = {}): void {
	const lifecycle = createCodexCompactionPolicyLifecycle(pi, {
		compact: dependencies.compact ?? compact,
		request: dependencies.request ?? requestResponsesCompaction,
	});
	const clearEphemeral = () => lifecycle.clearEphemeral();
	pi.on("session_start", clearEphemeral);
	pi.on("model_select", clearEphemeral);
	pi.on("session_before_switch", clearEphemeral);
	pi.on("session_before_fork", clearEphemeral);
	pi.on("session_before_tree", clearEphemeral);
	pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => lifecycle.beforeCompact(event, ctx));
	pi.on("before_provider_request", (event, ctx) => lifecycle.beforeProviderRequest(event, ctx));
}

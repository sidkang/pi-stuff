import { assertFetchUrlAllowed, parseFetchUrl } from "./url-guard.ts";
import { CdpClient, type CdpConnection } from "./cdp-transport.ts";

/** Hard UTF-8 HTML capture limit. Browser-side check prevents oversized CDP transfer. */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
/** Final browser-side UTF-8 sizing and HTML transfer budget, still capped by the shared deadline. */
export const CAPTURE_MAX_MS = 30_000;
/** Coarse load milestone wait. Missing load is not a hard failure. */
export const LOAD_EVENT_WAIT_MS = 5_000;
/**
 * Minimum post-load observation before readiness can succeed.
 * Prevents accepting a stable empty shell immediately after load.
 */
export const READINESS_MIN_OBSERVE_MS = 1_500;
/** Relevant-network quiet window and semantic DOM stability window. */
export const READINESS_QUIET_MS = 750;
/** Signature sampling interval during readiness / post-scroll settle. */
export const READINESS_SAMPLE_MS = 250;
/** Hard upper bound on post-load readiness waiting. */
export const READINESS_MAX_MS = 8_000;
/** Total budget for the bounded lazy-load phase. */
export const LAZY_LOAD_MAX_MS = 5_000;
/** Maximum incremental scroll steps. Never loops to page bottom. */
export const LAZY_LOAD_MAX_STEPS = 4;
/** Each step scrolls this fraction of the current viewport height. */
export const LAZY_LOAD_STEP_VIEWPORTS = 0.8;
/**
 * Total scroll distance cap in viewport heights.
 * With STEP=0.8 this binds before MAX_STEPS under continuous growth (3 scrolls → 2.4).
 */
export const LAZY_LOAD_MAX_DISTANCE_VIEWPORTS = 2.4;
/** Per-step settle wait cap after each scroll. */
export const LAZY_LOAD_SETTLE_MAX_MS = 1_500;
/** Stop lazy-load after this many consecutive steps with no meaningful growth. */
export const LAZY_LOAD_NO_GROWTH_LIMIT = 2;
/**
 * Character threshold used only as a soft pre-stop before exact UTF-8 capture.
 * Sized below the 64 MiB hard cap but above large real-world home pages (~18M chars).
 */
export const HTML_SOFT_CHAR_LIMIT = 56_000_000;
export const TEARDOWN_TIMEOUT_MS = 2_000;
/** Minimum meaningful text growth during lazy-load. */
export const LAZY_LOAD_MIN_TEXT_GROWTH = 200;
/**
 * How many times a late allowed main-frame Document/redirect may restart readiness
 * after the initial navigation document.
 */
export const DOCUMENT_RESTART_MAX = 2;
/** Readiness budget used after a late main-frame document change. */
export const DOCUMENT_RESTART_READINESS_MAX_MS = 3_000;

/** Resource types that can affect main-content readiness. Image/Font/Media/WebSocket are ignored. */
export const RELEVANT_RESOURCE_TYPES = new Set(["Document", "XHR", "Fetch", "Script"]);

export type CapturedPage = {
	requestedUrl: string;
	url: string;
	title: string;
	html: string;
};

export type CapturePageOptions = {
	connection: CdpConnection;
	url: string;
	signal?: AbortSignal;
	deadlineAt?: number;
	clientFactory?: typeof CdpClient.connect;
	lookup?: Parameters<typeof assertFetchUrlAllowed>[1] extends infer T ? T extends { lookup?: infer L } ? L : never : never;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type ContentSignature = {
	textLength: number;
	articleCount: number;
	linkCount: number;
	headingCount: number;
	scrollHeight: number;
	canScroll: boolean;
	htmlChars: number;
};

export type LazyLoadBudgetState = {
	stepsCompleted: number;
	scrolledViewports: number;
	noGrowth: number;
	phaseElapsedMs: number;
	canScroll: boolean;
	nearHtmlCap: boolean;
};

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("This operation was aborted", "AbortError");
}

function remainingMs(deadlineAt: number | undefined, fallback: number, now: () => number): number {
	if (deadlineAt === undefined) return fallback;
	return Math.max(0, deadlineAt - now());
}

function budgetMs(deadlineAt: number | undefined, preferred: number, now: () => number): number {
	return Math.min(preferred, remainingMs(deadlineAt, preferred, now));
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	if (signal?.aborted) throw abortReason(signal);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(abortReason(signal!));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function isRelevantResourceType(resourceType: string | undefined): boolean {
	if (!resourceType) return false;
	return RELEVANT_RESOURCE_TYPES.has(resourceType);
}

export function signatureKey(signature: ContentSignature): string {
	return [
		signature.textLength,
		signature.articleCount,
		signature.linkCount,
		signature.headingCount,
		signature.scrollHeight,
		signature.htmlChars,
	].join("|");
}

export function hasMeaningfulGrowth(before: ContentSignature, after: ContentSignature): boolean {
	if (after.articleCount > before.articleCount) return true;
	if (after.linkCount > before.linkCount) return true;
	if (after.headingCount > before.headingCount) return true;
	if (after.textLength >= before.textLength + LAZY_LOAD_MIN_TEXT_GROWTH) return true;
	return false;
}

export function isNearHtmlCap(signature: ContentSignature): boolean {
	return signature.htmlChars >= HTML_SOFT_CHAR_LIMIT;
}

/** Pure stop rules for the lazy-load loop so each hard budget is unit-testable. */
export function lazyLoadShouldStop(state: LazyLoadBudgetState): boolean {
	if (state.phaseElapsedMs >= LAZY_LOAD_MAX_MS) return true;
	if (state.stepsCompleted >= LAZY_LOAD_MAX_STEPS) return true;
	if (state.scrolledViewports >= LAZY_LOAD_MAX_DISTANCE_VIEWPORTS) return true;
	if (state.noGrowth >= LAZY_LOAD_NO_GROWTH_LIMIT) return true;
	if (!state.canScroll) return true;
	if (state.nearHtmlCap) return true;
	return false;
}

function parseSignature(value: unknown): ContentSignature | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const textLength = typeof record.textLength === "number" ? record.textLength : 0;
	const articleCount = typeof record.articleCount === "number" ? record.articleCount : 0;
	const linkCount = typeof record.linkCount === "number" ? record.linkCount : 0;
	const headingCount = typeof record.headingCount === "number" ? record.headingCount : 0;
	const scrollHeight = typeof record.scrollHeight === "number" ? record.scrollHeight : 0;
	const canScroll = record.canScroll === true;
	const htmlChars = typeof record.htmlChars === "number" ? record.htmlChars : 0;
	return { textLength, articleCount, linkCount, headingCount, scrollHeight, canScroll, htmlChars };
}

async function closeTargetBounded(client: CdpClient, targetId: string): Promise<void> {
	// Idempotent: retry once so teardown still closes the owned target under flaky CDP.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await client.send("Target.closeTarget", { targetId }, null, {
				timeoutMs: TEARDOWN_TIMEOUT_MS,
			});
			return;
		} catch {
			// Retry once; final failure must not replace the primary error.
		}
	}
}

const SIGNATURE_EXPRESSION = `(() => {
	const root = document.querySelector("main")
		|| document.querySelector('[role="main"]')
		|| document.body
		|| document.documentElement;
	const textLength = root && typeof root.innerText === "string" ? root.innerText.length : 0;
	const articleCount = root ? root.querySelectorAll("article").length : 0;
	const linkCount = root ? root.querySelectorAll("a[href]").length : 0;
	const headingCount = root ? root.querySelectorAll("h1,h2,h3").length : 0;
	const scrollHeight = Math.max(
		document.documentElement ? document.documentElement.scrollHeight : 0,
		document.body ? document.body.scrollHeight : 0,
	);
	const viewport = window.innerHeight || 0;
	const y = window.scrollY || document.documentElement.scrollTop || 0;
	const canScroll = scrollHeight > viewport + y + 4;
	const htmlChars = document.documentElement ? String(document.documentElement.outerHTML).length : 0;
	return { textLength, articleCount, linkCount, headingCount, scrollHeight, canScroll, htmlChars };
})()`;

const SCROLL_EXPRESSION = `(() => {
	const viewport = Math.max(1, window.innerHeight || 0);
	const step = Math.floor(viewport * ${LAZY_LOAD_STEP_VIEWPORTS});
	window.scrollBy(0, step);
	return {
		scrolledBy: step,
		scrollY: window.scrollY || document.documentElement.scrollTop || 0,
		scrollHeight: Math.max(
			document.documentElement ? document.documentElement.scrollHeight : 0,
			document.body ? document.body.scrollHeight : 0,
		),
	};
})()`;

const CAPTURE_EXPRESSION = `(() => {
	const href = String(location.href || "");
	const title = String(document.title || "");
	const html = String(document.documentElement ? document.documentElement.outerHTML : "");
	const bytes = new TextEncoder().encode(html).byteLength;
	if (bytes > ${MAX_CAPTURE_BYTES}) {
		return { oversized: true, bytes, href, title };
	}
	return { oversized: false, bytes, href, title, html };
})()`;

async function evaluateValue(
	client: CdpClient,
	sessionId: string,
	expression: string,
	options: { signal?: AbortSignal; deadlineAt?: number; timeoutMs?: number },
): Promise<unknown> {
	const evaluated = await client.send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	}, sessionId, {
		signal: options.signal,
		deadlineAt: options.deadlineAt,
		timeoutMs: options.timeoutMs,
	});
	const value = evaluated.result && typeof evaluated.result === "object" && !Array.isArray(evaluated.result)
		? (evaluated.result as { value?: unknown }).value
		: undefined;
	return value;
}

async function sampleSignature(
	client: CdpClient,
	sessionId: string,
	options: { signal?: AbortSignal; deadlineAt?: number },
): Promise<ContentSignature> {
	const value = await evaluateValue(client, sessionId, SIGNATURE_EXPRESSION, options);
	return parseSignature(value) ?? {
		textLength: 0,
		articleCount: 0,
		linkCount: 0,
		headingCount: 0,
		scrollHeight: 0,
		canScroll: false,
		htmlChars: 0,
	};
}

type NetworkTracker = {
	inflight: Set<string>;
	dispose: () => void;
	isQuiet: (quietMs: number, nowMs: number) => boolean;
};

function createNetworkTracker(
	client: CdpClient,
	sessionId: string,
	now: () => number,
): NetworkTracker {
	const inflight = new Set<string>();
	let lastActivityAt = now();
	const offWillBeSent = client.on("Network.requestWillBeSent", (params, eventSessionId) => {
		if (eventSessionId !== sessionId) return;
		const requestId = typeof params.requestId === "string" ? params.requestId : "";
		if (!requestId) return;
		const type = typeof params.type === "string" ? params.type : undefined;
		// CDP may omit type on some redirects; treat missing as Document-relevant for safety.
		if (type !== undefined && !isRelevantResourceType(type)) return;
		inflight.add(requestId);
		lastActivityAt = now();
	});
	const finish = (params: Record<string, unknown>, eventSessionId: string | null) => {
		if (eventSessionId !== sessionId) return;
		const requestId = typeof params.requestId === "string" ? params.requestId : "";
		if (!requestId || !inflight.has(requestId)) return;
		inflight.delete(requestId);
		lastActivityAt = now();
	};
	const offFinished = client.on("Network.loadingFinished", finish);
	const offFailed = client.on("Network.loadingFailed", finish);
	return {
		inflight,
		dispose() {
			offWillBeSent();
			offFinished();
			offFailed();
		},
		isQuiet(quietMs: number, nowMs: number) {
			return inflight.size === 0 && nowMs - lastActivityAt >= quietMs;
		},
	};
}

async function waitForLoadMilestone(options: {
	loadFired: () => boolean;
	signal?: AbortSignal;
	deadlineAt?: number;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	throwIfGuardError: () => void;
}): Promise<void> {
	const loadWaitMs = budgetMs(options.deadlineAt, LOAD_EVENT_WAIT_MS, options.now);
	const loadDeadline = options.now() + loadWaitMs;
	while (!options.loadFired() && options.now() < loadDeadline) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		options.throwIfGuardError();
		const slice = Math.min(50, loadDeadline - options.now());
		if (slice <= 0) break;
		await options.sleep(slice, options.signal);
	}
	options.throwIfGuardError();
}

async function waitForReadiness(options: {
	client: CdpClient;
	sessionId: string;
	network: NetworkTracker;
	signal?: AbortSignal;
	/** Outer shared operation deadline (abort/budget ceiling). */
	operationDeadlineAt?: number;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	maxMs: number;
	minObserveMs: number;
	quietMs: number;
	throwIfGuardError: () => void;
	/** Optional: if document generation changes, exit early so caller can restart. */
	documentGeneration?: () => number;
	expectedGeneration?: number;
}): Promise<ContentSignature> {
	const startedAt = options.now();
	const phaseBudget = budgetMs(options.operationDeadlineAt, options.maxMs, options.now);
	const phaseDeadlineAt = startedAt + phaseBudget;
	let previousKey = "";
	let stableSince = startedAt;
	let lastSignature: ContentSignature | undefined;

	while (options.now() < phaseDeadlineAt) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		options.throwIfGuardError();
		if (
			options.documentGeneration
			&& options.expectedGeneration !== undefined
			&& options.documentGeneration() !== options.expectedGeneration
		) {
			return lastSignature ?? await sampleSignature(options.client, options.sessionId, {
				signal: options.signal,
				deadlineAt: phaseDeadlineAt,
			});
		}

		// Phase-local deadline so each readiness sample cannot inherit a fresh 60s window.
		const signature = await sampleSignature(options.client, options.sessionId, {
			signal: options.signal,
			deadlineAt: phaseDeadlineAt,
		});
		lastSignature = signature;
		const key = signatureKey(signature);
		const observedAt = options.now();
		if (key !== previousKey) {
			previousKey = key;
			stableSince = observedAt;
		}

		const observedLongEnough = observedAt - startedAt >= options.minObserveMs;
		const domQuiet = observedAt - stableSince >= options.quietMs;
		const networkQuiet = options.network.isQuiet(options.quietMs, observedAt);
		if (observedLongEnough && domQuiet && networkQuiet) {
			return signature;
		}
		if (isNearHtmlCap(signature)) {
			return signature;
		}

		const remaining = phaseDeadlineAt - options.now();
		if (remaining <= 0) break;
		await options.sleep(Math.min(READINESS_SAMPLE_MS, remaining), options.signal);
	}

	return lastSignature ?? await sampleSignature(options.client, options.sessionId, {
		signal: options.signal,
		deadlineAt: phaseDeadlineAt,
	});
}

async function boundedLazyLoad(options: {
	client: CdpClient;
	sessionId: string;
	network: NetworkTracker;
	signal?: AbortSignal;
	operationDeadlineAt?: number;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	throwIfGuardError: () => void;
	initial: ContentSignature;
	documentGeneration: () => number;
	expectedGeneration: number;
}): Promise<ContentSignature> {
	const phaseStartedAt = options.now();
	const phaseBudget = budgetMs(options.operationDeadlineAt, LAZY_LOAD_MAX_MS, options.now);
	if (phaseBudget <= 0) return options.initial;

	let signature = options.initial;
	let noGrowth = 0;
	let scrolledViewports = 0;
	let stepsCompleted = 0;

	while (true) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		options.throwIfGuardError();
		if (options.documentGeneration() !== options.expectedGeneration) return signature;

		const phaseElapsedMs = options.now() - phaseStartedAt;
		if (lazyLoadShouldStop({
			stepsCompleted,
			scrolledViewports,
			noGrowth,
			phaseElapsedMs,
			canScroll: signature.canScroll,
			nearHtmlCap: isNearHtmlCap(signature),
		})) {
			return signature;
		}

		const before = signature;
		const scrollDeadlineAt = options.now() + Math.min(
			1_000,
			remainingMs(options.operationDeadlineAt, 1_000, options.now),
			phaseBudget - phaseElapsedMs,
		);
		await evaluateValue(options.client, options.sessionId, SCROLL_EXPRESSION, {
			signal: options.signal,
			deadlineAt: scrollDeadlineAt,
		});
		stepsCompleted += 1;
		scrolledViewports += LAZY_LOAD_STEP_VIEWPORTS;

		const settleBudget = Math.min(
			LAZY_LOAD_SETTLE_MAX_MS,
			phaseBudget - (options.now() - phaseStartedAt),
			remainingMs(options.operationDeadlineAt, LAZY_LOAD_SETTLE_MAX_MS, options.now),
		);
		if (settleBudget > 0) {
			signature = await waitForReadiness({
				client: options.client,
				sessionId: options.sessionId,
				network: options.network,
				signal: options.signal,
				operationDeadlineAt: options.operationDeadlineAt,
				now: options.now,
				sleep: options.sleep,
				maxMs: settleBudget,
				minObserveMs: Math.min(READINESS_QUIET_MS, settleBudget),
				quietMs: Math.min(READINESS_QUIET_MS, settleBudget),
				throwIfGuardError: options.throwIfGuardError,
				documentGeneration: options.documentGeneration,
				expectedGeneration: options.expectedGeneration,
			});
		} else {
			signature = await sampleSignature(options.client, options.sessionId, {
				signal: options.signal,
				deadlineAt: options.now() + Math.min(500, remainingMs(options.operationDeadlineAt, 500, options.now)),
			});
		}

		if (options.documentGeneration() !== options.expectedGeneration) return signature;

		if (hasMeaningfulGrowth(before, signature)) {
			noGrowth = 0;
		} else {
			noGrowth += 1;
		}
	}
}

export async function capturePageWithCdp(options: CapturePageOptions): Promise<CapturedPage> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const clientFactory = options.clientFactory ?? CdpClient.connect;
	const requested = parseFetchUrl(options.url);
	if (requested.ok !== true) throw new Error(requested.message);
	const requestedUrl = requested.url.href;
	await assertFetchUrlAllowed(requestedUrl, {
		lookup: options.lookup,
		resolveDns: false,
		signal: options.signal,
	});

	const client = await clientFactory(options.connection, options.signal, {
		deadlineAt: options.deadlineAt,
		now,
	});

	let targetId: string | undefined;
	let sessionId: string | undefined;
	const pendingGuards = new Set<Promise<void>>();
	const openMainFrameRequestIds = new Set<string>();
	let guardError: Error | undefined;
	let offPaused: (() => void) | undefined;
	let offLoad: (() => void) | undefined;
	let offLifecycle: (() => void) | undefined;
	let network: NetworkTracker | undefined;
	/** Monotonic main-frame Document generation. Bumps on each allowed continue. */
	let documentGeneration = 0;
	/** Cumulative main-frame load events observed on this target. */
	let loadCount = 0;
	/** loadCount snapshot when each document generation was continued. */
	const loadCountAtGeneration = new Map<number, number>();

	const throwIfGuardError = () => {
		if (guardError) throw guardError;
	};

	/**
	 * Always use an independent teardown/operation-independent timeout.
	 * SSRF failRequest must not depend on an already-aborted capture signal.
	 */
	const failRequest = async (requestId: string) => {
		if (!sessionId) return;
		try {
			await client.send("Fetch.failRequest", {
				requestId,
				errorReason: "BlockedByClient",
			}, sessionId, {
				timeoutMs: TEARDOWN_TIMEOUT_MS,
			});
		} catch {
			// ignore failRequest errors
		}
	};

	try {
		const created = await client.send("Target.createTarget", {
			url: "about:blank",
			background: true,
		}, null, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});
		if (typeof created.targetId !== "string" || !created.targetId) {
			throw new Error("CDP did not return a targetId.");
		}
		targetId = created.targetId;

		const attached = await client.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		}, null, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});
		if (typeof attached.sessionId !== "string" || !attached.sessionId) {
			throw new Error("CDP did not return a sessionId.");
		}
		sessionId = attached.sessionId;

		await client.send("Page.enable", {}, sessionId, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});
		await client.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});
		await client.send("Network.enable", {}, sessionId, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});

		const frameTree = await client.send("Page.getFrameTree", {}, sessionId, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});
		const mainFrameId = (() => {
			const tree = frameTree.frameTree;
			if (!tree || typeof tree !== "object" || Array.isArray(tree)) return undefined;
			const frame = (tree as { frame?: unknown }).frame;
			if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
			const id = (frame as { id?: unknown }).id;
			return typeof id === "string" ? id : undefined;
		})();
		if (!mainFrameId) throw new Error("CDP did not return a main frame id.");

		await client.send("Fetch.enable", {
			handleAuthRequests: false,
			patterns: [{ requestStage: "Request", resourceType: "Document" }],
		}, sessionId, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});

		offPaused = client.on("Fetch.requestPaused", (params, eventSessionId) => {
			if (eventSessionId !== sessionId) return;
			const work = (async () => {
				const requestId = typeof params.requestId === "string" ? params.requestId : "";
				if (!requestId) return;
				const frameId = typeof params.frameId === "string" ? params.frameId : "";
				const resourceType = typeof params.resourceType === "string" ? params.resourceType : "";
				const request = (params.request && typeof params.request === "object" && !Array.isArray(params.request))
					? params.request as { url?: unknown }
					: {};
				const requestUrl = typeof request.url === "string" ? request.url : "";
				// Main-frame Document only.
				if (resourceType && resourceType !== "Document") {
					await client.send("Fetch.continueRequest", { requestId }, sessionId, {
						signal: options.signal,
						deadlineAt: options.deadlineAt,
					});
					return;
				}
				if (frameId && frameId !== mainFrameId) {
					await client.send("Fetch.continueRequest", { requestId }, sessionId, {
						signal: options.signal,
						deadlineAt: options.deadlineAt,
					});
					return;
				}
				openMainFrameRequestIds.add(requestId);
				try {
					await assertFetchUrlAllowed(requestUrl, {
						lookup: options.lookup,
						resolveDns: false,
						signal: options.signal,
					});
					await client.send("Fetch.continueRequest", { requestId }, sessionId, {
						signal: options.signal,
						deadlineAt: options.deadlineAt,
					});
					// Allowed main-frame Document/redirect: new document generation.
					// Baseline loadCount so only loads AFTER this continue satisfy readiness.
					documentGeneration += 1;
					loadCountAtGeneration.set(documentGeneration, loadCount);
				} catch (error) {
					await failRequest(requestId);
					throw error instanceof Error ? error : new Error(String(error));
				} finally {
					openMainFrameRequestIds.delete(requestId);
				}
			})().catch((error) => {
				guardError = error instanceof Error ? error : new Error(String(error));
			});
			pendingGuards.add(work);
			void work.finally(() => pendingGuards.delete(work));
		});

		network = createNetworkTracker(client, sessionId, now);
		offLoad = client.on("Page.loadEventFired", (_params, eventSessionId) => {
			if (eventSessionId === sessionId) loadCount += 1;
		});
		offLifecycle = client.on("Page.lifecycleEvent", (params, eventSessionId) => {
			if (eventSessionId !== sessionId) return;
			const frameId = typeof params.frameId === "string" ? params.frameId : "";
			if ((params.name === "load" || params.name === "Page.loadEventFired") && frameId === mainFrameId) {
				loadCount += 1;
			}
		});

		await client.send("Page.navigate", { url: requestedUrl }, sessionId, {
			signal: options.signal,
			deadlineAt: options.deadlineAt,
		});
		// Fetch.requestPaused handlers are async. Wait for the navigation Document
		// continue/fail before snapshotting documentGeneration for readiness.
		if (pendingGuards.size > 0) {
			await Promise.all([...pendingGuards]);
		}
		throwIfGuardError();
		if (documentGeneration === 0) {
			// No main-frame Document was intercepted; still allow capture of the current page.
			documentGeneration = 1;
			loadCountAtGeneration.set(1, loadCount);
		}

		let signature: ContentSignature | undefined;
		let restarts = 0;
		// Capture loop: if a late allowed Document/redirect advances generation, restart readiness.
		while (true) {
			const expectedGeneration = documentGeneration;
			const loadBaseline = loadCountAtGeneration.get(expectedGeneration) ?? 0;
			await waitForLoadMilestone({
				// A load counts for this document only when it occurs after its continue.
				loadFired: () => loadCount > loadBaseline,
				signal: options.signal,
				deadlineAt: options.deadlineAt,
				now,
				sleep,
				throwIfGuardError,
			});

			const isRestart = restarts > 0;
			const readinessMax = isRestart ? DOCUMENT_RESTART_READINESS_MAX_MS : READINESS_MAX_MS;
			const minObserve = isRestart
				? Math.min(READINESS_MIN_OBSERVE_MS, DOCUMENT_RESTART_READINESS_MAX_MS)
				: READINESS_MIN_OBSERVE_MS;

			signature = await waitForReadiness({
				client,
				sessionId,
				network,
				signal: options.signal,
				operationDeadlineAt: options.deadlineAt,
				now,
				sleep,
				maxMs: readinessMax,
				minObserveMs: minObserve,
				quietMs: READINESS_QUIET_MS,
				throwIfGuardError,
				documentGeneration: () => documentGeneration,
				expectedGeneration,
			});
			throwIfGuardError();

			// Lazy-load only for the first stable document generation.
			if (!isRestart && documentGeneration === expectedGeneration) {
				signature = await boundedLazyLoad({
					client,
					sessionId,
					network,
					signal: options.signal,
					operationDeadlineAt: options.deadlineAt,
					now,
					sleep,
					throwIfGuardError,
					initial: signature,
					documentGeneration: () => documentGeneration,
					expectedGeneration,
				});
				throwIfGuardError();
			}

			// Never race main-frame guards before capture.
			if (pendingGuards.size > 0) {
				await Promise.all([...pendingGuards]);
			}
			throwIfGuardError();

			if (documentGeneration === expectedGeneration) break;
			restarts += 1;
			if (restarts > DOCUMENT_RESTART_MAX) break;
			if (remainingMs(options.deadlineAt, 1, now) <= 0) break;
		}

		const captureDeadlineAt = Math.min(
			options.deadlineAt ?? Number.POSITIVE_INFINITY,
			now() + CAPTURE_MAX_MS,
		);
		const value = await evaluateValue(client, sessionId, CAPTURE_EXPRESSION, {
			signal: options.signal,
			deadlineAt: captureDeadlineAt,
		});
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("CDP page capture returned an unexpected result.");
		}
		const record = value as {
			oversized?: unknown;
			bytes?: unknown;
			href?: unknown;
			title?: unknown;
			html?: unknown;
		};
		const href = typeof record.href === "string" ? record.href : "";
		const title = typeof record.title === "string" ? record.title : "";
		if (!href) throw new Error("CDP page capture returned no final URL.");
		if (record.oversized === true) {
			// Browser-side hard stop: oversized HTML never traverses CDP as content.
			throw new Error(`Captured HTML exceeds the ${MAX_CAPTURE_BYTES / (1024 * 1024)} MiB limit.`);
		}
		const html = typeof record.html === "string" ? record.html : "";
		const finalUrl = await assertFetchUrlAllowed(href, {
			lookup: options.lookup,
			resolveDns: false,
			signal: options.signal,
		});
		// Node-side second check keeps the contract even if the browser expression regresses.
		if (utf8ByteLength(html) > MAX_CAPTURE_BYTES) {
			throw new Error(`Captured HTML exceeds the ${MAX_CAPTURE_BYTES / (1024 * 1024)} MiB limit.`);
		}
		return {
			requestedUrl,
			url: finalUrl.href,
			title: title.trim(),
			html,
		};
	} finally {
		// Teardown order is security-sensitive:
		// 1) Fail known paused main-frame Documents with an independent timeout.
		// 2) Drain in-flight guards.
		// 3) Close the owned target while Fetch interception is still active.
		// 4) Only then drop listeners.
		// Never Fetch.disable: CDP resumes paused requests on disable, which could
		// continue a forbidden redirect after an aborted/expired operation signal.
		for (const requestId of [...openMainFrameRequestIds]) {
			await failRequest(requestId);
			openMainFrameRequestIds.delete(requestId);
		}
		if (pendingGuards.size > 0) {
			await Promise.allSettled([...pendingGuards]);
		}
		// Fail again in case a guard added a request id while draining.
		for (const requestId of [...openMainFrameRequestIds]) {
			await failRequest(requestId);
			openMainFrameRequestIds.delete(requestId);
		}
		if (targetId) {
			await closeTargetBounded(client, targetId);
			targetId = undefined;
		}
		offPaused?.();
		offLoad?.();
		offLifecycle?.();
		network?.dispose();
		client.close();
	}
}

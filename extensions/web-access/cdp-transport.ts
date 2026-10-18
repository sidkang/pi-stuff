import type WebSocket from "ws";
import {
	HttpResponseTooLargeError,
	MAX_HTTP_RESPONSE_BYTES,
	readBoundedHttpResponseText,
} from "./http-response-limit.ts";

/**
 * Inbound CDP WebSocket message hard limit.
 * Sized above the 64 MiB HTML capture cap to allow JSON envelope and escaping overhead
 * while still rejecting pathological CDP payloads before toString/JSON.parse.
 */
export const MAX_CDP_MESSAGE_BYTES = 128 * 1024 * 1024;

/**
 * CDP HTTP discovery (`/json/version`, nested `cdp_url`) uses the same 1 MiB HTTP
 * response envelope as Responses/hosted clients. This bounds discovery metadata only;
 * captured HTML (64 MiB) and inbound WS frames (128 MiB) remain separate ceilings.
 */
export const MAX_CDP_DISCOVERY_BYTES = MAX_HTTP_RESPONSE_BYTES;

export type CdpConnection = {
	endpoint: string;
	apiKey?: string;
};

export type CdpMessageHandler = (params: Record<string, unknown>, sessionId: string | null) => void;

type WebSocketConstructor = typeof WebSocket;

export type CdpClientOptions = {
	connectTimeoutMs?: number;
	fetchImpl?: typeof fetch;
	webSocketImpl?: WebSocketConstructor;
	now?: () => number;
};

async function loadWebSocketImpl(): Promise<WebSocketConstructor> {
	// Defer the runtime dependency so extension registration can load without node_modules.
	const mod = await import("ws");
	return (mod.default ?? mod) as WebSocketConstructor;
}

function isAbortError(error: unknown): boolean {
	return (error instanceof Error && error.name === "AbortError")
		|| (error instanceof DOMException && error.name === "AbortError");
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("This operation was aborted", "AbortError");
}

function remainingTimeoutMs(deadlineAt: number | undefined, fallbackMs: number, now: () => number): number {
	if (deadlineAt === undefined) return fallbackMs;
	return Math.max(1, deadlineAt - now());
}

function combineTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!signal) return timeout;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
	const controller = new AbortController();
	const onAbort = (event: Event) => {
		const source = event.target;
		controller.abort(source instanceof AbortSignal ? abortReason(source) : undefined);
	};
	for (const item of [signal, timeout]) {
		if (item.aborted) {
			controller.abort(abortReason(item));
			return controller.signal;
		}
		item.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

export function normalizeCdpEndpoint(raw: string): URL {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("CDP endpoint is empty.");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("CDP endpoint is not a valid URL.");
	}
	if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
		throw new Error("CDP endpoint must use http:, https:, ws:, or wss:.");
	}
	if (url.protocol === "http:" || url.protocol === "https:") {
		const path = url.pathname.replace(/\/$/, "");
		if (!path.endsWith("/json/version")) {
			url.pathname = `${path}/json/version`;
		} else {
			url.pathname = path;
		}
	}
	return url;
}

function cdpTimeoutError(method: string): Error {
	const error = new Error(`CDP timeout: ${method}`);
	error.name = "TimeoutError";
	return error;
}

function discoveryAuthAttempts(apiKey: string | undefined): Array<Record<string, string>> {
	if (!apiKey) return [{}];
	return [
		{ Authorization: `Bearer ${apiKey}` },
		{ "X-API-Key": apiKey },
	];
}

async function fetchDiscoveryJson(
	url: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch,
	label: string,
): Promise<Record<string, unknown>> {
	const attempts = discoveryAuthAttempts(apiKey);
	for (let index = 0; index < attempts.length; index++) {
		const response = await fetchImpl(url, {
			headers: attempts[index],
			signal,
		});
		if (!response.ok && (response.status === 401 || response.status === 403) && index + 1 < attempts.length) {
			continue;
		}
		if (!response.ok) {
			throw new Error(`${label} returned HTTP ${response.status}.`);
		}
		let text: string;
		try {
			text = await readBoundedHttpResponseText(response, MAX_CDP_DISCOVERY_BYTES);
		} catch (error) {
			if (error instanceof HttpResponseTooLargeError) {
				throw new Error(`${label} response exceeded the ${MAX_CDP_DISCOVERY_BYTES / (1024 * 1024)} MiB size limit.`);
			}
			throw error;
		}
		let body: unknown;
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			throw new Error(`${label} returned non-JSON response.`);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new Error(`${label} returned an unexpected JSON body.`);
		}
		return body as Record<string, unknown>;
	}
	throw new Error(`${label} failed.`);
}

export async function discoverCdpWebSocketUrl(
	connection: CdpConnection,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const endpoint = normalizeCdpEndpoint(connection.endpoint);
	if (endpoint.protocol === "ws:" || endpoint.protocol === "wss:") {
		return endpoint.href;
	}

	const body = await fetchDiscoveryJson(
		endpoint.href,
		connection.apiKey,
		signal,
		fetchImpl,
		"CDP discovery",
	);
	if (typeof body.webSocketDebuggerUrl === "string" && body.webSocketDebuggerUrl.trim()) {
		return body.webSocketDebuggerUrl.trim();
	}
	if (typeof body.cdp_url === "string" && body.cdp_url.trim()) {
		const next = new URL(body.cdp_url, `${endpoint.origin}/`);
		if (!next.pathname.endsWith("/json/version")) {
			next.pathname = `${next.pathname.replace(/\/$/, "")}/json/version`;
		}
		const version = await fetchDiscoveryJson(
			next.href,
			connection.apiKey,
			signal,
			fetchImpl,
			"CDP version discovery",
		);
		if (typeof version.webSocketDebuggerUrl === "string" && version.webSocketDebuggerUrl.trim()) {
			return version.webSocketDebuggerUrl.trim();
		}
	}
	throw new Error("CDP discovery returned no webSocketDebuggerUrl.");
}

function openWebSocket(
	url: string,
	apiKey: string | undefined,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	webSocketImpl: WebSocketConstructor,
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}
		const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
		const ws = headers
			? new webSocketImpl(url, { headers })
			: new webSocketImpl(url);
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) {
				try {
					ws.close();
				} catch {
					// ignore
				}
				reject(error);
				return;
			}
			resolve(ws);
		};
		const onAbort = () => finish(abortReason(signal!));
		const timer = setTimeout(() => finish(new Error("CDP WebSocket connect timeout.")), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		ws.once("open", () => finish());
		ws.once("error", (error) => {
			finish(error instanceof Error ? error : new Error("CDP WebSocket connection failed."));
		});
	});
}

export class CdpClient {
	private readonly ws: WebSocket;
	private readonly now: () => number;
	private nextId = 0;
	private readonly callbacks = new Map<number, {
		resolve: (value: Record<string, unknown>) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly eventHandlers = new Map<string, Set<CdpMessageHandler>>();
	private closed = false;

	private rejectAllPending(error: Error): void {
		for (const [id, callback] of this.callbacks) {
			clearTimeout(callback.timer);
			this.callbacks.delete(id);
			callback.reject(error);
		}
	}

	private messageByteLength(data: unknown): number {
		if (typeof data === "string") return Buffer.byteLength(data, "utf8");
		if (Buffer.isBuffer(data)) return data.byteLength;
		if (ArrayBuffer.isView(data)) return data.byteLength;
		if (data instanceof ArrayBuffer) return data.byteLength;
		if (Array.isArray(data)) {
			return data.reduce((sum: number, chunk) => sum + this.messageByteLength(chunk), 0);
		}
		return Buffer.byteLength(String(data), "utf8");
	}

	private constructor(ws: WebSocket, now: () => number) {
		this.ws = ws;
		this.now = now;
		ws.on("message", (data) => {
			const byteLength = this.messageByteLength(data);
			if (byteLength > MAX_CDP_MESSAGE_BYTES) {
				// Reject before toString/JSON.parse so oversized payloads never materialize as strings.
				const error = new Error(`CDP message exceeds the ${MAX_CDP_MESSAGE_BYTES / (1024 * 1024)} MiB limit.`);
				this.rejectAllPending(error);
				this.close();
				return;
			}
			const text = typeof data === "string"
				? data
				: Buffer.isBuffer(data)
					? data.toString("utf8")
					: ArrayBuffer.isView(data)
						? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
						: String(data);
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(text) as Record<string, unknown>;
			} catch {
				return;
			}
			if (typeof message.id === "number" && this.callbacks.has(message.id)) {
				const callback = this.callbacks.get(message.id)!;
				this.callbacks.delete(message.id);
				clearTimeout(callback.timer);
				if (message.error && typeof message.error === "object" && message.error !== null) {
					const error = message.error as { message?: unknown };
					callback.reject(new Error(typeof error.message === "string" ? error.message : "CDP command failed."));
					return;
				}
				callback.resolve((message.result && typeof message.result === "object" && !Array.isArray(message.result))
					? message.result as Record<string, unknown>
					: {});
				return;
			}
			if (typeof message.method === "string") {
				const params = (message.params && typeof message.params === "object" && !Array.isArray(message.params))
					? message.params as Record<string, unknown>
					: {};
				const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
				this.emit(message.method, params, sessionId);
			}
		});
		ws.on("close", () => {
			this.closed = true;
			this.rejectAllPending(new Error("CDP connection closed."));
		});
	}

	static async connect(
		connection: CdpConnection,
		signal?: AbortSignal,
		options: CdpClientOptions & { deadlineAt?: number } = {},
	): Promise<CdpClient> {
		const now = options.now ?? Date.now;
		const fetchImpl = options.fetchImpl ?? fetch;
		const webSocketImpl = options.webSocketImpl ?? await loadWebSocketImpl();
		const connectTimeoutMs = remainingTimeoutMs(options.deadlineAt, options.connectTimeoutMs ?? 10_000, now);
		const discoverySignal = combineTimeout(signal, connectTimeoutMs);
		const webSocketUrl = await discoverCdpWebSocketUrl(connection, discoverySignal, fetchImpl);
		const ws = await openWebSocket(
			webSocketUrl,
			connection.apiKey,
			remainingTimeoutMs(options.deadlineAt, options.connectTimeoutMs ?? 10_000, now),
			signal,
			webSocketImpl,
		);
		return new CdpClient(ws, now);
	}

	on(method: string, handler: CdpMessageHandler): () => void {
		if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
		this.eventHandlers.get(method)!.add(handler);
		return () => this.off(method, handler);
	}

	off(method: string, handler: CdpMessageHandler): void {
		const handlers = this.eventHandlers.get(method);
		if (!handlers) return;
		handlers.delete(handler);
		if (handlers.size === 0) this.eventHandlers.delete(method);
	}

	private emit(method: string, params: Record<string, unknown>, sessionId: string | null): void {
		const handlers = this.eventHandlers.get(method);
		if (!handlers) return;
		for (const handler of [...handlers]) {
			try {
				handler(params, sessionId);
			} catch {
				// Keep the session alive if a handler throws.
			}
		}
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId: string | null = null,
		options: { signal?: AbortSignal; timeoutMs?: number; deadlineAt?: number } = {},
	): Promise<Record<string, unknown>> {
		if (this.closed) return Promise.reject(new Error("CDP connection is closed."));
		if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
		const timeoutMs = remainingTimeoutMs(options.deadlineAt, options.timeoutMs ?? 10_000, this.now);
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			const payload: Record<string, unknown> = { id, method, params };
			if (sessionId) payload.sessionId = sessionId;
			const timer = setTimeout(() => {
				this.callbacks.delete(id);
				options.signal?.removeEventListener("abort", onAbort);
				reject(cdpTimeoutError(method));
			}, timeoutMs);
			const onAbort = () => {
				this.callbacks.delete(id);
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(abortReason(options.signal!));
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.callbacks.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			try {
				this.ws.send(JSON.stringify(payload));
			} catch (error) {
				this.callbacks.delete(id);
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error("Failed to send CDP command."));
			}
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.ws.close();
		} catch {
			// ignore
		}
	}
}

export function isCdpAbortError(error: unknown): boolean {
	return isAbortError(error);
}

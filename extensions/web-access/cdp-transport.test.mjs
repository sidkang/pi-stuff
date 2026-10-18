import assert from "node:assert/strict";
import test from "node:test";
import { CdpClient, discoverCdpWebSocketUrl, MAX_CDP_DISCOVERY_BYTES, MAX_CDP_MESSAGE_BYTES } from "./cdp-transport.ts";

test("discoverCdpWebSocketUrl appends /json/version to HTTP CDP roots", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(String(url));
		if (String(url) === "https://browser.example/cdp/json/version") {
			return new Response(JSON.stringify({
				webSocketDebuggerUrl: "wss://browser.example/devtools/browser/1",
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		throw new Error(`unexpected url ${url}`);
	};

	const wsUrl = await discoverCdpWebSocketUrl({
		endpoint: "https://browser.example/cdp",
	}, undefined, fetchImpl);

	assert.equal(wsUrl, "wss://browser.example/devtools/browser/1");
	assert.deepEqual(calls, ["https://browser.example/cdp/json/version"]);
});

test("discoverCdpWebSocketUrl appends /json/version to HTTP CDP roots", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(String(url));
		if (String(url) === "https://browser.example/cdp/json/version") {
			return new Response(JSON.stringify({
				webSocketDebuggerUrl: "wss://browser.example/devtools/browser/1",
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		throw new Error(`unexpected url ${url}`);
	};

	const wsUrl = await discoverCdpWebSocketUrl({
		endpoint: "https://browser.example/cdp",
	}, undefined, fetchImpl);

	assert.equal(wsUrl, "wss://browser.example/devtools/browser/1");
	assert.deepEqual(calls, ["https://browser.example/cdp/json/version"]);
});

test("discoverCdpWebSocketUrl retries Bearer 401 with X-API-Key on nested cdp_url", async () => {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		const headers = init.headers ?? {};
		calls.push({ url, headers: { ...headers } });
		if (url === "https://gateway.example/json/version") {
			if (headers.Authorization === "Bearer secret") {
				return new Response(JSON.stringify({
					cdp_url: "https://gateway.example/browser/1",
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response("unauthorized", { status: 401 });
		}
		if (url === "https://gateway.example/browser/1/json/version") {
			if (headers.Authorization === "Bearer secret") {
				return new Response("unauthorized", { status: 401 });
			}
			if (headers["X-API-Key"] === "secret") {
				return new Response(JSON.stringify({
					webSocketDebuggerUrl: "wss://gateway.example/devtools/browser/abc",
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response("unauthorized", { status: 401 });
		}
		throw new Error(`unexpected url ${url}`);
	};

	const wsUrl = await discoverCdpWebSocketUrl({
		endpoint: "https://gateway.example/json/version",
		apiKey: "secret",
	}, undefined, fetchImpl);

	assert.equal(wsUrl, "wss://gateway.example/devtools/browser/abc");
	assert.equal(calls.length, 3);
	assert.equal(calls[0].headers.Authorization, "Bearer secret");
	assert.equal(calls[1].headers.Authorization, "Bearer secret");
	assert.equal(calls[2].headers["X-API-Key"], "secret");
});

test("CdpClient.connect sends Bearer on discovered WebSocket handshake", async () => {
	const fetchImpl = async () => new Response(JSON.stringify({
		webSocketDebuggerUrl: "wss://browser.example/devtools/browser/1",
	}), { status: 200, headers: { "content-type": "application/json" } });

	let handshakeHeaders;
	class FakeWebSocket {
		static OPEN = 1;
		readyState = FakeWebSocket.OPEN;
		constructor(_url, options = {}) {
			handshakeHeaders = options.headers ?? {};
			queueMicrotask(() => this.openHandler?.());
		}
		once(event, handler) {
			if (event === "open") this.openHandler = handler;
			if (event === "error") this.errorHandler = handler;
		}
		on(event, handler) {
			if (event === "message") this.messageHandler = handler;
			if (event === "close") this.closeHandler = handler;
		}
		send() {}
		close() {
			this.closeHandler?.();
		}
	}

	const client = await CdpClient.connect({
		endpoint: "https://browser.example/json/version",
		apiKey: "secret-token",
	}, undefined, {
		fetchImpl,
		webSocketImpl: FakeWebSocket,
		connectTimeoutMs: 1000,
	});
	assert.deepEqual(handshakeHeaders, { Authorization: "Bearer secret-token" });
	client.close();
});

test("CdpClient.connect sends Bearer on direct ws endpoints", async () => {
	let handshakeHeaders;
	class FakeWebSocket {
		static OPEN = 1;
		readyState = FakeWebSocket.OPEN;
		constructor(_url, options = {}) {
			handshakeHeaders = options.headers ?? {};
			queueMicrotask(() => this.openHandler?.());
		}
		once(event, handler) {
			if (event === "open") this.openHandler = handler;
		}
		on(event, handler) {
			if (event === "close") this.closeHandler = handler;
		}
		send() {}
		close() {
			this.closeHandler?.();
		}
	}

	const client = await CdpClient.connect({
		endpoint: "wss://browser.example/devtools/browser/1",
		apiKey: "direct-secret",
	}, undefined, {
		webSocketImpl: FakeWebSocket,
		connectTimeoutMs: 1000,
	});
	assert.deepEqual(handshakeHeaders, { Authorization: "Bearer direct-secret" });
	client.close();
});

test("CdpClient names command deadline failures TimeoutError", async () => {
	class FakeWebSocket {
		static OPEN = 1;
		readyState = FakeWebSocket.OPEN;
		constructor() {
			queueMicrotask(() => this.openHandler?.());
		}
		once(event, handler) {
			if (event === "open") this.openHandler = handler;
		}
		on(event, handler) {
			if (event === "close") this.closeHandler = handler;
		}
		send() {
			// Keep the command pending until its command deadline expires.
		}
		close() {
			this.closeHandler?.();
		}
	}

	const client = await CdpClient.connect({
		endpoint: "wss://browser.example/devtools/browser/1",
	}, undefined, {
		webSocketImpl: FakeWebSocket,
		connectTimeoutMs: 1000,
	});
	await assert.rejects(
		() => client.send("Runtime.evaluate", { expression: "1" }, null, { timeoutMs: 1 }),
		(error) => error instanceof Error
			&& error.name === "TimeoutError"
			&& error.message === "CDP timeout: Runtime.evaluate",
	);
	client.close();
});

test("CdpClient rejects oversized inbound WebSocket messages before parse and rejects all pending", async () => {
	let messageHandler;
	let closed = false;
	let closeHandlerCount = 0;
	class FakeWebSocket {
		static OPEN = 1;
		readyState = FakeWebSocket.OPEN;
		constructor() {
			queueMicrotask(() => this.openHandler?.());
		}
		once(event, handler) {
			if (event === "open") this.openHandler = handler;
			if (event === "error") this.errorHandler = handler;
		}
		on(event, handler) {
			if (event === "message") messageHandler = handler;
			if (event === "close") this.closeHandler = handler;
		}
		send() {
			// Leave commands pending until the test delivers an oversized frame.
		}
		close() {
			closed = true;
			closeHandlerCount += 1;
			// Simulate the real socket close event after close().
			this.closeHandler?.();
		}
	}

	const client = await CdpClient.connect({
		endpoint: "wss://browser.example/devtools/browser/1",
	}, undefined, {
		webSocketImpl: FakeWebSocket,
		connectTimeoutMs: 1000,
	});

	const pendingA = client.send("Page.enable", {}, null, { timeoutMs: 1000 });
	const pendingB = client.send("Runtime.evaluate", { expression: "1" }, null, { timeoutMs: 1000 });
	const pendingC = client.send("Network.enable", {}, null, { timeoutMs: 1000 });

	const oversized = Buffer.alloc(MAX_CDP_MESSAGE_BYTES + 1, 0x61);
	messageHandler?.(oversized);

	const messageMiB = MAX_CDP_MESSAGE_BYTES / (1024 * 1024);
	const messageLimit = new RegExp(`${messageMiB} MiB`);
	await assert.rejects(() => pendingA, messageLimit);
	await assert.rejects(() => pendingB, messageLimit);
	await assert.rejects(() => pendingC, messageLimit);
	assert.equal(closed, true);
	// close() is idempotent: oversized path closes once; subsequent close is a no-op.
	client.close();
	assert.equal(closeHandlerCount, 1);
	// Further sends fail on the closed connection without hanging.
	await assert.rejects(() => client.send("Page.disable", {}, null, { timeoutMs: 100 }), /closed/i);
	// Ensure the message limit stays above the HTML capture cap (64 MiB).
	assert.ok(MAX_CDP_MESSAGE_BYTES > 64 * 1024 * 1024);
});

function streamingJsonResponse(chunks, status = 200) {
	let cancelled = false;
	// Leave the stream open after enqueue (same pattern as responses-client unfinished streams)
	// so reader.cancel() is observable when the byte ceiling trips mid-body.
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
			}
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		response: new Response(stream, { status, headers: { "content-type": "application/json" } }),
		wasCancelled: () => cancelled,
	};
}

test("discoverCdpWebSocketUrl accepts discovery JSON at the 1 MiB exact boundary", async () => {
	const wsUrl = "wss://browser.example/devtools/browser/edge";
	const prefix = `{"webSocketDebuggerUrl":"${wsUrl}","padding":"`;
	const suffix = `"}`;
	const paddingSize = MAX_CDP_DISCOVERY_BYTES - Buffer.byteLength(prefix + suffix, "utf8");
	assert.ok(paddingSize > 0);
	const body = `${prefix}${"a".repeat(paddingSize)}${suffix}`;
	assert.equal(Buffer.byteLength(body, "utf8"), MAX_CDP_DISCOVERY_BYTES);

	const ws = await discoverCdpWebSocketUrl({
		endpoint: "https://browser.example/json/version",
	}, undefined, async () => new Response(body, {
		status: 200,
		headers: { "content-type": "application/json" },
	}));
	assert.equal(ws, wsUrl);
});

test("discoverCdpWebSocketUrl rejects oversized discovery JSON and cancels the reader", async () => {
	const prefix = `{"webSocketDebuggerUrl":"wss://browser.example/devtools/browser/x","padding":"`;
	const suffix = `"}`;
	const paddingSize = MAX_CDP_DISCOVERY_BYTES - Buffer.byteLength(prefix + suffix, "utf8") + 1;
	const body = `${prefix}${"b".repeat(paddingSize)}${suffix}`;
	assert.ok(Buffer.byteLength(body, "utf8") > MAX_CDP_DISCOVERY_BYTES);
	const tracked = streamingJsonResponse([body]);

	await assert.rejects(
		() => discoverCdpWebSocketUrl({
			endpoint: "https://browser.example/json/version",
		}, undefined, async () => tracked.response),
		/1 MiB/,
	);
	assert.equal(tracked.wasCancelled(), true);
});

test("nested CDP version discovery also enforces the 1 MiB HTTP envelope", async () => {
	const nested = streamingJsonResponse([
		`{"padding":"${"c".repeat(MAX_CDP_DISCOVERY_BYTES)}"}`,
	]);
	const fetchImpl = async (url) => {
		if (String(url) === "https://gateway.example/json/version") {
			return new Response(JSON.stringify({ cdp_url: "https://gateway.example/browser/1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (String(url) === "https://gateway.example/browser/1/json/version") {
			return nested.response;
		}
		throw new Error(`unexpected url ${url}`);
	};

	await assert.rejects(
		() => discoverCdpWebSocketUrl({ endpoint: "https://gateway.example/json/version" }, undefined, fetchImpl),
		/1 MiB/,
	);
	assert.equal(nested.wasCancelled(), true);
});

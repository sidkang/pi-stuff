import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	capturePageWithCdp,
	hasMeaningfulGrowth,
	isNearHtmlCap,
	isRelevantResourceType,
	lazyLoadShouldStop,
	HTML_SOFT_CHAR_LIMIT,
	LAZY_LOAD_MAX_DISTANCE_VIEWPORTS,
	LAZY_LOAD_MAX_STEPS,
	LAZY_LOAD_STEP_VIEWPORTS,
	MAX_CAPTURE_BYTES,
	READINESS_MIN_OBSERVE_MS,
	READINESS_QUIET_MS,
	DOCUMENT_RESTART_MAX,
} from "./cdp-fetch.ts";
import { CdpClient, MAX_CDP_MESSAGE_BYTES, normalizeCdpEndpoint } from "./cdp-transport.ts";
import fetchContent from "./fetch-content.ts";
import webAccess from "./index.ts";

const root = dirname(fileURLToPath(import.meta.url));
const ordinaryHtml = readFileSync(join(root, "fixtures/ordinary-page.html"), "utf8");

function createClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		sleep: async (ms = 0) => {
			t += Math.max(0, ms);
		},
		advance(ms) {
			t += Math.max(0, ms);
		},
		get time() {
			return t;
		},
	};
}

function defaultSignatureFromHtml(html, extras = {}) {
	return {
		textLength: extras.textLength ?? Math.min(html.length, 1200),
		articleCount: extras.articleCount ?? (html.includes("<article") ? 1 : 0),
		linkCount: extras.linkCount ?? 3,
		headingCount: extras.headingCount ?? 1,
		scrollHeight: extras.scrollHeight ?? 2000,
		canScroll: extras.canScroll ?? false,
		htmlChars: extras.htmlChars ?? html.length,
	};
}

function createScriptedClient(options = {}) {
	const commands = [];
	const closes = [];
	const handlers = new Map();
	let targetCount = 0;
	let html = options.html ?? ordinaryHtml;
	const finalHref = options.finalHref ?? "https://example.com/ordinary";
	const title = options.title ?? "Ordinary Article Title";
	const redirectTo = options.redirectTo;
	const emitSubframeLoadFirst = options.emitSubframeLoadFirst === true;
	const browserOversized = options.browserOversized === true;
	const captureHtml = options.captureHtml; // if set, used for final capture regardless of signature htmlChars
	let loadEventCount = 0;
	let signature = options.signature ?? defaultSignatureFromHtml(html, options.signatureExtras);
	const hydrateAtMs = options.hydrateAtMs;
	const clock = options.clock;
	const scrollGrowth = options.scrollGrowth; // array of growth deltas applied per scroll
	let scrollIndex = 0;
	const pendingNetwork = [];
	const emit = (method, params, sessionId) => {
		for (const handler of handlers.get(method) ?? []) handler(params, sessionId);
	};

	const client = {
		on(method, handler) {
			if (!handlers.has(method)) handlers.set(method, new Set());
			handlers.get(method).add(handler);
			return () => handlers.get(method)?.delete(handler);
		},
		emit,
		async send(method, params = {}, sessionId = null) {
			commands.push({ method, params, sessionId });
			if (method === "Target.createTarget") {
				targetCount += 1;
				return { targetId: `target-${targetCount}` };
			}
			if (method === "Target.attachToTarget") {
				return { sessionId: `session-${params.targetId}` };
			}
			if (method === "Page.getFrameTree") {
				return { frameTree: { frame: { id: "frame-main" } } };
			}
			if (method === "Page.navigate") {
				const sessionHandlers = handlers.get("Fetch.requestPaused") ?? new Set();
				const sid = sessionId;
				const flushGuards = async () => {
					// Production Fetch.requestPaused handlers are fire-and-forget. Yield so
					// continueRequest finishes before load events attribute to the new document.
					for (let i = 0; i < 5; i++) await Promise.resolve();
				};
				const emitForSession = async (url) => {
					for (const handler of sessionHandlers) {
						handler({
							requestId: `req-${commands.length}-${url}`,
							frameId: "frame-main",
							resourceType: "Document",
							request: { url },
						}, sid);
					}
					await flushGuards();
				};
				await emitForSession(params.url);
				if (redirectTo) await emitForSession(redirectTo);
				if (options.onNavigate) await options.onNavigate({ emit, sessionId: sid, handlers });
				if (emitSubframeLoadFirst) {
					for (const handler of handlers.get("Page.lifecycleEvent") ?? []) {
						handler({ name: "load", frameId: "frame-iframe" }, sid);
					}
					// Delay main-frame load slightly so the waiter must ignore subframe load.
					queueMicrotask(() => {
						for (const handler of handlers.get("Page.loadEventFired") ?? []) {
							handler({}, sid);
							loadEventCount += 1;
						}
					});
					return {};
				}
				for (const handler of handlers.get("Page.loadEventFired") ?? []) {
					handler({}, sid);
					loadEventCount += 1;
				}
				return {};
			}
			if (method === "Runtime.evaluate") {
				const expression = String(params.expression ?? "");
				if (hydrateAtMs !== undefined && clock && clock.now() >= hydrateAtMs && options.hydratedSignature) {
					signature = { ...signature, ...options.hydratedSignature };
					if (options.hydratedHtml) html = options.hydratedHtml;
				}
				if (expression.includes("querySelectorAll(\"article\")") || expression.includes("textLength")) {
					return { result: { value: { ...signature } } };
				}
				if (expression.includes("scrollBy")) {
					const growth = Array.isArray(scrollGrowth)
						? scrollGrowth[Math.min(scrollIndex, scrollGrowth.length - 1)]
						: undefined;
					scrollIndex += 1;
					if (growth) {
						signature = {
							...signature,
							textLength: signature.textLength + (growth.textLength ?? 0),
							articleCount: signature.articleCount + (growth.articleCount ?? 0),
							linkCount: signature.linkCount + (growth.linkCount ?? 0),
							headingCount: signature.headingCount + (growth.headingCount ?? 0),
							scrollHeight: signature.scrollHeight + (growth.scrollHeight ?? 500),
							htmlChars: signature.htmlChars + (growth.htmlChars ?? 500),
							canScroll: growth.canScroll ?? signature.canScroll,
						};
						if (growth.html) html = growth.html;
					}
					return {
						result: {
							value: {
								scrolledBy: 800,
								scrollY: scrollIndex * 800,
								scrollHeight: signature.scrollHeight,
							},
						},
					};
				}
				// Final capture expression uses TextEncoder / oversized.
				const finalHtml = captureHtml ?? html;
				if (browserOversized) {
					return {
						result: {
							value: {
								oversized: true,
								bytes: MAX_CAPTURE_BYTES + 1,
								href: finalHref,
								title,
							},
						},
					};
				}
				const bytes = Buffer.byteLength(finalHtml, "utf8");
				if (bytes > MAX_CAPTURE_BYTES) {
					// Simulate browser-side hard stop when expression runs correctly.
					if (options.simulateLegacyCaptureWithoutBrowserCheck) {
						return {
							result: {
								value: {
									oversized: false,
									bytes,
									href: finalHref,
									title,
									html: finalHtml,
								},
							},
						};
					}
					return {
						result: {
							value: {
								oversized: true,
								bytes,
								href: finalHref,
								title,
							},
						},
					};
				}
				return {
					result: {
						value: {
							oversized: false,
							bytes,
							href: finalHref,
							title,
							html: finalHtml,
						},
					},
				};
			}
			if (method === "Target.closeTarget") {
				closes.push(params.targetId);
				return { success: true };
			}
			return {};
		},
		close() {
			closes.push("client-close");
		},
	};

	return {
		commands,
		closes,
		client,
		handlers,
		emit,
		get signature() {
			return signature;
		},
		setSignature(next) {
			signature = { ...signature, ...next };
		},
		get scrollIndex() {
			return scrollIndex;
		},
		get loadEventCount() {
			return loadEventCount;
		},
		factory: async () => client,
	};
}

function captureOptions(fake, clock, extra = {}) {
	const { url, lookup, ...rest } = extra;
	return {
		connection: { endpoint: "https://browser.example/json/version" },
		url: url ?? "https://example.com/ordinary",
		clientFactory: fake.factory,
		lookup: lookup ?? (async () => [{ address: "1.1.1.1" }]),
		now: clock.now,
		sleep: clock.sleep,
		...rest,
	};
}

test("normalizeCdpEndpoint rewrites HTTP CDP roots to /json/version", () => {
	assert.equal(
		normalizeCdpEndpoint("https://browser.example").href,
		"https://browser.example/json/version",
	);
	assert.equal(
		normalizeCdpEndpoint("https://browser.example/").href,
		"https://browser.example/json/version",
	);
	assert.equal(
		normalizeCdpEndpoint("https://browser.example/cdp").href,
		"https://browser.example/cdp/json/version",
	);
	assert.equal(
		normalizeCdpEndpoint("https://browser.example/cdp/").href,
		"https://browser.example/cdp/json/version",
	);
	assert.equal(
		normalizeCdpEndpoint("https://browser.example/cdp/json/version").href,
		"https://browser.example/cdp/json/version",
	);
	assert.equal(
		normalizeCdpEndpoint("https://browser.example/cdp/json/version/").href,
		"https://browser.example/cdp/json/version",
	);
	assert.equal(
		normalizeCdpEndpoint("https://browser.example/cdp?token=1").href,
		"https://browser.example/cdp/json/version?token=1",
	);
	assert.equal(
		normalizeCdpEndpoint("wss://browser.example/devtools/browser/1").href,
		"wss://browser.example/devtools/browser/1",
	);
});

test("capturePageWithCdp enables interception and network before navigate and closes only its target", async () => {
	const clock = createClock();
	const fake = createScriptedClient({ clock });
	const page = await capturePageWithCdp(captureOptions(fake, clock));
	assert.equal(page.url, "https://example.com/ordinary");
	assert.match(page.html, /Ordinary Article Title/);

	const methods = fake.commands.map((item) => item.method);
	const networkAt = methods.indexOf("Network.enable");
	const enableAt = methods.indexOf("Fetch.enable");
	const navigateAt = methods.indexOf("Page.navigate");
	assert.ok(networkAt >= 0);
	assert.ok(enableAt >= 0);
	assert.ok(navigateAt > enableAt);
	assert.ok(navigateAt > networkAt);
	assert.equal(fake.commands.some((item) => item.method === "Target.createTarget" && item.params.background === true), true);
	assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
	assert.ok(fake.closes.includes("client-close"));
	// Composite readiness requires a minimum observation window.
	assert.ok(clock.time >= READINESS_MIN_OBSERVE_MS);
});

test("capturePageWithCdp fails private redirects before load and still closes target", async () => {
	const clock = createClock();
	const fake = createScriptedClient({
		clock,
		redirectTo: "http://127.0.0.1/secret",
	});
	await assert.rejects(
		() => capturePageWithCdp(captureOptions(fake, clock)),
		/blocked|local/i,
	);
	assert.ok(fake.commands.some((item) => item.method === "Fetch.failRequest"));
	assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
});

test("capturePageWithCdp rejects initial credentials before connecting and redirect credentials before continuing", async () => {
	const credentialUrl = "https://user:secret@example.com/path";
	const initialClock = createClock();
	const initial = createScriptedClient({ clock: initialClock });
	await assert.rejects(() => capturePageWithCdp(captureOptions(initial, initialClock, {
		url: credentialUrl,
		clientFactory: async () => assert.fail("must reject before CDP connection"),
	})), /credentials/);
	assert.equal(initial.commands.length, 0);

	const clock = createClock();
	const redirected = createScriptedClient({ clock, redirectTo: credentialUrl });
	await assert.rejects(() => capturePageWithCdp(captureOptions(redirected, clock)), /credentials/);
	assert.ok(redirected.commands.some((item) => item.method === "Fetch.failRequest"));
	assert.deepEqual(redirected.closes.filter((item) => item !== "client-close"), ["target-1"]);
});

test("capturePageWithCdp rejects oversized HTML without transferring body content", async () => {
	const clock = createClock();
	const fake = createScriptedClient({
		clock,
		browserOversized: true,
	});
	const captureMiB = MAX_CAPTURE_BYTES / (1024 * 1024);
	await assert.rejects(
		() => capturePageWithCdp(captureOptions(fake, clock)),
		new RegExp(`${captureMiB} MiB`),
	);
	const captureEval = fake.commands.filter((item) => item.method === "Runtime.evaluate").at(-1);
	// Browser-side oversized path returns only metadata; scripted client never stores HTML in that response.
	assert.ok(captureEval);
	assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
});

test("capturePageWithCdp Node-side second check rejects legacy oversized HTML payloads", async () => {
	const clock = createClock();
	// Avoid allocating a full 64 MiB string: use a length that exceeds the cap once encoded.
	// ASCII 'x' is 1 byte UTF-8, so length = MAX_CAPTURE_BYTES + 10 is enough without extra overhead.
	const overBy = 10;
	const huge = `<!doctype html><html><body>${"x".repeat(MAX_CAPTURE_BYTES + overBy)}</body></html>`;
	const fake = createScriptedClient({
		clock,
		html: huge,
		simulateLegacyCaptureWithoutBrowserCheck: true,
	});
	const captureMiB = MAX_CAPTURE_BYTES / (1024 * 1024);
	await assert.rejects(
		() => capturePageWithCdp(captureOptions(fake, clock)),
		new RegExp(`${captureMiB} MiB`),
	);
});

test("web-access registers fetch_content with url and optional kernel parameters", () => {
	const tools = new Map();
	const events = [];
	webAccess({
		on(event) {
			events.push(event);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
	});
	assert.deepEqual([...tools.keys()], ["web_search", "x_search", "fetch_content"]);
	assert.equal(tools.get("fetch_content").label, "Fetch Content");
	assert.deepEqual(Object.keys(tools.get("fetch_content").parameters.properties), ["url", "provider", "kernel"]);
	assert.deepEqual(tools.get("fetch_content").parameters.properties.kernel.enum, ["defuddle", "html-extractor", "llm"]);
	assert.ok(events.includes("tool_result"));
});

test("fetch_content fails clearly without CDP endpoint", async () => {
	let definition;
	fetchContent({
		on() {},
		registerTool(value) {
			definition = value;
		},
	});
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEndpoint = process.env.CDP_ENDPOINT;
	const previousApiKey = process.env.CDP_API_KEY;
	const root = mkdtempSync(join(tmpdir(), "web-access-no-cdp-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ webAccess: {} }));
	delete process.env.CDP_ENDPOINT;
	delete process.env.CDP_API_KEY;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await assert.rejects(
			() => definition.execute("call-1", { url: "https://example.com" }, undefined, undefined, {
				env: {},
				cwd: root,
				isProjectTrusted: () => false,
			}),
			/CDP_ENDPOINT or webAccess\.fetch\.cdp\.endpoint/,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousEndpoint === undefined) delete process.env.CDP_ENDPOINT;
		else process.env.CDP_ENDPOINT = previousEndpoint;
		if (previousApiKey === undefined) delete process.env.CDP_API_KEY;
		else process.env.CDP_API_KEY = previousApiKey;
		rmSync(root, { recursive: true, force: true });
	}
});

test("capturePageWithCdp ignores subframe load lifecycle events", async () => {
	const clock = createClock();
	const fake = createScriptedClient({ clock, emitSubframeLoadFirst: true });
	const page = await capturePageWithCdp(captureOptions(fake, clock));
	assert.equal(page.url, "https://example.com/ordinary");
	// Main-frame loadEventFired still arrives and is required; subframe lifecycle alone is insufficient.
	assert.equal(fake.loadEventCount, 1);
});

test("parallel capturePageWithCdp calls own and close distinct targets", async () => {
	const clock = createClock();
	const shared = createScriptedClient({ clock });
	const [first, second] = await Promise.all([
		capturePageWithCdp(captureOptions(shared, clock, { url: "https://example.com/a" })),
		capturePageWithCdp(captureOptions(shared, clock, { url: "https://example.com/b" })),
	]);
	assert.ok(first.html.includes("Ordinary Article Title"));
	assert.ok(second.html.includes("Ordinary Article Title"));
	const closedTargets = shared.closes.filter((item) => item !== "client-close");
	assert.deepEqual(new Set(closedTargets), new Set(["target-1", "target-2"]));
});

test("assertFetchUrlAllowed aborts a stalled DNS lookup via signal when DNS is enabled", async () => {
	const { assertFetchUrlAllowed } = await import("./url-guard.ts");
	const controller = new AbortController();
	const pending = assertFetchUrlAllowed("https://public.example", {
		signal: controller.signal,
		resolveDns: true,
		lookup: () => new Promise(() => {}),
	});
	queueMicrotask(() => controller.abort());
	await assert.rejects(() => pending, /aborted/i);
});

test("capturePageWithCdp awaits late main-frame guards and never continues a forbidden redirect", async () => {
	const clock = createClock();
	const commands = [];
	const handlers = new Map();
	const signature = defaultSignatureFromHtml(ordinaryHtml);
	const client = {
		on(method, handler) {
			if (!handlers.has(method)) handlers.set(method, new Set());
			handlers.get(method).add(handler);
			return () => handlers.get(method)?.delete(handler);
		},
		async send(method, params = {}, sessionId = null) {
			commands.push({ method, params, sessionId });
			if (method === "Target.createTarget") return { targetId: "target-1" };
			if (method === "Target.attachToTarget") return { sessionId: "session-1" };
			if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main" } } };
			if (method === "Page.navigate") {
				// Fire-and-forget: do not await the paused handler, so the production code
				// must still wait for the pending main-frame guard before capture.
				for (const handler of handlers.get("Fetch.requestPaused") ?? []) {
					void handler({
						requestId: "req-redirect",
						frameId: "frame-main",
						resourceType: "Document",
						request: { url: "http://127.0.0.1/secret" },
					}, "session-1");
				}
				// Static IP-literal checks reject without Agent-local DNS.
				return {};
			}
			if (method === "Runtime.evaluate") {
				const expression = String(params.expression ?? "");
				if (expression.includes("textLength")) {
					return { result: { value: { ...signature } } };
				}
				return {
					result: {
						value: {
							oversized: false,
							bytes: Buffer.byteLength(ordinaryHtml, "utf8"),
							href: "https://example.com/ordinary",
							title: "Ordinary Article Title",
							html: ordinaryHtml,
						},
					},
				};
			}
			if (method === "Target.closeTarget") return { success: true };
			return {};
		},
		close() {},
	};

	const pending = capturePageWithCdp({
		connection: { endpoint: "https://browser.example/json/version" },
		url: "https://example.com/ordinary",
		clientFactory: async () => client,
		now: clock.now,
		sleep: clock.sleep,
	});

	await assert.rejects(() => pending, /blocked|local/i);
	assert.equal(commands.some((item) => item.method === "Fetch.continueRequest" && item.params.requestId === "req-redirect"), false);
	assert.equal(commands.some((item) => item.method === "Fetch.failRequest" && item.params.requestId === "req-redirect"), true);
	// Teardown must close the owned target without Fetch.disable (disable can resume paused requests).
	assert.equal(commands.some((item) => item.method === "Fetch.disable"), false);
	assert.equal(commands.some((item) => item.method === "Target.closeTarget" && item.params.targetId === "target-1"), true);
});

test("successful capture+extract details use only the locked success fields", async () => {
	const { setFetchContentDepsForTests, default: registerFetch } = await import("./fetch-content.ts");
	const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temp = mkdtempSync(join(tmpdir(), "web-access-fetch-details-"));
	const agentDir = join(temp, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		webAccess: {
			fetch: {
				cdp: { endpoint: "https://browser.example/json/version" },
			},
		},
	}));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const clock = createClock();
	const fake = createScriptedClient({ clock });
	const captureDeadlines = [];
	setFetchContentDepsForTests({
		capturePage: async (options) => {
			captureDeadlines.push({
				hasSignal: Boolean(options.signal),
				deadlineAt: options.deadlineAt,
			});
			return capturePageWithCdp({
				...options,
				clientFactory: fake.factory,
				lookup: async () => [{ address: "1.1.1.1" }],
				now: clock.now,
				sleep: clock.sleep,
			});
		},
	});

	let definition;
	registerFetch({
		on() {},
		registerTool(value) {
			definition = value;
		},
	});

	try {
		const before = Date.now();
		const result = await definition.execute(
			"call-details",
			{ url: "https://example.com/ordinary" },
			undefined,
			undefined,
			{ env: {} },
		);
		const after = Date.now();
		assert.deepEqual(Object.keys(result.details).sort(), [
			"totalBytes", "structuredChars", "structuredTruncated", "retrievedAt", "elapsedMs",
			"kernel",
			"requestedUrl",
			"returnedChars",
			"source",
			"title",
			"totalChars",
			"truncated",
			"url",
		].sort());
		assert.equal(result.details.requestedUrl, "https://example.com/ordinary");
		assert.equal(result.details.url, "https://example.com/ordinary");
		assert.equal(result.details.kernel, "defuddle");
		assert.equal(typeof result.details.title, "string");
		assert.ok(result.details.totalChars > 0);
		assert.ok(result.details.returnedChars > 0);
		assert.equal(result.details.returnedChars, result.content[0].text.split("\n\n---\n")[0].length);
		assert.equal(result.details.truncated, result.details.returnedChars < result.details.totalChars);
		assert.equal(captureDeadlines.length, 1);
		assert.equal(captureDeadlines[0].hasSignal, true);
		assert.ok(captureDeadlines[0].deadlineAt >= before + 60_000 - 50);
		assert.ok(captureDeadlines[0].deadlineAt <= after + 60_000);
		assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
	} finally {
		setFetchContentDepsForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("fetch_content parameter kernel overrides the configured default", async () => {
	const { setFetchContentDepsForTests, default: registerFetch } = await import("./fetch-content.ts");
	const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temp = mkdtempSync(join(tmpdir(), "web-access-fetch-kernel-"));
	const agentDir = join(temp, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		webAccess: {
			fetch: {
				cdp: { endpoint: "https://browser.example/json/version" },
				extract: { kernel: "html-extractor" },
			},
		},
	}));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const clock = createClock();
	const fake = createScriptedClient({ clock });
	const kernelCalls = [];
	setFetchContentDepsForTests({
		capturePage: async (options) => capturePageWithCdp({
			...options,
			clientFactory: fake.factory,
			lookup: async () => [{ address: "1.1.1.1" }],
			now: clock.now,
			sleep: clock.sleep,
		}),
		runKernels: async (options) => {
			kernelCalls.push(options.selected);
			assert.equal(options.selected, "defuddle");
			assert.ok(options.html.includes("Ordinary Article Title"));
			assert.ok(options.signal);
			return {
				kernel: "defuddle",
				title: "Defuddle Title",
				content: "defuddle markdown body",
			};
		},
	});

	let definition;
	registerFetch({
		on() {},
		registerTool(value) {
			definition = value;
		},
	});

	try {
		const result = await definition.execute(
			"call-kernel",
			{ url: "https://example.com/ordinary", kernel: "defuddle" },
			undefined,
			undefined,
			{ env: {} },
		);
		assert.equal(result.details.kernel, "defuddle");
		assert.match(result.content[0].text, /defuddle markdown body/);
		assert.deepEqual(kernelCalls, ["defuddle"]);
		assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
	} finally {
		setFetchContentDepsForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("fetch_content llm kernel fails clearly without model and still closes target", async () => {
	const { setFetchContentDepsForTests, default: registerFetch } = await import("./fetch-content.ts");
	const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temp = mkdtempSync(join(tmpdir(), "web-access-fetch-llm-"));
	const agentDir = join(temp, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		webAccess: {
			fetch: {
				cdp: { endpoint: "https://browser.example/json/version" },
				extract: { kernel: "llm" },
			},
		},
	}));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const clock = createClock();
	const fake = createScriptedClient({ clock });
	let localKernelCalls = 0;
	let completeCalls = 0;
	setFetchContentDepsForTests({
		capturePage: async (options) => capturePageWithCdp({
			...options,
			clientFactory: fake.factory,
			lookup: async () => [{ address: "1.1.1.1" }],
			now: clock.now,
			sleep: clock.sleep,
		}),
		runKernels: async (options) => {
			const { runExtractionKernels } = await import("./extract-kernels.ts");
			return runExtractionKernels({
				...options,
				runners: {
					async defuddle() {
						localKernelCalls += 1;
						return { content: "nope" };
					},
					async "html-extractor"() {
						localKernelCalls += 1;
						return { content: "nope" };
					},
				},
			});
		},
	});

	let definition;
	registerFetch({
		on() {},
		registerTool(value) {
			definition = value;
		},
	});

	try {
		await assert.rejects(
			() => definition.execute(
				"call-llm",
				{ url: "https://example.com/ordinary" },
				undefined,
				undefined,
				{
					env: {},
					modelRegistry: {
						find() { return { provider: "newapi", id: "gpt-extract" }; },
						async complete() {
							completeCalls += 1;
							throw new Error("should not complete without extract model");
						},
					},
				},
			),
			/No extract model is configured for the llm Extraction Kernel/i,
		);
		assert.equal(localKernelCalls, 0);
		assert.equal(completeCalls, 0);
		assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
	} finally {
		setFetchContentDepsForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("fetch_content llm kernel succeeds with fake Model Registry and closes target", async () => {
	const { setFetchContentDepsForTests, default: registerFetch } = await import("./fetch-content.ts");
	const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temp = mkdtempSync(join(tmpdir(), "web-access-fetch-llm-ok-"));
	const agentDir = join(temp, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		webAccess: {
			fetch: {
				cdp: { endpoint: "https://browser.example/json/version" },
				extract: { kernel: "llm", model: "newapi/gpt-extract" },
			},
		},
	}));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const clock = createClock();
	const fake = createScriptedClient({ clock });
	const completeCalls = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		completeCalls.push({ url: String(input), body: JSON.parse(init.body) });
		assert.equal(String(input), "https://extract.example/v1/responses");
		assert.equal(Object.hasOwn(init.body ? JSON.parse(init.body) : {}, "tools"), false);
		const body = JSON.parse(init.body);
		assert.equal(Object.hasOwn(body, "reasoning"), false);
		assert.match(body.instructions ?? "", /untrusted page data only/i);
		const user = body.input?.[0]?.content?.[0]?.text ?? "";
		assert.match(user, /Requested URL:/);
		assert.match(user, /Final URL:/);
		assert.doesNotMatch(user, /base64/i);
		assert.ok(user.includes("---BEGIN UNTRUSTED PAGE DATA---"));
		assert.ok(user.includes("---END UNTRUSTED PAGE DATA---"));
		assert.match(user, /<html[\s>]/i);
		return new Response(JSON.stringify({ output_text: "# LLM Extract\n\nbody" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	setFetchContentDepsForTests({
		capturePage: async (options) => capturePageWithCdp({
			...options,
			clientFactory: fake.factory,
			lookup: async () => [{ address: "1.1.1.1" }],
			now: clock.now,
			sleep: clock.sleep,
		}),
	});

	let definition;
	registerFetch({
		on() {},
		registerTool(value) {
			definition = value;
		},
	});

	try {
		const result = await definition.execute(
			"call-llm-ok",
			{ url: "https://example.com/ordinary" },
			undefined,
			undefined,
			{
				env: {},
				modelRegistry: {
					find(provider, modelId) {
						assert.equal(provider, "newapi");
						assert.equal(modelId, "gpt-extract");
						return {
							provider,
							id: modelId,
							api: "openai-responses",
							baseUrl: "https://extract.example/v1",
						};
					},
					async getApiKeyAndHeaders() {
						return { ok: true, apiKey: "test-key", headers: {} };
					},
				},
			},
		);
		assert.equal(result.details.kernel, "llm");
		assert.match(result.content[0].text, /# LLM Extract/);
		assert.equal(completeCalls.length, 1);
		assert.deepEqual(Object.keys(result.details).sort(), [
			"totalBytes", "structuredChars", "structuredTruncated", "retrievedAt", "elapsedMs",
			"kernel",
			"requestedUrl",
			"returnedChars",
			"source",
			"title",
			"totalChars",
			"truncated",
			"url",
		].sort());
		assert.equal(result.details.title, "Ordinary Article Title");
		assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
	} finally {
		globalThis.fetch = previousFetch;
		setFetchContentDepsForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("fetch_content closes target after llm model failure", async () => {
	const { setFetchContentDepsForTests, default: registerFetch } = await import("./fetch-content.ts");
	const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temp = mkdtempSync(join(tmpdir(), "web-access-fetch-llm-fail-"));
	const agentDir = join(temp, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		webAccess: {
			fetch: {
				cdp: { endpoint: "https://browser.example/json/version" },
				extract: { kernel: "llm", model: "newapi/gpt-extract" },
			},
		},
	}));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const clock = createClock();
	const fake = createScriptedClient({ clock });
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(
		JSON.stringify({ error: { message: "401 unauthorized Authorization: Bearer sk-live-secret" } }),
		{ status: 401, headers: { "content-type": "application/json" } },
	);
	setFetchContentDepsForTests({
		capturePage: async (options) => capturePageWithCdp({
			...options,
			clientFactory: fake.factory,
			lookup: async () => [{ address: "1.1.1.1" }],
			now: clock.now,
			sleep: clock.sleep,
		}),
	});

	let definition;
	registerFetch({
		on() {},
		registerTool(value) {
			definition = value;
		},
	});

	try {
		await assert.rejects(
			() => definition.execute(
				"call-llm-fail",
				{ url: "https://example.com/ordinary" },
				undefined,
				undefined,
				{
					env: {},
					modelRegistry: {
						find() {
							return {
								provider: "newapi",
								id: "gpt-extract",
								api: "openai-responses",
								baseUrl: "https://extract.example/v1",
							};
						},
						async getApiKeyAndHeaders() {
							return { ok: true, apiKey: "test-key", headers: {} };
						},
					},
				},
			),
			(error) => error instanceof Error
				&& /unauthorized|auth/i.test(error.message)
				&& !error.message.includes("sk-live-secret"),
		);
		assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
	} finally {
		globalThis.fetch = previousFetch;
		setFetchContentDepsForTests();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("isRelevantResourceType tracks document/xhr/fetch/script only", () => {
	assert.equal(isRelevantResourceType("Document"), true);
	assert.equal(isRelevantResourceType("XHR"), true);
	assert.equal(isRelevantResourceType("Fetch"), true);
	assert.equal(isRelevantResourceType("Script"), true);
	assert.equal(isRelevantResourceType("Image"), false);
	assert.equal(isRelevantResourceType("Font"), false);
	assert.equal(isRelevantResourceType("Media"), false);
	assert.equal(isRelevantResourceType("WebSocket"), false);
	assert.equal(isRelevantResourceType(undefined), false);
});

test("hasMeaningfulGrowth and isNearHtmlCap use content metrics", () => {
	const base = defaultSignatureFromHtml(ordinaryHtml, { textLength: 100, articleCount: 1, linkCount: 2, headingCount: 1, htmlChars: 1000 });
	assert.equal(hasMeaningfulGrowth(base, { ...base, articleCount: 2 }), true);
	assert.equal(hasMeaningfulGrowth(base, { ...base, textLength: 250 }), false);
	assert.equal(hasMeaningfulGrowth(base, { ...base, textLength: 400 }), true);
	assert.equal(isNearHtmlCap({ ...base, htmlChars: HTML_SOFT_CHAR_LIMIT }), true);
	assert.equal(isNearHtmlCap({ ...base, htmlChars: HTML_SOFT_CHAR_LIMIT - 1 }), false);
	assert.equal(isNearHtmlCap(base), false);
});

test("capturePageWithCdp waits for delayed hydration before capture", async () => {
	const clock = createClock();
	const shellHtml = "<!doctype html><html><body><main>shell</main></body></html>";
	const hydratedHtml = "<!doctype html><html><body><main><article>Hydrated Article</article></main></body></html>";
	let sessionId;
	const hydrateAt = READINESS_MIN_OBSERVE_MS + 250;
	const fake = createScriptedClient({
		clock,
		html: shellHtml,
		signatureExtras: { textLength: 20, articleCount: 0, linkCount: 0, headingCount: 0, canScroll: false, htmlChars: shellHtml.length },
		hydrateAtMs: hydrateAt,
		hydratedSignature: { textLength: 400, articleCount: 1, linkCount: 2, headingCount: 1, canScroll: false, htmlChars: hydratedHtml.length },
		hydratedHtml,
		onNavigate({ emit, sessionId: sid }) {
			sessionId = sid;
			// Hold a relevant request open until hydration so readiness cannot accept the shell early.
			emit("Network.requestWillBeSent", {
				requestId: "hydrate-fetch",
				type: "Fetch",
				request: { url: "https://example.com/api/content" },
			}, sid);
		},
	});
	const originalSleep = clock.sleep;
	let released = false;
	clock.sleep = async (ms) => {
		await originalSleep(ms);
		if (!released && clock.time >= hydrateAt) {
			released = true;
			fake.emit("Network.loadingFinished", { requestId: "hydrate-fetch" }, sessionId);
		}
	};
	const page = await capturePageWithCdp(captureOptions(fake, clock));
	assert.match(page.html, /Hydrated Article/);
	assert.ok(clock.time >= hydrateAt + READINESS_QUIET_MS);
});

test("capturePageWithCdp keeps waiting while relevant fetch is in flight", async () => {
	const clock = createClock();
	let sessionId;
	const holdUntil = READINESS_MIN_OBSERVE_MS + READINESS_QUIET_MS + 500;
	const fake = createScriptedClient({
		clock,
		onNavigate({ emit, sessionId: sid }) {
			sessionId = sid;
			emit("Network.requestWillBeSent", {
				requestId: "xhr-1",
				type: "Fetch",
				request: { url: "https://example.com/api/feed" },
			}, sid);
		},
	});
	const originalSleep = clock.sleep;
	let finished = false;
	let sawInflightPastMinObserve = false;
	clock.sleep = async (ms) => {
		// Prove the request is still open past the min-observe window.
		if (!finished && clock.time >= READINESS_MIN_OBSERVE_MS) {
			sawInflightPastMinObserve = true;
		}
		await originalSleep(ms);
		if (!finished && clock.time >= holdUntil) {
			finished = true;
			fake.emit("Network.loadingFinished", { requestId: "xhr-1" }, sessionId);
		}
	};
	const page = await capturePageWithCdp(captureOptions(fake, clock));
	assert.match(page.html, /Ordinary Article Title/);
	assert.equal(sawInflightPastMinObserve, true);
	assert.equal(finished, true);
	// Quiet window is measured after the in-flight request finishes.
	assert.ok(clock.time >= holdUntil + READINESS_QUIET_MS);
});

test("capturePageWithCdp ignores image/font/websocket network activity for readiness", async () => {
	const clock = createClock();
	const fake = createScriptedClient({
		clock,
		onNavigate({ emit, sessionId }) {
			emit("Network.requestWillBeSent", { requestId: "img-1", type: "Image", request: { url: "https://cdn.example/a.png" } }, sessionId);
			emit("Network.requestWillBeSent", { requestId: "font-1", type: "Font", request: { url: "https://cdn.example/a.woff2" } }, sessionId);
			emit("Network.requestWillBeSent", { requestId: "ws-1", type: "WebSocket", request: { url: "wss://cdn.example/socket" } }, sessionId);
		},
	});
	const page = await capturePageWithCdp(captureOptions(fake, clock));
	assert.match(page.html, /Ordinary Article Title/);
	// Completes at the normal readiness bound even though ignored requests never finish.
	assert.ok(clock.time >= READINESS_MIN_OBSERVE_MS);
	assert.ok(clock.time < READINESS_MIN_OBSERVE_MS + 5_000);
});

test("capturePageWithCdp performs bounded incremental lazy-load scrolling", async () => {
	const clock = createClock();
	const fake = createScriptedClient({
		clock,
		signatureExtras: {
			textLength: 100,
			articleCount: 1,
			linkCount: 1,
			headingCount: 1,
			scrollHeight: 5000,
			canScroll: true,
			htmlChars: ordinaryHtml.length,
		},
		scrollGrowth: [
			{ textLength: 300, articleCount: 1, linkCount: 1, canScroll: true },
			{ textLength: 300, articleCount: 1, linkCount: 1, canScroll: true },
			{ textLength: 0, articleCount: 0, linkCount: 0, canScroll: false },
		],
	});
	const page = await capturePageWithCdp(captureOptions(fake, clock));
	assert.match(page.html, /Ordinary Article Title/);
	assert.ok(fake.scrollIndex >= 1);
	assert.ok(fake.scrollIndex <= 4);
	assert.ok(fake.commands.some((item) => item.method === "Runtime.evaluate" && String(item.params.expression).includes("scrollBy")));
});

test("lazyLoadShouldStop proves each hard budget independently", () => {
	const base = {
		stepsCompleted: 0,
		scrolledViewports: 0,
		noGrowth: 0,
		phaseElapsedMs: 0,
		canScroll: true,
		nearHtmlCap: false,
	};
	assert.equal(lazyLoadShouldStop(base), false);
	assert.equal(lazyLoadShouldStop({ ...base, stepsCompleted: LAZY_LOAD_MAX_STEPS }), true);
	assert.equal(lazyLoadShouldStop({ ...base, scrolledViewports: LAZY_LOAD_MAX_DISTANCE_VIEWPORTS }), true);
	assert.equal(lazyLoadShouldStop({ ...base, noGrowth: 2 }), true);
	assert.equal(lazyLoadShouldStop({ ...base, phaseElapsedMs: 5_000 }), true);
	assert.equal(lazyLoadShouldStop({ ...base, canScroll: false }), true);
	assert.equal(lazyLoadShouldStop({ ...base, nearHtmlCap: true }), true);
	// Distance binds before steps under continuous growth with current constants.
	assert.ok(LAZY_LOAD_MAX_DISTANCE_VIEWPORTS < LAZY_LOAD_MAX_STEPS * LAZY_LOAD_STEP_VIEWPORTS);
});

test("capturePageWithCdp stops infinite growth after distance budget", async () => {
	const clock = createClock();
	const fake = createScriptedClient({
		clock,
		signatureExtras: {
			textLength: 100,
			articleCount: 1,
			linkCount: 1,
			headingCount: 1,
			scrollHeight: 10_000,
			canScroll: true,
			htmlChars: ordinaryHtml.length,
		},
		// Every scroll keeps growing forever.
		scrollGrowth: [
			{ textLength: 300, articleCount: 1, linkCount: 1, canScroll: true },
		],
	});
	await capturePageWithCdp(captureOptions(fake, clock));
	// Distance 2.4 / step 0.8 => 3 scrolls; MAX_STEPS=4 is not reached.
	// Distance 2.4 / step 0.8 => 3 scrolls before the next pre-scroll distance check stops.
	const expectedScrolls = Math.round(LAZY_LOAD_MAX_DISTANCE_VIEWPORTS / LAZY_LOAD_STEP_VIEWPORTS);
	assert.equal(fake.scrollIndex, expectedScrolls);
	assert.ok(fake.scrollIndex < LAZY_LOAD_MAX_STEPS);
});

test("capturePageWithCdp stops lazy-load after repeated no-growth", async () => {
	const clock = createClock();
	const fake = createScriptedClient({
		clock,
		signatureExtras: {
			textLength: 500,
			articleCount: 2,
			linkCount: 4,
			headingCount: 2,
			scrollHeight: 8000,
			canScroll: true,
			htmlChars: ordinaryHtml.length,
		},
		scrollGrowth: [
			{ textLength: 0, articleCount: 0, linkCount: 0, canScroll: true },
			{ textLength: 0, articleCount: 0, linkCount: 0, canScroll: true },
			{ textLength: 500, articleCount: 2, linkCount: 2, canScroll: true },
		],
	});
	await capturePageWithCdp(captureOptions(fake, clock));
	// Two consecutive no-growth steps stop before the third growing step.
	assert.equal(fake.scrollIndex, 2);
});

test("capturePageWithCdp stops lazy-load when HTML nears the soft cap", async () => {
	const clock = createClock();
	const fake = createScriptedClient({
		clock,
		signatureExtras: {
			textLength: 100,
			articleCount: 1,
			linkCount: 1,
			headingCount: 1,
			scrollHeight: 9000,
			canScroll: true,
			htmlChars: HTML_SOFT_CHAR_LIMIT - 100_000,
		},
		scrollGrowth: [
			{ textLength: 300, articleCount: 1, htmlChars: 200_000, canScroll: true },
			{ textLength: 300, articleCount: 1, htmlChars: 200_000, canScroll: true },
		],
	});
	await capturePageWithCdp(captureOptions(fake, clock));
	// First scroll pushes htmlChars over soft cap; next readiness sample stops further scrolling.
	assert.equal(fake.scrollIndex, 1);
});

test("capturePageWithCdp aborts during readiness when signal aborts", async () => {
	const clock = createClock();
	const controller = new AbortController();
	const fake = createScriptedClient({ clock });
	const originalSleep = clock.sleep;
	clock.sleep = async (ms) => {
		await originalSleep(ms);
		if (clock.time >= 500) controller.abort();
	};
	await assert.rejects(
		() => capturePageWithCdp(captureOptions(fake, clock, { signal: controller.signal })),
		/aborted/i,
	);
	assert.deepEqual(fake.closes.filter((item) => item !== "client-close"), ["target-1"]);
});

test("capturePageWithCdp respects shared deadline during readiness", async () => {
	const clock = createClock(1_000);
	const fake = createScriptedClient({
		clock,
		// Keep DOM changing so readiness cannot stabilize early.
		signatureExtras: { textLength: 10, articleCount: 0, canScroll: false, htmlChars: 100 },
	});
	let samples = 0;
	const originalFactory = fake.factory;
	fake.factory = async () => {
		const client = await originalFactory();
		const originalSend = client.send.bind(client);
		client.send = async (method, params = {}, sessionId = null) => {
			const result = await originalSend(method, params, sessionId);
			if (method === "Runtime.evaluate" && String(params.expression).includes("textLength")) {
				samples += 1;
				// Change signature every sample to prevent early stability.
				fake.setSignature({ textLength: 10 + samples, articleCount: 0, linkCount: 0, headingCount: 0, scrollHeight: 1000, canScroll: false, htmlChars: 100 + samples });
			}
			return result;
		};
		return client;
	};
	const page = await capturePageWithCdp(captureOptions(fake, clock, { deadlineAt: 1_000 + 900 }));
	assert.match(page.html, /Ordinary Article Title/);
	// Deadline budget is under the normal readiness max, so virtual time stays bounded.
	assert.ok(clock.time <= 1_000 + 900 + 50);
});

test("capturePageWithCdp aborts with late private redirect and never continues it", async () => {
	const clock = createClock();
	const controller = new AbortController();
	const commands = [];
	const handlers = new Map();
	const closes = [];
	const signature = defaultSignatureFromHtml(ordinaryHtml);
	let pausedHandlerActive = true;
	const client = {
		on(method, handler) {
			if (!handlers.has(method)) handlers.set(method, new Set());
			handlers.get(method).add(handler);
			return () => {
				handlers.get(method)?.delete(handler);
				if (method === "Fetch.requestPaused") pausedHandlerActive = handlers.get(method)?.size > 0;
			};
		},
		async send(method, params = {}, sessionId = null) {
			commands.push({ method, params, sessionId });
			if (method === "Target.createTarget") return { targetId: "target-1" };
			if (method === "Target.attachToTarget") return { sessionId: "session-1" };
			if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main" } } };
			if (method === "Page.navigate") {
				for (const handler of handlers.get("Fetch.requestPaused") ?? []) {
					handler({
						requestId: "req-initial",
						frameId: "frame-main",
						resourceType: "Document",
						request: { url: "https://example.com/ordinary" },
					}, "session-1");
				}
				for (let i = 0; i < 5; i++) await Promise.resolve();
				for (const handler of handlers.get("Page.loadEventFired") ?? []) {
					handler({}, "session-1");
				}
				return {};
			}
			if (method === "Runtime.evaluate") {
				const expression = String(params.expression ?? "");
				if (expression.includes("textLength")) {
					return { result: { value: { ...signature } } };
				}
				return {
					result: {
						value: {
							oversized: false,
							bytes: Buffer.byteLength(ordinaryHtml, "utf8"),
							href: "https://example.com/ordinary",
							title: "Ordinary Article Title",
							html: ordinaryHtml,
						},
					},
				};
			}
			if (method === "Target.closeTarget") {
				closes.push(params.targetId);
				return { success: true };
			}
			return {};
		},
		close() {
			closes.push("client-close");
		},
	};

	const originalSleep = clock.sleep;
	let injected = false;
	const sleep = async (ms, signal) => {
		await originalSleep(ms);
		if (!injected && clock.time >= 400) {
			injected = true;
			// Abort the operation signal, then inject a late private main-frame Document.
			controller.abort();
			for (const handler of handlers.get("Fetch.requestPaused") ?? []) {
				void handler({
					requestId: "req-late-private",
					frameId: "frame-main",
					resourceType: "Document",
					request: { url: "http://127.0.0.1/secret" },
				}, "session-1");
			}
		}
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("This operation was aborted", "AbortError");
		}
	};

	await assert.rejects(
		() => capturePageWithCdp({
			connection: { endpoint: "https://browser.example/json/version" },
			url: "https://example.com/ordinary",
			clientFactory: async () => client,
			lookup: async (hostname) => {
				if (hostname === "127.0.0.1") return [{ address: "127.0.0.1" }];
				return [{ address: "1.1.1.1" }];
			},
			signal: controller.signal,
			now: clock.now,
			sleep,
		}),
		/aborted|blocked|local/i,
	);

	// Late private redirect must be failed, never continued, and target must close.
	assert.equal(commands.some((item) => item.method === "Fetch.continueRequest" && item.params.requestId === "req-late-private"), false);
	assert.equal(commands.some((item) => item.method === "Fetch.failRequest" && item.params.requestId === "req-late-private"), true);
	assert.equal(commands.some((item) => item.method === "Fetch.disable"), false);
	assert.deepEqual(closes.filter((item) => item !== "client-close"), ["target-1"]);
	// failRequest for the late redirect must not depend on the aborted operation signal:
	// the teardown path uses timeoutMs only (no signal field in our scripted client assertions via presence).
	const lateFail = commands.find((item) => item.method === "Fetch.failRequest" && item.params.requestId === "req-late-private");
	assert.ok(lateFail);
});

test("capturePageWithCdp re-runs readiness after a late allowed main-frame redirect", async () => {
	const clock = createClock();
	const commands = [];
	const handlers = new Map();
	const closes = [];
	let html = "<!doctype html><html><body><main>first document shell</main></body></html>";
	let signature = {
		textLength: 20,
		articleCount: 0,
		linkCount: 0,
		headingCount: 0,
		scrollHeight: 1000,
		canScroll: false,
		htmlChars: html.length,
	};
	const finalHtml = "<!doctype html><html><body><main><article>Final Redirected Article</article></main></body></html>";
	let redirected = false;
	let loadCount = 0;
	const client = {
		on(method, handler) {
			if (!handlers.has(method)) handlers.set(method, new Set());
			handlers.get(method).add(handler);
			return () => handlers.get(method)?.delete(handler);
		},
		async send(method, params = {}, sessionId = null) {
			commands.push({ method, params, sessionId });
			if (method === "Target.createTarget") return { targetId: "target-1" };
			if (method === "Target.attachToTarget") return { sessionId: "session-1" };
			if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main" } } };
			if (method === "Page.navigate") {
				for (const handler of handlers.get("Fetch.requestPaused") ?? []) {
					handler({
						requestId: "req-initial",
						frameId: "frame-main",
						resourceType: "Document",
						request: { url: "https://example.com/first" },
					}, "session-1");
				}
				for (let i = 0; i < 5; i++) await Promise.resolve();
				for (const handler of handlers.get("Page.loadEventFired") ?? []) {
					handler({}, "session-1");
					loadCount += 1;
				}
				return {};
			}
			if (method === "Runtime.evaluate") {
				const expression = String(params.expression ?? "");
				if (expression.includes("textLength")) {
					// Keep the pre-redirect DOM unstable so readiness cannot finish before the late Document.
					if (!redirected) {
						signature = { ...signature, textLength: signature.textLength + 1 };
					}
					return { result: { value: { ...signature } } };
				}
				return {
					result: {
						value: {
							oversized: false,
							bytes: Buffer.byteLength(html, "utf8"),
							href: redirected ? "https://example.com/final" : "https://example.com/first",
							title: redirected ? "Final Redirected Article" : "First",
							html,
						},
					},
				};
			}
			if (method === "Target.closeTarget") {
				closes.push(params.targetId);
				return { success: true };
			}
			return {};
		},
		close() {
			closes.push("client-close");
		},
	};

	const originalSleep = clock.sleep;
	const sleep = async (ms, signal) => {
		await originalSleep(ms);
		if (!redirected && clock.time >= READINESS_MIN_OBSERVE_MS + 100) {
			redirected = true;
			// Late allowed main-frame Document after initial readiness observation has begun.
			for (const handler of handlers.get("Fetch.requestPaused") ?? []) {
				handler({
					requestId: "req-late-allowed",
					frameId: "frame-main",
					resourceType: "Document",
					request: { url: "https://example.com/final" },
				}, "session-1");
			}
			for (let i = 0; i < 5; i++) await Promise.resolve();
			html = finalHtml;
			signature = {
				textLength: 400,
				articleCount: 1,
				linkCount: 1,
				headingCount: 1,
				scrollHeight: 1200,
				canScroll: false,
				htmlChars: finalHtml.length,
			};
			// New document load milestone after the allowed continue.
			for (const handler of handlers.get("Page.loadEventFired") ?? []) {
				handler({}, "session-1");
				loadCount += 1;
			}
		}
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("This operation was aborted", "AbortError");
		}
	};

	const page = await capturePageWithCdp({
		connection: { endpoint: "https://browser.example/json/version" },
		url: "https://example.com/first",
		clientFactory: async () => client,
		lookup: async () => [{ address: "1.1.1.1" }],
		now: clock.now,
		sleep,
	});

	assert.equal(page.url, "https://example.com/final");
	assert.match(page.html, /Final Redirected Article/);
	assert.equal(commands.some((item) => item.method === "Fetch.continueRequest" && item.params.requestId === "req-late-allowed"), true);
	// Final document must receive a fresh minimum observation window after the redirect.
	assert.ok(clock.time >= READINESS_MIN_OBSERVE_MS * 2);
	assert.ok(loadCount >= 2);
	assert.ok(DOCUMENT_RESTART_MAX >= 1);
	assert.deepEqual(closes.filter((item) => item !== "client-close"), ["target-1"]);
});

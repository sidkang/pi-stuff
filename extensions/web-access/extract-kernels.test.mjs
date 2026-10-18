import assert from "node:assert/strict";
import test from "node:test";
import {
	ExtractionKernelError,
	kernelsFromSelection,
	parseExtractionKernel,
	resolveExtractionKernel,
	runExtractionKernels,
} from "./extract-kernels.ts";

test("parseExtractionKernel accepts known kernels and marks invalid values", () => {
	assert.equal(parseExtractionKernel(undefined), undefined);
	assert.equal(parseExtractionKernel("defuddle"), "defuddle");
	assert.equal(parseExtractionKernel("html-extractor"), "html-extractor");
	assert.equal(parseExtractionKernel("llm"), "llm");
	assert.equal(parseExtractionKernel("other"), "invalid");
	assert.equal(parseExtractionKernel(""), "invalid");
});

test("kernelsFromSelection starts at the selected kernel", () => {
	assert.deepEqual(kernelsFromSelection("defuddle"), ["defuddle", "html-extractor", "llm"]);
	assert.deepEqual(kernelsFromSelection("html-extractor"), ["html-extractor", "llm"]);
	assert.deepEqual(kernelsFromSelection("llm"), ["llm"]);
	assert.equal(resolveExtractionKernel(undefined), "defuddle");
});

test("unset/default kernel uses Defuddle then falls through to html-extractor on empty output", async () => {
	const order = [];
	const result = await runExtractionKernels({
		selected: "defuddle",
		html: "<html></html>",
		url: "https://example.com",
		runners: {
			async defuddle() {
				order.push("defuddle");
				return { content: "   \r\n  " };
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { title: "From HE", content: "html extractor body\r\n" };
			},
		},
	});
	assert.deepEqual(order, ["defuddle", "html-extractor"]);
	assert.equal(result.kernel, "html-extractor");
	assert.equal(result.content, "html extractor body");
	assert.equal(result.title, "From HE");
});

test("local kernel exceptions fall through while nonempty Defuddle stops the chain", async () => {
	const order = [];
	const success = await runExtractionKernels({
		selected: "defuddle",
		html: "<html></html>",
		url: "https://example.com",
		runners: {
			async defuddle() {
				order.push("defuddle");
				return { title: "D", content: "defuddle body" };
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "should not run" };
			},
		},
	});
	assert.deepEqual(order, ["defuddle"]);
	assert.equal(success.kernel, "defuddle");

	order.length = 0;
	const recovered = await runExtractionKernels({
		selected: "defuddle",
		html: "<html></html>",
		url: "https://example.com",
		runners: {
			async defuddle() {
				order.push("defuddle");
				throw new Error("local defuddle boom");
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "recovered" };
			},
		},
	});
	assert.deepEqual(order, ["defuddle", "html-extractor"]);
	assert.equal(recovered.kernel, "html-extractor");
	assert.equal(recovered.content, "recovered");
});

test("html-extractor selection skips Defuddle", async () => {
	const order = [];
	const result = await runExtractionKernels({
		selected: "html-extractor",
		html: "<html></html>",
		url: "https://example.com",
		runners: {
			async defuddle() {
				order.push("defuddle");
				return { content: "should not run" };
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "only he" };
			},
		},
	});
	assert.deepEqual(order, ["html-extractor"]);
	assert.equal(result.kernel, "html-extractor");
});

test("llm selection fails clearly without model and without calling local kernels", async () => {
	const order = [];
	await assert.rejects(
		() => runExtractionKernels({
			selected: "llm",
			html: "<html></html>",
			url: "https://example.com",
			runners: {
				async defuddle() {
					order.push("defuddle");
					return { content: "nope" };
				},
				async "html-extractor"() {
					order.push("html-extractor");
					return { content: "nope" };
				},
			},
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "missing_config"
			&& /No extract model is configured for the llm Extraction Kernel/i.test(error.message),
	);
	assert.deepEqual(order, []);
});

test("configured llm-only selection returns model markdown without local kernels", async () => {
	const order = [];
	const result = await runExtractionKernels({
		selected: "llm",
		html: "<html><body>page</body></html>",
		url: "https://example.com",
		titleHint: "T",
		extractModel: { provider: "newapi", modelId: "gpt-extract" },
		modelRegistry: { find() { return {}; }, async complete() { throw new Error("unused"); } },
		runners: {
			async defuddle() {
				order.push("defuddle");
				return { content: "nope" };
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "nope" };
			},
		},
		async llmRunner() {
			order.push("llm");
			return { content: "from llm\r\n" };
		},
	});
	assert.deepEqual(order, ["llm"]);
	assert.equal(result.kernel, "llm");
	assert.equal(result.content, "from llm");
	assert.equal(result.title, "T");
});

test("defuddle selection reaches configured llm only after local kernels fail", async () => {
	const order = [];
	const result = await runExtractionKernels({
		selected: "defuddle",
		html: "<html></html>",
		url: "https://example.com",
		extractModel: { provider: "newapi", modelId: "gpt-extract" },
		modelRegistry: { find() { return {}; }, async complete() { throw new Error("unused"); } },
		runners: {
			async defuddle() {
				order.push("defuddle");
				return { content: "   " };
			},
			async "html-extractor"() {
				order.push("html-extractor");
				throw new Error("local he failed");
			},
		},
		async llmRunner(input) {
			order.push("llm");
			assert.equal(input.model.provider, "newapi");
			return { content: "llm recovered" };
		},
	});
	assert.deepEqual(order, ["defuddle", "html-extractor", "llm"]);
	assert.equal(result.kernel, "llm");
	assert.equal(result.content, "llm recovered");
});

test("html-extractor selection reaches configured llm after local failure", async () => {
	const order = [];
	const result = await runExtractionKernels({
		selected: "html-extractor",
		html: "<html></html>",
		url: "https://example.com",
		extractModel: { provider: "newapi", modelId: "gpt-extract" },
		modelRegistry: { find() { return {}; }, async complete() { throw new Error("unused"); } },
		runners: {
			async defuddle() {
				order.push("defuddle");
				return { content: "should not run" };
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "\n" };
			},
		},
		async llmRunner() {
			order.push("llm");
			return { content: "llm after he" };
		},
	});
	assert.deepEqual(order, ["html-extractor", "llm"]);
	assert.equal(result.kernel, "llm");
});

test("unconfigured llm is skipped after local failures; direct llm failure does not become Defuddle", async () => {
	const order = [];
	await assert.rejects(
		() => runExtractionKernels({
			selected: "defuddle",
			html: "<html></html>",
			url: "https://example.com",
			runners: {
				async defuddle() {
					order.push("defuddle");
					return { content: "" };
				},
				async "html-extractor"() {
					order.push("html-extractor");
					return { content: "" };
				},
			},
			async llmRunner() {
				order.push("llm");
				return { content: "should not run" };
			},
		}),
		(error) => error instanceof ExtractionKernelError
			&& /llm Extraction Kernel is not configured/i.test(error.message),
	);
	assert.deepEqual(order, ["defuddle", "html-extractor"]);

	order.length = 0;
	const pageSentinel = "PAGE_SENTINEL_DO_NOT_ECHO_llm_only";
	await assert.rejects(
		() => runExtractionKernels({
			selected: "llm",
			html: `<html><body>${pageSentinel}</body></html>`,
			url: "https://example.com",
			extractModel: { provider: "newapi", modelId: "gpt-extract" },
			modelRegistry: { find() { return {}; }, async complete() { throw new Error("unused"); } },
			runners: {
				async defuddle() {
					order.push("defuddle");
					return { content: "secret local success" };
				},
				async "html-extractor"() {
					order.push("html-extractor");
					return { content: "nope" };
				},
			},
			async llmRunner() {
				order.push("llm");
				throw new Error(`provider boom Authorization: Bearer sk-live-secret ${pageSentinel}`);
			},
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "backend_error"
			&& error.message === "llm completion failed"
			&& !error.message.includes("provider boom")
			&& !error.message.includes("sk-live-secret")
			&& !error.message.includes(pageSentinel),
	);
	assert.deepEqual(order, ["llm"]);
});

test("llm runner receives the original shared deadline", async () => {
	const deadlineAt = Date.now() + 45_000;
	let seen;
	await runExtractionKernels({
		selected: "llm",
		html: "<html></html>",
		url: "https://example.com",
		extractModel: { provider: "newapi", modelId: "gpt-extract" },
		modelRegistry: { find() { return {}; }, async complete() { throw new Error("unused"); } },
		deadlineAt,
		async llmRunner(input) {
			seen = input.deadlineAt;
			return { content: "ok" };
		},
	});
	assert.equal(seen, deadlineAt);
});

test("abort and timeout stop Kernel Fallback immediately", async () => {
	const order = [];
	const abortController = new AbortController();
	const aborting = runExtractionKernels({
		selected: "defuddle",
		html: "<html></html>",
		url: "https://example.com",
		signal: abortController.signal,
		runners: {
			async defuddle() {
				order.push("defuddle");
				abortController.abort(new DOMException("aborted", "AbortError"));
				await new Promise(() => {});
				return { content: "never" };
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "should not run" };
			},
		},
	});
	await assert.rejects(() => aborting, (error) => error instanceof Error && error.name === "AbortError");
	assert.deepEqual(order, ["defuddle"]);

	order.length = 0;
	const timeoutSignal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
	await assert.rejects(
		() => runExtractionKernels({
			selected: "defuddle",
			html: "<html></html>",
			url: "https://example.com",
			signal: timeoutSignal,
			runners: {
				async defuddle() {
					order.push("defuddle");
					return { content: "never" };
				},
				async "html-extractor"() {
					order.push("html-extractor");
					return { content: "never" };
				},
			},
		}),
		(error) => error instanceof Error && error.name === "TimeoutError",
	);
	assert.deepEqual(order, []);
});

test("Node AbortSignal.timeout reason stops Kernel Fallback", async () => {
	const order = [];
	const timeoutSignal = AbortSignal.timeout(1);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await assert.rejects(
		() => runExtractionKernels({
			selected: "defuddle",
			html: "<html></html>",
			url: "https://example.com",
			signal: timeoutSignal,
			runners: {
				async defuddle() {
					order.push("defuddle");
					return { content: "never" };
				},
				async "html-extractor"() {
					order.push("html-extractor");
					return { content: "never" };
				},
			},
		}),
		(error) => error instanceof Error && error.name === "TimeoutError",
	);
	assert.deepEqual(order, []);
});

test("local kernel exception text is not echoed while fallback remains correct", async () => {
	const order = [];
	const pageSentinel = "PAGE_SENTINEL_DO_NOT_ECHO_local";
	const recovered = await runExtractionKernels({
		selected: "defuddle",
		html: `<html><body>${pageSentinel}</body></html>`,
		url: "https://example.com",
		runners: {
			async defuddle() {
				order.push("defuddle");
				throw new Error(`parser failed with Authorization: Bearer sk-live-super-secret-token-value and ${pageSentinel}`);
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "recovered after secret-bearing local error" };
			},
		},
	});
	assert.deepEqual(order, ["defuddle", "html-extractor"]);
	assert.equal(recovered.kernel, "html-extractor");
	assert.equal(recovered.content, "recovered after secret-bearing local error");

	await assert.rejects(
		() => runExtractionKernels({
			selected: "defuddle",
			html: `<html><body>${pageSentinel}</body></html>`,
			url: "https://example.com",
			runners: {
				async defuddle() {
					throw new Error(`defuddle failed with Authorization: Bearer sk-live-super-secret-token-value and ${pageSentinel}`);
				},
				async "html-extractor"() {
					throw new Error(`html-extractor failed with Authorization: Bearer sk-live-super-secret-token-value and ${pageSentinel}`);
				},
			},
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "backend_error"
			&& error.message === "No Extraction Kernel produced markdown (defuddle: failed; html-extractor: failed; llm Extraction Kernel is not configured (missing webAccess.fetch.extract.model).)."
			&& !error.message.includes("sk-live-super-secret-token-value")
			&& !error.message.includes(pageSentinel)
			&& !error.message.includes("Authorization")
			&& !/Bearer\s+sk-live/i.test(error.message),
	);
});

test("local exceptions mentioning abort/timeout fall through; aggregate diagnostics stay bounded", async () => {
	const order = [];
	const recovered = await runExtractionKernels({
		selected: "defuddle",
		html: "<html></html>",
		url: "https://example.com",
		runners: {
			async defuddle() {
				order.push("defuddle");
				throw new Error("parser aborted after timeout while reading page body");
			},
			async "html-extractor"() {
				order.push("html-extractor");
				return { content: "recovered after misleading local error" };
			},
		},
	});
	assert.deepEqual(order, ["defuddle", "html-extractor"]);
	assert.equal(recovered.kernel, "html-extractor");

	const huge = "SECRET_PAGE_TEXT_".repeat(80);
	await assert.rejects(
		() => runExtractionKernels({
			selected: "defuddle",
			html: `<html><body>${huge}</body></html>`,
			url: "https://example.com",
			runners: {
				async defuddle() {
					throw new Error(`defuddle failed while reading ${huge}`);
				},
				async "html-extractor"() {
					throw new Error(`html-extractor failed while reading ${huge}`);
				},
			},
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "backend_error"
			&& error.message.length <= 1100
			&& /No Extraction Kernel produced markdown/.test(error.message)
			&& /defuddle: failed/.test(error.message)
			&& /html-extractor: failed/.test(error.message)
			&& !error.message.includes(huge)
			&& !error.message.includes("SECRET_PAGE_TEXT_"),
	);
});

test("default local normalize/extract worker terminates while real work is ongoing", async () => {
	const chunk = `<h-char unicode="ff0c" class="biaodian"><h-inner>，</h-inner></h-char>`;
	// Bounded fixture: enough wrappers for linkedom work to start, not a memory bomb.
	const html = `<!doctype html><html><body><article>${chunk.repeat(2_500)}</article></body></html>`;
	const controller = new AbortController();
	const pending = runExtractionKernels({
		selected: "defuddle",
		html,
		url: "https://example.com/article",
		signal: controller.signal,
	});
	// Abort after the worker has had time to start synchronous parse/normalize work.
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort(new DOMException("aborted during local extract", "AbortError"));
	await assert.rejects(
		() => pending,
		(error) => error instanceof Error && error.name === "AbortError",
	);
});

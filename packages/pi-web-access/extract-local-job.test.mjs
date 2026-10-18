import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { resolveWorkerExecArgv, runLocalExtractionJob } from "./extract-local-job.ts";
import { runExtractionKernels } from "./extract-kernels.ts";

test("resolveWorkerExecArgv keeps tsx, drops invalid NODE_OPTIONS flags, and adds strip-types only when needed", () => {
	assert.deepEqual(resolveWorkerExecArgv(["--import", "tsx"]), ["--import", "tsx"]);
	assert.deepEqual(resolveWorkerExecArgv(["--experimental-strip-types"]), ["--experimental-strip-types"]);
	assert.deepEqual(resolveWorkerExecArgv([]), ["--experimental-strip-types"]);
	assert.deepEqual(
		resolveWorkerExecArgv(["--stack-trace-limit=10", "--import", "tsx", "--v8-pool-size=4"]),
		["--import", "tsx"],
	);
});

test("runLocalExtractionJob terminates the worker when aborted during in-flight work", async () => {
	let terminateCount = 0;
	class BusyWorker extends EventEmitter {
		constructor() {
			super();
			this.alive = true;
		}
		terminate() {
			terminateCount += 1;
			this.alive = false;
			queueMicrotask(() => this.emit("exit", 1));
			return Promise.resolve(1);
		}
	}

	const controller = new AbortController();
	const pending = runLocalExtractionJob(
		{ op: "normalize", html: "<html></html>" },
		{ signal: controller.signal, workerFactory: BusyWorker },
	);
	await Promise.resolve();
	controller.abort(new DOMException("stop", "AbortError"));
	await assert.rejects(() => pending, (error) => error instanceof Error && error.name === "AbortError");
	assert.ok(terminateCount >= 1);
});

test("default kernel path still extracts through the worker boundary", async () => {
	const result = await runExtractionKernels({
		selected: "defuddle",
		html: "<!doctype html><html><body><article><h1>Hello</h1><p>Worker path content.</p></article></body></html>",
		url: "https://example.com/hello",
	});
	assert.equal(result.kernel, "defuddle");
	assert.match(result.content, /Worker path content|Hello/);
});

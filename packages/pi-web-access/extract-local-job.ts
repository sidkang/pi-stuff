import { Worker } from "node:worker_threads";
import type {
	LocalExtractionFailure,
	LocalExtractionJob,
	LocalExtractionSuccess,
} from "./extract-local-worker.ts";

const WORKER_URL = new URL("./extract-local-worker.ts", import.meta.url);

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("This operation was aborted", "AbortError");
}

/**
 * Prefer the parent process loader (tsx in tests, native strip-types in Node >=22.19).
 * Fall back to experimental strip-types so the installed .ts worker runs without tsx.
 * Only forward Worker-safe flags; NODE_OPTIONS often pollutes process.execArgv with V8 flags
 * that Worker rejects (ERR_WORKER_INVALID_EXEC_ARGV).
 */
export function resolveWorkerExecArgv(execArgv: string[] = process.execArgv): string[] {
	const allowed: string[] = [];
	for (let index = 0; index < execArgv.length; index++) {
		const arg = execArgv[index]!;
		if (arg === "--import" || arg === "--require" || arg === "--experimental-loader" || arg === "--loader") {
			allowed.push(arg);
			const next = execArgv[index + 1];
			if (next && !next.startsWith("-")) {
				allowed.push(next);
				index += 1;
			}
			continue;
		}
		if (
			arg.startsWith("--import=")
			|| arg.startsWith("--require=")
			|| arg.startsWith("--experimental-loader=")
			|| arg.startsWith("--loader=")
			|| arg === "--experimental-strip-types"
			|| arg === "--experimental-transform-types"
		) {
			allowed.push(arg);
		}
	}
	if (allowed.some((arg) =>
		arg.includes("tsx")
		|| arg.includes("ts-node")
		|| arg.includes("strip-types")
		|| arg.includes("transform-types")
	)) {
		return allowed;
	}
	return [...allowed, "--experimental-strip-types"];
}

export type RunLocalExtractionJobOptions = {
	signal?: AbortSignal;
	/** Test seam: replace Worker construction. */
	workerFactory?: typeof Worker;
	execArgv?: string[];
};

/**
 * Run one normalize/extract job in a dedicated worker thread.
 * Abort/timeout terminates the worker so synchronous parseHTML/Defuddle cannot outlive the deadline.
 */
export async function runLocalExtractionJob<T>(
	job: LocalExtractionJob,
	options: RunLocalExtractionJobOptions = {},
): Promise<T> {
	if (options.signal?.aborted) throw abortReason(options.signal);

	const WorkerImpl = options.workerFactory ?? Worker;
	const worker = new WorkerImpl(WORKER_URL, {
		workerData: job,
		execArgv: resolveWorkerExecArgv(options.execArgv),
	});

	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, value?: T) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
			void worker.terminate().catch(() => undefined);
			if (error) reject(error);
			else resolve(value as T);
		};
		const onAbort = () => {
			void worker.terminate()
				.catch(() => undefined)
				.finally(() => finish(abortReason(options.signal!)));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		worker.on("message", (message: LocalExtractionSuccess | LocalExtractionFailure) => {
			if (message && message.ok === true) {
				finish(undefined, message.result as T);
				return;
			}
			const failure = message && message.ok === false ? message.error : undefined;
			const error = new Error(failure?.message ?? "local extraction worker failed");
			if (failure?.name) error.name = failure.name;
			finish(error);
		});
		worker.on("error", (error) => {
			finish(error instanceof Error ? error : new Error(String(error)));
		});
		worker.on("exit", (code) => {
			if (settled) return;
			if (options.signal?.aborted) {
				finish(abortReason(options.signal));
				return;
			}
			if (code !== 0) {
				finish(new Error(`local extraction worker exited with code ${code}`));
			}
		});
	});
}

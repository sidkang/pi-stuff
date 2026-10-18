import { SOURCE_TIMEOUT_MS } from "./settings.ts";

export type SourceDeadlineOptions = {
	timeoutMs?: number;
	createTimeout?: (ms: number) => AbortSignal;
};

let testTimeoutMs: number | undefined;
let testCreateTimeout: ((ms: number) => AbortSignal) | undefined;

export function setSourceDeadlineForTests(options?: SourceDeadlineOptions): void {
	testTimeoutMs = options?.timeoutMs;
	testCreateTimeout = options?.createTimeout;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("This operation was aborted", "AbortError");
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
	const active = signals.filter(Boolean);
	if (active.length === 1) return active[0]!;
	if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
	const controller = new AbortController();
	const abort = (event: Event) => {
		const source = event.target;
		controller.abort(source instanceof AbortSignal ? abortReason(source) : undefined);
	};
	for (const signal of active) {
		if (signal.aborted) {
			controller.abort(abortReason(signal));
			return controller.signal;
		}
		signal.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}

export function createSourceDeadline(signal: AbortSignal | undefined, options: SourceDeadlineOptions = {}): AbortSignal {
	const timeoutMs = options.timeoutMs ?? testTimeoutMs ?? SOURCE_TIMEOUT_MS;
	const createTimeout = options.createTimeout ?? testCreateTimeout ?? ((ms: number) => AbortSignal.timeout(ms));
	const timeoutSignal = createTimeout(timeoutMs);
	return signal ? combineSignals([signal, timeoutSignal]) : timeoutSignal;
}

export async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortReason(signal);
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(abortReason(signal));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

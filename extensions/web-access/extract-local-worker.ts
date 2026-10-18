/**
 * Killable worker for synchronous local HTML normalize / Extraction Kernels.
 * LLM extraction stays on the main thread (credentials + Model Registry).
 */
import { parentPort, workerData } from "node:worker_threads";

export type LocalExtractionJob =
	| { op: "normalize"; html: string }
	| { op: "extract"; kernel: "defuddle" | "html-extractor"; html: string; url: string };

export type LocalExtractionSuccess =
	| { ok: true; result: { html: string } }
	| { ok: true; result: { title: string; content: string } };

export type LocalExtractionFailure = {
	ok: false;
	error: { name: string; message: string };
};

async function runJob(job: LocalExtractionJob): Promise<LocalExtractionSuccess["result"]> {
	if (job.op === "normalize") {
		const { normalizeHanTypographyHtml } = await import("./extract-html-normalize.ts");
		return { html: await normalizeHanTypographyHtml(job.html) };
	}
	if (job.kernel === "defuddle") {
		const { extractWithDefuddle } = await import("./extract-defuddle.ts");
		return await extractWithDefuddle(job.html, job.url);
	}
	const { extractWithHtmlExtractor } = await import("./extract-html-extractor.ts");
	return await extractWithHtmlExtractor(job.html, job.url);
}

function failureFrom(error: unknown): LocalExtractionFailure {
	return {
		ok: false,
		error: {
			name: error instanceof Error ? error.name : "Error",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

if (parentPort) {
	const job = workerData as LocalExtractionJob;
	try {
		const result = await runJob(job);
		const message: LocalExtractionSuccess = job.op === "normalize"
			? { ok: true, result: result as { html: string } }
			: { ok: true, result: result as { title: string; content: string } };
		parentPort.postMessage(message);
	} catch (error) {
		parentPort.postMessage(failureFrom(error));
	}
}

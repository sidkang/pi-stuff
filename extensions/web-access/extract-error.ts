export class ExtractionKernelError extends Error {
	code: string;

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options?.cause instanceof Error ? { cause: options.cause } : undefined);
		this.name = "ExtractionKernelError";
		this.code = code;
	}
}

import { Type } from "typebox";

const optionalString = () => Type.Optional(Type.String());
const optionalNumber = () => Type.Optional(Type.Number());

export const SearchOutputSchema = Type.Object({
	query: Type.String(), answer: Type.String(),
	sources: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: optionalString(), publishedDate: optionalString() }, { additionalProperties: false })),
	citations: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), citedText: optionalString() }, { additionalProperties: false })),
	citationUrls: Type.Array(Type.String()),
	source: optionalString(), provider: optionalString(), model: optionalString(), api: optionalString(), requestId: optionalString(),
	elapsedMs: optionalNumber(), timeoutMs: optionalNumber(),
	usage: Type.Optional(Type.Object({ inputTokens: optionalNumber(), outputTokens: optionalNumber(), totalTokens: optionalNumber() }, { additionalProperties: false })),
}, { additionalProperties: false });

export const FetchOutputSchema = Type.Object({
	requestedUrl: Type.String(), url: Type.String(), title: Type.String(), markdown: Type.String(), source: Type.String(), kernel: optionalString(),
	totalChars: Type.Integer(), totalBytes: Type.Integer(), returnedChars: Type.Integer(), truncated: Type.Boolean(),
	structuredChars: Type.Integer(), structuredTruncated: Type.Boolean(), fullOutputPath: optionalString(),
	retrievedAt: Type.String(), elapsedMs: Type.Number(),
}, { additionalProperties: false });

// Hints only: browser reads can still trigger page activity and expose private data.
export const WEB_READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

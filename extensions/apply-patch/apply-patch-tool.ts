import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatch, type ApplyPatchResult } from "./apply-patch.ts";
import { ApplyPatchOutputSchema, buildApplyPatchOutput } from "./apply-patch-output.ts";
import { renderApplyPatchCall, renderApplyPatchResult } from "./apply-patch-renderer.ts";
import {
	resolveWorkspaceFiles,
	WORKSPACE_ACCESS_QUERY_V1,
	WORKSPACE_ACCESS_QUERY_V2,
} from "./workspace-files.ts";

/** Sync probe: first v2 provide() is authoritative; only a valid host object keeps Host preview I/O. */
function allowHostPreviewForSession(pi?: ExtensionAPI): boolean {
	if (!pi?.events) return true;
	let allow = true;
	let sawV2 = false;
	pi.events.emit(WORKSPACE_ACCESS_QUERY_V2, {
		protocolVersion: 2,
		provide(offer: { kind?: string } | undefined) {
			if (sawV2) return;
			sawV2 = true;
			// Explicit --no-sandbox host marker keeps Host preview. Anything else fails closed.
			allow = Boolean(offer) && typeof offer === "object" && offer.kind === "host";
		},
	});
	if (sawV2) return allow;
	// Older Sandbox v1: sandbox placement or unavailable => no Host preview.
	pi.events.emit(WORKSPACE_ACCESS_QUERY_V1, {
		protocolVersion: 1,
		provide(offer: { kind?: string; access?: { placement?: string } } | undefined) {
			if (!offer || typeof offer !== "object") return;
			if (offer.kind === "unavailable") allow = false;
			else if (offer.kind === "access" && offer.access?.placement === "sandbox") allow = false;
			else if (offer.kind === "access" && offer.access?.placement === "host") allow = true;
		},
	});
	return allow;
}

export interface ApplyPatchInput {
	input: string;
}

export const applyPatchToolSchema = Type.Object({
	input: Type.String({
		minLength: 1,
		description: "Complete apply_patch payload using the *** Begin Patch / *** End Patch envelope. Use relative file-operation headers and @@ update hunks whose context, removed, and added lines begin with a space, -, and + respectively.",
	}),
}, { additionalProperties: false, required: ["input"] });

function boundedSummary(result: ApplyPatchResult): string {
	const files = result.changedFiles.join(", ");
	return `${result.summary}\nFiles changed: ${files || "none"}`;
}

export function createApplyPatchToolDefinition(pi?: ExtensionAPI) {
	return {
		name: "apply_patch",
		label: "Apply Patch",
		description: "Use the `apply_patch` tool to edit files. Pass the complete patch payload in the `input` field.",
		promptSnippet: "Use apply_patch to edit files with its stripped-down, file-oriented patch format.",
		promptGuidelines: [
			"Pass one complete patch payload in input, beginning with *** Begin Patch and ending with *** End Patch.",
			"Each file operation must start with *** Add File, *** Delete File, or *** Update File. A *** Move to line must appear immediately after its Update File header, before all hunks.",
			"Within update hunks, prefix context lines with a space, removed lines with -, and added lines with +. Add File actions contain only + lines, use no @@ headers, and create a final newline.",
			"By default, include 3 complete lines immediately above and 3 complete lines immediately below each change. When nearby changes overlap, do not duplicate the first change's trailing context in the next hunk.",
			"If 3 lines of context do not uniquely identify the change, put the enclosing class, function, method, test, or other unique section after @@. Use multiple @@ section headers when nested context is needed.",
			"Use literal relative file paths only; do not quote them or prefix them with @. Read the current file first when exact context is uncertain or may have changed.",
			"Matching tries exact complete lines first, then ignores trailing whitespace, then surrounding whitespace. Every tier still rejects ambiguous matches instead of choosing the first occurrence.",
			"Delete File actions are header-only. Do not include the \\ No newline at end of file marker.",
		],
		parameters: applyPatchToolSchema,
		outputSchema: ApplyPatchOutputSchema,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId: string, params: ApplyPatchInput, signal: AbortSignal | undefined, onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined, ctx: ExtensionContext) {
			if (!params || typeof params.input !== "string") throw new Error("apply_patch requires an input string.");
			if (signal?.aborted) throw new Error("Operation aborted.");
			onUpdate?.({ content: [{ type: "text", text: "Applying patch…" }], details: { phase: "applying" } });
			const resolved = resolveWorkspaceFiles(pi?.events, { root: ctx.cwd, signal });
			const result = await applyPatch(params.input, {
				cwd: ctx.cwd,
				signal,
				workspace: resolved.access,
				workspacePlacement: resolved.placement,
			});
			return {
				content: [{ type: "text" as const, text: boundedSummary(result) }],
				details: result,
				structuredContent: buildApplyPatchOutput(result),
			};
		},
		renderShell: "self" as const,
		renderCall(args: unknown, theme: any, context: any) {
			return renderApplyPatchCall(args, theme, {
				...context,
				allowHostPreview: allowHostPreviewForSession(pi),
			});
		},
		renderResult(result: { content?: unknown; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
			return renderApplyPatchResult(result, options, theme, context);
		},
	};
}

export default function registerApplyPatchTool(pi: ExtensionAPI): void {
	pi.registerTool(createApplyPatchToolDefinition(pi));
}

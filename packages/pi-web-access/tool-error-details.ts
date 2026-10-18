import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/**
 * Factory-local bridge that restores structured hard-error details after Pi
 * catches a thrown tool error and rewrites `details` to `{}`.
 *
 * `execute()` still throws so outer/persisted `isError:true` stay real. Record bounded
 * details immediately before rethrow; the public `tool_result` hook patches them back.
 */
export type ToolErrorDetails = Record<string, unknown>;

export type ToolErrorDetailsRestore = {
	details: ToolErrorDetails;
};

export type ToolErrorDetailsBridge = {
	record(toolCallId: string, details: ToolErrorDetails): void;
	pendingCount(): number;
	install(pi: Pick<ExtensionAPI, "on">): void;
};

export function createToolErrorDetailsBridge(toolName: string): ToolErrorDetailsBridge {
	const pending = new Map<string, ToolErrorDetails>();

	function restore(event: ToolResultEvent): ToolErrorDetailsRestore | undefined {
		if (event.toolName !== toolName) return undefined;
		const details = pending.get(event.toolCallId);
		if (details === undefined) return undefined;
		pending.delete(event.toolCallId);
		if (event.isError !== true) return undefined;
		return { details };
	}

	return {
		record(toolCallId, details) {
			pending.set(toolCallId, { ...details });
		},
		pendingCount() {
			return pending.size;
		},
		install(pi) {
			pi.on("tool_result", (event) => restore(event));
			pi.on("session_shutdown", () => {
				pending.clear();
			});
		},
	};
}

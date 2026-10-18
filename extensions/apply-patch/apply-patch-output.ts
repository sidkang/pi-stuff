import { Type, type Static } from "typebox";
import type { ApplyPatchResult } from "./apply-patch.ts";

export const ApplyPatchOutputSchema = Type.Object({
	ok: Type.Boolean(),
	summary: Type.String(),
	changedFiles: Type.Array(Type.String()),
	files: Type.Array(Type.Object({
		kind: Type.String({ enum: ["add", "update", "delete"] }),
		path: Type.String(),
		moveTo: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
	noops: Type.Array(Type.Object({
		path: Type.String(),
		actionIndex: Type.Integer({ minimum: 0 }),
		hunkIndex: Type.Integer({ minimum: 0 }),
		startLine: Type.Integer({ minimum: 1 }),
		endLine: Type.Integer({ minimum: 1 }),
		reason: Type.String({ enum: ["already_satisfied"] }),
	}, { additionalProperties: false })),
	firstChangedLine: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export function buildApplyPatchOutput(result: ApplyPatchResult): Static<typeof ApplyPatchOutputSchema> {
	// Keep full diff/patch and Host-only paths in renderer details, not script data.
	return {
		ok: true,
		summary: result.summary,
		changedFiles: [...result.changedFiles],
		files: result.files.map((file) => ({
			kind: file.kind,
			path: file.path,
			...(file.moveTo !== undefined ? { moveTo: file.moveTo } : {}),
		})),
		noops: result.noops.map((noop) => ({
			path: noop.path,
			actionIndex: noop.actionIndex,
			hunkIndex: noop.hunkIndex,
			startLine: noop.startLine,
			endLine: noop.endLine,
			reason: noop.reason,
		})),
		...(result.firstChangedLine !== undefined ? { firstChangedLine: result.firstChangedLine } : {}),
	};
}

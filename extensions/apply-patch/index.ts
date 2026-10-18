import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerApplyPatchTool from "./apply-patch-tool.ts";
import { registerApplyPatchVisibility } from "./model-gating.ts";

export default function applyPatch(pi: ExtensionAPI) {
	registerApplyPatchTool(pi);
	registerApplyPatchVisibility(pi);
}

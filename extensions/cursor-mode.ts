import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

export { CURSOR_MARKER };

const LEADING_SGR = /^\x1b\[([0-9;]*)m/;
const SGR = /\x1b\[([0-9;]*)m/g;

function sgrControls(raw: string): { rawValues: string[]; controls: Array<[number, number]> } {
	const rawValues = raw === "" ? [""] : raw.split(";");
	const controls: Array<[number, number]> = [];

	for (let index = 0; index < rawValues.length; index++) {
		const value = Number(rawValues[index] || "0");
		if (value === 38 || value === 48 || value === 58) {
			const mode = Number(rawValues[index + 1] || "0");
			index += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			continue;
		}
		controls.push([index, value]);
	}

	return { rawValues, controls };
}

function inverseAfter(controls: Array<[number, number]>, initial: boolean): boolean {
	let inverse = initial;
	for (const [, parameter] of controls) {
		if (parameter === 0 || parameter === 27) inverse = false;
		else if (parameter === 7) inverse = true;
	}
	return inverse;
}

function withoutReverseOn(rawParameters: string): string | undefined {
	const { rawValues, controls } = sgrControls(rawParameters);
	if (!inverseAfter(controls, false)) return undefined;

	const reverseOnIndices = new Set(controls.filter(([, value]) => value === 7).map(([index]) => index));
	const remaining = rawValues.filter((_, index) => !reverseOnIndices.has(index));
	return remaining.length === 0 ? "" : `\x1b[${remaining.join(";")}m`;
}

export function hideCursorInLine(line: string): string {
	const markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex === -1) return line;

	const beforeMarker = line.slice(0, markerIndex);
	const afterMarker = line.slice(markerIndex + CURSOR_MARKER.length);
	// Focusable components emit CURSOR_MARKER immediately before their
	// reverse-video software cursor, whose content may be a multi-codepoint grapheme.
	const reverseOn = LEADING_SGR.exec(afterMarker);
	if (!reverseOn) return line;
	const replacementOpen = withoutReverseOn(reverseOn[1]);
	if (replacementOpen === undefined) return line;

	const afterReverseOn = afterMarker.slice(reverseOn[0].length);
	let reset: RegExpExecArray | null = null;
	for (const match of afterReverseOn.matchAll(SGR)) {
		if (!inverseAfter(sgrControls(match[1]).controls, true)) {
			reset = match;
			break;
		}
	}
	if (!reset) return line;

	const cursorCell = afterReverseOn.slice(0, reset.index);
	const afterReset = afterReverseOn.slice(reset.index + reset[0].length);
	return beforeMarker + CURSOR_MARKER + replacementOpen + cursorCell + reset[0] + afterReset;
}

export default function registerCursorMode(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const previousEditorFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previousEditorFactory
				? previousEditorFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			const render = editor.render.bind(editor);

			editor.render = (width: number): string[] => {
				const lines = render(width);
				return tui.getShowHardwareCursor?.() === true ? lines.map(hideCursorInLine) : lines;
			};

			return editor;
		});
	});
}

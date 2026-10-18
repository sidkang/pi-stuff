import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, stripTerminalSequences } from "@earendil-works/pi-tui";

interface Notification {
	title: string;
	body: string;
}

const OSC_777_PREFIX = "\x1b]777;notify;";
const OSC_TERMINATOR = "\x07";
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;
const MAX_BODY_GRAPHEMES = 200;
const MAX_BODY_BYTES = 800;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const sanitizeNotificationText = (text: string): string =>
	stripTerminalSequences(text).replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();

const truncateNotificationBody = (text: string, maxGraphemes: number, maxBytes: number): string => {
	const accepted: string[] = [];
	let acceptedBytes = 0;

	for (const { segment } of graphemeSegmenter.segment(text)) {
		const segmentBytes = Buffer.byteLength(segment, "utf8");
		if (accepted.length >= maxGraphemes || acceptedBytes + segmentBytes > maxBytes) {
			const ellipsisBytes = Buffer.byteLength("…", "utf8");
			while (
				accepted.length > 0 &&
				(accepted.length >= maxGraphemes || acceptedBytes + ellipsisBytes > maxBytes)
			) {
				acceptedBytes -= Buffer.byteLength(accepted.pop()!, "utf8");
			}
			return `${accepted.join("")}…`;
		}
		accepted.push(segment);
		acceptedBytes += segmentBytes;
	}

	return text;
};

const buildOsc777Notification = (title: string, body: string): string =>
	`${OSC_777_PREFIX}${sanitizeNotificationText(title)};${sanitizeNotificationText(body)}${OSC_TERMINATOR}`;

const notify = (title: string, body: string): void => {
	try {
		process.stdout.write(buildOsc777Notification(title, body));
	} catch {
		// Desktop notifications are best-effort and must not break the Pi session.
	}
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;

		const content = message.content;
		if (typeof content === "string") return content.trim() || null;
		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}
		return null;
	}
	return null;
};

const shouldSkipNotification = (messages: Array<{ role?: string; stopReason?: unknown }>): boolean => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") {
			return message.stopReason === "aborted" || message.stopReason === "error";
		}
	}
	return false;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): Notification => {
	const normalized = sanitizeNotificationText(text ? simpleMarkdown(text) : "");
	if (!normalized) return { title: "Ready for input", body: "" };
	return {
		title: "π",
		body: truncateNotificationBody(normalized, MAX_BODY_GRAPHEMES, MAX_BODY_BYTES),
	};
};

export const __test = {
	buildOsc777Notification,
	extractLastAssistantText,
	formatNotification,
	sanitizeNotificationText,
	shouldSkipNotification,
	truncateNotificationBody,
};

export default function registerNotify(pi: ExtensionAPI): void {
	let pending: Notification | null = null;

	pi.on("agent_start", () => {
		// A new low-level run means Pi continued after the previous agent_end.
		pending = null;
	});

	pi.on("agent_end", (event, ctx) => {
		if (ctx.mode !== "tui" || shouldSkipNotification(event.messages ?? [])) {
			pending = null;
			return;
		}
		pending = formatNotification(extractLastAssistantText(event.messages ?? []));
	});

	pi.on("agent_settled", (_event, ctx) => {
		const notification = pending;
		pending = null;
		if (ctx.mode !== "tui" || !notification || !ctx.isIdle()) return;
		notify(notification.title, notification.body);
	});

	pi.on("session_shutdown", () => {
		pending = null;
	});
}

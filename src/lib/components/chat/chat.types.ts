import type { EmojiDisplay } from '$lib/chat/emoji';
import type { ReplyQuoteView } from '$lib/chat/replyQuote';

export interface ChatReaction {
	emoji: string;
	count: number;
	reactedByMe?: boolean;
	reactors: string[];
	/** A custom emoji's picture, when the reaction event carried one. */
	display?: EmojiDisplay;
	mediaKeyBase64?: string;
}

export interface ChatReactionEmojiView {
	display: EmojiDisplay;
	mediaKeyBase64?: string;
}

export interface ChatMessage {
	id: string;
	eventId: string;
	author: string;
	text: string;
	kind: number;
	createdAt: number;
	timeLabel: string;
	isOwn?: boolean;
	deliveryState?: 'sending' | 'sent' | 'error' | 'queued';
	/** Why a pending bubble is stuck (held send, coordinator error) — the
	 *  clock icon's tooltip. Absent for the plain offline-queued case. */
	deliveryDetail?: string;
	/** A send held back only by its custom emoji, so "send without emoji" can be
	 *  offered on the failed bubble instead of the message arriving as bare text. */
	emojiBlocked?: boolean;
	edited?: boolean;
	deleted?: boolean;
	reactions?: ChatReaction[];
	replyTo?: ReplyQuoteView;
	cursor?: number;
	/** Confirmed-message event tags (carries `imeta` for media). */
	tags?: string[][];
	/** Tags of the text actually displayed: an edit's tags when edited. */
	displayTags?: string[][];
	/** The media key belonging to `displayTags` (an edit's own epoch key). */
	displayMediaKeyBase64?: string;
	/** Per-epoch media key for decrypting this message's `imeta` media. */
	mediaKeyBase64?: string;
	/** True when this message is currently in the group's derived pin set. */
	pinned?: boolean;
	pinnedBy?: string;
	unreadReference?: boolean;
	unreadReferenceCursor?: number;
	systemKind?: 'member-added' | 'member-removed' | 'metadata-changed' | 'commit-lost' | 'reaction';
	systemTarget?: string;
	systemCommitter?: string;
	systemDetail?: string;
	/** Reaction marker only: composite row id of the reacted-to message.
	 *  Undefined when the target is unknown (no jump offered). */
	reactionTarget?: string;
	/** Reaction marker only: distinct reaction emojis, in arrival order. */
	reactionEmojis?: string[];
	/** Reaction marker only: the custom picture behind a reaction, by emoji. */
	reactionEmojiViews?: Record<string, ChatReactionEmojiView>;
	/** Reaction marker only: distinct reactor pubkeys, in arrival order. */
	reactionSenders?: string[];
	/** Reaction marker only: the member rows folded into this summary (merged
	 *  rows only). Each keeps its own target for its honest see icon. */
	reactionItems?: ChatMessage[];
	/** Media attachment. Optimistic/draft messages carry a local plaintext
	 *  `previewUrl` (shown immediately during upload); confirmed messages leave
	 *  this undefined and resolve the `imeta` lazily via the encrypted-media
	 *  store. Upload progress is NOT here — it lives in the `mediaUploadProgress`
	 *  registry so a per-tick update never rebuilds the message list.
	 *
	 *  Voice notes carry `durationMs` + `waveform` (the precomputed peaks), which
	 *  confirmed messages reconstruct from the `imeta` hints instead. */
	media?: {
		mime: string;
		filename: string;
		sizeBytes?: number;
		previewUrl?: string;
		/** Voice note only: whole-note length in ms. */
		durationMs?: number;
		/** Voice note only: normalized 0–1 amplitude peaks for the waveform. */
		waveform?: number[];
	};
}

export interface ChatGroup {
	id: string;
	title: string;
	subtitle: string;
}

export interface ChatMentionCandidate {
	pubkey: string;
	name?: string;
	displayName?: string;
	nip05?: string;
}

export interface ChatMentionReference {
	pubkey: string;
	label: string;
}

/** One staged file leaving the composer with its own caption. */
export interface OutgoingMediaAttachment {
	readonly file: File;
	readonly caption: string;
}

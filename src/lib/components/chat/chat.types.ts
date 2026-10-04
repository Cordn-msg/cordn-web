export interface ChatMessage {
	id: string;
	eventId: string;
	author: string;
	authorLabel?: string;
	text: string;
	kind: number;
	createdAt: number;
	timeLabel: string;
	dayLabel: string;
	isOwn?: boolean;
	deliveryState?: 'sending' | 'sent' | 'error' | 'queued';
	edited?: boolean;
	deleted?: boolean;
	reactions?: Array<{
		emoji: string;
		count: number;
		reactedByMe?: boolean;
		reactors: string[];
	}>;
	replyTo?: {
		id: string;
		author: string;
		authorLabel?: string;
		text: string;
		deleted?: boolean;
	};
	cursor?: number;
	/** Confirmed-message event tags (carries `imeta` for media). */
	tags?: string[][];
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
	/** Reaction marker only: distinct reactor pubkeys, in arrival order. */
	reactionSenders?: string[];
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

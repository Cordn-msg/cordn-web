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
	deliveryState?: 'sending' | 'sent' | 'error';
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
	systemKind?: 'member-added' | 'member-removed' | 'metadata-changed';
	systemTarget?: string;
	systemCommitter?: string;
	systemDetail?: string;
	/** Media attachment. Optimistic/draft messages carry a local plaintext
	 *  `previewUrl` (shown immediately during upload); confirmed messages leave
	 *  this undefined and the item resolves the `imeta` lazily via the
	 *  encrypted-media store. */
	media?: {
		kind: 'image' | 'file';
		mime: string;
		filename: string;
		sizeBytes?: number;
		previewUrl?: string;
		uploading?: boolean;
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

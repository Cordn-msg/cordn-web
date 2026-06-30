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
	encrypted?: boolean;
	unreadReference?: boolean;
	unreadReferenceCursor?: number;
	systemKind?: 'member-added' | 'member-removed' | 'metadata-changed';
	systemTarget?: string;
	systemCommitter?: string;
	systemDetail?: string;
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

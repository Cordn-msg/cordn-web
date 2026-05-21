export interface ChatMessage {
	id: string;
	eventId: string;
	author: string;
	authorLabel?: string;
	text: string;
	timeLabel: string;
	dayLabel: string;
	isOwn?: boolean;
	deliveryState?: 'sending' | 'sent' | 'error';
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
	};
}

export interface ChatGroup {
	id: string;
	title: string;
	subtitle: string;
}

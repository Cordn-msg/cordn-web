export interface ChatMessage {
	id: string;
	author: string;
	text: string;
	timestamp: string;
	isOwn?: boolean;
}

export interface ChatGroup {
	id: string;
	title: string;
	subtitle: string;
}

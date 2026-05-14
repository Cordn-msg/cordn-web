export interface ChatMessage {
	id: number;
	author: string;
	text: string;
	timestamp: string;
}

export interface ChatGroup {
	id: string;
	title: string;
	subtitle: string;
}

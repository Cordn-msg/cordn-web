import type { ChatGroup, ChatMessage } from './chat.types';

export const chatGroups: Record<string, ChatGroup> = {
	general: {
		id: 'general',
		title: 'General',
		subtitle: 'Shared group coordination'
	},
	research: {
		id: 'research',
		title: 'Research',
		subtitle: 'Protocol and design exploration'
	},
	ops: {
		id: 'ops',
		title: 'Ops',
		subtitle: 'Deployment and instance maintenance'
	}
};

export const defaultGroup = chatGroups.general;

const groupMessages = $state<Record<string, ChatMessage[]>>({
	general: [],
	research: [],
	ops: []
});

export function getGroupMessages(groupId: string) {
	return groupMessages[groupId] ?? [];
}

export function appendGroupMessage(groupId: string, message: ChatMessage) {
	groupMessages[groupId] = [...getGroupMessages(groupId), message];
}

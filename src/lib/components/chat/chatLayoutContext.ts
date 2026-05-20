import { getContext, setContext } from 'svelte';
import { writable, type Writable } from 'svelte/store';

const CHAT_LAYOUT_CONTEXT = Symbol('chat-layout-context');

export type ChatLayoutContext = {
	mobileSidebarOpen: Writable<boolean>;
};

export function createChatLayoutContext(): ChatLayoutContext {
	return {
		mobileSidebarOpen: writable(false)
	};
}

export function setChatLayoutContext(context: ChatLayoutContext) {
	setContext(CHAT_LAYOUT_CONTEXT, context);
	return context;
}

export function getChatLayoutContext(): ChatLayoutContext {
	return getContext<ChatLayoutContext>(CHAT_LAYOUT_CONTEXT) ?? createChatLayoutContext();
}

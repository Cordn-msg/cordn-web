/**
 * The parent ("up") destination for a chat-shell path — one source of truth for the in-app back
 * arrow and the Android hardware back button, so the two can never disagree about where "back"
 * goes.
 *
 * Deliberately path-based, not history-based: `history.back()` means "wherever you came from",
 * which differs by entry point (tap, search, notification, deep link, share) and exits the app
 * from a cold-opened deep link instead of returning to the chat list.
 *
 * `null` means "no parent" — the chat home, where Back leaves the app.
 */
export function chatUpHref(pathname: string): string | null {
	const segments = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
	if (segments[0] !== 'chat') return '/chat'; // profile pages (and anything else) sit under Chat
	const rest = segments.slice(1); // after the /chat prefix

	if (rest.length === 0) return null; // chat home
	if (rest[0] === 'config') return rest.length === 1 ? '/chat' : '/chat/config';
	// Coordinators lives outside /chat/config but its only entry is the settings card, so "up" is
	// settings (matches user expectation).
	if (rest[0] === 'coordinators') {
		return rest.length === 1 ? '/chat/config' : '/chat/coordinators';
	}
	if (rest.length === 1) return '/chat'; // chat | news | create-group | share
	// Conversation children: /chat/<id>/info and /chat/<id>/e/<eventId>.
	return `/chat/${rest[0]}`;
}

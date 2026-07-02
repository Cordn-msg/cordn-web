/**
 * Module-level lightbox state for chat media. Any media view (chat bubble,
 * info sidebar) calls openMediaLightbox(); MediaLightbox.svelte renders the
 * overlay once at the chat-layout level. Avoids prop-drilling an open callback
 * through the virtualized message list — same module-state pattern as
 * chatAttention.svelte.ts.
 */
export interface LightboxMedia {
	url: string;
	filename: string;
	mime: string;
}

export const mediaLightbox = $state<{ current: LightboxMedia | null }>({ current: null });

export function openMediaLightbox(media: LightboxMedia): void {
	mediaLightbox.current = media;
}

export function closeMediaLightbox(): void {
	mediaLightbox.current = null;
}

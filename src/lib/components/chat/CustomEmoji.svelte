<script lang="ts">
	import { cn } from '$lib/utils';
	import type { EmojiDisplay } from '$lib/chat/emoji';
	import {
		getMediaAutoLoad,
		isMessageMediaFailed,
		markMessageMediaFailed,
		resolveEmojiMedia
	} from '$lib/services/chatMediaStorage.svelte';

	/**
	 * One custom emoji: a plain pack picture, or the encrypted `emoji-media`
	 * blob Staircase sends, opened with the row's epoch key. Anything that
	 * cannot be had falls back to the shortcode, which is what a client
	 * without the emoji sees.
	 */
	let {
		display,
		mediaKeyBase64,
		class: className = '',
		sizeClass = 'size-[1.15em]',
		gateAutoLoad = true
	}: {
		display: EmojiDisplay;
		mediaKeyBase64?: string;
		class?: string;
		sizeClass?: string;
		/** Event-carried emoji honor the media auto-load setting; browsing does not. */
		gateAutoLoad?: boolean;
	} = $props();

	let resolvedUrl = $state<string | null>(null);
	let mediaFailed = $state(false);
	let imageFailed = $state(false);
	const autoLoad = $derived(!gateAutoLoad || getMediaAutoLoad());

	$effect(() => {
		// The URL is a dependency too: a plain tag changing is a new picture.
		void display.url;
		const media = display.media;
		const key = mediaKeyBase64;
		resolvedUrl = null;
		mediaFailed = false;
		imageFailed = false;
		if (!autoLoad) return;
		if (!media) return;
		if (!key || isMessageMediaFailed(media.plaintextHashHex)) {
			mediaFailed = true;
			return;
		}
		let cancelled = false;
		void resolveEmojiMedia(media, key)
			.then((resolved) => {
				if (cancelled) return;
				resolvedUrl = resolved?.url ?? null;
				if (!resolved) {
					mediaFailed = true;
					markMessageMediaFailed(media.plaintextHashHex);
				}
			})
			.catch(() => {
				if (cancelled) return;
				mediaFailed = true;
				markMessageMediaFailed(media.plaintextHashHex);
			});
		return () => {
			cancelled = true;
		};
	});

	const src = $derived(
		autoLoad
			? (resolvedUrl ??
					(display.media && !mediaFailed && mediaKeyBase64 ? null : (display.url ?? null)))
			: null
	);
</script>

{#if src && !imageFailed}
	<img
		{src}
		alt={`:${display.name}:`}
		title={`:${display.name}:`}
		class={cn('inline-block object-contain align-[-0.2em]', sizeClass, className)}
		loading="lazy"
		decoding="async"
		referrerpolicy="no-referrer"
		onerror={() => (imageFailed = true)}
	/>
{:else}
	<span class={cn('inline-block align-[-0.2em]', className)}>{`:${display.name}:`}</span>
{/if}

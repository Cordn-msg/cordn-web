<script lang="ts">
	import {
		getMediaAutoLoad,
		isMediaUrlRevealed,
		revealMediaUrl
	} from '$lib/services/chatMediaStorage.svelte';
	import { openMediaLightbox } from '$lib/services/chatMediaLightbox.svelte';
	import { mediaUrlKind, mediaExtLabel, cn } from '$lib/utils';
	import ImageIcon from '@lucide/svelte/icons/image';
	import VideoIcon from '@lucide/svelte/icons/video';

	/**
	 * Renders a plain (unencrypted) media URL pasted into a message as an inline
	 * image or video, instead of the default link button. Gated by the global
	 * auto-load setting: off shows a "Load media" button the user taps first.
	 * Distinct from ChatMessageMedia, which handles encrypted `imeta` attachments.
	 */
	let { href, isOwn = false }: { href: string; isOwn?: boolean } = $props();

	const kind = $derived(mediaUrlKind(href));
	// Per-URL reveal lives in module scope (see chatMediaStorage) so it survives
	// virtualizer row remounts — local $state here caused the load-button flicker.
	const show = $derived(getMediaAutoLoad() || isMediaUrlRevealed(href));
	const filename = $derived(href.split('/').pop()?.split('?')[0] ?? 'media');
	const ext = $derived(mediaExtLabel(filename));
	const Icon = $derived(kind === 'video' ? VideoIcon : ImageIcon);
</script>

{#snippet loadButton()}
	<button
		type="button"
		class={cn(
			'mt-1 inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs',
			isOwn ? 'border-primary-foreground/30 text-primary-foreground' : 'border-border/60'
		)}
		onclick={() => revealMediaUrl(href)}
	>
		<Icon class="size-4 shrink-0" />
		Load media
		{#if ext}<span class="opacity-60">{ext}</span>{/if}
	</button>
{/snippet}

{#if kind === 'image'}
	{#if show}
		<button
			type="button"
			class="mt-1 block max-h-64 w-full max-w-[16rem] overflow-hidden rounded-2xl sm:max-w-[20rem]"
			aria-label="Open image"
			onclick={() => openMediaLightbox({ url: href, filename, mime: 'image/*' })}
		>
			<img
				src={href}
				alt={filename}
				loading="lazy"
				class="max-h-64 w-full cursor-zoom-in object-cover"
			/>
		</button>
	{:else}
		{@render loadButton()}
	{/if}
{:else if kind === 'video'}
	{#if show}
		<!-- ponytail: arbitrary external video URLs — captions are the sender/server's
		     responsibility, not something we can synthesize here. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			src={href}
			controls
			preload="metadata"
			class="mt-1 max-h-72 max-w-[16rem] rounded-2xl sm:max-w-[20rem]"
		></video>
	{:else}
		{@render loadButton()}
	{/if}
{/if}

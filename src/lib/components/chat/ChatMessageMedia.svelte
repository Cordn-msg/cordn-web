<script lang="ts">
	import { browser } from '$app/environment';
	import { Spinner } from '$lib/components/ui/spinner';
	import {
		peekMessageMedia,
		resolveMessageMedia,
		getMediaAutoLoad,
		isMessageMediaLoaded,
		markMessageMediaLoaded,
		type ResolvedMedia
	} from '$lib/services/chatMediaStorage.svelte';
	import { openMediaLightbox } from '$lib/services/chatMediaLightbox.svelte';
	import { cn, downloadObjectUrl, mediaExtLabel } from '$lib/utils';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import Download from '@lucide/svelte/icons/download';
	import FileText from '@lucide/svelte/icons/file-text';
	import ImageIcon from '@lucide/svelte/icons/image';
	import type { ChatMessage } from './chat.types';

	/**
	 * Structural slice of a message that this view reads. Loose on purpose so
	 * both the chat-bubble render model (ChatMessage, keyed by `eventId`) and the
	 * rich/sidebar model (StoredChatMessage, keyed by `id`) can render media
	 * without an adapter — they only need tags + the stashed per-epoch key.
	 */
	type MediaViewMessage = Pick<
		ChatMessage,
		'media' | 'tags' | 'mediaKeyBase64' | 'deliveryState'
	> & {
		eventId?: string;
		id?: string;
		isOwn?: boolean;
	};

	/**
	 * Renders a message's media attachment. Two sources:
	 *  - Optimistic (`media`): the sender's just-picked file, shown from a local
	 *    plaintext preview URL with an in-item upload spinner.
	 *  - Confirmed (`imeta` in `tags` + stashed `mediaKeyBase64`): the encrypted
	 *    blob, fetched + decrypted lazily on mount and cached.
	 *
	 * Isolated from ChatMessageItem so the resolve/effect lifecycle doesn't weigh
	 * down the virtualized row; the storage cache (keyed by plaintext hash) makes
	 * remounts cheap. Shared with the message-info sidebar (DefaultRich).
	 */
	let { message }: { message: MediaViewMessage } = $props();

	const optimistic = $derived(message.media);
	const ref = $derived(message.tags ? peekMessageMedia(message.tags) : null);
	const messageId = $derived(message.eventId ?? message.id ?? '');

	let resolved = $state<ResolvedMedia | null>(null);
	let loading = $state(false);
	let failed = $state(false);

	// Resolve only confirmed media (optimistic items show the local preview).
	$effect(() => {
		if (!browser) return;
		if (optimistic) {
			resolved = null;
			loading = false;
			failed = false;
			return;
		}
		const currentRef = ref;
		const key = message.mediaKeyBase64;
		if (!currentRef || !key || !message.tags) {
			resolved = null;
			loading = false;
			return;
		}
		// Auto-load gates the fetch/decrypt. The override lives in module scope
		// (survives row remounts) so scroll-away-and-back keeps media loaded.
		if (!getMediaAutoLoad() && !isMessageMediaLoaded(messageId)) {
			resolved = null;
			loading = false;
			return;
		}
		loading = true;
		failed = false;
		let cancelled = false;
		resolveMessageMedia({
			messageId,
			tags: message.tags,
			mediaKeyBase64: key
		})
			.then((r) => {
				if (cancelled) return;
				resolved = r;
				loading = false;
			})
			.catch(() => {
				if (cancelled) return;
				failed = true;
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	const hasMedia = $derived(Boolean(optimistic || ref));
	const showingImage = $derived(
		optimistic?.kind === 'image' ||
			(optimistic ? optimistic.mime.startsWith('image/') : Boolean(ref?.mime.startsWith('image/')))
	);
	const uploading = $derived(Boolean(optimistic?.uploading));
	const isFailed = $derived(Boolean(message.deliveryState === 'error') || failed);
	const mediaLabel = $derived(mediaExtLabel(ref?.filename, ref?.mime));
</script>

{#if hasMedia}
	<div class="mb-2 max-w-[16rem] sm:max-w-[20rem]">
		{#if optimistic}
			{#if optimistic.previewUrl && showingImage}
				<div class="relative">
					<button
						type="button"
						class="block max-h-64 w-full overflow-hidden rounded-2xl"
						aria-label="Open image"
						onclick={() =>
							optimistic.previewUrl &&
							openMediaLightbox({
								url: optimistic.previewUrl,
								filename: optimistic.filename,
								mime: optimistic.mime
							})}
					>
						<img
							src={optimistic.previewUrl}
							alt={optimistic.filename}
							class="max-h-64 w-full cursor-zoom-in object-cover"
						/>
					</button>
					{#if uploading}
						<div
							class="absolute inset-0 flex items-center justify-center rounded-2xl bg-background/40 backdrop-blur-[1px]"
						>
							<Spinner class="size-6" />
						</div>
					{/if}
				</div>
			{:else}
				<div
					class="flex items-center gap-2 rounded-xl border border-border/60 bg-background/50 px-2.5 py-2"
				>
					{#if uploading}
						<Spinner class="size-4 shrink-0" />
					{/if}
					<span class="min-w-0 flex-1 truncate text-xs">{optimistic.filename}</span>
				</div>
			{/if}
		{:else if loading}
			<div
				class="flex h-24 w-48 items-center justify-center rounded-2xl border border-dashed border-border/50"
			>
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else if resolved && resolved.mime.startsWith('image/')}
			<button
				type="button"
				class="block max-h-64 w-full overflow-hidden rounded-2xl"
				aria-label="Open image"
				onclick={() =>
					resolved &&
					openMediaLightbox({
						url: resolved.url,
						filename: resolved.filename,
						mime: resolved.mime
					})}
			>
				<img
					src={resolved.url}
					alt={ref?.alt ?? ref?.filename}
					class="max-h-64 w-full cursor-zoom-in object-cover transition-transform hover:scale-[1.02]"
				/>
			</button>
		{:else if resolved}
			<button
				type="button"
				onclick={() => {
					if (resolved) downloadObjectUrl(resolved.url, resolved.filename);
				}}
				class="flex items-center gap-2 rounded-xl border border-border/60 bg-background/50 px-2.5 py-2 transition-colors hover:bg-background"
			>
				<FileText class="size-4 shrink-0 text-muted-foreground" />
				<span class="min-w-0 flex-1 truncate text-xs">{resolved.filename}</span>
				<Download class="size-4 shrink-0 text-muted-foreground" />
			</button>
		{:else if isFailed}
			<div
				class={cn(
					'flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs',
					message.isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground'
				)}
			>
				<AlertTriangle class="size-4 shrink-0" />
				<span>Couldn't load media</span>
			</div>
		{:else}
			<button
				type="button"
				class={cn(
					'flex items-center gap-2 rounded-xl border border-dashed px-2.5 py-2 text-xs transition-colors hover:bg-background/50',
					message.isOwn
						? 'border-primary-foreground/40 text-primary-foreground/80'
						: 'border-border/50 text-muted-foreground'
				)}
				onclick={() => markMessageMediaLoaded(messageId)}
			>
				<ImageIcon class="size-4 shrink-0" />
				Load media
				{#if mediaLabel}<span class="opacity-60">{mediaLabel}</span>{/if}
			</button>
		{/if}
	</div>
{/if}

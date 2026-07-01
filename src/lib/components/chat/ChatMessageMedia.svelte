<script lang="ts">
	import { browser } from '$app/environment';
	import { Spinner } from '$lib/components/ui/spinner';
	import {
		peekMessageMedia,
		resolveMessageMedia,
		type ResolvedMedia
	} from '$lib/services/chatMediaStorage.svelte';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import Download from '@lucide/svelte/icons/download';
	import FileText from '@lucide/svelte/icons/file-text';
	import { cn } from '$lib/utils';
	import type { ChatMessage } from './chat.types';

	function downloadBlob(url: string, filename: string) {
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	/**
	 * Renders a message's media attachment. Two sources:
	 *  - Optimistic (`message.media`): the sender's just-picked file, shown from a
	 *    local plaintext preview URL with an in-item upload spinner.
	 *  - Confirmed (`imeta` in `message.tags` + stashed `mediaKeyBase64`): the
	 *    encrypted blob, fetched + decrypted lazily on mount and cached.
	 *
	 * Isolated from ChatMessageItem so the resolve/effect lifecycle doesn't weigh
	 * down the virtualized row; the storage cache (keyed by plaintext hash) makes
	 * remounts cheap.
	 */
	let { message }: { message: ChatMessage } = $props();

	const optimistic = $derived(message.media);
	const ref = $derived(message.tags ? peekMessageMedia(message.tags) : null);

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
		loading = true;
		failed = false;
		let cancelled = false;
		resolveMessageMedia({
			messageId: message.eventId,
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
</script>

{#if hasMedia}
	<div class="mb-2 max-w-[16rem] sm:max-w-[20rem]">
		{#if optimistic}
			{#if optimistic.previewUrl && showingImage}
				<div class="relative">
					<img
						src={optimistic.previewUrl}
						alt={optimistic.filename}
						class="max-h-64 w-full rounded-2xl object-cover"
					/>
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
			<img
				src={resolved.url}
				alt={ref?.alt ?? ref?.filename}
				class="max-h-64 w-full rounded-2xl object-cover"
			/>
		{:else if resolved}
			<button
				type="button"
				onclick={() => {
					if (resolved) downloadBlob(resolved.url, resolved.filename);
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
		{/if}
	</div>
{/if}

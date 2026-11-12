<script lang="ts">
	import type { EmojiPack } from '$lib/chat/emoji';
	import {
		emojiProbeState,
		packProbeUrl,
		probeEmojiUrl
	} from '$lib/services/emojiPackProbe.svelte';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import { isNativePlatform } from '$lib/services/nativeShims';

	/**
	 * Whether this device can read a pack's pictures for encrypted sending.
	 *
	 * One probe per host, and only once the card is on screen: a discovery search
	 * that returns 24 packs costs nothing until their cards are looked at, and 30
	 * emoji sharing a host cost one request rather than 30. A passing probe says
	 * nothing (a card that works needs no badge); a failing one says so, because
	 * silently turning `:name:` into text at send time is the surprise this
	 * prevents.
	 */
	let { pack }: { pack: EmojiPack } = $props();

	const probeUrl = $derived(packProbeUrl(pack));
	const probeState = $derived(probeUrl ? emojiProbeState(probeUrl) : undefined);
	let visible = $state(false);

	$effect(() => {
		if (visible && probeUrl) probeEmojiUrl(probeUrl);
	});

	function observe(node: HTMLElement) {
		if (typeof IntersectionObserver === 'undefined') {
			visible = true;
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				visible = true;
				observer.disconnect();
			}
		});
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}
</script>

<span use:observe class="inline-flex items-center">
	{#if probeState === 'failed'}
		<button
			type="button"
			class="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
			title={isNativePlatform()
				? 'This host could not be read from here, so sending one of its emoji is held back. Saving one to your collection from the lightbox keeps it locally, and that copy sends.'
				: 'This host blocks browser downloads, so its emoji can be shown but not sent as encrypted pictures from the web app. Adding one to your collection from the lightbox saves it locally so it can be sent.'}
			onclick={() => probeEmojiUrl(probeUrl, { force: true })}
		>
			<AlertTriangle class="size-3" />
			<span>Can’t be sent</span>
		</button>
	{:else if probeState === 'checking'}
		<span class="text-[11px] text-muted-foreground">Checking…</span>
	{/if}
</span>

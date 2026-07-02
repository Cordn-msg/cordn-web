<script lang="ts">
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVER } from '$lib/constants/chat';
	import {
		getBlossomServer,
		setBlossomServer,
		isCustomBlossomServer,
		getMediaAutoLoad,
		setMediaAutoLoad,
		getLoadAvatars,
		setLoadAvatars
	} from '$lib/services/chatMediaStorage.svelte';
	import Images from '@lucide/svelte/icons/images';
	import ImageIcon from '@lucide/svelte/icons/image';

	// A "Custom…" sentinel option value; selecting it reveals the URL input.
	const CUSTOM = '__custom__';

	let current = $state(getBlossomServer());
	let customUrl = $state(isCustomBlossomServer() ? getBlossomServer() : '');

	const selectedOption = $derived(
		BLOSSOM_SERVERS.includes(current as (typeof BLOSSOM_SERVERS)[number])
			? (current as string)
			: CUSTOM
	);

	function handleSelect(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		if (value === CUSTOM) {
			current = isCustomBlossomServer() ? getBlossomServer() : '';
		} else {
			current = value;
			setBlossomServer(value);
		}
	}

	function commitCustom() {
		if (customUrl.trim()) setBlossomServer(customUrl);
	}

	// Display toggles. Local $state mirrors the persisted module state; the
	// $effect writes back on change so the global flags flip live for every
	// mounted ChatMessageMedia / ProfileCard / InlineMediaUrl.
	let autoLoad = $state(getMediaAutoLoad());
	let loadAv = $state(getLoadAvatars());
	$effect(() => setMediaAutoLoad(autoLoad));
	$effect(() => setLoadAvatars(loadAv));
</script>

<svelte:head>
	<title>Media | Cordn</title>
	<meta
		name="description"
		content="Configure the Blossom server used for encrypted media uploads."
	/>
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Images class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">Media</h1>
				<p class="text-sm text-muted-foreground">
					Blossom server used to store the encrypted media you send.
				</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto max-w-2xl space-y-6">
			<Card.Root>
				<Card.Header>
					<Card.Title>Upload server</Card.Title>
					<Card.Description>
						Receivers follow the URL embedded in each message, so this only affects your own uploads
						— not what you can read.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<div class="space-y-4">
						<div class="space-y-2">
							<Label for="blossom-server">Server</Label>
							<div class="relative">
								<span
									class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
								>
									<ImageIcon class="size-4" />
								</span>
								<!-- ponytail: native <select> over a select component — one setting, no dep. -->
								<select
									id="blossom-server"
									class="h-10 w-full appearance-none rounded-md border border-input bg-background pr-3 pl-9 text-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
									value={selectedOption}
									onchange={handleSelect}
								>
									{#each BLOSSOM_SERVERS as server (server)}
										<option value={server}>{server}</option>
									{/each}
									<option value={CUSTOM}>Custom…</option>
								</select>
							</div>
						</div>

						{#if selectedOption === CUSTOM}
							<div class="space-y-2">
								<Label for="blossom-custom">Custom server URL</Label>
								<Input
									id="blossom-custom"
									bind:value={customUrl}
									placeholder="https://your-blossom-server.example/"
									onblur={commitCustom}
									onkeydown={(e) => e.key === 'Enter' && commitCustom()}
								/>
								<p class="text-xs text-muted-foreground">
									Defaults to {DEFAULT_BLOSSOM_SERVER} when left blank.
								</p>
							</div>
						{/if}
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Display</Card.Title>
					<Card.Description>Fetch media automatically, or load each item on tap.</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="flex items-center justify-between rounded-lg border border-border p-3">
						<div>
							<p class="text-sm font-medium">Auto-load media</p>
							<p class="text-xs text-muted-foreground">
								Off shows a “Load media” button on each image and video instead of fetching it.
							</p>
						</div>
						<Switch bind:checked={autoLoad} aria-label="Auto-load media" />
					</div>
					<div class="flex items-center justify-between rounded-lg border border-border p-3">
						<div>
							<p class="text-sm font-medium">Load avatars &amp; banners</p>
							<p class="text-xs text-muted-foreground">
								Off hides profile pictures and banners behind the default colored avatar.
							</p>
						</div>
						<Switch bind:checked={loadAv} aria-label="Load avatars and banners" />
					</div>
				</Card.Content>
			</Card.Root>
		</div>
	</div>
</div>

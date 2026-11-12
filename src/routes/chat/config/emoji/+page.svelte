<script lang="ts">
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import EmojiPackPreview from '$lib/components/chat/EmojiPackPreview.svelte';
	import EmojiPackCompatibility from '$lib/components/chat/EmojiPackCompatibility.svelte';
	import CustomEmoji from '$lib/components/chat/CustomEmoji.svelte';
	import PublishedEmojiPacks from '$lib/components/chat/PublishedEmojiPacks.svelte';
	import {
		ensureEmojiCollectionLoaded,
		listEmojiCollection,
		removeEmojiCollectionItem
	} from '$lib/services/chatEmojiCollection.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import {
		EMOJI_PACK_ERRORS,
		addEmojiPack,
		addEmojiPackSnapshot,
		fetchEmojiPack,
		listEmojiPacks,
		removeEmojiPack
	} from '$lib/services/chatEmojiPacks.svelte';
	import { emojiPackNaddr, parseEmojiSetAddress, type EmojiPack } from '$lib/chat/emoji';
	import { packProbeRank } from '$lib/services/emojiPackProbe.svelte';
	import { MESSAGE_AUTHOR_CHIP_CLASS } from '$lib/chat/messageTextClasses';
	import {
		EMOJI_DISCOVERY_RELAY_OPTIONS,
		getEmojiDiscoveryRelays,
		searchEmojiPacks,
		setEmojiDiscoveryRelays
	} from '$lib/services/chatEmojiDiscovery';
	import { cn, copyToClipboard } from '$lib/utils';
	import Smile from '@lucide/svelte/icons/smile';
	import Copy from '@lucide/svelte/icons/copy';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Search from '@lucide/svelte/icons/search';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';

	// Packs whose host is known to refuse this browser go last: they can be
	// looked at but not sent, so they should not lead the list.
	const packs = $derived([...listEmojiPacks()].sort((a, b) => packProbeRank(a) - packProbeRank(b)));
	const collection = $derived(listEmojiCollection());
	$effect(() => {
		void ensureEmojiCollectionLoaded();
	});
	const authorChipClass = cn(MESSAGE_AUTHOR_CHIP_CLASS, 'bg-muted text-foreground');
	let input = $state('');
	let busy = $state(false);
	let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let preview = $state<EmojiPack | null>(null);
	let previewFor = $state('');
	const previewMatches = $derived(preview !== null && previewFor === input.trim());

	function handleInput() {
		preview = null;
		previewFor = '';
		message = null;
	}

	async function previewPack() {
		const requested = input.trim();
		if (busy || !requested) return;
		busy = true;
		message = null;
		const result = await fetchEmojiPack(requested);
		busy = false;
		// The address may have changed while the relays answered; drop the reply.
		if (input.trim() !== requested) return;
		if ('error' in result) {
			preview = null;
			previewFor = '';
			message = { kind: 'error', text: EMOJI_PACK_ERRORS[result.error] };
			return;
		}
		preview = result.pack;
		previewFor = requested;
	}

	async function add() {
		const requested = input.trim();
		if (busy || !requested) return;
		busy = true;
		message = null;
		const result =
			previewMatches && preview ? addEmojiPackSnapshot(preview) : await addEmojiPack(requested);
		busy = false;
		if ('error' in result) {
			message = { kind: 'error', text: EMOJI_PACK_ERRORS[result.error] };
			return;
		}
		if (input.trim() === requested) input = '';
		preview = null;
		previewFor = '';
		message = { kind: 'ok', text: `Added ${result.pack.title}.` };
	}

	function remove(coordinate: string, title: string) {
		removeEmojiPack(coordinate);
		message = { kind: 'ok', text: `Removed ${title}.` };
	}

	async function copyPack(pack: EmojiPack) {
		await copyToClipboard(emojiPackNaddr(pack));
	}

	const DISCOVERY_RESULT_LIMIT = 24;
	const discoveryRelayOptions = EMOJI_DISCOVERY_RELAY_OPTIONS;
	const addedCoordinates = $derived(new Set(packs.map((pack) => pack.coordinate)));
	let discoveryRelays = $state(getEmojiDiscoveryRelays());
	let discovering = $state(false);
	let discovered = $state<EmojiPack[]>([]);
	let discoveryQuery = $state('');
	let discoveryMessage = $state<{ kind: 'ok' | 'empty' | 'error'; text: string } | null>(null);
	const filteredDiscovered = $derived.by(() => {
		const needle = discoveryQuery.trim().toLowerCase();
		if (!needle) return discovered;
		return discovered.filter(
			(pack) =>
				pack.title.toLowerCase().includes(needle) ||
				pack.emoji.some((emoji) => emoji.name.toLowerCase().includes(needle))
		);
	});
	const visibleDiscovered = $derived(
		filteredDiscovered
			.slice(0, DISCOVERY_RESULT_LIMIT)
			.sort((a, b) => packProbeRank(a) - packProbeRank(b))
	);
	const discoveryResultLabel = $derived.by(() => {
		const shown = visibleDiscovered.length;
		if (discoveryQuery.trim()) {
			const found = filteredDiscovered.length;
			return `${shown} of ${found} match${found === 1 ? '' : 'es'}`;
		}
		return discovered.length > shown
			? `${shown} of ${discovered.length} packs`
			: `${shown} pack${shown === 1 ? '' : 's'}`;
	});

	function toggleDiscoveryRelay(relay: string) {
		const next = discoveryRelays.includes(relay)
			? discoveryRelays.filter((candidate) => candidate !== relay)
			: [...discoveryRelays, relay];
		discoveryRelays = next;
		setEmojiDiscoveryRelays(next);
		discovered = [];
		discoveryQuery = '';
		discoveryMessage = null;
		// A request already in flight belongs to the old selection; let a new search run.
		discovering = false;
	}

	async function discover() {
		if (discovering || discoveryRelays.length === 0) return;
		const selected = discoveryRelays;
		discovering = true;
		discovered = [];
		discoveryQuery = '';
		discoveryMessage = null;
		try {
			const found = await searchEmojiPacks(selected);
			if (discoveryRelays !== selected) return;
			discovered = found;
			if (found.length === 0) {
				discoveryMessage = { kind: 'empty', text: 'No emoji packs found on those relays.' };
			}
		} catch {
			if (discoveryRelays !== selected) return;
			discovered = [];
			discoveryMessage = { kind: 'error', text: 'Could not search those relays. Try again.' };
		} finally {
			if (discoveryRelays === selected) discovering = false;
		}
	}

	function addDiscovered(pack: EmojiPack) {
		const result = addEmojiPackSnapshot(pack);
		if ('error' in result) {
			discoveryMessage = { kind: 'error', text: EMOJI_PACK_ERRORS[result.error] };
			return;
		}
		discoveryMessage = { kind: 'ok', text: `Added ${result.pack.title}.` };
	}
</script>

<svelte:head>
	<meta name="description" content="Add NIP-30 custom emoji packs to Cordn." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Smile class="size-4" />
			</div>
			<div class="min-w-0">
				<h1 class="text-lg font-semibold tracking-tight">Emoji packs</h1>
				<p class="truncate text-sm text-muted-foreground">
					Custom emoji from NIP-30 sets, shared with Staircase.
				</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto max-w-2xl space-y-6">
			<Card.Root>
				<Card.Header>
					<Card.Title>Add a pack</Card.Title>
					<Card.Description>
						Paste an <code class="text-xs">naddr1…</code> or
						<code class="text-xs">30030:&lt;pubkey&gt;:&lt;d&gt;</code> from another Cordn client.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-3">
					<div class="flex flex-wrap gap-2">
						<Input
							bind:value={input}
							placeholder="naddr1… or 30030:…"
							aria-label="Emoji pack address"
							class="min-w-0 flex-1"
							oninput={handleInput}
							onkeydown={(event) => event.key === 'Enter' && void add()}
						/>
						<Button
							type="button"
							variant="outline"
							disabled={busy || !input.trim()}
							onclick={() => void previewPack()}
						>
							Preview
						</Button>
						<Button type="button" disabled={busy || !input.trim()} onclick={() => void add()}>
							{busy ? 'Working…' : 'Add'}
						</Button>
					</div>
					{#if previewMatches && preview}
						<div class="space-y-3 rounded-xl border border-border bg-card/50 p-3">
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{preview.title}</p>
									<p class="text-xs text-muted-foreground">{preview.emoji.length} emoji</p>
								</div>
								<Button type="button" size="sm" disabled={busy} onclick={() => void add()}>
									Add pack
								</Button>
							</div>
							<EmojiPackPreview pack={preview} gateAutoLoad={false} />
						</div>
					{/if}
					{#if message}
						<p
							class="text-sm {message.kind === 'error'
								? 'text-destructive'
								: 'text-muted-foreground'}"
						>
							{message.text}
						</p>
					{/if}
					<p class="text-xs text-muted-foreground">
						Packs are kept on this device. The pack's host is contacted only when its pictures are
						shown or sent.
					</p>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="min-w-0">
							<Card.Title>Discover packs</Card.Title>
							<Card.Description
								>Search recent NIP-30 sets on the relays you choose.</Card.Description
							>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} type="button" variant="outline" size="sm" class="gap-1.5">
											<span
												>{discoveryRelays.length} relay{discoveryRelays.length === 1
													? ''
													: 's'}</span
											>
											<ChevronDown class="size-3.5" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-72">
									{#each discoveryRelayOptions as relay (relay)}
										<DropdownMenu.Item
											onSelect={(event) => {
												event.preventDefault();
												toggleDiscoveryRelay(relay);
											}}
											class="gap-2"
										>
											<Check class="size-4 {discoveryRelays.includes(relay) ? '' : 'opacity-0'}" />
											<span class="truncate">{relay}</span>
										</DropdownMenu.Item>
									{/each}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
							<Button
								type="button"
								size="sm"
								disabled={discovering || discoveryRelays.length === 0}
								onclick={() => void discover()}
							>
								{#if discovering}<Spinner class="size-3.5" />{:else}<Search class="size-3.5" />{/if}
								{discovering ? 'Searching…' : 'Search'}
							</Button>
						</div>
					</div>
				</Card.Header>
				<Card.Content class="space-y-3">
					{#if discovered.length > 0}
						<Input
							bind:value={discoveryQuery}
							type="search"
							placeholder="Filter by pack or emoji…"
							aria-label="Filter emoji packs"
						/>
						<p class="text-xs text-muted-foreground">{discoveryResultLabel}</p>
						{#if visibleDiscovered.length > 0}
							<div class="space-y-2">
								{#each visibleDiscovered as pack (pack.coordinate)}
									<div class="space-y-2 rounded-xl border border-border p-3">
										<div class="flex items-center justify-between gap-3">
											<div class="min-w-0">
												<p class="truncate text-sm font-medium">{pack.title}</p>
												<p class="text-xs text-muted-foreground">
													{pack.emoji.length} emoji
												</p>
												<EmojiPackCompatibility {pack} />
											</div>
											{#if addedCoordinates.has(pack.coordinate)}
												<Button type="button" variant="outline" size="sm" disabled>Added</Button>
											{:else}
												<Button
													type="button"
													variant="outline"
													size="sm"
													onclick={() => addDiscovered(pack)}
												>
													Add
												</Button>
											{/if}
										</div>
										<EmojiPackPreview {pack} limit={4} gateAutoLoad={false} />
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-xs text-muted-foreground">
								No packs match “{discoveryQuery}”.
							</p>
						{/if}
					{:else if !discovering && !discoveryMessage}
						<p class="text-xs text-muted-foreground">Choose relays and search for packs.</p>
					{/if}
					{#if discoveryMessage}
						<p
							class="text-sm {discoveryMessage.kind === 'error'
								? 'text-destructive'
								: 'text-muted-foreground'}"
						>
							{discoveryMessage.text}
						</p>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>My collection</Card.Title>
					<Card.Description>
						Pictures you saved from a chat with “Add to collection”. They are kept on this device,
						so sending one never asks the host it came from.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-3">
					{#if collection.length === 0}
						<p class="text-sm text-muted-foreground">
							Open any image or custom emoji in the lightbox and tap the smiley button to save it
							here.
						</p>
					{:else}
						<div class="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
							{#each collection as item (item.id)}
								<div
									class="flex min-w-0 flex-col items-center gap-1 rounded-xl border border-border bg-card p-2"
								>
									<CustomEmoji
										display={{ name: item.name, url: item.url }}
										gateAutoLoad={false}
										sizeClass="size-8"
									/>
									<span class="w-full truncate text-center text-[11px] text-muted-foreground">
										{item.name}
									</span>
									<button
										type="button"
										class="text-[10px] text-muted-foreground underline hover:text-destructive"
										aria-label={`Remove :${item.name}: from your collection`}
										onclick={() => void removeEmojiCollectionItem(item.id)}
									>
										Remove
									</button>
								</div>
							{/each}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			{#if $activeAccount}
				{#key $activeAccount.pubkey}
					<PublishedEmojiPacks pubkey={$activeAccount.pubkey} />
				{/key}
			{/if}

			{#if packs.length === 0}
				<Card.Root>
					<Card.Content class="py-8 text-center text-sm text-muted-foreground">
						No packs yet. Add a NIP-30 emoji set to use its shortcodes in messages and reactions.
					</Card.Content>
				</Card.Root>
			{:else}
				<div class="space-y-3">
					{#each packs as pack (pack.coordinate)}
						{@const author = parseEmojiSetAddress(pack.coordinate)?.pubkey}
						<Card.Root>
							<Card.Header>
								<div class="min-w-0">
									<Card.Title class="truncate">{pack.title}</Card.Title>
									<div
										class="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground"
									>
										<span>{pack.emoji.length} emoji</span>
										<EmojiPackCompatibility {pack} />
										{#if author}
											<span class={authorChipClass}>
												<ProfileCard
													pubkey={author}
													mode="inline"
													showInlineAvatar={true}
													profileLink={false}
												/>
											</span>
										{/if}
									</div>
								</div>
								<Card.Action class="flex items-center gap-1">
									<DropdownMenu.Root>
										<DropdownMenu.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													type="button"
													variant="ghost"
													size="icon-sm"
													class="rounded-lg text-muted-foreground"
													aria-label={`Actions for ${pack.title}`}
													title={`Actions for ${pack.title}`}
												>
													<EllipsisVertical class="size-4" />
												</Button>
											{/snippet}
										</DropdownMenu.Trigger>
										<DropdownMenu.Content align="end" class="w-44">
											<DropdownMenu.Item onclick={() => void copyPack(pack)} class="gap-2">
												<Copy class="size-4" />
												<span>Copy naddr</span>
											</DropdownMenu.Item>
											<DropdownMenu.Item
												onclick={() => remove(pack.coordinate, pack.title)}
												class="gap-2 text-destructive data-[highlighted]:text-destructive"
											>
												<Trash2 class="size-4" />
												<span>Remove pack</span>
											</DropdownMenu.Item>
										</DropdownMenu.Content>
									</DropdownMenu.Root>
								</Card.Action>
							</Card.Header>
							<Card.Content>
								<EmojiPackPreview {pack} gateAutoLoad={false} />
							</Card.Content>
						</Card.Root>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

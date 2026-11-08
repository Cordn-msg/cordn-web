<script lang="ts">
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import CustomEmoji from '$lib/components/chat/CustomEmoji.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		addEmojiPack,
		listEmojiPacks,
		removeEmojiPack
	} from '$lib/services/chatEmojiPacks.svelte';
	import Smile from '@lucide/svelte/icons/smile';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	const packs = $derived(listEmojiPacks());
	let input = $state('');
	let busy = $state(false);
	let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	const errors = {
		address: 'Paste an naddr or a 30030: coordinate.',
		exists: 'That pack is already added.',
		full: 'You have reached the pack limit. Remove one first.',
		missing: 'The pack could not be found on the relays.',
		'signed-out': 'Log in to add emoji packs.'
	} as const;

	async function add() {
		if (busy || !input.trim()) return;
		busy = true;
		message = null;
		const result = await addEmojiPack(input);
		busy = false;
		if ('error' in result) {
			message = { kind: 'error', text: errors[result.error] };
			return;
		}
		input = '';
		message = { kind: 'ok', text: `Added ${result.pack.title}.` };
	}

	function remove(coordinate: string, title: string) {
		removeEmojiPack(coordinate);
		message = { kind: 'ok', text: `Removed ${title}.` };
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
					<div class="flex gap-2">
						<Input
							bind:value={input}
							placeholder="naddr1… or 30030:…"
							aria-label="Emoji pack address"
							onkeydown={(event) => event.key === 'Enter' && void add()}
						/>
						<Button type="button" disabled={busy || !input.trim()} onclick={() => void add()}>
							{busy ? 'Adding…' : 'Add'}
						</Button>
					</div>
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
						shown.
					</p>
				</Card.Content>
			</Card.Root>

			{#if packs.length === 0}
				<Card.Root>
					<Card.Content class="py-8 text-center text-sm text-muted-foreground">
						No packs yet. Add a NIP-30 emoji set to use its shortcodes in messages and reactions.
					</Card.Content>
				</Card.Root>
			{:else}
				<div class="space-y-3">
					{#each packs as pack (pack.coordinate)}
						<Card.Root>
							<Card.Header class="flex-row items-start justify-between gap-3">
								<div class="min-w-0">
									<Card.Title class="truncate">{pack.title}</Card.Title>
									<Card.Description class="truncate">
										{pack.emoji.length} emoji · {pack.coordinate}
									</Card.Description>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									class="shrink-0 text-muted-foreground"
									aria-label={`Remove ${pack.title}`}
									title={`Remove ${pack.title}`}
									onclick={() => remove(pack.coordinate, pack.title)}
								>
									<Trash2 class="size-4" />
								</Button>
							</Card.Header>
							<Card.Content>
								<div class="flex flex-wrap gap-2">
									{#each pack.emoji.slice(0, 16) as emoji (emoji.name)}
										<span
											class="flex size-10 items-center justify-center rounded-lg border border-border bg-card"
											title={`:${emoji.name}:`}
										>
											<CustomEmoji
												display={{ name: emoji.name, url: emoji.url }}
												sizeClass="size-7"
											/>
										</span>
									{/each}
								</div>
							</Card.Content>
						</Card.Root>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

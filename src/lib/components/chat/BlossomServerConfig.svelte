<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import ImageIcon from '@lucide/svelte/icons/image';
	import { BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVER } from '$lib/constants/chat';
	import {
		getBlossomServer,
		setBlossomServer,
		isCustomBlossomServer
	} from '$lib/services/chatMediaStorage.svelte';

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
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Media</Card.Title>
		<Card.Description>
			Blossom server used to store encrypted media (images, documents) you send. Receivers follow
			the URL stored in each message, so this only affects uploads.
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

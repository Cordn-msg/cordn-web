<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { matchesProfileSearch } from '$lib/components/chat/profileSearch';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import X from '@lucide/svelte/icons/x';

	type SelectOption = {
		pubkey: string;
		label?: string;
		description?: string;
		disabled?: boolean;
	};

	let {
		label,
		placeholder = 'Search people…',
		emptyLabel = 'No results',
		helperText = '',
		options = [],
		selectedPubkeys = $bindable([]),
		showRawPubkey = false
	}: {
		label: string;
		placeholder?: string;
		emptyLabel?: string;
		helperText?: string;
		options?: SelectOption[];
		selectedPubkeys?: string[];
		showRawPubkey?: boolean;
	} = $props();

	let search = $state('');

	// Load profile metadata for the option pubkeys so search matches names, not
	// just pubkeys/refs. Fetch only while a search is active (mirrors
	// AvailableKeyPackageDirectory); rows still load names lazily for display.
	const profileHints = useProfileHints(
		() => (search.trim() ? options.map((option) => option.pubkey) : []),
		{ relays: metadataRelays }
	);

	const selectedSet = $derived.by(() => new Set(selectedPubkeys));
	const selectedOptions = $derived.by(() =>
		selectedPubkeys
			.map((pubkey) => options.find((option) => option.pubkey === pubkey))
			.filter((option): option is SelectOption => Boolean(option))
	);
	const filteredOptions = $derived.by(() =>
		options.filter((option) => {
			if (selectedSet.has(option.pubkey)) return false;
			return matchesProfileSearch({
				pubkey: option.pubkey,
				profileHints,
				search,
				extraFields: [option.label, option.description]
			});
		})
	);

	function add(pubkey: string) {
		if (selectedSet.has(pubkey)) return;
		selectedPubkeys = [...selectedPubkeys, pubkey];
		search = '';
	}

	function remove(pubkey: string) {
		selectedPubkeys = selectedPubkeys.filter((value) => value !== pubkey);
	}
</script>

<div class="space-y-3 rounded-2xl border border-border p-4">
	<div class="flex items-center justify-between gap-3">
		<div>
			<p class="text-sm font-medium">{label}</p>
			{#if helperText}
				<p class="text-xs text-muted-foreground">{helperText}</p>
			{/if}
		</div>
		{#if selectedPubkeys.length > 0}
			<span class="text-xs text-muted-foreground">{selectedPubkeys.length} selected</span>
		{/if}
	</div>

	{#if selectedOptions.length > 0}
		<div class="flex flex-wrap gap-2">
			{#each selectedOptions as option (option.pubkey)}
				<div
					class="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-2 py-1.5"
				>
					<ProfileCard
						pubkey={option.pubkey}
						mode="inline"
						showInlineAvatar={true}
						profileLink={false}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-6 w-6 rounded-full"
						onclick={() => remove(option.pubkey)}
						aria-label={`Remove ${option.label ?? option.pubkey}`}
					>
						<X class="size-3.5" />
					</Button>
				</div>
			{/each}
		</div>
	{/if}

	<Input bind:value={search} {placeholder} />

	<div class="max-h-72 space-y-2 overflow-y-auto">
		{#if filteredOptions.length === 0}
			<div
				class="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
			>
				{emptyLabel}
			</div>
		{:else}
			{#each filteredOptions as option (option.pubkey)}
				<button
					type="button"
					class="flex w-full items-center gap-3 rounded-xl border border-border px-3 py-3 text-left transition hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
					disabled={option.disabled}
					onclick={() => add(option.pubkey)}
				>
					<div class="min-w-0 flex-1">
						<ProfileCard pubkey={option.pubkey} mode="compact" profileLink={false} />
						{#if option.description}
							<p class="mt-1 truncate text-xs text-muted-foreground">{option.description}</p>
						{/if}
						{#if showRawPubkey}
							<p class="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">
								{option.pubkey}
							</p>
						{/if}
					</div>
				</button>
			{/each}
		{/if}
	</div>
</div>

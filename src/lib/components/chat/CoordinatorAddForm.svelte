<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card';
	import * as InputGroup from '$lib/components/ui/input-group';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Button } from '$lib/components/ui/button';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getChatCoordinator, upsertChatCoordinator } from '$lib/services/chatCoordinators.svelte';
	import { decodeCoordinatorQueryParam } from '$lib/utils/groupShareLink';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	// ponytail: seed from URL once at mount (c/r/label/color/default). The `c`
	// convention matches group-share links; reactively seeding a textarea would
	// clobber manual edits, so a one-shot read is the correct minimal model.
	let identifier = $state(page.url.searchParams.get('c') ?? '');
	let label = $state(page.url.searchParams.get('label') ?? '');
	let color = $state(page.url.searchParams.get('color') ?? '');
	let isDefault = $state(page.url.searchParams.get('default') === 'true');
	let relays = $state(
		(page.url.searchParams.get('r') ?? '')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.join('\n')
	);
	let advancedOpen = $state(false);
	let error = $state('');

	const parsedIdentifier = $derived.by(() => {
		const value = identifier.trim();
		return value ? decodeCoordinatorQueryParam(value) : null;
	});
	const existing = $derived(
		parsedIdentifier ? getChatCoordinator(parsedIdentifier.coordinatorKey) : undefined
	);

	// Sync relays from a pasted nprofile. Manual edits are inherently safe:
	// this effect's only dependency is parsedIdentifier, so it re-runs only when
	// the identifier changes (a fresh paste), never when the user edits relays.
	$effect(() => {
		const parsed = parsedIdentifier;
		if (parsed?.relays?.length) {
			relays = parsed.relays.join('\n');
		}
	});
	// Auto-reveal the relay/color section when the identifier resolves a key but
	// carries no relay hints (hex / npub / nprofile-without-relays) — that's the
	// "you probably want to add relays" nudge. Only ever opens, never closes, so
	// manual toggles survive.
	$effect(() => {
		const parsed = parsedIdentifier;
		if (parsed && !parsed.relays?.length) advancedOpen = true;
	});

	function parseRelayList(value: string): string[] {
		return value
			.split(/[,\n]/)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	async function handleSubmit(event: Event) {
		event.preventDefault();
		const parsed = parsedIdentifier;
		if (!parsed) {
			error = 'Enter a valid hex pubkey, npub, or nprofile.';
			return;
		}
		try {
			error = '';
			upsertChatCoordinator({
				pubkey: parsed.coordinatorKey,
				label,
				relays: parseRelayList(relays),
				isDefault,
				color
			});
			identifier = '';
			label = '';
			relays = '';
			color = '';
			isDefault = false;
			// Clear any prefill params so a reload doesn't re-trigger the form.
			if (page.url.search) {
				await goto(page.url.pathname, {
					replaceState: true,
					keepFocus: true,
					noScroll: true
				});
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save coordinator';
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Add coordinator</Card.Title>
		<Card.Description>
			Paste a hex pubkey, npub, or nprofile. nprofile carries relay hints automatically.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if !$activeAccount}
			<div class="space-y-3">
				<p class="text-sm text-muted-foreground">Log in to manage local coordinator settings.</p>
				<AccountLoginDialog />
			</div>
		{:else}
			<form class="space-y-4" onsubmit={handleSubmit}>
				<InputGroup.Root>
					<InputGroup.Input
						bind:value={identifier}
						class="font-mono text-xs"
						placeholder="hex / npub / nprofile"
						autocomplete="off"
						spellcheck={false}
					/>
					<InputGroup.Addon>
						<InputGroup.Text>Identifier</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>

				{#if identifier.trim() && !parsedIdentifier}
					<p class="text-xs text-destructive">Not a valid hex pubkey, npub, or nprofile.</p>
				{:else if parsedIdentifier}
					<p class="text-xs text-muted-foreground">
						Resolved: <span class="font-mono">{parsedIdentifier.coordinatorKey.slice(0, 16)}…</span>
					</p>
				{/if}

				{#if existing}
					<p
						class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
					>
						Already saved as “{existing.label}”. Saving will update it.
					</p>
				{/if}

				<InputGroup.Root>
					<InputGroup.Input bind:value={label} placeholder="Local label (optional)" />
					<InputGroup.Addon>
						<InputGroup.Text>Label</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>

				<Collapsible.Root bind:open={advancedOpen}>
					<Collapsible.Trigger
						class="flex w-full items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						Advanced
						<ChevronDown
							class={`size-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
						/>
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="mt-3 space-y-4">
							<InputGroup.Root>
								<InputGroup.Textarea
									bind:value={relays}
									class="min-h-24 font-mono text-xs"
									placeholder="wss://relay.example.org (one per line)"
								/>
								<InputGroup.Addon align="block-start">
									<InputGroup.Text>Relays</InputGroup.Text>
								</InputGroup.Addon>
							</InputGroup.Root>

							<InputGroup.Root>
								<InputGroup.Input
									bind:value={color}
									placeholder="#a1b2c3 (optional override)"
									class="font-mono text-xs"
								/>
								<InputGroup.Addon>
									<InputGroup.Text>Color</InputGroup.Text>
								</InputGroup.Addon>
							</InputGroup.Root>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<label class="flex items-center gap-2 text-sm text-muted-foreground">
					<input bind:checked={isDefault} type="checkbox" class="h-4 w-4 rounded border-border" />
					Set as default coordinator
				</label>

				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}

				<div class="flex justify-end">
					<Button type="submit" disabled={!parsedIdentifier}>Save coordinator</Button>
				</div>
			</form>
		{/if}
	</Card.Content>
</Card.Root>

<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		clearChatPetname,
		getChatPetname,
		setChatPetname
	} from '$lib/services/chatPetnames.svelte';

	/**
	 * Local name ("petname") editor for somebody else's profile. Device-local on
	 * purpose: it is the account holder's own label, never published, and it
	 * keeps working for profiles with no metadata (where the app would otherwise
	 * only ever show an npub).
	 */
	let { pubkey }: { pubkey: string } = $props();

	// Seeded at init (no first-paint flash of the placeholder) and re-seeded only
	// when the editor switches subject; a save must not clobber what is being typed.
	let draft = $state(untrack(() => getChatPetname(pubkey) ?? ''));
	let seededFor = untrack(() => pubkey);
	const saved = $derived(getChatPetname(pubkey) ?? '');

	$effect(() => {
		if (seededFor === pubkey) return;
		seededFor = pubkey;
		draft = getChatPetname(pubkey) ?? '';
	});

	const normalizedDraft = $derived(draft.replace(/\s+/g, ' ').trim());
	const dirty = $derived(normalizedDraft !== saved);

	function save(event: Event) {
		event.preventDefault();
		if (!dirty) return;
		if (normalizedDraft) setChatPetname(pubkey, normalizedDraft);
		else clearChatPetname(pubkey);
		draft = normalizedDraft;
	}

	function remove() {
		clearChatPetname(pubkey);
		draft = '';
	}
</script>

<form
	class="w-full max-w-sm space-y-2 rounded-xl border border-border bg-card/40 p-3"
	onsubmit={save}
>
	<p class="text-xs text-muted-foreground">
		Petname
		<span class="text-muted-foreground/80">— only you see this, on this device.</span>
	</p>
	<div class="flex items-center gap-2">
		<Input
			bind:value={draft}
			maxlength={64}
			placeholder="A name you will recognize"
			aria-label="Your petname for this profile"
		/>
		<Button type="submit" size="sm" disabled={!dirty}>{saved ? 'Update' : 'Save'}</Button>
		{#if saved}
			<Button type="button" size="sm" variant="ghost" onclick={remove}>Remove</Button>
		{/if}
	</div>
</form>

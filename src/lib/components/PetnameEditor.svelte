<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as InputGroup from '$lib/components/ui/input-group';
	import {
		clearChatPetname,
		getChatPetname,
		setChatPetname
	} from '$lib/services/chatPetnames.svelte';

	/**
	 * Local name ("petname") editor for somebody else's profile, shown only while
	 * editing — the same transient form the self-profile editor uses. Device-local
	 * on purpose: it is the account holder's own label, never published, and it
	 * keeps working for profiles with no metadata (where the app would otherwise
	 * only ever show an npub).
	 */
	let { pubkey, onClose }: { pubkey: string; onClose: () => void } = $props();

	// Seeded at open (no first-paint flash of the placeholder).
	let draft = $state(untrack(() => getChatPetname(pubkey) ?? ''));
	const saved = $derived(getChatPetname(pubkey) ?? '');
	const normalizedDraft = $derived(draft.replace(/\s+/g, ' ').trim());
	const dirty = $derived(normalizedDraft !== saved);

	function save(event: Event) {
		event.preventDefault();
		if (!dirty) return;
		if (normalizedDraft) setChatPetname(pubkey, normalizedDraft);
		else clearChatPetname(pubkey);
		onClose();
	}

	function remove() {
		clearChatPetname(pubkey);
		onClose();
	}
</script>

<form class="space-y-4" onsubmit={save}>
	<InputGroup.Root>
		<InputGroup.Input
			bind:value={draft}
			maxlength={64}
			placeholder="A name you will recognize"
			aria-label="Your petname for this profile"
		/>
		<InputGroup.Addon>
			<InputGroup.Text>Petname</InputGroup.Text>
		</InputGroup.Addon>
	</InputGroup.Root>

	<p class="text-sm text-muted-foreground">
		Only you see this name, on this device. It is never published or synced.
	</p>

	<div class="flex flex-wrap items-center justify-end gap-2">
		{#if saved}
			<Button type="button" variant="ghost" class="mr-auto" onclick={remove}>Remove</Button>
		{/if}
		<Button type="button" variant="ghost" onclick={onClose}>Cancel</Button>
		<Button type="submit" disabled={!dirty}>Save</Button>
	</div>
</form>

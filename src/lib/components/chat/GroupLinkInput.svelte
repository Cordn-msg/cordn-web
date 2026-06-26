<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { gotoShareTarget, parseShareTarget } from '$lib/utils/groupShareLink';
	import { toast } from 'svelte-sonner';

	let {
		onNavigate = () => {},
		placeholder = 'Paste a group link or ID',
		submitLabel = 'Open'
	}: {
		onNavigate?: () => void;
		placeholder?: string;
		submitLabel?: string;
	} = $props();

	let value = $state('');
	let submitting = $state(false);

	async function handleSubmit() {
		const trimmed = value.trim();
		if (!trimmed || submitting) return;
		const target = parseShareTarget(trimmed);
		if (!target) {
			toast.error("That doesn't look like a valid group link or ID.");
			return;
		}
		submitting = true;
		try {
			onNavigate();
			await gotoShareTarget(target);
			value = '';
		} finally {
			submitting = false;
		}
	}
</script>

<form
	class="flex gap-2"
	onsubmit={(e) => {
		e.preventDefault();
		void handleSubmit();
	}}
>
	<Input
		bind:value
		{placeholder}
		aria-label={placeholder}
		autocomplete="off"
		autocapitalize="off"
		spellcheck={false}
	/>
	<Button type="submit" disabled={submitting || !value.trim()} class="shrink-0">
		{submitLabel}
	</Button>
</form>

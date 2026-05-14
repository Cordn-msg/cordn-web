<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { SendHorizontal } from '@lucide/svelte';

	let {
		value = $bindable(''),
		onSubmit
	}: {
		value?: string;
		onSubmit: () => void;
	} = $props();

	function handleSubmit(event: Event) {
		event.preventDefault();
		onSubmit();
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			onSubmit();
		}
	}

	function handleInput(event: Event) {
		const target = event.currentTarget as HTMLTextAreaElement;
		target.style.height = 'auto';
		target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
	}
</script>

<div class="border-t border-border bg-background">
	<form class="mx-auto flex max-w-5xl gap-3 px-4 py-4 md:px-6" onsubmit={handleSubmit}>
		<Textarea
			bind:value
			placeholder="Type a message..."
			rows={1}
			onkeydown={handleKeyDown}
			oninput={handleInput}
			class="max-h-32 min-h-11 flex-1 rounded-xl border border-input bg-card text-sm shadow-xs"
		/>
		<Button type="submit" class="h-11 rounded-xl px-4" disabled={!value.trim()}>
			<SendHorizontal class="size-4" />
			<span class="ml-2">Send</span>
		</Button>
	</form>
</div>

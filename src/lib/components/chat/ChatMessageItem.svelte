<script lang="ts">
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import type { ChatMessage } from './chat.types';

	let { message }: { message: ChatMessage } = $props();

	const isOwn = $derived(message.author === 'me');
	const avatarFallbackClass = $derived.by(() => {
		if (message.author === 'me') {
			return 'bg-primary text-primary-foreground';
		}

		if (message.author === 'peer') {
			return 'bg-secondary text-secondary-foreground';
		}

		return 'bg-muted';
	});
	const initials = $derived.by(() => {
		if (message.author === 'system') return '🪢';

		return message.author
			.split(' ')
			.map((part) => part[0])
			.join('')
			.slice(0, 2)
			.toUpperCase();
	});
</script>

<article class="flex gap-3" class:flex-row-reverse={isOwn}>
	<Avatar class="mt-1 h-9 w-9 shrink-0 border border-border">
		<AvatarFallback class={`text-xs ${avatarFallbackClass}`}>
			{initials}
		</AvatarFallback>
	</Avatar>

	<div class="flex max-w-3xl flex-col gap-1" class:items-end={isOwn}>
		<div
			class="flex items-center gap-2 text-xs text-muted-foreground"
			class:flex-row-reverse={isOwn}
		>
			<span class="font-medium text-foreground">{message.author}</span>
			<span>{message.timestamp}</span>
		</div>

		<div
			class="max-w-full rounded-2xl border border-border px-4 py-3 text-sm leading-7 shadow-sm"
			class:bg-primary={isOwn}
			class:text-primary-foreground={isOwn}
			class:border-primary={isOwn}
			class:bg-card={!isOwn}
		>
			<p class="[overflow-wrap:anywhere] break-words">{message.text}</p>
		</div>
	</div>
</article>

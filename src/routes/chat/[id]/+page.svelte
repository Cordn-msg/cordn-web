<script lang="ts">
	import ChatShell from '$lib/components/chat/ChatShell.svelte';
	import { chatGroups, defaultGroup } from '$lib/components/chat/chat-data.svelte';

	let { params } = $props();

	const group = $derived.by(() => chatGroups[params.id] ?? defaultGroup);
</script>

<svelte:head>
	<title>{group.title} | Cordn</title>
	<meta name="description" content="Cordn group chat route." />
</svelte:head>

<ChatShell groupId={group.id} title={group.title} subtitle={group.subtitle} />

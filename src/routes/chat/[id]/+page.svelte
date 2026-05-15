<script lang="ts">
	import ChatShell from '$lib/components/chat/ChatShell.svelte';
	import { getChatGroup, listChatGroups } from '$lib/services/chatGroups.svelte';

	let { params } = $props();

	const group = $derived.by(() => getChatGroup(params.id) ?? listChatGroups()[0]);
</script>

<svelte:head>
	<title>{group?.metadata?.name || group?.alias || 'Chat'} | Cordn</title>
	<meta name="description" content="Cordn group chat route." />
</svelte:head>

{#if group}
	<ChatShell
		groupId={group.id}
		title={group.metadata?.name || group.alias}
		subtitle={group.metadata?.description || 'Coordinator-assisted messaging'}
	/>
{/if}

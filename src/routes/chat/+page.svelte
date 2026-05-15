<script lang="ts">
	import ChatShell from '$lib/components/chat/ChatShell.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';

	const defaultGroup = $derived.by(() => listChatGroups()[0]);
</script>

<svelte:head>
	<title>{defaultGroup?.metadata?.name || 'Chat'} | Cordn</title>
	<meta name="description" content="Cordn group chat." />
</svelte:head>

{#if defaultGroup}
	<ChatShell
		groupId={defaultGroup.id}
		title={defaultGroup.metadata?.name || defaultGroup.alias}
		subtitle={defaultGroup.metadata?.description || 'Coordinator-assisted messaging'}
	/>
{:else}
	<div class="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
		<p>Create a group from the sidebar to get started.</p>
	</div>
{/if}

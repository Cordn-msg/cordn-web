<script lang="ts">
	import ChatShell from '$lib/components/chat/ChatShell.svelte';
	import { defaultGroup } from '$lib/components/chat/chat-data.svelte';
</script>

<svelte:head>
	<title>General | Cordn</title>
	<meta name="description" content="General Cordn group chat scaffold with sidebar navigation." />
</svelte:head>

<ChatShell groupId={defaultGroup.id} title={defaultGroup.title} subtitle={defaultGroup.subtitle} />

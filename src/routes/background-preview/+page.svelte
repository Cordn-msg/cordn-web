<script lang="ts">
	import { onMount } from 'svelte';
	import { runColdNotificationPreviews } from '$lib/services/chatNotificationPreview';

	onMount(() => {
		void runColdNotificationPreviews();
	});
</script>

<div class="hidden" aria-hidden="true"></div>

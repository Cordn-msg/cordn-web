<script lang="ts">
	import CollapsibleText from '$lib/components/chat/CollapsibleText.svelte';
	import { getCachedChatMarkdownBlocks } from '$lib/components/chat/chatMessageRenderCache';
	import ChatMarkdown from '$lib/chat/markdown/ChatMarkdown.svelte';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import { parseGitRepository, type ChatGitPullRequest } from '$lib/chat/gitPullRequests';
	import { useNostrEvent } from '$lib/services/useNostrEvent.svelte';
	import { openMessageLink } from '$lib/utils/groupShareLink';
	import { cn } from '$lib/utils';
	import type { NostrEvent } from 'nostr-tools';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';

	/**
	 * NIP-34 pull request (kind 1618) body. The surrounding NostrEventEmbed owns
	 * the author header, kind/time meta, and overflow menu; this component only
	 * renders the PR-specific presentation.
	 */
	let {
		event,
		pullRequest,
		isOwn = false,
		metaClass
	}: {
		event: NostrEvent;
		pullRequest: ChatGitPullRequest;
		isOwn?: boolean;
		metaClass: string;
	} = $props();

	const repositoryPointer = $derived(pullRequest.repository?.pointer);
	const repositoryEvent = useNostrEvent(() => repositoryPointer);
	const repository = $derived(
		parseGitRepository(repositoryEvent.current, pullRequest.repository?.identifier)
	);
	const repositoryName = $derived(repository?.name || pullRequest.repository?.identifier || '');
	const repositoryHref = $derived(
		repository?.webUrls[0] ||
			(pullRequest.repository ? `https://nostr.at/${pullRequest.repository.naddr}` : '')
	);
	const descriptionBlocks = $derived(
		pullRequest.description
			? getCachedChatMarkdownBlocks(`${event.id}:pull-request`, pullRequest.description)
			: null
	);
	const visibleLabels = $derived(pullRequest.labels.slice(0, 3));
	const extraLabelCount = $derived(pullRequest.labels.length - visibleLabels.length);
	const shortCommit = $derived(pullRequest.commit.slice(0, 7));
</script>

{#if pullRequest.subject}
	<span class="mt-0.5 block text-sm font-semibold">{pullRequest.subject}</span>
{/if}

{#if visibleLabels.length}
	<span class="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs leading-4">
		{#each visibleLabels as label (label)}
			<span
				class={cn(
					'rounded-full px-1.5 py-0.5 font-medium',
					isOwn ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-muted text-foreground'
				)}>{label}</span
			>
		{/each}
		{#if extraLabelCount > 0}
			<span class={metaClass}>+{extraLabelCount}</span>
		{/if}
	</span>
{/if}

{#if pullRequest.description}
	<span class="mt-1 block text-sm">
		<CollapsibleText length={pullRequest.description.length} {isOwn}>
			{#if descriptionBlocks}
				<ChatMarkdown blocks={descriptionBlocks} messageId={`${event.id}:pull-request`} {isOwn} />
			{:else}
				<MessageParts
					messageId={`${event.id}:pull-request`}
					text={pullRequest.description}
					{isOwn}
				/>
			{/if}
		</CollapsibleText>
	</span>
{/if}

{#if repositoryName || pullRequest.branchName || pullRequest.targetBranch || pullRequest.commit}
	<span class={cn('mt-1 flex min-w-0 flex-col gap-0.5 text-xs leading-4', metaClass)}>
		{#if repositoryName}
			<span class="flex min-w-0 items-center gap-1">
				<FolderGit2 class="size-3.5 shrink-0" />
				{#if repositoryHref}
					<button
						type="button"
						class="min-w-0 truncate font-medium underline-offset-2 hover:underline"
						title={repositoryHref}
						onclick={() => void openMessageLink(repositoryHref)}
					>
						{repositoryName}
					</button>
				{:else}
					<span class="min-w-0 truncate">{repositoryName}</span>
				{/if}
			</span>
		{/if}
		{#if pullRequest.branchName || pullRequest.targetBranch || pullRequest.commit}
			<span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
				{#if pullRequest.branchName || pullRequest.targetBranch}
					<span class="inline-flex min-w-0 items-center gap-1">
						<GitBranch class="size-3.5 shrink-0" />
						{#if pullRequest.branchName}
							<span class="min-w-0 truncate font-mono">{pullRequest.branchName}</span>
						{/if}
						{#if pullRequest.branchName && pullRequest.targetBranch}
							<span class="shrink-0">→</span>
						{/if}
						{#if pullRequest.targetBranch}
							<span class="min-w-0 truncate font-mono">{pullRequest.targetBranch}</span>
						{/if}
					</span>
				{/if}
				{#if pullRequest.commit}
					<span class="inline-flex min-w-0 items-center gap-1" title={pullRequest.commit}>
						<GitCommitHorizontal class="size-3.5 shrink-0" />
						<span class="font-mono">{shortCommit}</span>
					</span>
				{/if}
			</span>
		{/if}
	</span>
{/if}

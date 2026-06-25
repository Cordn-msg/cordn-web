<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import CoordinatorAddForm from '$lib/components/chat/CoordinatorAddForm.svelte';
	import CoordinatorCard, {
		type CoordinatorCardEntry
	} from '$lib/components/chat/CoordinatorCard.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getChatCoordinator,
		getCoordinatorColor,
		listChatCoordinators,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
	import { resolve } from '$app/paths';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import Bolt from '@lucide/svelte/icons/bolt';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plus from '@lucide/svelte/icons/plus';
	import Server from '@lucide/svelte/icons/server';

	const coordinators = $derived.by(() => listChatCoordinators());
	const groups = $derived.by(() => listChatGroups());
	const localKeyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const knownCoordinatorKeys = $derived.by(() => {
		const keys = new SvelteSet<string>();
		for (const coordinator of coordinators) keys.add(coordinator.pubkey);
		for (const group of groups) keys.add(group.coordinatorKey);
		for (const keyPackage of localKeyPackages) {
			for (const coordinatorKey of keyPackage.publishedCoordinatorKeys) keys.add(coordinatorKey);
		}
		return [...keys];
	});
	const coordinatorEntries = $derived.by<CoordinatorCardEntry[]>(() =>
		knownCoordinatorKeys.map((pubkey) => {
			const saved = getChatCoordinator(pubkey);
			return {
				pubkey,
				label: saved?.label || `Coordinator ${pubkey.slice(0, 8)}`,
				color: getCoordinatorColor(saved ?? { pubkey, color: undefined }),
				relays: saved?.relays ?? [],
				isDefault: saved?.isDefault ?? false,
				isSaved: Boolean(saved),
				lastUsedAt: saved?.lastUsedAt
			};
		})
	);

	function addDefaultCoordinator() {
		upsertChatCoordinator({
			pubkey: DEFAULT_CHAT_COORDINATOR_PUBKEY,
			label: 'Default coordinator',
			isDefault: true
		});
	}
</script>

<svelte:head>
	<title>Coordinators | Cordn</title>
	<meta name="description" content="Coordinator hub for Cordn chat." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Server class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">Coordinators</h1>
				<p class="text-sm text-muted-foreground">
					Manage coordinator profiles, defaults, relays, and remote inspection entry points.
				</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto max-w-6xl space-y-6">
			<div class="mx-auto w-full max-w-2xl">
				<CoordinatorAddForm />
			</div>

			<Card.Root>
				<Card.Header>
					<Card.Title>Known coordinators</Card.Title>
					<Card.Description>
						Coordinator pubkeys referenced by saved profiles, groups, or published key packages.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<div class="grid gap-4 lg:grid-cols-2">
						{#if coordinatorEntries.length === 0}
							<button
								type="button"
								onclick={addDefaultCoordinator}
								class="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-4 py-10 text-center text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/40 hover:text-foreground lg:col-span-2"
							>
								<span
									class="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-border"
								>
									<Plus class="size-6" />
								</span>
								<span class="space-y-1">
									<span class="block text-sm font-medium text-foreground"
										>Add default coordinator</span
									>
									<span class="block text-xs"
										>Start with the recommended coordinator so others can invite you.</span
									>
								</span>
							</button>
						{:else}
							{#each coordinatorEntries as coordinator (coordinator.pubkey)}
								<CoordinatorCard {coordinator} />
							{/each}
						{/if}
					</div>
				</Card.Content>
				<Card.Footer class="flex-wrap justify-between gap-3 border-t border-border pt-6">
					<p class="text-sm text-muted-foreground">
						Coordinators are the primary operational boundary for Cordn groups, key packages, and
						welcomes.
					</p>
					<div class="flex gap-2">
						<Button href={resolve('/chat/create-group')} variant="outline">
							<Bolt class="mr-2 size-4" />
							Create group
						</Button>
						<Button href={resolve('/chat/config/key-packages')} variant="outline">
							<KeyRound class="mr-2 size-4" />
							Key packages
						</Button>
					</div>
				</Card.Footer>
			</Card.Root>
		</div>
	</div>
</div>

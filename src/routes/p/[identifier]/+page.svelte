<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getChatGroupDisplayTitle } from '$lib/components/chat/chatGroupDisplay';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import { fetchPublicCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';
	import type { AvailableKeyPackage } from '$lib/contracts';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { activeAccount, logout } from '$lib/services/accountManager.svelte';
	import {
		getDefaultChatCoordinator,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { createChatGroup, inviteChatGroupMember } from '$lib/services/chatGroups.svelte';
	import { metadataRelays, relayPool } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import {
		listChatGroupMembers,
		listChatGroups,
		type StoredChatGroup
	} from '$lib/services/chatGroups.svelte';
	import {
		addressLoader,
		createUserRelayListByPubkeyLoader,
		getMetadataLookupRelays,
		getUserRelayListFromStore
	} from '$lib/services/loaders.svelte';
	import { cleanupActiveAccountChatData } from '$lib/services/chatSession.svelte';
	import { DIALOG_IDS, dialogState } from '$lib/stores/dialog-state.svelte';
	import { normalizePubKey } from '$lib/utils';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Save from '@lucide/svelte/icons/save';
	import UserRound from '@lucide/svelte/icons/user-round';
	import { ProfileModel } from 'applesauce-core/models';
	import { nip19 } from 'nostr-tools';
	import { Metadata } from 'nostr-tools/kinds';
	import { untrack } from 'svelte';

	let { params } = $props();

	type ProfileHint = { name?: string; displayName?: string; nip05?: string };
	type DecodedProfileIdentifier = { pubkey: string; error: string };

	function decodeProfileIdentifier(identifier: string): string {
		const trimmed = identifier.trim();
		if (!trimmed) throw new Error('Missing profile identifier');

		if (/^[0-9a-f]{64}$/i.test(trimmed)) {
			return normalizePubKey(trimmed);
		}

		const decoded = nip19.decode(trimmed);
		if (decoded.type === 'npub') {
			return normalizePubKey(decoded.data);
		}

		if (decoded.type === 'nprofile') {
			return normalizePubKey(decoded.data.pubkey);
		}

		throw new Error('Profile identifier must be a hex pubkey, npub, or nprofile');
	}

	const decodedProfileIdentifier = $derived.by<DecodedProfileIdentifier>(() => {
		try {
			return { pubkey: decodeProfileIdentifier(params.identifier), error: '' };
		} catch (error) {
			return {
				pubkey: '',
				error: error instanceof Error ? error.message : 'Failed to decode the profile identifier.'
			};
		}
	});
	const profilePubkey = $derived.by(() => decodedProfileIdentifier.pubkey);
	const profileIdentifierError = $derived.by(() => decodedProfileIdentifier.error);
	const profile = $derived(eventStore.model(ProfileModel, profilePubkey));
	const sharedGroups = $derived.by(() => {
		if (!profilePubkey) return [];
		const targetPubkey = profilePubkey;
		return listChatGroups().filter((group) =>
			listChatGroupMembers(group.id).some(
				(member) => normalizePubKey(member.stablePubkey) === targetPubkey
			)
		);
	});
	const sharedGroupCount = $derived.by(() => sharedGroups.length);
	const isSelf = $derived.by(() => {
		if (!$activeAccount) return false;
		return normalizePubKey($activeAccount.pubkey) === profilePubkey;
	});
	const requestedCoordinatorKey = $derived.by(() => {
		const value = page.url.searchParams.get('c')?.trim();
		if (!value) return undefined;
		return /^[0-9a-f]{64}$/i.test(value) ? normalizePubKey(value) : undefined;
	});
	const selectedCoordinatorKey = $derived.by(
		() => requestedCoordinatorKey ?? DEFAULT_CHAT_COORDINATOR_PUBKEY
	);
	const defaultCoordinator = $derived.by(() => getDefaultChatCoordinator());
	const npub = $derived.by(() => (profilePubkey ? nip19.npubEncode(profilePubkey) : ''));
	const displayName = $derived.by(
		() =>
			$profile?.name || $profile?.display_name || $profile?.nip05 || npub.slice(0, 16) || 'Profile'
	);
	const profileKeyPackage = $derived.by(() =>
		availableKeyPackages.find((entry) => normalizePubKey(entry.pk) === profilePubkey)
	);
	const startChatDisabled = $derived.by(
		() =>
			Boolean(profileIdentifierError) ||
			isSelf ||
			(Boolean($activeAccount) && (loadingAvailableKeyPackages || !profileKeyPackage))
	);
	const loadedProfileRelays = $derived.by(() => getUserRelayListFromStore(profilePubkey));
	const profileLookupRelays = $derived.by(() => getMetadataLookupRelays(profilePubkey));
	const profilePublishRelays = $derived.by(() => loadedProfileRelays);
	let availableKeyPackages = $state<AvailableKeyPackage[]>([]);
	let loadingAvailableKeyPackages = $state(false);
	let availableKeyPackagesError = $state('');
	let sharedGroupProfileHints = $state<Record<string, ProfileHint>>({});
	let editingProfile = $state(false);
	let profileName = $state('');
	let profileDisplayName = $state('');
	let profileAbout = $state('');
	let profilePicture = $state('');
	let profileBanner = $state('');
	let profileNip05 = $state('');
	let profileWebsite = $state('');
	let profileRelayList = $state('');
	let submittingProfile = $state(false);
	let profileError = $state('');
	let logoutCleaning = $state(false);
	let startingChat = $state(false);
	let startChatError = $state('');
	let startChatAfterLogin = $state(false);
	let initializedEditorForPubkey = $state('');

	$effect(() => {
		if (!profilePubkey) {
			availableKeyPackages = [];
			loadingAvailableKeyPackages = false;
			availableKeyPackagesError = '';
			return;
		}

		if (isSelf) {
			availableKeyPackages = [];
			loadingAvailableKeyPackages = false;
			availableKeyPackagesError = '';
			return;
		}

		let cancelled = false;
		loadingAvailableKeyPackages = true;
		availableKeyPackagesError = '';

		void fetchPublicCoordinatorAvailableKeyPackages(selectedCoordinatorKey)
			.then((entries) => {
				if (cancelled) return;
				availableKeyPackages = entries;
			})
			.catch((error) => {
				if (cancelled) return;
				availableKeyPackages = [];
				availableKeyPackagesError =
					error instanceof Error ? error.message : 'Failed to load coordinator key packages.';
			})
			.finally(() => {
				if (cancelled) return;
				loadingAvailableKeyPackages = false;
			});

		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (!profilePubkey) return;

		const pubkeys = [
			...new Set(
				sharedGroups.flatMap((group) =>
					listChatGroupMembers(group.id, $activeAccount?.pubkey)
						.map((member) => normalizePubKey(member.stablePubkey))
						.filter((pubkey) => pubkey && pubkey !== profilePubkey)
				)
			)
		];

		if (pubkeys.length === 0) return;

		const subscriptions = pubkeys.flatMap((pubkey) => [
			createUserRelayListByPubkeyLoader(pubkey).subscribe(),
			addressLoader({
				kind: Metadata,
				pubkey,
				relays: getMetadataLookupRelays(pubkey)
			}).subscribe(),
			eventStore.model(ProfileModel, pubkey).subscribe((nextProfile) => {
				const current = untrack(() => sharedGroupProfileHints[pubkey]);
				const next = {
					name: nextProfile?.name,
					displayName: nextProfile?.display_name,
					nip05: nextProfile?.nip05
				};
				if (
					current?.name === next.name &&
					current?.displayName === next.displayName &&
					current?.nip05 === next.nip05
				) {
					return;
				}
				sharedGroupProfileHints = { ...untrack(() => sharedGroupProfileHints), [pubkey]: next };
			})
		]);

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});

	$effect(() => {
		if (!profilePubkey) return;

		const subscription = createUserRelayListByPubkeyLoader(profilePubkey).subscribe();

		return () => subscription.unsubscribe();
	});

	$effect(() => {
		if (!profilePubkey) return;

		const subscription = addressLoader({
			kind: Metadata,
			pubkey: profilePubkey,
			relays: profileLookupRelays
		}).subscribe();

		return () => subscription.unsubscribe();
	});

	$effect(() => {
		if (!isSelf) {
			editingProfile = false;
			initializedEditorForPubkey = '';
			return;
		}

		if (initializedEditorForPubkey === profilePubkey && editingProfile) {
			return;
		}

		if (initializedEditorForPubkey !== profilePubkey) {
			resetProfileEditor();
			initializedEditorForPubkey = profilePubkey;
		}
	});

	$effect(() => {
		if (!startChatAfterLogin || !$activeAccount || isSelf || startingChat) {
			return;
		}

		startChatAfterLogin = false;
		void handleStartChat();
	});

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupId });
	}

	function getSharedGroupTitle(group: StoredChatGroup) {
		return getChatGroupDisplayTitle({
			group,
			activePubkey: $activeAccount?.pubkey,
			profileHints: sharedGroupProfileHints,
			memberPubkeys: listChatGroupMembers(group.id).map((member) => member.stablePubkey)
		});
	}

	function resetProfileEditor() {
		profileName = $profile?.name ?? '';
		profileDisplayName = $profile?.display_name ?? '';
		profileAbout = $profile?.about ?? '';
		profilePicture = $profile?.picture ?? '';
		profileBanner = $profile?.banner ?? '';
		profileNip05 = $profile?.nip05 ?? '';
		profileWebsite = $profile?.website ?? '';
		profileRelayList = profilePublishRelays.join('\n');
		profileError = '';
	}

	function parseRelayList(value: string): string[] {
		return [
			...new Set(
				value
					.split(/\r?\n/)
					.map((entry) => entry.trim())
					.filter(Boolean)
			)
		];
	}

	const enteredProfileRelayCount = $derived.by(() => parseRelayList(profileRelayList).length);

	const profileDirty = $derived.by(
		() =>
			profileName !== ($profile?.name ?? '') ||
			profileDisplayName !== ($profile?.display_name ?? '') ||
			profileAbout !== ($profile?.about ?? '') ||
			profilePicture !== ($profile?.picture ?? '') ||
			profileBanner !== ($profile?.banner ?? '') ||
			profileNip05 !== ($profile?.nip05 ?? '') ||
			profileWebsite !== ($profile?.website ?? '') ||
			profileRelayList !== profilePublishRelays.join('\n')
	);

	function startEditingProfile() {
		resetProfileEditor();
		editingProfile = true;
	}

	function cancelEditingProfile() {
		resetProfileEditor();
		editingProfile = false;
	}

	async function saveProfile(event: Event) {
		event.preventDefault();
		if (!$activeAccount) return;

		submittingProfile = true;
		profileError = '';

		try {
			const content = JSON.stringify({
				name: profileName.trim() || undefined,
				display_name: profileDisplayName.trim() || undefined,
				about: profileAbout.trim() || undefined,
				picture: profilePicture.trim() || undefined,
				banner: profileBanner.trim() || undefined,
				nip05: profileNip05.trim() || undefined,
				website: profileWebsite.trim() || undefined
			});

			const unsignedEvent = {
				kind: Metadata,
				created_at: Math.floor(Date.now() / 1000),
				tags: [],
				content,
				pubkey: $activeAccount.pubkey
			};

			const signer = (
				$activeAccount as {
					signer?: {
						signEvent?: (
							event: typeof unsignedEvent
						) => Promise<typeof unsignedEvent & { id: string; sig: string }>;
					};
				}
			).signer;

			if (!signer?.signEvent) {
				throw new Error('Active account signer does not support metadata signing');
			}

			const nextEvent = await signer.signEvent(unsignedEvent);

			let relays = parseRelayList(profileRelayList) || metadataRelays;
			if (relays.length === 0) {
				relays = metadataRelays;
			}

			for (const relay of relays) {
				await relayPool.relay(relay).publish(nextEvent);
			}

			eventStore.add(nextEvent);
			editingProfile = false;
		} catch (error) {
			profileError = error instanceof Error ? error.message : 'Failed to save profile metadata';
		} finally {
			submittingProfile = false;
		}
	}

	async function cleanAndLogout() {
		logoutCleaning = true;
		try {
			await cleanupActiveAccountChatData();
			logout();
			await goto(resolve('/chat'));
		} finally {
			logoutCleaning = false;
		}
	}

	async function handleStartChat() {
		if (isSelf || !profilePubkey) return;

		if (!$activeAccount) {
			startChatAfterLogin = true;
			dialogState.dialogId = DIALOG_IDS.LOGIN;
			return;
		}

		if (!profileKeyPackage || loadingAvailableKeyPackages) {
			return;
		}

		try {
			startingChat = true;
			startChatError = '';

			if (!defaultCoordinator || defaultCoordinator.pubkey !== selectedCoordinatorKey) {
				upsertChatCoordinator({
					pubkey: selectedCoordinatorKey,
					label:
						selectedCoordinatorKey === DEFAULT_CHAT_COORDINATOR_PUBKEY
							? 'Default coordinator'
							: `Coordinator ${selectedCoordinatorKey.slice(0, 8)}`,
					isDefault: true
				});
			}

			const group = await createChatGroup({
				name: '',
				coordinatorKey: selectedCoordinatorKey
			});
			await inviteChatGroupMember({
				groupId: group.id,
				identifier: profileKeyPackage.kp_ref
			});
			await goto(resolve('/chat/[id]', { id: group.id }));
		} catch (error) {
			startChatError = error instanceof Error ? error.message : 'Failed to start chat';
		} finally {
			startingChat = false;
		}
	}
</script>

<svelte:head>
	<title>{($profile?.name || $profile?.display_name || 'Profile') + ' | Cordn'}</title>
	<meta name="description" content="Cordn profile page with shared local groups." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center justify-between gap-4">
			<div class="flex min-w-0 items-center gap-3">
				<div
					class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
				>
					<UserRound class="size-4" />
				</div>
				<div class="min-w-0">
					<p class="text-xs tracking-[0.2em] text-muted-foreground uppercase">Profile</p>
					<h1 class="truncate text-lg font-semibold tracking-tight">
						{isSelf ? 'Your profile' : 'User profile'}
					</h1>
				</div>
			</div>

			<Button href={resolve('/chat')} variant="outline">
				<ArrowLeft class="mr-2 size-4" />
				Back to chat
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto flex max-w-5xl flex-col gap-6">
			<div class="hidden">
				<AccountLoginDialog />
			</div>

			{#if profileIdentifierError}
				<Card.Root>
					<Card.Header>
						<Card.Title>Invalid profile identifier</Card.Title>
						<Card.Description>This profile link could not be decoded.</Card.Description>
					</Card.Header>
					<Card.Content>
						<div class="space-y-4">
							<p
								class="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
							>
								{profileIdentifierError}
							</p>
							<p class="text-sm text-muted-foreground">
								Use a full hex pubkey, npub, or nprofile identifier.
							</p>
						</div>
					</Card.Content>
				</Card.Root>
			{:else}
				<Card.Root>
					<Card.Header>
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div>
								<Card.Title>{isSelf ? 'Identity' : 'Profile overview'}</Card.Title>
							</div>

							{#if isSelf}
								<div class="flex flex-wrap gap-2">
									<Button type="button" variant="outline" onclick={startEditingProfile}>
										<Pencil class="mr-2 size-4" />
										Edit profile
									</Button>
									<Button type="button" variant="outline" onclick={logout}>
										<LogOut class="mr-2 size-4" />
										Log out
									</Button>
									<Button
										type="button"
										variant="ghost"
										onclick={cleanAndLogout}
										disabled={logoutCleaning}
									>
										{logoutCleaning ? 'Cleaning…' : 'Log out and clean data'}
									</Button>
								</div>
							{/if}
						</div>
					</Card.Header>
					<Card.Content>
						{#if isSelf && editingProfile}
							<form class="space-y-4" onsubmit={saveProfile}>
								<InputGroup.Root>
									<InputGroup.Input bind:value={profileName} placeholder="Name" />
									<InputGroup.Addon>
										<InputGroup.Text>Name</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Input bind:value={profileDisplayName} placeholder="Display name" />
									<InputGroup.Addon>
										<InputGroup.Text>Display</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Input
										bind:value={profilePicture}
										placeholder="https://example.com/avatar.png"
									/>
									<InputGroup.Addon>
										<InputGroup.Text>Picture</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Input
										bind:value={profileBanner}
										placeholder="https://example.com/banner.png"
									/>
									<InputGroup.Addon>
										<InputGroup.Text>Banner</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Input bind:value={profileNip05} placeholder="name@example.com" />
									<InputGroup.Addon>
										<InputGroup.Text>NIP-05</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Input bind:value={profileWebsite} placeholder="https://example.com" />
									<InputGroup.Addon>
										<InputGroup.Text>Website</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Textarea
										bind:value={profileAbout}
										placeholder="Tell people about yourself"
										class="min-h-28"
									/>
									<InputGroup.Addon align="block-start">
										<InputGroup.Text>About</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Textarea
										bind:value={profileRelayList}
										placeholder=""
										class="min-h-24"
									/>
									<InputGroup.Addon align="block-start">
										<InputGroup.Text>Relays</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<div class="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
									<p>
										Publishing to {enteredProfileRelayCount} relay{enteredProfileRelayCount === 1
											? ''
											: 's'}.
									</p>
									<p class="mt-1 text-xs">
										{#if loadedProfileRelays.length > 0}
											Loaded from the profile 10002 relay list event and used for metadata
											publishing.
										{:else}
											No profile 10002 relay list was found yet. Add user relays before saving.
										{/if}
									</p>
								</div>

								{#if profileError}
									<div
										class="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
									>
										{profileError}
									</div>
								{/if}

								<div class="flex flex-wrap justify-end gap-2">
									<Button type="button" variant="ghost" onclick={cancelEditingProfile}
										>Cancel</Button
									>
									<Button type="submit" disabled={submittingProfile || !profileDirty}>
										<Save class="mr-2 size-4" />
										{submittingProfile ? 'Saving…' : 'Save profile'}
									</Button>
								</div>
							</form>
						{:else}
							<div class="flex w-full flex-col items-center gap-3">
								<ProfileCard pubkey={profilePubkey} mode="extended" />
								<div class="flex w-full max-w-sm flex-col items-stretch gap-2">
									<Button
										type="button"
										onclick={handleStartChat}
										disabled={startChatDisabled || startingChat}
									>
										<MessageCirclePlus class="mr-2 size-4" />
										{startingChat ? 'Starting chat…' : 'Start chat'}
									</Button>
									{#if startChatError}
										<p class="text-sm text-destructive">{startChatError}</p>
									{:else if availableKeyPackagesError}
										<p class="text-sm text-destructive">{availableKeyPackagesError}</p>
									{/if}
								</div>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
				{#if sharedGroups.length}
					<Card.Root>
						<Card.Header>
							<Card.Title>Groups in common</Card.Title>
							<Card.Description>
								{#if isSelf}
									Your local groups on this device.
								{:else}
									Local groups where this profile appears in the current membership list.
								{/if}
							</Card.Description>
						</Card.Header>
						<Card.Content>
							<div class="space-y-3">
								<div class="rounded-2xl border border-border bg-card/40 px-4 py-4">
									<p class="text-xs tracking-[0.2em] text-muted-foreground uppercase">
										{displayName}
									</p>
									<p class="text-2xl font-semibold tracking-tight">{sharedGroupCount}</p>
									<p class="text-sm text-muted-foreground">
										{sharedGroupCount === 1 ? 'Shared local group' : 'Shared local groups'}
									</p>
								</div>

								{#each sharedGroups as group (group.id)}
									<a
										href={getGroupHref(group.id)}
										class="block rounded-2xl border border-border px-4 py-4 transition-colors hover:bg-muted/40"
									>
										<p class="font-medium">{getSharedGroupTitle(group)}</p>
										<p class="mt-1 text-sm text-muted-foreground">
											{group.metadata?.description || 'Coordinator-assisted messaging'}
										</p>
									</a>
								{/each}
							</div>
						</Card.Content>
					</Card.Root>
				{/if}
			{/if}
		</div>
	</div>
</div>

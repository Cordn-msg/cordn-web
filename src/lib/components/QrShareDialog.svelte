<script lang="ts">
	import { browser } from '$app/environment';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { errorMessage } from '$lib/utils';
	import QrCode from '$lib/components/QrCode.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import GroupLinkInput from '$lib/components/chat/GroupLinkInput.svelte';
	import { gotoShareTarget, parseShareTarget } from '$lib/utils/groupShareLink';
	import type { ProfileShareHint } from '$lib/utils/profileShareHint';
	import { copyText } from '$lib/services/nativeShims';
	import Copy from '@lucide/svelte/icons/copy';
	import QrCodeIcon from '@lucide/svelte/icons/qr-code';
	import ScanLine from '@lucide/svelte/icons/scan-line';

	let {
		open = $bindable(false),
		title,
		description,
		data,
		copyLabel = 'Copy link',
		copiedLabel = 'Copied link',
		hint = undefined,
		shareOptions = [],
		onNavigate = () => {}
	}: {
		open?: boolean;
		title: string;
		description: string;
		data: string;
		copyLabel?: string;
		copiedLabel?: string;
		/** Optional status/warning block shown under the share link (e.g. reachability). */
		hint?: ProfileShareHint;
		/** Alternative `data` values the user can switch between (e.g. per-coordinator
		 * profile links). Tabs render only when more than one is offered. */
		shareOptions?: { label: string; value: string; color?: string; hint?: ProfileShareHint }[];
		onNavigate?: () => void;
	} = $props();

	type Tab = 'share' | 'scan';
	let tab = $state<Tab>('share');
	let copied = $state(false);
	let resolving = $state(false);
	let selectedShareIndex = $state(0);

	const showShareOptions = $derived(shareOptions.length > 1);
	const selectedShareIndexSafe = $derived(
		selectedShareIndex < shareOptions.length ? selectedShareIndex : 0
	);
	const effectiveData = $derived(
		showShareOptions ? (shareOptions[selectedShareIndexSafe]?.value ?? data) : data
	);
	const activeHint = $derived(shareOptions[selectedShareIndexSafe]?.hint ?? hint);
	let hintBusy = $state(false);

	async function runHintAction() {
		const action = activeHint?.action;
		if (!action || hintBusy) return;
		hintBusy = true;
		try {
			await action.onAction();
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			hintBusy = false;
		}
	}

	// Reset to the Share tab whenever the dialog closes so reopening it never
	// surprises the user by immediately requesting camera access.
	let wasOpen = false;
	$effect(() => {
		if (!open && wasOpen) {
			tab = 'share';
			selectedShareIndex = 0;
		}
		wasOpen = open;
	});

	async function copyLink() {
		if (!effectiveData || !browser) return;
		await copyText(effectiveData);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	function closeAfterNavigate() {
		open = false;
		onNavigate();
	}

	async function handleScanResult(value: string) {
		if (resolving) return;
		const trimmed = value.trim();
		if (!trimmed) return;
		resolving = true;
		try {
			// Same routing as the paste box, so a scanned code follows the rules a
			// pasted one does (including another client's group link).
			const target = parseShareTarget(trimmed);
			if (!target) {
				toast.error('That QR code is not a valid link.');
				return;
			}
			// External links leave the dialog open, so the code stays scannable.
			if (target.kind === 'internal') closeAfterNavigate();
			await gotoShareTarget(target);
		} finally {
			resolving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>{description}</Dialog.Description>
		</Dialog.Header>

		<div class="flex space-x-1 rounded-lg bg-muted p-1">
			<button
				type="button"
				class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
				'share'
					? 'bg-background shadow-sm'
					: 'hover:bg-muted-foreground/10'}"
				onclick={() => (tab = 'share')}
			>
				<QrCodeIcon class="size-4" />
				Share
			</button>
			<button
				type="button"
				class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
				'scan'
					? 'bg-background shadow-sm'
					: 'hover:bg-muted-foreground/10'}"
				onclick={() => (tab = 'scan')}
			>
				<ScanLine class="size-4" />
				Scan
			</button>
		</div>

		{#if tab === 'share'}
			<div class="flex flex-col items-center gap-4 py-2">
				{#if showShareOptions}
					<div
						role="tablist"
						class="flex w-full flex-wrap justify-center gap-1 rounded-lg bg-muted p-1"
					>
						{#each shareOptions as option, i (option.value)}
							<button
								type="button"
								role="tab"
								aria-selected={selectedShareIndexSafe === i}
								class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {selectedShareIndexSafe ===
								i
									? 'bg-background shadow-sm'
									: 'hover:bg-muted-foreground/10'}"
								onclick={() => (selectedShareIndex = i)}
							>
								{#if option.color}
									<span
										class="size-2.5 shrink-0 rounded-full border border-border"
										style={`background-color: ${option.color};`}
										aria-hidden="true"
									></span>
								{/if}
								<span class="truncate">{option.label}</span>
							</button>
						{/each}
					</div>
				{/if}
				<QrCode data={effectiveData} size={220} />
				<p
					class="w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs break-all text-muted-foreground"
				>
					{effectiveData}
				</p>
				<Button type="button" variant="outline" class="w-full" onclick={copyLink}>
					<Copy class="mr-2 size-4" />
					{copied ? copiedLabel : copyLabel}
				</Button>
				{#if activeHint}
					<div
						class="flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs {activeHint.tone ===
						'warn'
							? 'border-destructive/30 bg-destructive/10 text-destructive'
							: 'border-border bg-muted/30 text-muted-foreground'}"
					>
						<p>{activeHint.text}</p>
						{#if activeHint.action}
							<Button
								type="button"
								variant="outline"
								size="sm"
								class="shrink-0"
								disabled={hintBusy}
								onclick={runHintAction}
							>
								{#if hintBusy}
									<Spinner class="mr-2 size-4" />
								{/if}
								{hintBusy
									? (activeHint.action.pendingLabel ?? activeHint.action.label)
									: activeHint.action.label}
							</Button>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<div class="flex flex-col items-center gap-3 py-2">
				<QrScanner onResult={handleScanResult} />
				<p class="text-center text-xs text-muted-foreground">
					Point your camera at a Cordn share code to open it here.
				</p>
				<div class="w-full">
					<p class="mb-1.5 text-center text-xs text-muted-foreground">Or paste a link or ID</p>
					<GroupLinkInput onNavigate={closeAfterNavigate} />
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

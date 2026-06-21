<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import QrCode from '$lib/components/QrCode.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
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
		onNavigate = () => {}
	}: {
		open?: boolean;
		title: string;
		description: string;
		data: string;
		copyLabel?: string;
		copiedLabel?: string;
		onNavigate?: () => void;
	} = $props();

	type Tab = 'share' | 'scan';
	let tab = $state<Tab>('share');
	let copied = $state(false);
	let resolving = $state(false);

	// Reset to the Share tab whenever the dialog closes so reopening it never
	// surprises the user by immediately requesting camera access.
	let wasOpen = false;
	$effect(() => {
		if (!open && wasOpen) tab = 'share';
		wasOpen = open;
	});

	async function copyLink() {
		if (!data || !browser) return;
		await navigator.clipboard.writeText(data);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	async function handleScanResult(value: string) {
		if (resolving) return;
		const trimmed = value.trim();
		if (!trimmed) return;
		resolving = true;
		try {
			let target: URL;
			try {
				target = new URL(trimmed, window.location.origin);
			} catch {
				toast.error('That QR code is not a valid link.');
				return;
			}

			if (target.origin === window.location.origin) {
				const path = target.pathname + target.search + target.hash;
				open = false;
				onNavigate();
				// Path comes from a scanned QR code at runtime, so resolve() cannot apply.
				// eslint-disable-next-line svelte/no-navigation-without-resolve
				await goto(path);
			} else {
				window.open(target.toString(), '_blank', 'noopener,noreferrer');
			}
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
				<QrCode {data} size={220} />
				<p
					class="w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs break-all text-muted-foreground"
				>
					{data}
				</p>
				<Button type="button" variant="outline" class="w-full" onclick={copyLink}>
					<Copy class="mr-2 size-4" />
					{copied ? copiedLabel : copyLabel}
				</Button>
			</div>
		{:else}
			<div class="flex flex-col items-center gap-3 py-2">
				<QrScanner onResult={handleScanResult} />
				<p class="text-center text-xs text-muted-foreground">
					Point your camera at a Cordn share code to open it here.
				</p>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

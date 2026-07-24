<script lang="ts">
	/**
	 * Read-only dev panel for multi-device sync. Pure visualization of locally
	 * persisted state (`config.lastSeenTip`, `config.tipHistory`) plus two
	 * on-demand network probes (relay + Blossom coherence). Changes no service
	 * state; the probes fire only on explicit button click.
	 */
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { copyText, openExternal } from '$lib/services/nativeShims';
	import type {
		MultiDeviceOwnerConfig,
		ReconcileCounts,
		TipTransition
	} from '$lib/services/multiDevice.svelte';
	import {
		probeRelayTips,
		probeBlossomBlobs,
		type RelayTipProbe,
		type BlobProbe
	} from '$lib/services/multiDeviceDev.svelte';
	import Radio from '@lucide/svelte/icons/radio';
	import HardDriveDownload from '@lucide/svelte/icons/hard-drive-download';
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { toast } from 'svelte-sonner';

	let { config }: { config: MultiDeviceOwnerConfig } = $props();

	// ponytail: probes are session-only $state, triggered on click. Never auto-run
	// — opening a settings page must not fire N network requests.
	let relayRows = $state<RelayTipProbe[] | null>(null);
	let blobRows = $state<BlobProbe[] | null>(null);
	let relayRunning = $state(false);
	let blobRunning = $state(false);
	// ponytail: single-open expand — inspect one transition at a time. Click
	// another row to switch, click the same to collapse.
	let expandedKey = $state<string | null>(null);

	const tip = $derived(config.lastSeenTip);
	const history = $derived(config.tipHistory ?? []);

	// Coherence: all relays returned the SAME event id (version drift = bug).
	// null = not yet probed; true = single id across all relays; false = drift or gap.
	const relayCoherent = $derived.by(() => {
		if (!relayRows || relayRows.length === 0) return null;
		if (relayRows.some((r) => r.eventId === null)) return false;
		return new Set(relayRows.map((r) => r.eventId)).size === 1;
	});

	// Blob coherence: every advertised address present on every configured server.
	const blobCoherent = $derived.by(() => {
		if (!blobRows || blobRows.length === 0) return null;
		return blobRows.every((r) => r.present);
	});

	async function checkRelays() {
		relayRunning = true;
		try {
			relayRows = await probeRelayTips(config);
		} finally {
			relayRunning = false;
		}
	}

	async function checkBlobs() {
		blobRunning = true;
		try {
			blobRows = await probeBlossomBlobs(config);
		} finally {
			blobRunning = false;
		}
	}

	function short(s: string, n = 10): string {
		return s.length <= n ? s : `${s.slice(0, n)}…`;
	}
	function fmtTime(ms: number): string {
		return new Date(ms).toLocaleString();
	}
	function fmtSize(bytes: number | null): string {
		if (bytes == null) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	type RowTone = 'meta' | 'add' | 'chg' | 'rm';
	type HashRow = { label: string; address: string; tone: RowTone };

	function toggleExpand(key: string): void {
		expandedKey = expandedKey === key ? null : key;
	}

	/** First configured Blossom host + sha256 = the BUD-01 GET URL for the blob. */
	function inspectUrl(address: string): string {
		const host = (config.blossomServers[0] ?? '').replace(/\/+$/, '');
		return `${host}/${address}`;
	}

	async function copyHash(address: string): Promise<void> {
		try {
			await copyText(address);
			toast.success('Address copied');
		} catch {
			toast.error('Could not copy — select manually');
		}
	}

	/** Open the blob's GET URL in a new tab for server-side inspection. */
	function openOnServer(address: string): void {
		void openExternal(inspectUrl(address));
	}

	/** Rows for an expanded transition: the content address of every sealed
	 * document this tip move touched (meta + each added/changed/removed group).
	 * `removed` carries the address that just left the tip — still inspectable. */
	function rowsFor(h: TipTransition): HashRow[] {
		const meta = h.metaChanged ? (h.metaAddress ?? config.lastSeenTip?.metaAddress) : undefined;
		return [
			...(meta ? [{ label: 'meta', address: meta, tone: 'meta' as const }] : []),
			...h.added.map((g) => ({ label: short(g.gid, 8), address: g.address, tone: 'add' as const })),
			...h.changed.map((g) => ({
				label: short(g.gid, 8),
				address: g.address,
				tone: 'chg' as const
			})),
			...h.removed.map((g) => ({ label: short(g.gid, 8), address: g.address, tone: 'rm' as const }))
		];
	}

	function toneClass(tone: RowTone): string {
		switch (tone) {
			case 'meta':
				return 'text-amber-600 dark:text-amber-400';
			case 'add':
				return 'text-emerald-600 dark:text-emerald-400';
			case 'chg':
				return 'text-blue-600 dark:text-blue-400';
			case 'rm':
				return 'text-red-600 dark:text-red-400';
		}
	}
	// Compact counts summary — only non-zero buckets, so a clean reconcile renders
	// nothing instead of five zeroes.
	const countLabels: Record<keyof ReconcileCounts, string> = {
		seeded: 'seed',
		fastForwarded: 'fwd',
		skipped: 'skip',
		dropped: 'drop',
		ignored: 'ign'
	};

	// Coherence pill class — null = neutral (not probed), true = green, false = red.
	function pillClass(ok: boolean | null): string {
		if (ok === null) return 'bg-muted text-muted-foreground';
		return ok
			? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
			: 'bg-red-500/15 text-red-700 dark:text-red-400';
	}
</script>

<div class="space-y-4 rounded-lg border border-dashed border-border bg-muted/20 p-4">
	<!-- Current persisted tip: pure projection of config.lastSeenTip. -->
	<div class="space-y-2">
		<h4 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Local tip</h4>
		{#if tip}
			<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
				<dt class="text-muted-foreground">event</dt>
				<dd class="truncate">{short(config.lastSeenTipEventId ?? '?', 16)}</dd>
				<dt class="text-muted-foreground">meta</dt>
				<dd class="truncate">{tip.metaAddress ? short(tip.metaAddress, 16) : '—'}</dd>
			</dl>
			{#if tip.groups.length}
				<ul class="space-y-1 font-mono text-xs">
					{#each tip.groups as g (g.gid)}
						<li class="flex items-center gap-2">
							<span class="text-muted-foreground">{short(g.gid, 8)}</span>
							<span class="truncate">{short(g.address, 16)}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-xs text-muted-foreground">No groups in the tip yet.</p>
			{/if}
		{:else}
			<p class="text-xs text-muted-foreground">No tip seen yet.</p>
		{/if}
	</div>

	<!-- Transition history: the dev log, newest first. -->
	<div class="space-y-2 border-t border-border pt-3">
		<h4 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
			History ({history.length})
		</h4>
		{#if history.length === 0}
			<p class="text-xs text-muted-foreground">No tip transitions recorded yet.</p>
		{:else}
			<ul class="max-h-64 space-y-2 overflow-y-auto pr-1">
				{#each history as h (h.eventId + h.at)}
					{@const rowKey = h.eventId + h.at}
					{@const expanded = expandedKey === rowKey}
					{@const nonzero = h.counts
						? (Object.entries(h.counts) as [keyof ReconcileCounts, number][]).filter(
								([, v]) => v > 0
							)
						: []}
					<li class="rounded-md border border-border bg-background p-2 text-xs">
						<button
							type="button"
							class="flex w-full flex-col gap-1 text-left"
							onclick={() => toggleExpand(rowKey)}
							aria-expanded={expanded}
						>
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-mono text-[10px] text-muted-foreground">
									{fmtTime(h.at)}
								</span>
								<span
									class={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${h.source === 'read' ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'}`}
								>
									{h.source === 'read' ? 'ingest' : 'publish'}
								</span>
								{#if h.metaChanged}
									<span
										class="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
									>
										meta↻
									</span>
								{/if}
								{#each nonzero as [key, v] (key)}
									<span class="font-mono text-[10px] text-muted-foreground">
										{countLabels[key]}:{v}
									</span>
								{/each}
								<ChevronRight
									class={`ml-auto size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
								/>
							</div>
							{#if h.added.length || h.removed.length || h.changed.length}
								<div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px]">
									{#each h.added as g (g.gid)}
										<span class="text-emerald-600 dark:text-emerald-400">+{short(g.gid, 8)}</span>
									{/each}
									{#each h.changed as g (g.gid)}
										<span class="text-blue-600 dark:text-blue-400">~{short(g.gid, 8)}</span>
									{/each}
									{#each h.removed as g (g.gid)}
										<span class="text-red-600 dark:text-red-400">-{short(g.gid, 8)}</span>
									{/each}
								</div>
							{/if}
						</button>
						{#if expanded}
							{@const rows = rowsFor(h)}
							<div class="mt-2 space-y-1 border-t border-dashed border-border pt-2">
								{#each rows as r (r.label + r.address)}
									<div class="flex items-center gap-2 font-mono text-[10px]">
										<span class="w-14 shrink-0 truncate {toneClass(r.tone)}">{r.label}</span>
										<span class="flex-1 truncate text-muted-foreground">{r.address}</span>
										<button
											type="button"
											class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
											onclick={() => copyHash(r.address)}
											title="Copy address"
											aria-label="Copy address"
										>
											<Copy class="size-3" />
										</button>
										<button
											type="button"
											class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
											onclick={() => openOnServer(r.address)}
											title="Open on server"
											aria-label="Open on server"
										>
											<ExternalLink class="size-3" />
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- Health probes: manual, on-demand. -->
	<div class="space-y-3 border-t border-border pt-3">
		<h4 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Health</h4>

		<!-- Relay coherence -->
		<div class="space-y-2">
			<div class="flex items-center gap-2">
				<Button variant="outline" size="sm" onclick={checkRelays} disabled={relayRunning}>
					{#if relayRunning}
						<Spinner class="mr-2 size-3.5" />
						Checking…
					{:else}
						<Radio class="mr-2 size-3.5" />
						Check relays
					{/if}
				</Button>
				{#if relayCoherent !== null}
					<span class={`rounded-full px-2 py-0.5 text-xs font-medium ${pillClass(relayCoherent)}`}>
						{relayCoherent ? 'coherent' : 'drift / gap'}
					</span>
				{/if}
			</div>
			{#if relayRows}
				<ul class="space-y-1 font-mono text-xs">
					{#each relayRows as r (r.relay)}
						<li class="flex items-center justify-between gap-2">
							<span class="truncate">{r.relay}</span>
							<span class={r.eventId ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400'}>
								{r.eventId ? short(r.eventId, 12) : 'missing'}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<!-- Blossom coherence -->
		<div class="space-y-2">
			<div class="flex items-center gap-2">
				<Button variant="outline" size="sm" onclick={checkBlobs} disabled={blobRunning}>
					{#if blobRunning}
						<Spinner class="mr-2 size-3.5" />
						Checking…
					{:else}
						<HardDriveDownload class="mr-2 size-3.5" />
						Check Blossom servers
					{/if}
				</Button>
				{#if blobCoherent !== null}
					<span class={`rounded-full px-2 py-0.5 text-xs font-medium ${pillClass(blobCoherent)}`}>
						{blobCoherent ? 'coherent' : 'gaps'}
					</span>
				{/if}
			</div>
			{#if blobRows}
				<ul class="space-y-1 font-mono text-xs">
					{#each blobRows as r (r.server + r.address)}
						<li class="flex items-center justify-between gap-2">
							<span class="truncate text-muted-foreground">
								{r.kind === 'meta' ? 'meta' : short(r.gid ?? r.address, 8)}
								· {r.server.replace(/^https?:\/\//, '')}
							</span>
							<span
								class={r.present
									? 'text-emerald-600 dark:text-emerald-400'
									: 'text-red-600 dark:text-red-400'}
							>
								{#if r.present}
									✓ {fmtSize(r.size)}
								{:else if r.status === 0}
									unreachable
								{:else}
									✗ {r.status}{r.reason ? ` ${r.reason}` : ''}
								{/if}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>

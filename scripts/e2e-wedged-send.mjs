/**
 * E2E: a wedged pending bubble (clock) must explain itself and be escapable.
 * A message enqueued against a group whose coordinator is unreachable fails
 * its attempt transiently — the bubble stays queued with a clock. Asserts the
 * clock's tooltip carries the real failure reason (deliveryDetail, not the
 * misleading offline line) and that the message-actions Delete discards the
 * wedged bubble (outbox intent abandoned).
 *
 * Run: node scripts/e2e-wedged-send.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const PRIV = schnorr.utils.randomSecretKey();
const ACCOUNT = {
	type: 'nsec',
	id: 'harness-account',
	pubkey: bytesToHex(schnorr.getPublicKey(PRIV)),
	signer: { key: bytesToHex(PRIV) }
};

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const HARNESS_DIR = 'src/routes/__wedged-send-harness';
const HARNESS_PAGE = `${HARNESS_DIR}/+page.svelte`;

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HARNESS_SVELTE = `<script lang="ts">
	// Thin shell: everything heavy loads dynamically client-side so the dev
	// server never imports the MLS/relay graph for this route.
	import { onMount } from 'svelte';

	type Api = {
		mount: (el: HTMLElement) => void;
		appendMessage: () => boolean;
		startReply: () => boolean;
		hasReplyPreview: () => boolean;
	};

	let ChatShellC = $state<unknown>(null);
	let gid = $state('');

	onMount(async () => {
		const [{ default: ChatShell }, groups, lifecycle, keyPackages, mls] = await Promise.all([
			import('$lib/components/chat/ChatShell.svelte'),
			import('$lib/services/chatGroups.svelte'),
			import('$lib/services/chatGroupLifecycle.svelte'),
			import('$lib/services/chatKeyPackages.svelte'),
						import('ts-mls')
		]);
		const PEER = 'cc'.repeat(32);
		const mkMessage = (i: number) => ({
			cursor: i,
			createdAt: 1000 + i,
			direction: 'inbound' as const,
			sender: PEER,
			id: 'peer-' + i,
			kind: 9,
			tags: [] as string[][],
			content: 'peer message ' + i
		});

		// Real MLS state: listChatGroupMembers decodes it unguarded at render.
		const artifacts = await lifecycle.createMemberArtifacts({
			createKeyPackage: () =>
				keyPackages.createChatKeyPackage({ label: 'harness', isLastResort: false })
		});
		const state = await lifecycle.createInitialGroupState({
			metadata: { name: 'harness' },
			memberArtifacts: artifacts
		});
		const GID = new TextDecoder().decode(state.groupContext.groupId);
		let next = 3;
		// Settle the groups load FIRST: a boot-time ensureGroupsLoaded() would
		// otherwise re-read IDB (empty) and replace the store array, wiping the
		// in-memory group before its async put lands ("Group not found").
		await groups.ensureGroupsLoaded();
		groups.persistGroup({
			id: GID,
			coordinatorKey: 'aa'.repeat(32),
			createdAt: 1,
			stateBase64: mls.bytesToBase64(mls.encode(mls.clientStateEncoder, state)),
			lastCursor: 3,
			fetchCursor: 3,
			messages: [mkMessage(1), mkMessage(2), mkMessage(3)],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n,
			status: 'active',
			metadata: { name: 'harness' }
		});

		const w = window as unknown as Record<string, unknown>;
		const outbox = await import('$lib/services/chatOutboxQueue');
		w.__enqueue = () => outbox.enqueueTextMessage({ groupId: GID, content: 'wedged hello' });
		ChatShellC = ChatShell;
		gid = GID;
	});
</script>

{#if ChatShellC}
	{@const Shell = ChatShellC as typeof import('$lib/components/chat/ChatShell.svelte').default}
	<p>gid: {gid}</p>
	<div style="height: 100vh">
		<Shell groupId={gid} title="harness" />
	</div>
{/if}
`;

async function main() {
	mkdirSync(HARNESS_DIR, { recursive: true });
	writeFileSync(HARNESS_PAGE, HARNESS_SVELTE);
	writeFileSync(`${HARNESS_DIR}/+page.ts`, "export const ssr = false;\n");
	log('harness route written');

	log('starting dev server…');
	const vite = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	let viteErr = '';
	const onOut = (d) => {
		viteErr += String(d);
	};
	vite.stdout?.on('data', onOut);
	vite.stderr?.on('data', onOut);
	const cleanup = () => {
		try {
			process.kill(-vite.pid, 'SIGTERM');
		} catch {}
		rmSync(HARNESS_DIR, { recursive: true, force: true });
	};
	process.on('exit', cleanup);

	let failed = null;
	try {
		let up = false;
		for (let i = 0; i < 60 && !up; i++) {
			await sleep(500);
			up = await fetch(BASE)
				.then((r) => r.ok)
				.catch(() => false);
		}
		if (!up) throw new Error('dev server did not come up');
		log('dev server up');

		const browser = await chromium.launch();
		const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
		await context.addInitScript((account) => {
			localStorage.setItem('accounts', JSON.stringify([account]));
			localStorage.setItem('active', account.id);
		}, ACCOUNT);
		const page = await context.newPage();
		page.on('pageerror', (e) => log('pageerror:', String(e).slice(0, 1200)));
		page.on('console', (m) => {
			if (m.type() === 'error' || m.text().includes('harness'))
				log('console:', m.type(), m.text().slice(0, 300));
		});

		await page.goto(`${BASE}/__wedged-send-harness`, {
			waitUntil: 'domcontentloaded',
			timeout: 60_000
		});
		await page.locator('[data-message-id]').first().waitFor({ timeout: 30_000 });
		log('chat rendered');

		await page.evaluate(() => window.__enqueue());
		const bubble = page.locator('[data-message-id]', { hasText: 'wedged hello' }).first();
		await bubble.waitFor({ timeout: 10_000 });
		log('wedged bubble rendered');

		// The attempt fails transiently (coordinator unreachable): the clock's
		// tooltip must carry the recorded failure reason, not the offline line.
		let tooltip = '';
		for (let i = 0; i < 60 && !tooltip; i++) {
			await sleep(1_000);
			tooltip = await page.evaluate(() => {
				const rows = document.querySelectorAll('[data-message-id]');
				for (const row of rows) {
					if (!row.textContent?.includes('wedged hello')) continue;
					const clock = row.querySelector('[aria-label^="Queued"]');
					return clock?.getAttribute('title') ?? '';
				}
				return '';
			});
		}
		if (!tooltip) throw new Error('no tooltip found on the wedged bubble');
		if (tooltip === 'Queued — will send when back online') {
			throw new Error('tooltip still the misleading offline line');
		}
		log('clock tooltip carries the real reason:', tooltip.slice(0, 80));

		// Escape hatch: message actions → Delete discards the wedged bubble.
		await bubble.hover();
		await page.locator('[aria-label="Open message actions"]').last().click();
		await page.locator('role=menuitem', { hasText: 'Delete' }).last().click();
		await sleep(500);
		const gone = await page.evaluate(
			() => !document.body.innerText.includes('wedged hello')
		);
		if (!gone) throw new Error('wedged bubble still present after Delete');

		log('PASS: wedged bubble explains itself and Delete discards it');
	} catch (e) {
		failed = e;
	} finally {
		cleanup();
	}
	if (failed) {
		console.error('[e2e] vite stderr (last 3000):', viteErr.slice(-3000));
		console.error('[e2e] FAIL:', failed.message);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error('[e2e] FAIL:', e);
	process.exit(1);
});

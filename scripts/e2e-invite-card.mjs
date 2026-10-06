/**
 * E2E: a cordn group link pasted into a chat message renders as an invite
 * card (Staircase pattern) — kind label, title from the link's ?m= metadata,
 * a Join action for a group we are not in — and the raw link text leaves the
 * bubble body the card stands in for. Show link reveals the raw form.
 *
 * Strategy: a temporary dev-only harness route mounts the REAL ChatShell on
 * a synthetic group (persistGroup) whose third peer message carries a full
 * cordn.net group share URL with ?m={"name":"Garden"}.
 *
 * Run: node scripts/e2e-invite-card.mjs
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
const HARNESS_DIR = 'src/routes/__invite-card-harness';
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
		const { encodeGroupRef } = await import('@cordn/core');
		const INVITE_CODE = encodeGroupRef({
			gid: 'garden-invite-1',
			coordinatorPubkey: 'bb'.repeat(32)
		});
		const INVITE_URL = 'https://cordn.net/chat/' + INVITE_CODE + '?m=eyJuYW1lIjoiR2FyZGVuIn0';
		const mkMessage = (i: number) => ({
			cursor: i,
			createdAt: 1000 + i,
			direction: 'inbound' as const,
			sender: PEER,
			id: 'peer-' + i,
			kind: 9,
			tags: [] as string[][],
			content:
				i === 3
					? 'come to the garden ' + INVITE_URL
					: i === 4
						? 'or scan ' + INVITE_CODE
						: 'peer message ' + i
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
			lastCursor: 5,
			fetchCursor: 5,
			messages: [mkMessage(1), mkMessage(2), mkMessage(3), mkMessage(4), mkMessage(5)],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n,
			status: 'active',
			metadata: { name: 'harness' }
		});

		const w = window as unknown as Record<string, unknown>;
		w.__inviteUrl = () => INVITE_URL;
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

		await page.goto(`${BASE}/__invite-card-harness`, {
			waitUntil: 'domcontentloaded',
			timeout: 60_000
		});
		await page.locator('[data-message-id]').first().waitFor({ timeout: 30_000 });
		log('chat rendered');

		// Card for the full share URL: kind label, ?m= title, Join action.
		const card = page.locator('text=Cordn invite · group').first();
		await card.waitFor({ timeout: 10_000 });
		const body = await page.evaluate(() => document.body.innerText);
		if (!body.includes('Garden')) throw new Error('card title from ?m= metadata missing');
		if (!body.includes('Join')) throw new Error('Join action missing for unknown group');
		// The raw link left the bubble: the cordn1 code must not appear as body text.
		const inviteUrl = await page.evaluate(() => window.__inviteUrl());
		if (body.includes(inviteUrl)) throw new Error('raw invite URL still rendered in the body');
		log('invite card rendered: label + Garden title + Join, URL stripped from body');

		// The bare code message gets its own card.
		const cardCount = await page.locator('text=Cordn invite · group').count();
		if (cardCount < 2) throw new Error(`expected 2 invite cards, found ${cardCount}`);
		log(`bare cordn1 code card rendered too (${cardCount} cards)`);

		// Show link reveals the raw form.
		await page.locator('button:has-text("Show link")').first().click();
		await sleep(200);
		const shown = await page.evaluate(() => document.body.innerText);
		if (!shown.includes(inviteUrl)) throw new Error('Show link did not reveal the raw URL');
		log('Show link reveals the raw URL');

		log('PASS: group links render as invite cards');
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

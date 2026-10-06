/**
 * E2E repro: a reply in progress (preview visible in the composer) must
 * survive new messages arriving — neither the preview nor the reply intent
 * may be dropped, or the send publishes as a plain message.
 *
 * Strategy: a temporary dev-only harness route mounts the REAL ChatShell on
 * a synthetic group (persistGroup, peer-authored messages), starts a reply
 * through the real row action, then fires the exact store write an incoming
 * message performs (replaceGroup with an appended message = the identity
 * churn that rebuilds the messages derived). Asserts the "Replying to"
 * preview survives and the composer element identity is stable.
 *
 * Run: node scripts/e2e-reply-churn.mjs
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
const HARNESS_DIR = 'src/routes/__reply-churn-harness';
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
		// The store write an incoming message performs: whole-group replace with
		// the appended message — the identity churn that rebuilds the derived
		// messages array (see the video-playback churn funnel).
		w.__appendMessage = () => {
			const group = groups.getChatGroup(GID);
			if (!group) return false;
			next += 1;
			groups.replaceGroup(GID, {
				...group,
				lastCursor: next,
				fetchCursor: next,
				messages: [...group.messages, mkMessage(next)]
			});
			return true;
		};
		w.__hasReplyPreview = () => document.body.innerText.includes('Replying to');
		// Transient groups-store gap through the real APIs (the account-switch
		// shape): no-owner reload empties the store, owner reload restores from
		// IDB. Between the two, getChatGroup misses — render must survive it.
		w.__gap = async () => {
			const am = await import('$lib/services/accountManager.svelte');
			const owner = am.manager.getActive()?.pubkey;
			await groups.reloadChatGroupsForOwner(undefined);
			// Hold the gap across a render flush — a microtask-sized gap can
			// batch away before any derived evaluates.
			await new Promise((r) => setTimeout(r, 300));
			await groups.reloadChatGroupsForOwner(owner);
		};
		w.__dupCheck = async () => {
			const direct = await import('/src/lib/services/chatGroups.svelte.ts');
			const same = direct.chatGroupsStore === groups.chatGroupsStore;
			return {
				sameStore: same,
				directSees: Boolean(direct.getChatGroup(GID)),
				aliasSees: Boolean(groups.getChatGroup(GID))
			};
		};
		w.__storeState = () => {
			const g = groups.getChatGroup(GID);
			return { gid: GID, exists: Boolean(g), msgs: g?.messages.length ?? -1 };
		};

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

		await page.goto(`${BASE}/__reply-churn-harness`, {
			waitUntil: 'domcontentloaded',
			timeout: 60_000
		});
		await page.locator('[data-message-id]').first().waitFor({ timeout: 30_000 });
		log('chat rendered');

		await page.locator('[data-message-id]').last().hover();
		await page.locator('[aria-label="Reply to message"]').last().click();
		await sleep(400);
		const previewBefore = await page.evaluate(() => window.__hasReplyPreview());
		if (!previewBefore) throw new Error('reply preview did not appear after click');
		log('reply preview visible');

		const composerBefore = await page.evaluate(() => {
			const el = document.querySelector('textarea');
			window.__composer = el;
			return Boolean(el);
		});
		if (!composerBefore) throw new Error('composer textarea not found');

		// Arrival churn — two waves, same-chat and cross-chat-shaped.
		await page.evaluate(() => window.__appendMessage());
		log('churn wave 1: incoming-message store write');
		await sleep(700);
		await page.evaluate(() => window.__appendMessage());
		log('churn wave 2: incoming-message store write');
		await sleep(700);
		log('churn wave 3: transient groups-store gap (account-switch shape)');
		await page.evaluate(() => window.__gap());
		await sleep(1_000);

		const after = await page.evaluate(
			() =>
				({
					preview: window.__hasReplyPreview(),
					sameComposer: document.querySelector('textarea') === window.__composer
				})
		);
		log('after churn:', JSON.stringify(after));

		if (!after.preview) {
			failed = new Error('reply preview disappeared on message arrival');
		} else if (!after.sameComposer) {
			failed = new Error('composer was remounted on message arrival');
		} else {
			log('PASS: reply preview and composer survived the arrival churn');
		}
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

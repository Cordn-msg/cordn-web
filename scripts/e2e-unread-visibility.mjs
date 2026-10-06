/**
 * E2E regression check: opening a group with a big unread backlog must only
 * mark the on-screen messages read (Signal-Desktop-style visibility marking),
 * not the whole history — so the unread marker survives a partial read and
 * resumes where reading stopped.
 *
 * Strategy: a temporary dev-only harness route mounts the real
 * ChatMessageList with 60 messages, presence pre-read to cursor 20 (so the
 * open lands on cursor 21 via the real open-at-first-unread focus), wired to
 * the real markChatGroupRead. Then asserts:
 *  1. after open, the read cursor advanced past 20 but stayed well below 60
 *     (only the visible window was marked),
 *  2. the focus row (first unread) sits at the top of the viewport,
 *  3. scrolling to the bottom marks everything (at-bottom → high-water,
 *     covering folded annotations).
 *
 * Run: node scripts/e2e-unread-visibility.mjs   (exit 0 = pass)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const HARNESS_DIR = 'src/routes/__unread-visibility-harness';
const HARNESS_PAGE = `${HARNESS_DIR}/+page.svelte`;
const N = 60;
const LAST_READ = 20;

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HARNESS_SVELTE = `<script lang="ts">
	import { browser } from '$app/environment';
	import ChatMessageList from '$lib/components/chat/ChatMessageList.svelte';
	import { persistGroup } from '$lib/services/chatGroups.svelte';
	import {
		markChatGroupRead,
		getChatGroupLastReadCursor
	} from '$lib/services/chatGroupPresence.svelte';
	import type { ChatMessage } from '$lib/components/chat/chat.types';

	const GID = 'unread-harness';
	const FOCUS_ID = 'm${LAST_READ}:${LAST_READ + 1}';

	const messages: ChatMessage[] = Array.from({ length: ${N} }, (_, i) => ({
		id: \`m\${i}:\${i + 1}\`,
		eventId: \`m\${i}\`,
		author: 'cc'.repeat(32),
		text: \`message \${i} — \${'lorem ipsum dolor '.repeat(3)}\`,
		kind: 9,
		createdAt: 1000 + i,
		cursor: i + 1,
		timeLabel: '12:00',
		dayLabel: 'Today'
	}));

	if (browser) {
		persistGroup({
			id: GID,
			coordinatorKey: 'aa'.repeat(32),
			createdAt: 1,
			stateBase64: '',
			lastCursor: ${N},
			fetchCursor: ${N},
			messages: Array.from({ length: ${N} }, (_, i) => ({
				cursor: i + 1,
				createdAt: 1000 + i,
				direction: 'inbound' as const,
				sender: 'cc'.repeat(32),
				id: \`m\${i}\`,
				kind: 9,
				tags: [],
				content: messages[i]!.text
			})),
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n,
			status: 'active'
		});
		// Pre-read 20 of 60: open should land on cursor 21 and mark only the
		// visible window (exact visibility mark, never clamped to the tail).
		markChatGroupRead(GID, ${LAST_READ});
	}

	const w = window as unknown as Record<string, unknown>;
	w.__readCursor = () => (browser ? getChatGroupLastReadCursor(GID) : -1);
	w.__focusRowTop = () =>
		document.querySelector('[data-message-id="' + FOCUS_ID + '"]')?.getBoundingClientRect().top ??
		null;
	w.__scroller = () => document.querySelector('.overflow-y-auto');
</script>

<div style="height: 100vh">
	<ChatMessageList
		{messages}
		initialFocusMessageId={FOCUS_ID}
		onVisibleRead={({ cursor, atBottom }) => {
			// Same handler shape as ChatShell.
			if (atBottom) markChatGroupRead(GID);
			else markChatGroupRead(GID, cursor);
		}}
	/>
</div>
`;

async function main() {
	mkdirSync(HARNESS_DIR, { recursive: true });
	writeFileSync(HARNESS_PAGE, HARNESS_SVELTE);
	log('harness route written');

	log('starting dev server…');
	const vite = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], {
		stdio: 'ignore',
		detached: true
	});
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
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } }))
			.newPage();
		page.on('pageerror', (e) => log('pageerror (tolerated):', String(e).slice(0, 160)));

		await page.goto(`${BASE}/__unread-visibility-harness`, {
			waitUntil: 'domcontentloaded',
			timeout: 60_000
		});
		await page.locator('[data-message-id]').first().waitFor({ timeout: 30_000 });
		await sleep(1_500); // let the focus flight settle and the visible pass run

		// 1. Partial mark: advanced past 20, far short of the tail (60).
		const afterOpen = await page.evaluate(() => window.__readCursor());
		log(`read cursor after open: ${afterOpen} (pre-read ${LAST_READ}, tail ${N})`);
		if (!(afterOpen > LAST_READ && afterOpen < N - 10)) {
			failed = new Error(
				`open should mark only the visible window: cursor ${afterOpen}, expected ${LAST_READ} < cursor < ${N - 10}`
			);
		}

		// 2. Open-at-first-unread still lands the marker row at the viewport top.
		if (!failed) {
			const focusTop = await page.evaluate(() => window.__focusRowTop());
			log(`focus row top offset: ${focusTop?.toFixed?.(1)}px`);
			if (focusTop === null || focusTop < -40 || focusTop > 200) {
				failed = new Error(`first-unread row not at viewport top: ${focusTop}`);
			}
		}

		// 3. Scroll to the bottom → mark everything (at-bottom high-water).
		if (!failed) {
			await page.evaluate(() => {
				const el = window.__scroller();
				el.scrollTop = el.scrollHeight;
			});
			await sleep(1_000);
			const afterBottom = await page.evaluate(() => window.__readCursor());
			log(`read cursor after scrolling to bottom: ${afterBottom}`);
			if (afterBottom !== N) {
				failed = new Error(`bottom must mark the full history: cursor ${afterBottom}, expected ${N}`);
			}
		}

		if (!failed) log('PASS: visibility-based read marking behaves as specified');
	} catch (e) {
		failed = e;
	} finally {
		cleanup();
	}
	if (failed) {
		console.error('[e2e] FAIL:', failed.message);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error('[e2e] FAIL:', e);
	process.exit(1);
});

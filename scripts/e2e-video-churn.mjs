/**
 * E2E regression check: a playing video in a chat must survive message-list
 * rebuilds (the "someone messages and the video stops" bug).
 *
 * Strategy: the fix lives in ChatMessageMedia's resolve effect, reached
 * through the real ChatMessageList → ChatMessageItem → ChatMessageMedia
 * stack. A full coordinator/MLS seeded group is impractical to fake, so this
 * mounts a temporary dev-only harness route with the real component stack and
 * one fabricated `imeta` video message, then rebuilds the messages array the
 * exact way ChatShell's `messages` derived does on every groups-store write:
 * fresh ChatMessage objects with the same tags refs (shallow), plus the
 * deeper variant where the tags array identity also churns.
 *
 * Steps:
 *  1. Encodes a real VP8/WebM clip (in-browser MediaRecorder — no ffmpeg).
 *  2. Encrypts it exactly like a cordn `imeta` attachment (chacha20poly1305,
 *     same AAD layout as chatMediaCipher), serves the ciphertext from a
 *     route-mocked URL.
 *  3. Writes src/routes/__video-churn-harness/+page.svelte (removed after
 *     the run), boots vite dev, opens the harness, plays the video.
 *  4. Fires 3 rebuild waves; asserts the SAME <video> element still plays.
 *
 * Run: node scripts/e2e-video-churn.mjs   (exit 0 = pass)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const HARNESS_DIR = 'src/routes/__video-churn-harness';
const HARNESS_PAGE = `${HARNESS_DIR}/+page.svelte`;
const MEDIA_URL = 'https://seed.local/churn-test-media';
const MIME = 'video/webm';
const FILENAME = 'churn-test.webm';

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HARNESS_SVELTE = `<script lang="ts">
	import ChatMessageList from '$lib/components/chat/ChatMessageList.svelte';
	import type { ChatMessage } from '$lib/components/chat/chat.types';

	const seed = (
		window as unknown as {
			__churnSeed?: { imeta: string[][]; keyBase64: string };
		}
	).__churnSeed;

	const base: ChatMessage = {
		id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1',
		eventId: 'a'.repeat(64),
		author: 'b'.repeat(64),
		text: 'churn test video',
		kind: 9,
		createdAt: Math.floor(Date.now() / 1000) - 60,
		timeLabel: '12:00',
		dayLabel: 'Today',
		isOwn: false,
		tags: seed?.imeta,
		mediaKeyBase64: seed?.keyBase64
	};

	let messages = $state<ChatMessage[]>([base]);

	const w = window as unknown as Record<string, unknown>;
	// Identity churn, exactly what ChatShell's \`messages\` derived produces on
	// every groups-store write: fresh objects, SAME tags refs.
	w.__churnRebuild = () => {
		messages = messages.map((m) => ({ ...m }));
	};
	// Deeper churn: tags array replaced with an equal-content copy (record
	// replaced wholesale). Same imeta hash → must also survive.
	w.__churnRebuildDeep = () => {
		messages = messages.map((m) => ({ ...m, tags: m.tags?.map((t) => [...t]) }));
	};
</script>

<div style="height: 100vh">
	<ChatMessageList {messages} />
</div>
`;

// ---------------------------------------------------------------- crypto seed
function encryptLikeApp(plaintext) {
	const key = randomBytes(32);
	const nonce = randomBytes(12);
	const enc = new TextEncoder();
	const plaintextHash = sha256(plaintext);
	const aad = new Uint8Array([
		...enc.encode(MIME),
		0x00,
		...enc.encode(FILENAME),
		0x00,
		...plaintextHash
	]);
	const blob = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
	return {
		cipher: blob,
		keyBase64: Buffer.from(key).toString('base64'),
		nonceHex: bytesToHex(nonce),
		hashHex: bytesToHex(plaintextHash)
	};
}

// ------------------------------------------------------- in-browser webm gen
async function generateWebm(browser) {
	const page = await browser.newPage();
	try {
		const dataUrl = await page.evaluate(
			() =>
				new Promise((resolve, reject) => {
					const canvas = document.createElement('canvas');
					canvas.width = 320;
					canvas.height = 240;
					const ctx = canvas.getContext('2d');
					const stream = canvas.captureStream(10);
					const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
					const chunks = [];
					rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
					rec.onerror = () => reject(new Error('MediaRecorder failed'));
					rec.onstop = () => {
						const fr = new FileReader();
						fr.onload = () => resolve(fr.result);
						fr.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
					};
					rec.start();
					let n = 0;
					const iv = setInterval(() => {
						ctx.fillStyle = n % 2 ? '#3366aa' : '#aa6633';
						ctx.fillRect(0, 0, 320, 240);
						ctx.fillStyle = '#fff';
						ctx.font = '48px sans-serif';
						ctx.fillText(String(n), 20, 130);
						// ~12s clip so playback outlives the churn window
						if (++n > 120) {
							clearInterval(iv);
							rec.stop();
						}
					}, 100);
					setTimeout(() => rec.state !== 'inactive' && rec.stop(), 15000);
				})
		);
		return Buffer.from(dataUrl.split(',')[1], 'base64');
	} finally {
		await page.close();
	}
}

// --------------------------------------------------------------------- main
async function main() {
	log('generating webm clip…');
	const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
	const plaintext = await generateWebm(browser);
	const enc = encryptLikeApp(plaintext);
	log(`clip ${plaintext.length}B, ciphertext ${enc.cipher.length}B`);

	const imetaTag = [
		'imeta',
		`url ${MEDIA_URL}`,
		`m ${MIME}`,
		`filename ${FILENAME}`,
		`x ${enc.hashHex}`,
		`n ${enc.nonceHex}`,
		'v cordn-em-v1'
	];

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

		const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
		await context.route(MEDIA_URL, (route) =>
			route.fulfill({
				status: 200,
				headers: {
					'content-type': 'application/octet-stream',
					'access-control-allow-origin': '*'
				},
				body: Buffer.from(enc.cipher)
			})
		);
		await context.addInitScript(
			(seed) => {
				window.__churnSeed = seed;
			},
			{ imeta: [imetaTag], keyBase64: enc.keyBase64 }
		);

		const page = await context.newPage();
		page.on('pageerror', (e) => log('pageerror (tolerated):', String(e).slice(0, 160)));

		await page.goto(`${BASE}/__video-churn-harness`, {
			waitUntil: 'domcontentloaded',
			timeout: 60_000
		});
		try {
			await page.locator('video').waitFor({ state: 'attached', timeout: 30_000 });
		} catch {
			log('body text:', (await page.evaluate(() => document.body.innerText)).slice(0, 400));
			await page.screenshot({ path: '/tmp/e2e-video-churn-fail.png' });
			throw new Error('video element never attached');
		}
		log('video rendered');

		await page.evaluate(() => {
			const v = document.querySelector('video');
			v.loop = true;
			window.__firstVideo = v;
			void v.play();
		});

		// Wait until genuinely playing.
		let t0 = 0;
		for (let i = 0; i < 40; i++) {
			await sleep(250);
			t0 = await page.evaluate(() => {
				const v = document.querySelector('video');
				return v ? (v.paused ? -1 : v.currentTime) : -1;
			});
			if (t0 > 0.4) break;
		}
		if (t0 < 0.4) throw new Error(`video never started playing (state=${t0})`);
		log(`playing at t=${t0.toFixed(2)}s`);

		// Churn waves — the same funnel an incoming message (any chat) drives:
		// messages array rebuilt with fresh objects → new message props →
		// ChatMessageMedia resolve effect re-runs.
		await page.evaluate(() => window.__churnRebuild());
		log('churn wave 1: shallow rebuild (same tags refs) — as on any groups-store write');
		await sleep(700);
		await page.evaluate(() => window.__churnRebuild());
		log('churn wave 2: shallow rebuild');
		await sleep(700);
		await page.evaluate(() => window.__churnRebuildDeep());
		log('churn wave 3: deep rebuild (fresh tags arrays, same imeta content)');
		await sleep(1_500);

		const after = await page.evaluate(() => {
			const v = document.querySelector('video');
			return {
				sameElement: v === window.__firstVideo,
				paused: v ? v.paused : null,
				currentTime: v ? v.currentTime : null
			};
		});
		log('after churn:', JSON.stringify(after));

		const pass = after.sameElement && after.paused === false && after.currentTime > t0 + 0.15;
		if (!pass) {
			failed = new Error(
				`video did not survive churn: ${JSON.stringify(after)} (started at ${t0.toFixed(2)}s)`
			);
			await page.screenshot({ path: '/tmp/e2e-video-churn-fail.png' });
		} else {
			log('PASS: same <video> element still playing after churn');
		}
	} catch (e) {
		failed = e;
	} finally {
		await browser.close().catch(() => {});
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

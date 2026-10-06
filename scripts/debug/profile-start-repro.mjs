/**
 * Debug repro: "start conversation from /p/... sometimes times out".
 *
 * What it proves (or disproves) with evidence:
 *  A. Happy path timing — logged-in profile page, healthy network:
 *     how long the page's own key-package fetch takes until the
 *     "Start chat" button enables. (Non-destructive: no click, no kp_take.)
 *  B. Failure repro — same page with the default coordinator's relays
 *     pointed at a local TCP server that accepts but never responds
 *     (relay/coordinator are "online"; the client's WS handshake just
 *     hangs — the "zombie relay" class): expect the full 20s deadline to
 *     burn, then "Coordinator request timed out after 20000ms", Start chat
 *     stays disabled, and NO retry/refetch happens afterwards.
 *
 * Run: node scripts/debug/profile-start-repro.mjs
 * (spawns `pnpm dev --port 5199` itself; kills it on exit)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const SILENT_RELAY_PORT = 53210;
// A pubkey that really publishes key packages on the default coordinator
// (public kp_list data, nothing consumed by this script).
const TARGET_NPUB =
	'npub1vx73e4zzusd7rery6maaej4x5878jfud32p3e5a28vq42cx7yqtqad87jz';
const DEFAULT_COORDINATOR =
	'92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5';

const dev = spawn('pnpm', ['dev', '--port', String(PORT), '--strictPort'], {
	stdio: ['ignore', 'pipe', 'pipe'],
	env: process.env
});
dev.stdout.on('data', (d) => process.stdout.write(`[dev] ${d}`));
dev.stderr.on('data', (d) => process.stderr.write(`[dev] ${d}`));

// Relay that accepts TCP and never speaks: WS handshake hangs forever.
const silentRelay = createServer((socket) => {
	socket.on('error', () => undefined);
	// never write, never close
});
silentRelay.listen(SILENT_RELAY_PORT, '127.0.0.1');

async function waitDevServer() {
	for (let i = 0; i < 90; i += 1) {
		try {
			const res = await fetch(`${BASE}/chat`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error('dev server did not come up');
}

async function login(context) {
	const page = await context.newPage();
	await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: 'Get started' }).click();
	await page.getByRole('button', { name: 'Sign up', exact: true }).first().click();
	await page.getByRole('button', { name: 'Generate a new account' }).click();
	await page
		.locator('[data-slot="dialog-footer"] button, .dialog-footer button')
		.getByText('Sign up')
		.click();
	await page.waitForFunction(() => !document.querySelector('[data-slot="dialog-content"]'), null, {
		timeout: 15_000
	});
	return page;
}

async function runScenario(label, { preseedSilentRelay = false } = {}) {
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	if (preseedSilentRelay) {
		await context.addInitScript(
			({ key, pubkey, relay }) => {
				localStorage.setItem(
					key,
					JSON.stringify({
						coordinators: [
							{
								id: pubkey,
								pubkey,
								label: 'Default coordinator',
								relays: [relay],
								isDefault: true,
								createdAt: Date.now()
							}
						]
					})
				);
			},
			{
				key: 'cordn-chat-coordinators',
				pubkey: DEFAULT_COORDINATOR,
				relay: `ws://localhost:${SILENT_RELAY_PORT}`
			}
		);
	}
	const consoleLines = [];
	context.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
	context.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message.slice(0, 200)}`));

	const t0 = Date.now();
	const page = await login(context);
	const tLogin = Date.now() - t0;

	const tNav = Date.now();
	await page.goto(`${BASE}/p/${TARGET_NPUB}`, { waitUntil: 'domcontentloaded' });
	const button = page.getByRole('button', { name: /Start chat/ });
	await button.waitFor({ state: 'visible', timeout: 60_000 });
	const tButton = Date.now() - tNav;

	const outcome = { label, tLogin, tButton, enabledAt: null, errorText: null, errorAt: null, timedOut: false };
	// Watch for the destructive error text from the moment the button appears.
	const errWatch = page
		.locator('p.text-destructive')
		.first()
		.waitFor({ state: 'visible', timeout: 45_000 })
		.then(() => (outcome.errorAt = Date.now() - tNav))
		.catch(() => undefined);
	try {
		await page.waitForFunction(
			() => {
				const els = [...document.querySelectorAll('button')];
				const b = els.find((e) => e.textContent?.includes('Start chat'));
				return b ? !b.disabled : false;
			},
			null,
			{ timeout: 40_000, polling: 250 }
		);
		outcome.enabledAt = Date.now() - tNav;
		void errWatch;
	} catch {
		outcome.timedOut = true;
		const err = page.locator('p.text-destructive, .text-destructive');
		outcome.errorText = (await err.first().textContent().catch(() => null))?.trim() ?? null;
		await errWatch;
		outcome.buttonDisabled = await button.isDisabled();
		outcome.retryButtonVisible = await page
			.getByRole('button', { name: 'Retry' })
			.isVisible()
			.catch(() => false);
		if (outcome.retryButtonVisible) {
			// The retry is an explicit probe: it must re-dial despite the read
			// backoff, so the surfaced error changes to the real transport error.
			await page.getByRole('button', { name: 'Retry' }).click();
			await page.waitForTimeout(15_000);
			outcome.retryErrorAfterClick = (await err
				.first()
				.textContent()
				.catch(() => null))
				?.trim();
		}
		// Does anything retry on its own? Watch for another 6s.
		await page.waitForTimeout(6000);
		outcome.errorStillAfter6s = outcome.errorText ===
			((await err.first().textContent().catch(() => null))?.trim() ?? null);
		outcome.buttonDisabledAfter6s = await button.isDisabled();
	}
	await browser.close();
	return { outcome, consoleLines };
}

try {
	await waitDevServer();

	const happy = await runScenario('A: healthy network');
	console.log('\n=== A. Happy path (healthy network) ===');
	console.log(JSON.stringify(happy.outcome, null, 2));

	const blocked = await runScenario('B: relay accepts TCP but never responds (zombie relay)', {
		preseedSilentRelay: true
	});
	console.log('\n=== B. Coordinator online, client<->relay path hangs ===');
	console.log(JSON.stringify(blocked.outcome, null, 2));
	console.log('\n--- console excerpt (B) ---');
	console.log(
		blocked.consoleLines
			.filter((l) => !l.includes('vite') && !l.includes('Download the'))
			.slice(-25)
			.join('\n')
	);
} catch (error) {
	console.error('[repro] failed:', error);
} finally {
	dev.kill('SIGTERM');
	spawn('pkill', ['-f', `vite dev --port ${PORT}`]);
	silentRelay.close();
	process.exit(0);
}

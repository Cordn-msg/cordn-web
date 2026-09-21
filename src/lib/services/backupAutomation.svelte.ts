/**
 * Automated local backups — opt-in, native-only.
 *
 * Key model: a random 32-byte Backup Key (BK) encrypts every backup (v2 envelope, no KDF on
 * the hot path). The BK itself is stored only in wrapped form:
 *  - Android Keystore (SecureStorePlugin): unwraps unattended on this device, no user input.
 *  - Optional passphrase wrapper: embedded in every envelope, restores on a new device.
 *  - Recovery key (hex, shown once at enable): the same BK typed by hand at restore time.
 * Nothing is derived from the nsec; the BK is fresh OS randomness.
 *
 * Backups land in Directory.Data/backups (app-private). ponytail: that copy (and the Keystore
 * key) dies on uninstall — same-device corruption recovery only; device migration rides the
 * recovery key/passphrase plus manual export. A SAF persistable-folder destination is the
 * follow-up if users need uninstall-surviving automation.
 *
 * Triggers: one run per app start (dirty starts true), on foreground, and a 10-min in-app
 * tick — all debounced through the same path, re-entrancy-guarded.
 */
import { App } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { registerPlugin } from '@capacitor/core';
import { browser } from '$app/environment';
import { bytesToBase64 } from 'ts-mls';
import { bytesToHex, hexToBytes } from 'applesauce-core/helpers';

import { clearBackupDirty, isBackupDirty } from '$lib/services/chatBackupDirty';
import {
	exportClientData,
	importClientData,
	wrapBackupKeyWithPassphrase,
	type ImportResult,
	type PassphraseWrappedBackupKey
} from '$lib/services/chatBackup.svelte';
import { isNativePlatform } from '$lib/services/nativeShims';

const SETTINGS_KEY = 'cordn.autoBackup';
const WRAPPED_KEY_STORAGE = 'cordn.autoBackup.wrappedKey';
const KEY_ALIAS = 'backup-key';
const BACKUP_DIR = 'backups';
const KEEP_COUNT = 5;
/** All trigger paths debounce through this window; fresh writes during a run re-dirty for the next. */
const DEBOUNCE_MS = 60_000;
const TICK_MS = 10 * 60_000;

interface SecureStorePlugin {
	/** value: base64 plaintext; stored only Keystore-wrapped, never on disk in the clear. */
	put(options: { alias: string; value: string }): Promise<void>;
	get(options: { alias: string }): Promise<{ value: string }>;
	delete(options: { alias: string }): Promise<void>;
}
const SecureStore = registerPlugin<SecureStorePlugin>('SecureStore');

export interface AutoBackupSettings {
	enabled: boolean;
	lastRunAt: number | null;
}

function loadSettings(): AutoBackupSettings {
	if (!browser) return { enabled: false, lastRunAt: null };
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (typeof parsed?.enabled === 'boolean') {
				return { enabled: parsed.enabled, lastRunAt: parsed.lastRunAt ?? null };
			}
		}
	} catch {
		// corrupt entry — fall through to default
	}
	return { enabled: false, lastRunAt: null };
}

function persistSettings(settings: AutoBackupSettings): void {
	if (!browser) return;
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadWrappedKeyEntry(): PassphraseWrappedBackupKey | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(WRAPPED_KEY_STORAGE);
		// Stored wrapped (useless without the passphrase or the Keystore) purely so each
		// envelope can embed it without re-running the 600k-iteration KDF per backup.
		// On-device plaintext nsec in localStorage is today's strictly-worse baseline.
		return raw ? (JSON.parse(raw) as PassphraseWrappedBackupKey) : null;
	} catch {
		return null;
	}
}

export const autoBackupStore = $state<{
	settings: AutoBackupSettings;
	running: boolean;
	lastError: string;
}>({
	settings: loadSettings(),
	running: false,
	lastError: ''
});

/** The passphrase-wrapped BK embedded into every automated envelope (null = no passphrase set). */
let wrappedKeyEntry: PassphraseWrappedBackupKey | null = loadWrappedKeyEntry();

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let appStateHooked = false;

function backupName(ts: number): string {
	// Zero-padded so lexical sort === chronological sort.
	return `cordn-backup-${String(ts).padStart(14, '0')}.json`;
}

async function getDeviceBackupKey(): Promise<string | null> {
	if (!isNativePlatform()) return null;
	try {
		const { value } = await SecureStore.get({ alias: KEY_ALIAS });
		return value || null;
	} catch {
		return null;
	}
}

/**
 * Enable automation: generate a fresh BK, store it Keystore-wrapped, optionally record a
 * passphrase wrapper for envelopes. Returns the recovery key (64 hex chars) for the UI to
 * show exactly once — it is the only offline copy of the BK outside the Keystore.
 */
export async function enableAutoBackup(passphrase?: string): Promise<string> {
	if (!isNativePlatform()) throw new Error('Automatic backups work in the Android app only');
	const keyBytes = crypto.getRandomValues(new Uint8Array(32));
	const keyB64 = bytesToBase64(keyBytes);
	await SecureStore.put({ alias: KEY_ALIAS, value: keyB64 });
	if (passphrase && passphrase.length > 0) {
		wrappedKeyEntry = await wrapBackupKeyWithPassphrase(passphrase, keyB64);
		localStorage.setItem(WRAPPED_KEY_STORAGE, JSON.stringify(wrappedKeyEntry));
	}
	autoBackupStore.settings = { enabled: true, lastRunAt: null };
	autoBackupStore.lastError = '';
	persistSettings(autoBackupStore.settings);
	return bytesToHex(keyBytes);
}

export function disableAutoBackup(): void {
	autoBackupStore.settings = { ...autoBackupStore.settings, enabled: false };
	persistSettings(autoBackupStore.settings);
}

/** Forget the BK and any passphrase wrapper (called from the UI's explicit reset path). */
export async function forgetAutoBackupKey(): Promise<void> {
	wrappedKeyEntry = null;
	if (browser) localStorage.removeItem(WRAPPED_KEY_STORAGE);
	if (isNativePlatform()) {
		try {
			await SecureStore.delete({ alias: KEY_ALIAS });
		} catch {
			// already gone
		}
	}
}

async function rotateBackups(keep = KEEP_COUNT): Promise<void> {
	const { files } = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Data });
	const names = files
		.map((f) => f.name)
		.filter((n) => n.startsWith('cordn-backup-') && n.endsWith('.json'))
		.sort();
	for (const name of names.slice(0, Math.max(0, names.length - keep))) {
		await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${name}`, directory: Directory.Data });
	}
}

/**
 * Run one automated backup now (respects the same guards as the scheduler; exposed so the
 * settings UI offers "Back up now"). Returns false when skipped (no account / no key / busy).
 */
export async function runAutoBackup(): Promise<boolean> {
	if (!isNativePlatform() || !autoBackupStore.settings.enabled || autoBackupStore.running) {
		return false;
	}
	const backupKey = await getDeviceBackupKey();
	if (!backupKey) {
		autoBackupStore.lastError = 'Backup key missing — disable and re-enable automatic backups';
		return false;
	}
	autoBackupStore.running = true;
	try {
		const payload = await exportClientData({
			includeMessages: true,
			backupKey,
			// Embed the stored passphrase wrapper (if any) so the file is self-contained for device
			// migration. It was wrapped once at enable time — no KDF on this hot path.
			preWrappedKey: wrappedKeyEntry
		});
		// Never a Blob: string path only — the Blob→base64 re-encode was the Android OOM crash.
		const ts = Date.now();
		const tmp = `${BACKUP_DIR}/.tmp-${ts}.json`;
		await Filesystem.writeFile({
			path: tmp,
			data: payload,
			directory: Directory.Data,
			encoding: Encoding.UTF8,
			recursive: true
		});
		await Filesystem.rename({
			from: tmp,
			to: `${BACKUP_DIR}/${backupName(ts)}`,
			directory: Directory.Data,
			toDirectory: Directory.Data
		});
		await rotateBackups();
		autoBackupStore.settings = { enabled: true, lastRunAt: ts };
		autoBackupStore.lastError = '';
		persistSettings(autoBackupStore.settings);
		clearBackupDirty();
		return true;
	} catch (error) {
		autoBackupStore.lastError = error instanceof Error ? error.message : 'Backup failed';
		return false;
	} finally {
		autoBackupStore.running = false;
	}
}

function maybeScheduleRun(): void {
	if (!autoBackupStore.settings.enabled || !isNativePlatform()) return;
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		if (isBackupDirty()) void runAutoBackup();
	}, DEBOUNCE_MS);
}

/**
 * Wire the scheduler. Call once from the root layout (no-op on web / when disabled). Boot and
 * foreground both funnel through the debounce; the tick covers long-lived foreground sessions.
 */
export function initAutoBackup(): void {
	if (!browser || !isNativePlatform()) return;
	if (!appStateHooked) {
		appStateHooked = true;
		void App.addListener('appStateChange', ({ isActive }) => {
			if (isActive) maybeScheduleRun();
		});
	}
	if (!tickTimer) {
		tickTimer = setInterval(maybeScheduleRun, TICK_MS);
	}
	maybeScheduleRun();
}

export async function listDeviceBackups(): Promise<string[]> {
	if (!isNativePlatform()) return [];
	try {
		const { files } = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Data });
		return files
			.map((f) => f.name)
			.filter((n) => n.startsWith('cordn-backup-') && n.endsWith('.json'))
			.sort();
	} catch {
		return []; // dir not created yet
	}
}

export async function readLatestDeviceBackup(): Promise<{ name: string; text: string } | null> {
	const names = await listDeviceBackups();
	const latest = names.at(-1);
	if (!latest) return null;
	const res = await Filesystem.readFile({
		path: `${BACKUP_DIR}/${latest}`,
		directory: Directory.Data,
		encoding: Encoding.UTF8
	});
	return { name: latest, text: typeof res.data === 'string' ? res.data : '' };
}

/**
 * Restore the latest on-device backup. Tries the Keystore BK first (no typing on the same
 * device); `credentials` carries a typed recovery key or passphrase for the reinstall case.
 */
export async function restoreLatestDeviceBackup(credentials?: {
	backupKeyHex?: string;
	passphrase?: string;
}): Promise<ImportResult> {
	const latest = await readLatestDeviceBackup();
	if (!latest) throw new Error('No device backup found');
	// Typed recovery key wins (also validates it), else the Keystore device key; the passphrase
	// rides along either way for envelopes that only carry a passphrase wrapper.
	const typed = credentials?.backupKeyHex?.trim().toLowerCase();
	if (typed && !/^[0-9a-f]{64}$/.test(typed)) {
		throw new Error('Recovery key must be 64 hex characters');
	}
	const backupKey = typed ? bytesToBase64(hexToBytes(typed)) : await getDeviceBackupKey();
	return importClientData(latest.text, {
		backupKey,
		passphrase: credentials?.passphrase ?? null
	});
}

/**
 * Intro and backup state.
 *
 * Two small localStorage facts, deliberately not a store or a schema:
 *  - intro seen: one browser, whatever identity shows up next;
 *  - backup confirmed: per identity, so the chat-home "save a copy" prompt
 *    clears the moment the user actually has a copy.
 *
 * `revision` is the reactivity hook: per-identity getters read it so a
 * `$derived` in a component re-runs after any write in this tab.
 */
import { browser } from '$app/environment';

const INTRO_KEY = 'cordn.introSeen';
const BACKUP_PREFIX = 'cordn.backupConfirmed.';

const flags = $state({
	introSeen: browser ? localStorage.getItem(INTRO_KEY) === '1' : true,
	revision: 0
});

function read(key: string): boolean {
	return browser && localStorage.getItem(key) === '1';
}

function write(key: string, value: boolean): void {
	if (!browser) return;
	if (value) localStorage.setItem(key, '1');
	else localStorage.removeItem(key);
}

export function hasSeenIntro(): boolean {
	return flags.introSeen;
}

export function markIntroSeen(): void {
	if (flags.introSeen) return;
	flags.introSeen = true;
	write(INTRO_KEY, true);
}

export function hasConfirmedBackup(pubkey: string | undefined): boolean {
	void flags.revision;
	return Boolean(pubkey) && read(`${BACKUP_PREFIX}${pubkey}`);
}

export function markBackupConfirmed(pubkey: string | undefined): void {
	if (!pubkey) return;
	write(`${BACKUP_PREFIX}${pubkey}`, true);
	flags.revision++;
}

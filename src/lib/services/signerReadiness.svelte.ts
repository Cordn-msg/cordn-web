import type { IAccount } from 'applesauce-accounts';
import { ExtensionSigner } from 'applesauce-signers/signers';

/**
 * Identity readiness gate.
 *
 * Coordinator activity must not start until the active identity can actually
 * sign. NIP-07 extension signers race app startup (the content script injects
 * `window.nostr` asynchronously), which used to surface as spurious
 * "Signer extension missing" coordinator errors on a fresh open — errors that
 * then poisoned per-coordinator health state. Gating here closes the race at
 * its source; `withCoordinatorClientRetry` remains the backstop for signers
 * that wake late mid-session (NIP-46 bunkers, NIP-55 Amber), which cannot be
 * probed cheaply and so are treated as ready immediately.
 */
export const signerReadinessStore = $state<{ waiting: boolean }>({ waiting: false });

const POLL_INTERVAL_MS = 100;
/** Bounded wait: past this the tick proceeds and the retry ladder owns recovery. */
const GATE_TIMEOUT_MS = 8_000;
/** Only surface the "waiting" hint if the extension is genuinely slow to inject. */
const HINT_AFTER_MS = 1_500;

/** Accounts whose gate has settled (positively or negatively) this session. */
const gateSettled = new Set<string>();

function extensionNostrPresent(): boolean {
	return typeof window !== 'undefined' && 'nostr' in window;
}

/**
 * Wait (bounded) for the account's signer to be usable. Returns whether the
 * signer was confirmed ready; `false` only means "gave up waiting" — callers
 * proceed regardless and rely on the retry ladder.
 */
export async function ensureSignerReady(account: IAccount): Promise<boolean> {
	if (!(account.signer instanceof ExtensionSigner) || extensionNostrPresent()) {
		gateSettled.add(account.id);
		return true;
	}
	if (gateSettled.has(account.id)) {
		// Settled negative earlier this session; re-polling every tick would stall
		// each one for the full window.
		return false;
	}

	const startedAt = Date.now();
	let hintTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
		hintTimer = null;
		signerReadinessStore.waiting = true;
	}, HINT_AFTER_MS);
	try {
		while (!extensionNostrPresent()) {
			if (Date.now() - startedAt >= GATE_TIMEOUT_MS) {
				gateSettled.add(account.id);
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		gateSettled.add(account.id);
		return true;
	} finally {
		if (hintTimer) clearTimeout(hintTimer);
		signerReadinessStore.waiting = false;
	}
}

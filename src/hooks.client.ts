/**
 * Client-side error diagnostics. Two crash reports in the field arrived with no logs to share;
 * this keeps a small ring buffer of the last uncaught errors in localStorage so users can copy
 * them from a future diagnostics surface (or via remote debugging). Cheap fire-and-forget —
 * every write is wrapped, so diagnostics can never *become* the crash.
 */
import type { HandleClientError } from '@sveltejs/kit';

const KEY = 'cordn.diagnostics';
const MAX_ENTRIES = 20;
const MAX_STACK = 2000;

interface DiagnosticsEntry {
	t: number;
	kind: 'error' | 'rejection';
	message: string;
	stack?: string;
	version: string;
	url: string;
}

function recordDiagnostics(kind: DiagnosticsEntry['kind'], error: unknown): void {
	try {
		const entry: DiagnosticsEntry = {
			t: Date.now(),
			kind,
			message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			stack: error instanceof Error && error.stack ? error.stack.slice(0, MAX_STACK) : undefined,
			version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
			url: location.href
		};
		const raw = localStorage.getItem(KEY);
		const list: DiagnosticsEntry[] = raw ? JSON.parse(raw) : [];
		list.push(entry);
		localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
	} catch {
		// Storage unavailable (private mode, quota) — diagnostics are best-effort only.
	}
}

export const handleError: HandleClientError = async ({ error }) => {
	recordDiagnostics('error', error);
	// Unknown errors stay opaque to the UI; expected ones (BackupError etc.) never reach here —
	// callers toast them before rethrowing would.
	return { message: 'Unexpected error' };
};

window.addEventListener('unhandledrejection', (event) => {
	recordDiagnostics('rejection', event.reason);
});

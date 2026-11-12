/**
 * Opt-in chat read/write tracing, for finding "why is this tab busy".
 *
 * Off by default and free when off (one `localStorage` read per call site,
 * nothing else). Turn it on with `localStorage.setItem('cordn.traceChat', '1')`
 * and reload: each hook then logs its label, so a repeated line names the loop.
 * Startup hooks (`loadGroups`, `watch tick`, `watch backlog`) split boot cost
 * between IndexedDB hydration, relay round trip and decrypt/apply.
 *
 * This exists because the open-group CPU burn had no visible cause: main-thread
 * JavaScript looked idle, and the cost was thousands of tiny IndexedDB callbacks
 * per second. The counters here answer "how often is this path running" without
 * guessing.
 */

const TRACE_FLAG_KEY = 'cordn.traceChat';

let cached: boolean | undefined;

export function isChatTracing(): boolean {
	if (typeof localStorage === 'undefined') return false;
	// Cached: callers sit on read paths, so this must not touch storage per call.
	// Toggling the flag therefore needs a reload, as the header says.
	cached ??= localStorage.getItem(TRACE_FLAG_KEY) === '1';
	return cached;
}

/** Log one trace line when tracing is on. Callers pass already-cheap data. */
export function traceChat(label: string, detail?: Record<string, unknown>): void {
	if (!isChatTracing()) return;
	if (detail) console.debug(`[chat-trace] ${label}`, detail);
	else console.debug(`[chat-trace] ${label}`);
}

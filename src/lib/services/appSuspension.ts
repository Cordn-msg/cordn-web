/**
 * A monotonic clock can keep ticking while JS is suspended, so clock drift
 * cannot prove a page stayed alive. Explicit freeze/bfcache/native events
 * take precedence; elapsed hidden time is the web fallback.
 * ponytail: long benign tab hides also rebuild; preserve warm sockets only if
 * measured reconnect cost justifies a more selective policy.
 */
export function shouldRebuildAfterBackground(hiddenAt: number | null, now = Date.now()): boolean {
	return hiddenAt !== null && now - hiddenAt >= 10_000;
}

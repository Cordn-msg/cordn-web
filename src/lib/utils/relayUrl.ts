/**
 * Whether this page can open a websocket to `url` at all.
 *
 * Browsers block `ws://` from an HTTPS page as mixed content before a socket
 * exists, so such a relay can only ever fail: no handshake, no retry that can
 * succeed, one console error per attempt. Loopback stays usable because local
 * development and local coordinators legitimately run `ws://` there.
 */
export function isRelayUrlReachable(url: string, pageProtocol: string): boolean {
	if (!url.trim().toLowerCase().startsWith('ws://')) return true;
	// HTTP pages (local dev, self-hosted over LAN) are not restricted.
	if (pageProtocol !== 'https:') return true;
	let hostname: string;
	try {
		hostname = new URL(url.trim()).hostname;
	} catch {
		// Malformed: let the connection layer report it as it always has.
		return true;
	}
	return (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname === '[::1]'
	);
}

/** {@link isRelayUrlReachable} against the current page (no filtering off-browser). */
export function isRelayReachableHere(url: string): boolean {
	const protocol = typeof location === 'undefined' ? '' : location.protocol;
	return isRelayUrlReachable(url, protocol);
}

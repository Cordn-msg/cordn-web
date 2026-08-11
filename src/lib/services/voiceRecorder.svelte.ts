import { browser } from '$app/environment';

/**
 * Voice-note recorder: a thin reactive wrapper around `getUserMedia` +
 * `MediaRecorder` + an `AnalyserNode`. Owns the mic permission, the recording
 * lifecycle, and the live waveform preview. Web and
 * the Capacitor Android WebView share ONE code path — the WebView's
 * `onPermissionRequest` is bridged to the runtime `RECORD_AUDIO` prompt by
 * Capacitor's `BridgeWebChromeClient` (declared in AndroidManifest.xml).
 *
 * Reactive surface (state/elapsedMs/livePeaks/error) is read via getters so a
 * Svelte 5 consumer stays reactive after destructuring. The heavy per-frame
 * audio math runs on the main thread — `AnalyserNode` is real-time-only and
 * can't cross a worker boundary, and it's cheap by design. Computed peaks are
 * kept in a non-reactive buffer and only snapshotted to `livePeaks` on a
 * throttle so a 60fps rAF doesn't flood the renderer.
 */

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'locked' | 'error';

export interface RecordingResult {
	readonly file: File;
	readonly mime: string;
	/** Wall-clock recording length, for the `imeta` `duration` hint + player UI. */
	readonly durationMs: number;
	/** Normalized 0–1 amplitude peaks (~48) driving the stored waveform. */
	readonly peaks: number[];
}

/** Mime types we'll accept, most-preferred first. `audio/webm;codecs=opus` is
 *  the Chromium default (WebView + desktop Chrome/Firefox): tiny, great
 *  quality, and `<audio>` decodes it on Android. mp4/aac is the fallback. */
const MIME_CANDIDATES = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/mp4;codecs=mp4a.40.2',
	'audio/mp4',
	'audio/ogg;codecs=opus'
];

const TARGET_PEAKS = 48;
const MIN_KEEPABLE_BYTES = 200;
const MIN_KEEPABLE_MS = 300;
const LIVE_PEAK_THROTTLE_MS = 70;
const ELAPSED_TICK_MS = 200;
// First-ever getUserMedia on Android WebView triggers the OS dialog and rejects
// immediately; a single retry after a beat succeeds once the user grants.
// Mirrors the documented Capacitor voice-record fix (Proxy2021/Enso@a8b2b28).
const PERMISSION_RETRY_MS = 500;
// If getUserMedia takes longer than this, a native permission dialog almost
// certainly appeared (and consumed the pointer gesture). We then start
// hands-free (locked) so explicit send/trash controls stay reachable — the
// hold-to-release gesture can't survive a system dialog. This timing heuristic
// replaces an unreliable Permissions-API pre-check on Android WebView.
// ponytail: heuristic threshold; tune if a slow-but-granted mic mis-locks.
const PERMISSION_DIALOG_THRESHOLD_MS = 700;

function pickMime(): string {
	if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function')
		return '';
	for (const candidate of MIME_CANDIDATES) {
		if (MediaRecorder.isTypeSupported(candidate)) return candidate;
	}
	return '';
}

function mimeExtension(mime: string): string {
	if (mime.includes('webm')) return 'webm';
	if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
	if (mime.includes('ogg')) return 'ogg';
	return 'audio';
}

/** Reduce a per-frame peak list to `target` max-bucket peaks, preserving shape. */
export function downsample(samples: number[], target: number): number[] {
	if (samples.length <= target) return samples.slice();
	const bucketSize = samples.length / target;
	const out: number[] = [];
	for (let i = 0; i < target; i++) {
		const start = Math.floor(i * bucketSize);
		const end = Math.floor((i + 1) * bucketSize);
		let max = 0;
		for (let j = start; j < end; j++) {
			const v = samples[j];
			if (v !== undefined && v > max) max = v;
		}
		out.push(max);
	}
	return out;
}

export function isVoiceRecordingSupported(): boolean {
	return (
		browser &&
		typeof navigator !== 'undefined' &&
		!!navigator.mediaDevices?.getUserMedia &&
		typeof MediaRecorder !== 'undefined'
	);
}

export interface VoiceRecorder {
	readonly state: RecorderState;
	readonly elapsedMs: number;
	readonly livePeaks: number[];
	readonly error: string | null;
	/** Begin recording (hold-to-record). Resolves once recording is actually
	 *  running; on a permission failure lands in `state === 'error'` with
	 *  `error` set, and resolves without recording. If the first-ever call needs
	 *  a native permission dialog (detected via getUserMedia timing), the
	 *  recording starts hands-free (locked) because the system dialog orphans the
	 *  hold gesture — explicit send/trash controls then stay reachable. */
	start(): Promise<void>;
	/** Switch a held recording to hands-free ("locked") mode. No-op otherwise. */
	lock(): void;
	/** Stop and return the recording to send, or null if nothing was captured
	 *  (too short / empty / never started). */
	stop(): Promise<RecordingResult | null>;
	/** Stop and discard. Safe at any state. */
	cancel(): Promise<void>;
	/** Sync teardown for component unmount — discards in-flight audio. */
	destroy(): void;
}

export function createVoiceRecorder(): VoiceRecorder {
	let state = $state<RecorderState>('idle');
	let elapsedMs = $state(0);
	let livePeaks = $state<number[]>([]);
	let error = $state<string | null>(null);

	let stream: MediaStream | null = null;
	let recorder: MediaRecorder | null = null;
	let audioContext: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let sampleBuffer: Uint8Array<ArrayBuffer> | null = null;
	let chunks: BlobPart[] = [];
	let rawPeaks: number[] = [];
	let mime = '';
	let startTs = 0;
	let rafId = 0;
	let elapsedTimer = 0;
	let liveThrottleLast = 0;
	// Guards a double stop/cancel and a cancel-during-requesting: once true, the
	// recording is finalizing or aborted and `start`/`stop`/`cancel` no-op.
	let finished = false;
	// Generation counter so a superseded in-flight `start` (user re-pressed the
	// mic while the first was still awaiting the permission prompt) releases its
	// own stream without clobbering the newer attempt's shared state — prevents a
	// dangling MediaStream (mic indicator stuck on).
	let generation = 0;

	function resetCounters(): void {
		startTs = Date.now();
		elapsedMs = 0;
		liveThrottleLast = 0;
		chunks = [];
		rawPeaks = [];
		livePeaks = [];
	}

	function tick(): void {
		if (!analyser || !sampleBuffer || state === 'idle') return;
		analyser.getByteTimeDomainData(sampleBuffer);
		let peak = 0;
		for (let i = 0; i < sampleBuffer.length; i++) {
			const v = (sampleBuffer[i] - 128) / 128;
			const abs = v < 0 ? -v : v;
			if (abs > peak) peak = abs;
		}
		rawPeaks.push(peak);
		const now = performance.now();
		if (now - liveThrottleLast >= LIVE_PEAK_THROTTLE_MS) {
			liveThrottleLast = now;
			livePeaks = downsample(rawPeaks, TARGET_PEAKS);
		}
		rafId = requestAnimationFrame(tick);
	}

	async function acquireStream(): Promise<MediaStream> {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('Microphone is not available on this device');
		}
		try {
			return await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			// Permission dialog may have just been shown — wait and retry once.
			await new Promise((resolve) => setTimeout(resolve, PERMISSION_RETRY_MS));
			return navigator.mediaDevices.getUserMedia({ audio: true });
		}
	}

	async function start(): Promise<void> {
		if (state === 'recording' || state === 'locked' || state === 'requesting') return;
		if (!isVoiceRecordingSupported()) {
			error = 'Voice recording is not supported on this device';
			state = 'error';
			return;
		}
		mime = pickMime();
		error = null;
		const mine = ++generation;
		finished = false;
		state = 'requesting';
		const acquireStartedAt = performance.now();
		try {
			stream = await acquireStream();
		} catch (err) {
			// Superseded by a newer start(): the newer attempt owns error handling.
			if (mine !== generation) return;
			// A cancel/drag-away that landed while the permission prompt was open
			// leaves `finished` true — tear down silently, no error surface.
			if (finished) {
				teardown();
				return;
			}
			error =
				err instanceof Error
					? err.name === 'NotAllowedError'
						? 'Microphone permission was denied'
						: err.message
					: 'Could not access microphone';
			state = 'error';
			return;
		}
		// Superseded by a newer start(): release this stream but leave the newer
		// attempt's state untouched (it owns the shared fields now).
		if (mine !== generation) {
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
			return;
		}
		if (finished) {
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
			teardown();
			return;
		}
		try {
			audioContext = new AudioContext();
			const source = audioContext.createMediaStreamSource(stream);
			analyser = audioContext.createAnalyser();
			analyser.fftSize = 1024;
			sampleBuffer = new Uint8Array(analyser.fftSize);
			source.connect(analyser);
			// No analyser→destination connect: we don't monitor playback live.
			recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
			recorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) chunks.push(event.data);
			};
			recorder.start();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not start recording';
			state = 'error';
			teardown();
			return;
		}
		resetCounters();
		elapsedTimer = window.setInterval(() => {
			elapsedMs = Date.now() - startTs;
		}, ELAPSED_TICK_MS);
		rafId = requestAnimationFrame(tick);
		const dialogShown = performance.now() - acquireStartedAt > PERMISSION_DIALOG_THRESHOLD_MS;
		state = dialogShown ? 'locked' : 'recording';
	}

	function lock(): void {
		if (state === 'recording') state = 'locked';
	}

	/** Stop the recorder, await its final chunk, and either build a keepable
	 *  `RecordingResult` (send=true) or discard (send=false). Always tears down. */
	function finalize(send: boolean): Promise<RecordingResult | null> {
		if (finished) return Promise.resolve(null);
		finished = true;
		cancelAnimationFrame(rafId);
		rafId = 0;
		if (elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = 0;
		}
		const durationMs = Date.now() - startTs;
		const peaks = downsample(rawPeaks, TARGET_PEAKS);
		const active = recorder;
		return new Promise<RecordingResult | null>((resolve) => {
			if (!active || active.state === 'inactive') {
				teardown();
				resolve(null);
				return;
			}
			active.onstop = () => {
				let result: RecordingResult | null = null;
				if (send && chunks.length > 0 && durationMs >= MIN_KEEPABLE_MS && peaks.length > 0) {
					const blobType = mime || (chunks[0] as Blob).type || 'audio/webm';
					const blob = new Blob(chunks, { type: blobType });
					if (blob.size >= MIN_KEEPABLE_BYTES) {
						const file = new File([blob], `voice-${Date.now()}.${mimeExtension(blobType)}`, {
							type: blob.type
						});
						result = { file, mime: blob.type, durationMs, peaks };
					}
				}
				teardown();
				resolve(result);
			};
			try {
				active.stop();
			} catch {
				teardown();
				resolve(null);
			}
		});
	}

	async function stop(): Promise<RecordingResult | null> {
		if (state !== 'recording' && state !== 'locked') return null;
		return finalize(true);
	}

	async function cancel(): Promise<void> {
		// A cancel during the permission prompt: flag so `start` tears down once
		// the stream resolves, and reset to idle immediately for the UI.
		if (state === 'requesting') {
			finished = true;
			state = 'idle';
			return;
		}
		if (state !== 'recording' && state !== 'locked') return;
		await finalize(false);
	}

	function teardown(): void {
		cancelAnimationFrame(rafId);
		rafId = 0;
		if (elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = 0;
		}
		if (recorder) {
			recorder.ondataavailable = null;
			recorder.onstop = null;
			recorder = null;
		}
		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
		}
		if (audioContext && audioContext.state !== 'closed') {
			void audioContext.close().catch(() => {});
		}
		audioContext = null;
		analyser = null;
		sampleBuffer = null;
		chunks = [];
		rawPeaks = [];
		state = 'idle';
		elapsedMs = 0;
		livePeaks = [];
	}

	function destroy(): void {
		finished = true;
		// Stop the recorder first so its async tail doesn't fire handlers after
		// we null them, then sync-teardown the rest.
		if (recorder && recorder.state !== 'inactive') {
			recorder.onstop = null;
			recorder.ondataavailable = null;
			try {
				recorder.stop();
			} catch {
				/* already tearing down */
			}
		}
		teardown();
		error = null;
	}

	return {
		get state() {
			return state;
		},
		get elapsedMs() {
			return elapsedMs;
		},
		get livePeaks() {
			return livePeaks;
		},
		get error() {
			return error;
		},
		start,
		lock,
		stop,
		cancel,
		destroy
	};
}

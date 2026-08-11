<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { formatClock } from '$lib/utils';
	import { voicePlayback } from '$lib/services/voicePlayback.svelte';
	import Play from '@lucide/svelte/icons/play';
	import Pause from '@lucide/svelte/icons/pause';
	import { downsample } from '$lib/services/voiceRecorder.svelte';

	/**
	 * Inline voice-note player: play/pause, a click-to-seek waveform, and a
	 * `currentTime / duration` clock. One hidden `<audio>` drives everything;
	 * native decoding is already off-main-thread, so there is nothing to worker
	 * here. The waveform peaks are precomputed (live-recorded) and carried in the
	 * `imeta`, so this renders instantly with zero decode cost — the audio bytes
	 * are only fetched when the user hits play (lazily, via the encrypted-media
	 * cache, same as images).
	 *
	 * `id` ties this player into the `voicePlayback` singleton so only one note
	 * plays at a time across the whole chat.
	 */
	let {
		url,
		durationMs,
		waveform = [],
		isOwn = false,
		id = ''
	}: {
		url: string;
		durationMs?: number;
		waveform?: number[];
		isOwn?: boolean;
		id?: string;
	} = $props();

	let audioEl = $state<HTMLAudioElement | null>(null);
	let trackEl = $state<HTMLDivElement | null>(null);
	let isPlaying = $state(false);
	let currentTime = $state(0);
	// NaN until <audio> metadata loads; falls back to the imeta `durationMs`.
	let realDuration = $state<number>(NaN);

	const durationSec = $derived(
		Number.isFinite(realDuration) && realDuration > 0 ? realDuration : (durationMs ?? 0) / 1000
	);
	// The stored waveform can hold ~48 peaks — too many for a ~120px message
	// bubble, where flex-1 bars (flex-basis 0) collapse toward 0 width once gaps
	// consume the track. Downsample to a display-friendly count so each bar stays
	// visibly wide; shape is preserved (max-per-bucket).
	const displayWaveform = $derived(downsample(waveform, 36));
	const playedBars = $derived(
		durationSec > 0 ? Math.round((currentTime / durationSec) * displayWaveform.length) : 0
	);

	// Another player started → pause ourselves. Reads the singleton reactively.
	$effect(() => {
		const active = voicePlayback.activeId;
		if (active !== id && audioEl && !audioEl.paused) audioEl.pause();
	});

	onDestroy(() => {
		if (audioEl) {
			audioEl.pause();
			audioEl.removeAttribute('src');
			audioEl.load();
		}
		voicePlayback.stop(id);
	});

	function toggle() {
		if (!audioEl) return;
		if (audioEl.paused) {
			voicePlayback.play(id);
			void audioEl.play();
		} else {
			audioEl.pause();
		}
	}

	function seekToRatio(ratio: number) {
		if (!audioEl || durationSec <= 0) return;
		const clamped = Math.min(1, Math.max(0, ratio));
		audioEl.currentTime = clamped * durationSec;
		currentTime = audioEl.currentTime;
	}

	function onTrackClick(event: MouseEvent) {
		if (!trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		seekToRatio((event.clientX - rect.left) / rect.width);
	}

	function onTrackKeydown(event: KeyboardEvent) {
		if (durationSec <= 0) return;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			seekToRatio((audioEl?.currentTime ?? 0) / durationSec - 0.05);
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			seekToRatio((audioEl?.currentTime ?? 0) / durationSec + 0.05);
		}
	}

	function onPlay() {
		isPlaying = true;
		voicePlayback.play(id);
	}
	function onPause() {
		isPlaying = false;
		voicePlayback.stop(id);
	}
	function onEnded() {
		isPlaying = false;
		currentTime = 0;
		voicePlayback.stop(id);
	}
</script>

<div class="flex w-full min-w-0 items-center gap-2">
	<Button
		type="button"
		variant={isOwn ? 'secondary' : 'default'}
		size="icon"
		class="size-9 shrink-0 rounded-full"
		onclick={toggle}
		aria-label={isPlaying ? 'Pause voice note' : 'Play voice note'}
	>
		{#if isPlaying}
			<Pause class="size-4" />
		{:else}
			<Play class="size-4 translate-x-0.5" />
		{/if}
	</Button>

	{#if waveform.length > 0}
		<div
			bind:this={trackEl}
			role="slider"
			aria-label="Seek voice note"
			aria-valuemin={0}
			aria-valuemax={Math.round(durationSec)}
			aria-valuenow={Math.round(currentTime)}
			tabindex={0}
			onclick={onTrackClick}
			onkeydown={onTrackKeydown}
			class="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-[1px] overflow-hidden"
		>
			{#each displayWaveform as peak, i (i)}
				<div
					class="min-w-[2px] flex-1 rounded-full transition-colors"
					class:bar-played-own={isOwn && i < playedBars}
					class:bar-unplayed-own={isOwn && i >= playedBars}
					class:bar-played-other={!isOwn && i < playedBars}
					class:bar-unplayed-other={!isOwn && i >= playedBars}
					style={`height: ${Math.max(10, Math.round(peak * 100))}%`}
				></div>
			{/each}
		</div>
	{:else}
		<!-- No precomputed peaks (older/foreign sender): a plain progress track. -->
		<div class="relative h-1.5 min-w-0 flex-1 rounded-full bg-foreground/20">
			<div
				class="absolute inset-y-0 left-0 rounded-full"
				class:bg-primary-foreground={isOwn}
				class:bg-primary={!isOwn}
				style={`width: ${Math.round((durationSec > 0 ? currentTime / durationSec : 0) * 100)}%`}
			></div>
		</div>
	{/if}

	<span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
		{formatClock(currentTime)} / {formatClock(durationSec)}
	</span>
</div>

<audio
	bind:this={audioEl}
	src={url}
	preload="metadata"
	onplay={onPlay}
	onpause={onPause}
	onended={onEnded}
	ontimeupdate={() => audioEl && (currentTime = audioEl.currentTime)}
	onloadedmetadata={() => audioEl && (realDuration = audioEl.duration)}
></audio>

<style>
	.bar-played-own {
		background-color: var(--color-primary-foreground);
	}
	.bar-unplayed-own {
		background-color: color-mix(in oklab, var(--color-primary-foreground) 40%, transparent);
	}
	.bar-played-other {
		background-color: var(--color-primary);
	}
	.bar-unplayed-other {
		background-color: color-mix(in oklab, var(--color-muted-foreground) 45%, transparent);
	}
</style>

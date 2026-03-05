/**
 * Audio file loading and playback system.
 *
 * Loads audio files into an AudioBuffer, then provides transport
 * controls (play, pause, stop, seek) with a time-update callback
 * driven by requestAnimationFrame for UI synchronisation.
 */

export type TimeUpdateCallback = (current: number, duration: number) => void;

export class AudioFileLoader {
  private ctx: AudioContext;
  private destination: AudioNode;
  private buffer: AudioBuffer | null = null;
  private fileName: string | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playing = false;
  private startOffset = 0;
  private startTime = 0;
  private onTimeUpdate: TimeUpdateCallback | null = null;
  private rafId = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /** Decode an audio File into a playable buffer. */
  async loadFile(file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.fileName = file.name;
    this.stop();
  }

  /** Decoded audio buffer (read-only reference). */
  getBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  /** Name of the currently loaded source file, if any. */
  getLoadedFileName(): string | null {
    return this.fileName;
  }

  // ---------------------------------------------------------------------------
  // Read-only properties
  // ---------------------------------------------------------------------------

  /** Total duration of the loaded buffer in seconds. */
  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** Current playback position in seconds. */
  get currentTime(): number {
    if (!this.playing) {
      return this.startOffset;
    }
    return this.startOffset + (this.ctx.currentTime - this.startTime);
  }

  /** Whether audio is currently playing. */
  get isPlaying(): boolean {
    return this.playing;
  }

  // ---------------------------------------------------------------------------
  // Callbacks
  // ---------------------------------------------------------------------------

  /** Register a callback invoked every animation frame during playback. */
  setTimeUpdateCallback(cb: TimeUpdateCallback): void {
    this.onTimeUpdate = cb;
  }

  // ---------------------------------------------------------------------------
  // Transport controls
  // ---------------------------------------------------------------------------

  /** Start or resume playback from the current offset. */
  play(): void {
    if (!this.buffer || this.playing) {
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.destination);
    source.start(0, this.startOffset);

    this.source = source;
    this.startTime = this.ctx.currentTime;
    this.playing = true;

    source.onended = () => {
      this.playing = false;
      this.startOffset = 0;
      cancelAnimationFrame(this.rafId);
    };

    this.tickTime();
  }

  /** Stop playback and reset position to the beginning. */
  stop(): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // source may not have been started
      }
      this.source.disconnect();
    }
    this.source = null;
    this.playing = false;
    this.startOffset = 0;
    cancelAnimationFrame(this.rafId);
  }

  /** Pause playback, preserving the current position. */
  pause(): void {
    if (!this.playing) {
      return;
    }

    this.startOffset = this.currentTime;

    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // source may not have been started
      }
      this.source.disconnect();
    }
    this.source = null;
    this.playing = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Seek to a specific time in seconds. Resumes playback if it was active. */
  seek(time: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.pause();
    }
    this.startOffset = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) {
      this.play();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Dispatch time-update callbacks on each animation frame. */
  private tickTime(): void {
    if (!this.playing) {
      return;
    }
    this.onTimeUpdate?.(this.currentTime, this.duration);
    this.rafId = requestAnimationFrame(() => this.tickTime());
  }
}

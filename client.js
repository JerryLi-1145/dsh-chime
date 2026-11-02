/**
 * dsh-chime — browser half.
 *
 * Long-polls the Host for cues and renders them with Web Audio. Both cue kinds
 * are decided on the Host (`approval/asked`, `turn/end` completed): the browser
 * approval waterfall is owned by the approval UI, so a later listener there
 * would run only after the user answers.
 *
 * Nothing is shipped as an audio file: each cue is a short oscillator envelope,
 * so the plugin stays a few kilobytes and has no sample licensing to carry.
 *
 * Browsers start an AudioContext suspended until a gesture. The context is
 * resumed by any pointer/key event; a cue that arrives before the gesture is
 * remembered and played then.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-chime',
  factory() {
    const POLL_PATH = '/dsh-chime/poll';
    const POLL_TIMEOUT_MS = 30_000;
    const SAME_KIND_GAP_MS = 1_200;

    /** @type {AudioContext | null} */
    let audio = null;
    /** @type {GainNode | null} */
    let master = null;
    /** @type {'approval' | 'complete' | null} */
    let pendingKind = null;
    const lastPlayed = { approval: 0, complete: 0 };

    // ---------- audio ----------

    function ensureAudio() {
      if (audio !== null) return audio;
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (typeof Ctor !== 'function') return null;
      try {
        audio = new Ctor();
        master = audio.createGain();
        master.gain.value = 0.2;
        master.connect(audio.destination);
      } catch {
        audio = null;
        master = null;
      }
      return audio;
    }

    function flushPending() {
      if (pendingKind === null || audio === null || audio.state !== 'running') return;
      const kind = pendingKind;
      pendingKind = null;
      render(kind);
    }

    function unlock() {
      const context = ensureAudio();
      if (context === null) return;
      if (context.state === 'running') {
        flushPending();
        return;
      }
      context.resume().then(flushPending, () => {});
    }

    /**
     * @param {'approval' | 'complete'} kind
     */
    function play(kind) {
      const now = Date.now();
      if (now - lastPlayed[kind] < SAME_KIND_GAP_MS) return;
      lastPlayed[kind] = now;

      const context = ensureAudio();
      if (context === null) return;
      if (context.state !== 'running') {
        // No gesture yet: remember the newest cue and let unlock play it. If the
        // environment allows autoplay (Electron does), resume resolves and the
        // cue plays immediately instead of waiting for a gesture.
        pendingKind = kind;
        context.resume().then(flushPending, () => {});
        return;
      }
      render(kind);
    }

    /**
     * One enveloped note. The 0.0001 floor keeps exponential ramps legal.
     * @param {{ freq: number, at: number, dur: number, gain: number, type: OscillatorType }} note
     */
    function tone(note) {
      if (audio === null || master === null) return;
      const oscillator = audio.createOscillator();
      const envelope = audio.createGain();
      oscillator.type = note.type;
      oscillator.frequency.setValueAtTime(note.freq, note.at);
      envelope.gain.setValueAtTime(0.0001, note.at);
      envelope.gain.exponentialRampToValueAtTime(note.gain, note.at + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, note.at + note.dur);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(note.at);
      oscillator.stop(note.at + note.dur + 0.03);
    }

    /**
     * @param {'approval' | 'complete'} kind
     */
    function render(kind) {
      if (audio === null) return;
      const at = audio.currentTime + 0.01;

      if (kind === 'approval') {
        // Two rising triangle blips: a question that is waiting for an answer.
        tone({ freq: 659.25, at, dur: 0.16, gain: 0.34, type: 'triangle' });
        tone({ freq: 880, at: at + 0.12, dur: 0.24, gain: 0.28, type: 'triangle' });
        return;
      }

      // A soft C-major arpeggio with a quiet octave sparkle: done.
      const notes = [
        [523.25, 0.5, 0.34],
        [659.25, 0.5, 0.3],
        [783.99, 0.62, 0.26],
        [1046.5, 0.7, 0.15],
      ];
      notes.forEach(([freq, dur, gain], index) => {
        const start = at + index * 0.105;
        tone({ freq, at: start, dur, gain, type: 'sine' });
        tone({ freq: freq * 2, at: start, dur: dur * 0.55, gain: gain * 0.12, type: 'sine' });
      });
    }

    // ---------- transport ----------

    function startPolling() {
      let stopped = false;
      let cursor = -1;
      /** @type {AbortController | null} */
      let current = null;
      let failures = 0;

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      async function run() {
        while (!stopped) {
          current = new AbortController();
          const timer = setTimeout(() => current?.abort(), POLL_TIMEOUT_MS);
          try {
            const response = await fetch(POLL_PATH + '?since=' + cursor, {
              cache: 'no-store',
              credentials: 'same-origin',
              signal: current.signal,
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const body = await response.json();
            if (stopped) return;
            failures = 0;
            if (body !== null && typeof body === 'object' && typeof body.cursor === 'number') {
              cursor = body.cursor;
            }
            if (body !== null && typeof body === 'object' && Array.isArray(body.events)) {
              for (const event of body.events) {
                if (event?.kind === 'approval' || event?.kind === 'complete') play(event.kind);
              }
            }
          } catch {
            if (stopped) return;
            failures = Math.min(failures + 1, 5);
            await sleep(500 * 2 ** (failures - 1));
          } finally {
            clearTimeout(timer);
            current = null;
          }
        }
      }

      void run();

      return () => {
        stopped = true;
        current?.abort();
      };
    }

    function installUnlock() {
      const options = { capture: true, passive: true };
      const onGesture = () => unlock();
      window.addEventListener('pointerdown', onGesture, options);
      window.addEventListener('keydown', onGesture, options);
      window.addEventListener('touchstart', onGesture, options);
      document.addEventListener('visibilitychange', onGesture);
      return () => {
        window.removeEventListener('pointerdown', onGesture, true);
        window.removeEventListener('keydown', onGesture, true);
        window.removeEventListener('touchstart', onGesture, true);
        document.removeEventListener('visibilitychange', onGesture);
      };
    }

    // ---------- plugin entry ----------

    function apply(ctx) {
      ctx.effect(() => {
        const stopPolling = startPolling();
        const stopUnlock = installUnlock();
        return () => {
          stopPolling();
          stopUnlock();
          pendingKind = null;
          const closing = audio;
          audio = null;
          master = null;
          if (closing !== null) void closing.close().catch(() => {});
        };
      }, 'dsh-chime: browser runtime');
    }

    return { apply };
  },
});

/**
 * dsh-chime — Host half.
 *
 * Watches committed Session events and turns two of them into short cues for the
 * browser half:
 *   - `approval/asked`                → a permission request is waiting
 *   - `turn/end` (reason `completed`) → the Agent finished its task
 *
 * `approval/asked` is the reliable signal: it is logged when the approval
 * service creates the request, independent of which answerer decides it. A
 * request that an automatic answerer resolves still chimes; the browser
 * waterfall was deliberately not used, because the approval UI's listener owns
 * that waterfall and a later listener only runs after the user answers.
 *
 * The browser half cannot subscribe to arbitrary Session events, so this half
 * exposes one tiny long-poll endpoint. It keeps the last few cues in memory and
 * hands the browser only what arrived after its cursor; a fresh page baselines
 * on the current cursor so a reload never replays old sounds.
 *
 * Delegated Sessions (`origin: 'subagent'`, `delegationDepth > 0`) are ignored
 * for completion: a root task that fans out would otherwise chime once per
 * child. A permission request is never silenced by that filter — it blocks work
 * until somebody answers, wherever it came from.
 */

const ROUTE_PREFIX = '/dsh-chime';
const POLL_WAIT_MS = 20_000;
const BUFFER_LIMIT = 32;

/** Required Host service: the Web carrier that serves this GUI. */
export const inject = ['webServer'];

/**
 * Keep the browser and the Host release in step.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context
 */
export function apply(ctx) {
  const queue = createCueQueue();

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        const kind = cueKindOf(event);
        if (kind === 'approval') {
          queue.push(kind);
          return;
        }
        if (kind === 'complete' && !isDelegatedSession(session)) queue.push(kind);
      }),
    'dsh-chime: session events',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          if (url.pathname === ROUTE_PREFIX + '/status') {
            sendJson(res, 200, queue.status(), { 'cache-control': 'no-store' });
            return;
          }
          if (url.pathname !== ROUTE_PREFIX + '/poll') {
            sendJson(res, 404, { error: 'not found' });
            return;
          }

          const parsed = Number(url.searchParams.get('since') ?? '-1');
          const since = Number.isFinite(parsed) ? Math.max(-1, Math.trunc(parsed)) : -1;
          const abort = new AbortController();
          const onClose = () => abort.abort();
          req.on('close', onClose);

          void queue
            .poll(since, abort.signal)
            .then((result) => {
              if (res.writableEnded || res.destroyed) return;
              sendJson(res, 200, result, { 'cache-control': 'no-store' });
            })
            .finally(() => {
              req.off('close', onClose);
            });
        },
      }),
    'dsh-chime: long-poll route',
  );

  ctx.effect(() => () => queue.close(), 'dsh-chime: release waiters');
}

/**
 * One cue kind for a committed Session event, or `null` when the event is not
 * something the user should hear. A failed Turn (`error`) deliberately stays
 * silent: this is a completion chime, and an error already surfaces in the
 * conversation.
 *
 * @param {unknown} event - committed Session event
 * @returns {'approval' | 'complete' | null}
 */
function cueKindOf(event) {
  if (event === null || typeof event !== 'object') return null;
  if (event.type === 'approval/asked') return 'approval';
  if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') return 'complete';
  return null;
}

/**
 * Whether this Session is a delegated child that should not chime on
 * completion.
 *
 * The discriminator is `origin`, not `parentSession`: a normal fork also carries
 * a parent, so using the parent would silence the conversation the user is in.
 * A malformed or missing header passes through — one extra chime beats a plugin
 * that goes silent when the Host changes a field.
 *
 * @param {unknown} session - Session carrying the event
 * @returns {boolean}
 */
function isDelegatedSession(session) {
  const header = session?.header;
  if (header === null || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  const depth = header.delegationDepth;
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0;
}

/**
 * Bounded in-memory cue queue with long-poll waiters.
 * @returns {{ push: (kind: string) => void, poll: (since: number, signal?: AbortSignal) => Promise<object>, close: () => void, status: () => { cursor: number, waiters: number } }}
 */
function createCueQueue() {
  let seq = 0;
  let closed = false;
  /** @type {Array<{ seq: number, kind: string, at: number }>} */
  const cues = [];
  /** @type {Set<{ since: number, resolve: (result: object) => void }>} */
  const waiters = new Set();

  const head = () => seq;

  function drain(since) {
    const cursor = head();
    if (!Number.isFinite(since) || since < 0 || since > cursor) return { cursor, events: [] };
    const oldest = cues.length > 0 ? cues[0].seq : cursor + 1;
    // The cursor fell behind the retained window (a tab slept through the
    // buffer). Report a reset so the client can rebase instead of replaying.
    if (since + 1 < oldest) return { cursor, events: [], reset: true };
    return { cursor, events: cues.filter((cue) => cue.seq > since) };
  }

  function wake() {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter.resolve(drain(waiter.since));
    }
  }

  function push(kind) {
    if (closed) return;
    seq += 1;
    cues.push({ seq, kind, at: Date.now() });
    while (cues.length > BUFFER_LIMIT) cues.shift();
    wake();
  }

  function poll(since, signal) {
    const ready = drain(since);
    // A negative cursor is the page's baseline probe: answer at once with the
    // current head so a fresh page never waits or replays history.
    if (closed || since < 0 || ready.events.length > 0 || ready.reset === true) return Promise.resolve(ready);
    if (signal?.aborted) return Promise.resolve({ cursor: head(), events: [] });

    return new Promise((resolve) => {
      const waiter = { since, resolve: /** @type {((result: object) => void) | null} */ (null) };
      const timer = setTimeout(() => settle({ cursor: head(), events: [] }), POLL_WAIT_MS);

      function settle(result) {
        clearTimeout(timer);
        waiters.delete(waiter);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(result);
      }
      function onAbort() {
        settle({ cursor: head(), events: [] });
      }

      waiter.resolve = settle;
      waiters.add(waiter);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function close() {
    closed = true;
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter.resolve({ cursor: head(), events: [] });
    }
  }

  return { push, poll, close, status: () => ({ cursor: head(), waiters: waiters.size }) };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

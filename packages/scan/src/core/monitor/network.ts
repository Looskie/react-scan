import { Store } from '../..';
import {
  FLOAT_MAX_LEN,
  GZIP_MIN_LEN,
  GZIP_MAX_LEN,
  MAX_PENDING_REQUESTS,
} from './constants';
import { getSession } from './utils';
import type {
  Interaction,
  IngestRequest,
  Session,
  InternalInteraction,
  Component,
} from './types';

let session: Session | null = null;
export const flush = (): void => {
  const monitor = Store.monitor.value;
  if (
    !monitor ||
    !navigator.onLine ||
    !monitor.url ||
    !monitor.interactions.length
  )
    return;

  // MARK: Sessions
  if (!session) session = getSession();
  if (!session) return; // only on SSR (unlikely)

  session.url = window.location.toString();
  session.route = Store.monitor.value?.route ?? null;

  // MARK: Interactions
  const now = performance.now();
  const interactions = new Array<Interaction>();
  const toFlushInteractions = new Array<InternalInteraction>();
  const toKeepInteractions = new Array<InternalInteraction>();

  // Split interactions into recent (< 4s) and old
  for (let i = 0; i < monitor.interactions.length; i++) {
    const interaction = monitor.interactions[i];
    if (now - interaction.performanceEntry.startTime <= 4000) {
      interactions.push({
        id: `${interaction.performanceEntry.type}::${interaction.componentPath}::${session?.route}`, //'${event. type}::${normalizePath(path)}::${getSession()?.url}';
        name: interaction.componentName,
        time: interaction.performanceEntry.duration,
        timestamp: interaction.performanceEntry.timestamp,
        type: interaction.performanceEntry.type,
      });
      toFlushInteractions.push(interaction);
    } else {
      toKeepInteractions.push(interaction);
    }
  }

  if (!toKeepInteractions.length) return;

  const components: Array<Component> = [];

  for (let i = 0; i < toFlushInteractions.length; i++) {
    const interaction = toFlushInteractions[i];
    const interactionId = interactions[i].id; // indexes should be match, and id already computed
    const entries = Array.from(interaction.components.entries());
    for (let j = 0; j < entries.length; j++) {
      const [name, component] = entries[j];

      components.push({
        name,
        interactionId,
        instances: component.fibers.size,
        renders: component.renders,
        totalTime: component.totalTime,
      });
      // @ts-expect-error todo: fix types
      interaction.renders = component.fibers.size;

      if (component.retiresAllowed === 0) {
        // otherwise there will be a memory leak if the user loses internet or our server goes down
        // we decide to skip the collection if this is the case
        interaction.components.delete(name);
      }
      component.retiresAllowed--;
    }
  }

  const payload: IngestRequest = {
    interactions,
    components,
    session,
  };

  monitor.pendingRequests++;
  monitor.interactions = toKeepInteractions;

  try {
    transport(monitor.url, payload)
      .then(() => {
        monitor.pendingRequests--;
      })
      .catch(() => transport(monitor.url!, payload).catch(() => null)); // retry only once
  } catch {
    /* */
  }

  monitor.interactions = toKeepInteractions;
};

// export const debouncedFlush = debounce(flush, 5000);
const CONTENT_TYPE = 'application/json';
const supportsCompression = typeof CompressionStream === 'function';

export const compress = async (payload: string): Promise<ArrayBuffer> => {
  const stream = new Blob([payload], { type: CONTENT_TYPE })
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
};

/**
 * Modified from @palette.dev/browser:
 *
 * @see https://gist.github.com/aidenybai/473689493f2d5d01bbc52e2da5950b45#file-palette-dev-browser-dist-palette-dev-mjs-L365
 */
export const transport = async (
  url: string,
  payload: IngestRequest,
): Promise<{ ok: boolean }> => {
  const fail = { ok: false };
  /**
   * JSON.stringify replacer function is ~60-80% slower than JSON.stringify
   *
   * Perflink: https://dub.sh/json-replacer-fn
   */
  const json = JSON.stringify(payload, (key, value) => {
    // Truncate floats to 5 decimal places (long floats cause error in ClickHouse)
    if (
      typeof value === 'number' &&
      parseInt(value as any) !== value /* float check */
    ) {
      value = ~~(value * FLOAT_MAX_LEN) / FLOAT_MAX_LEN;
    }
    // Remove falsy (e.g. undefined, null, []), and keys starting with "_"
    // to reduce the size of the payload
    if (
      // eslint-disable-next-line eqeqeq
      (value != null && value !== false) ||
      (Array.isArray(value) && value.length)
    ) {
      return value;
    }
  });
  // gzip may not be worth it for small payloads,
  // only use it if the payload is large enough
  const shouldCompress = json.length > GZIP_MIN_LEN;
  const body =
    shouldCompress && supportsCompression ? await compress(json) : json;

  if (!navigator.onLine) return fail;
  const headers: any = {
    'Content-Type': CONTENT_TYPE,
    'Content-Encoding': shouldCompress ? 'gzip' : undefined,
    'x-api-key': Store.monitor.value?.apiKey,
  };
  if (shouldCompress) url += '?z=1';
  const size = typeof body === 'string' ? body.length : body.byteLength;

  return fetch(url, {
    body,
    method: 'POST',
    referrerPolicy: 'origin',
    /**
     * Outgoing requests are usually cancelled when navigating to a different page, causing a "TypeError: Failed to
     * fetch" error and sending a "network_error" client-outcome - in Chrome, the request status shows "(cancelled)".
     * The `keepalive` flag keeps outgoing requests alive, even when switching pages. We want this since we're
     * frequently sending events right before the user is switching pages (e.g., when finishing navigation transactions).
     *
     * This is the modern alternative to the navigator.sendBeacon API.
     * @see https://javascript.info/fetch-api#keepalive
     *
     * Gotchas:
     * - `keepalive` isn't supported by Firefox
     * - As per spec (https://fetch.spec.whatwg.org/#http-network-or-cache-fetch):
     *   If the sum of contentLength and inflightKeepaliveBytes is greater than 64 kibibytes, then return a network error.
     *   We will therefore only activate the flag when we're below that limit.
     * - There is also a limit of requests that can be open at the same time, so we also limit this to 15.
     *
     * @see https://github.com/getsentry/sentry-javascript/pull/7553
     */
    keepalive:
      GZIP_MAX_LEN > size &&
      MAX_PENDING_REQUESTS > (Store.monitor.value?.pendingRequests ?? 0),
    priority: 'low',
    // mode: 'no-cors',
    headers,
  });
};
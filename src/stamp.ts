/*
    The idea of stamping library name and version onto every outbound event is
    adapted from mixpanel-node (lib/mixpanel-node.js send_event_request, which
    sets `mp_lib` and `$lib_version`), Copyright (c) 2012 Carl Sverre, released
    under the MIT license. See NOTICE.

    Intempt sends it as a header by default. A header cannot alter a downstream
    event schema; a new payload field could. Payload stamping is opt-in via
    `stampLibVersion`.
*/

import type { WirePayloadItem } from './types';

// Read at module load so a bundled or vendored copy still reports honestly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { name: string; version: string };

export const LIB_NAME = 'intempt-node';
export const LIB_VERSION: string = pkg.version;
export const LIB_HEADER = 'X-Intempt-Lib';

/** Adds `$lib`/`$libVersion` to a payload item when payload stamping is on. */
export function stampPayload(item: WirePayloadItem, enabled: boolean): WirePayloadItem {
  if (!enabled) {
    return item;
  }
  return { ...item, $lib: LIB_NAME, $libVersion: LIB_VERSION };
}

/*
    The idea of reporting library name and version on every outbound request is
    adapted from mixpanel-node (lib/mixpanel-node.js send_event_request, which
    sets `mp_lib` and `$lib_version`), Copyright (c) 2012 Carl Sverre, released
    under the MIT license. See NOTICE.

    Intempt sends it as a header rather than a payload field. A header cannot
    alter a downstream event schema; a new payload field could.
*/

// Read at module load so a vendored or bundled copy still reports honestly.
const pkg = require('../package.json') as { version: string };

export const LIB_NAME = 'intempt-node';
export const LIB_VERSION: string = pkg.version;
export const LIB_HEADER = 'X-Intempt-Lib';

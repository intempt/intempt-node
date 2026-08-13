/**
 * Compile-time guards for the public surface.
 *
 * These assert what does **not** compile, which no runtime test can do. Every
 * `@ts-expect-error` below is itself the assertion: if the surface widens so that
 * the line becomes legal, TypeScript reports the unused directive as an error and
 * `npm run typecheck` fails.
 *
 * Needed because removing `profileId` from the option types had no automated guard
 * at all — deleting `NoProfileId` from `TrackOptions` left the typecheck clean and
 * all tests green. The rule survived only as a comment.
 *
 * There is no `expect` here and vitest never runs this file (it is not `*.test.ts`).
 * `tsconfig.test.json` includes it, so the checking happens in `typecheck`.
 */

import { Agent } from 'node:http';
import { Intempt, SDK } from '../src';
import type { TrackOptions } from '../src';

const client = Intempt.init({
  org: 'o',
  project: 'p',
  apiKey: 'prefix.secret',
  sourceId: '684508596718616576',
});

// ---- profileId is not part of the v2 surface, however it arrives ----

// A fresh object literal is caught by the excess-property check...
// @ts-expect-error profileId is not a v2 identifier
void client.track('e', { userId: 'u1', profileId: 'p1' });

// ...and a variable is caught only because the field is declared `never`, which is
// the reason for declaring it rather than merely omitting it.
const viaVariable = { userId: 'u1', profileId: 'p1' };
// @ts-expect-error profileId is not a v2 identifier
void client.track('e', viaVariable);
// @ts-expect-error profileId is not a v2 identifier
void client.identify(viaVariable);
// @ts-expect-error profileId is not a v2 identifier
void client.group({ ...viaVariable, accountId: 'acme' });
// @ts-expect-error profileId is not a v2 identifier
void client.alias({ ...viaVariable, userId: 'u1', previousUserId: 'p' });
// trackBatch matters most of the four: TrackEvent extends TrackOptions, and if that
// link were ever loosened the payload builder would put the field straight on the
// wire. A mutant shaped like ingest.ts's own `WithProfileId` left typecheck clean
// and all tests green before this line existed.
// @ts-expect-error profileId is not a v2 identifier
void client.trackBatch([{ event: 'e', ...viaVariable }]);
// @ts-expect-error profileId is not a v2 identifier
void client.recommend({ ...viaVariable, feedId: '5292', fields: ['id'] });
// @ts-expect-error profileId is not a v2 identifier
void client.consent.grant(viaVariable);
// @ts-expect-error profileId is not a v2 identifier
void client.consent.revoke(viaVariable);
// @ts-expect-error profileId is not a v2 identifier
void client.ecommerce.productViewed({ ...viaVariable, productId: 'sku-1' });
// @ts-expect-error profileId is not a v2 identifier
void client.ecommerce.addedToCart({ ...viaVariable, productId: 'sku-1', quantity: 1 });
// @ts-expect-error profileId is not a v2 identifier
void client.ecommerce.ordered({ ...viaVariable, products: [{ productId: 'sku-1' }] });

// masterId was never a field on any type, so this is an ordinary excess property.
// Recorded here so the two exclusions are guarded in the same place.
// @ts-expect-error masterId is not a v2 identifier
void client.track('e', { userId: 'u1', masterId: '123' });

// ---- the options a live client cannot change ----

// @ts-expect-error keepAlive is fixed at construction
void client.setConfig({ keepAlive: false });
// @ts-expect-error agent is fixed at construction
void client.setConfig({ agent: new Agent() });

// `undefined` stays legal on both, and deliberately so: it reads as "leave this
// one alone", which is what a caller spreading a partial config relies on. An
// optional `never` permits exactly that and nothing else.
client.setConfig({ keepAlive: undefined, agent: undefined });

const patch: Partial<{ keepAlive: boolean; timeout: number }> = { keepAlive: false };
// @ts-expect-error keepAlive is fixed at construction, via a variable too
void client.setConfig(patch);

// The rest of the config stays changeable.
client.setConfig({ timeout: 5_000, host: 'api.intempt.com', debug: true, path: '/gw' });

// ---- what remains legal ----

const trackable: TrackOptions = { userId: 'u1', accountId: 'acme' };
void client.track('e', trackable);
void client.track('e', { accountId: 'acme', properties: { a: 1 } });
void client.recommend({ userId: 'u1', feedId: '5292', fields: ['id'] });

// The 1.x shim is profileId-first and must keep compiling.
const sdk = new SDK('o', 'p', 'prefix.secret', '684508596718616576');
void sdk.track('p1', 'e', { a: 1 });
void sdk.identify('p1', 'u1');
void sdk.group('p1', 'acme');
void sdk.alias('p1', 'u1', 'u2');
void sdk.record('p1', 'e', 'u1', 'acme', {});
void sdk.consents('p1', 'accept');
void sdk.productAdd('p1', 'sku-1', 1);
void sdk.productView('p1', 'sku-1');
void sdk.productOrdered('p1', [{ productId: 'sku-1' }]);
void sdk.close();

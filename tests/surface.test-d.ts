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
import type {
  FlagError,
  FlagErrorCode,
  FlagErrorKind,
  FlagReason,
  TrackOptions,
} from '../src';

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
void sdk.record('p1', 'e', 'u1', 'acme', {});
void sdk.consents('p1', 'accept');
void sdk.productAdd('p1', 'sku-1', 1);
void sdk.productView('p1', 'sku-1');
void sdk.productOrdered('p1', [{ productId: 'sku-1' }]);
void sdk.close();

// ---- variationDetail and onFlagError (INT-7454) ----

async function detailIsTyped(): Promise<void> {
  const detail = await client.variationDetail('k', { userId: 'u1' }, false);
  const value: boolean = detail.value;
  const reason: FlagReason = detail.reason;
  const kind: FlagErrorKind | undefined = detail.error?.kind;
  // F6: the server's reason is passed through, so the type is open to reasons added later.
  const future: FlagReason = 'some_future_reason';
  const variationId: number | undefined = detail.variationId;
  const valueType: string | undefined = detail.valueType;
  const code: FlagErrorCode | undefined = detail.errorCode;
  // @ts-expect-error an error code outside the OpenFeature set is not part of the union
  const badCode: FlagErrorCode = 'WRONG_TYPE';
  // F30 #4: jsonVariation takes any JSON value as its default, arrays and scalars included.
  const list: string[] = await client.jsonVariation('k', { userId: 'u1' }, ['a']);
  void [value, reason, kind, future, variationId, valueType, code, badCode, list];
}
void detailIsTyped;

client.setConfig({ onFlagError: (e: FlagError) => void e.key });
// @ts-expect-error the hook receives a FlagError, not a string
Intempt.init({ org: 'o', project: 'p', apiKey: 'a.b', onFlagError: (e: string) => e });

// ---- disableExposure is a per-read option, not part of who is evaluated (INT-7456) ----

void client.variation('k', { userId: 'u1' }, false, { disableExposure: true });
// @ts-expect-error disableExposure is not an identifier
void client.variation('k', { userId: 'u1', disableExposure: true }, false);

// ---- choose() has its own context: userId or profileId, never accountId (choose-api) ----

import type { Choice, ChooseContext, ChooseOptions } from '../src';

const chosen: Promise<Choice[]> = client.choose(
  { userId: 'u1', sessionId: 's1' },
  { names: ['n'], groups: ['g'], disableExposure: true },
);
const variantId: Promise<number | undefined> = chosen.then((c) => c[0]?.variantId);
const choiceContext: ChooseContext = { profileId: 'p1' };
const choiceOptions: ChooseOptions = {};
void [variantId, choiceContext, choiceOptions];
// @ts-expect-error accountId is not an identifier choose-api accepts
void client.choose({ userId: 'u1', accountId: 'a1' });
// @ts-expect-error names is an array
void client.choose({ userId: 'u1' }, { names: 'n' });
// @ts-expect-error a context is required
void client.choose();

// ---- the four 1.x choose helpers: a profileId and an optional filter ----

const legacyChosen: Promise<Choice[]> = client.chooseExperimentsByNames('p1', ['n']);
void [
  legacyChosen,
  client.chooseExperimentsByGroups('p1'),
  client.choosePersonalizationsByNames('p1', []),
  client.choosePersonalizationsByGroups('p1', ['g']),
];
// @ts-expect-error a profileId is required
void client.chooseExperimentsByNames();
// @ts-expect-error the filter is an array
void client.choosePersonalizationsByGroups('p1', 'g');

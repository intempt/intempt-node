import { afterEach, describe, expect, it } from 'vitest';
import { SDK } from '../src';
import {
  API_KEY,
  CHOOSE_PATH,
  HOST,
  ORG,
  ORIGIN,
  PROJECT,
  SOURCE,
  client,
  nock,
  setupNock,
} from './helpers';

setupNock();

const CHOICES = [{ name: 'hero', group: 'home', body: { a: 1 }, variantId: 7 }];

function capture(reply: unknown = { choices: CHOICES }, status = 200) {
  const sent: Record<string, unknown>[] = [];
  nock(ORIGIN)
    .post(CHOOSE_PATH, (b) => {
      sent.push(b as Record<string, unknown>);
      return true;
    })
    .reply(status, reply as Record<string, unknown>);
  return sent;
}

type Method =
  | 'chooseExperimentsByNames'
  | 'chooseExperimentsByGroups'
  | 'choosePersonalizationsByNames'
  | 'choosePersonalizationsByGroups';

const CASES: Array<{ method: Method; type: string; field: 'names' | 'groups' }> = [
  { method: 'chooseExperimentsByNames', type: 'experiment', field: 'names' },
  { method: 'chooseExperimentsByGroups', type: 'experiment', field: 'groups' },
  { method: 'choosePersonalizationsByNames', type: 'personalization', field: 'names' },
  { method: 'choosePersonalizationsByGroups', type: 'personalization', field: 'groups' },
];

describe.each(CASES)('$method on the v2 client', ({ method, type, field }) => {
  afterEach(() => nock.cleanAll());

  it(`sends the 1.x body: profileId + sourceId, ${field}, optimizationType ${type}, device`, async () => {
    const sent = capture();
    const c = client();
    const out = await c[method]('p-1', ['hero']);
    await c.close();
    expect(sent).toEqual([
      {
        identification: { profileId: 'p-1', sourceId: SOURCE },
        [field]: ['hero'],
        optimizationType: type,
        device: 'all',
      },
    ]);
    expect(out).toEqual(CHOICES);
  });

  it('omits the filter when none is given, as 1.x did, and keeps optimizationType', async () => {
    const sent = capture();
    const c = client();
    await c[method]('p-1');
    await c.close();
    expect(sent[0]).not.toHaveProperty('names');
    expect(sent[0]).not.toHaveProperty('groups');
    expect(sent[0]).toHaveProperty('optimizationType', type);
  });

  it('sends an empty array as given', async () => {
    const sent = capture();
    const c = client();
    await c[method]('p-1', []);
    await c.close();
    expect(sent[0]?.[field]).toEqual([]);
  });

  it('rejects a blank profileId and sends nothing', async () => {
    const c = client();
    await expect(c[method]('')).rejects.toThrow(TypeError);
    await expect(c[method]('   ')).rejects.toThrow(/profileId/);
    await c.close();
  });

  it('rejects a malformed name or group', async () => {
    const c = client();
    await expect(c[method]('p-1', ['bad name'])).rejects.toThrow(TypeError);
    await c.close();
  });

  it('resolves [] when the service errors', async () => {
    capture({ message: 'boom' }, 500);
    const c = client();
    expect(await c[method]('p-1', ['hero'])).toEqual([]);
    await c.close();
  });

  it('rejects on a closed client', async () => {
    const c = client();
    await c.close();
    await expect(c[method]('p-1')).rejects.toThrow();
  });
});

describe('choose() keeps sending no optimizationType', () => {
  it('is absent on the single choose()', async () => {
    const sent = capture();
    const c = client();
    await c.choose({ userId: 'u-1' }, { names: ['hero'] });
    await c.close();
    expect(sent[0]).not.toHaveProperty('optimizationType');
  });
});

describe.each(CASES)('$method on the 1.x SDK shim', ({ method, type, field }) => {
  it('forwards to the same request and returns the choices', async () => {
    const sent = capture();
    const sdk = new SDK(ORG, PROJECT, API_KEY, SOURCE);
    sdk.v2.setConfig({ host: HOST });
    const out = await sdk[method]('p-1', ['hero']);
    await sdk.close();
    expect(sent[0]).toEqual({
      identification: { profileId: 'p-1', sourceId: SOURCE },
      [field]: ['hero'],
      optimizationType: type,
      device: 'all',
    });
    expect(out).toEqual(CHOICES);
  });
});

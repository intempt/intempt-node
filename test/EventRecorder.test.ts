import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventRecorder, PushSource } from '../src';

const orgName = 'o';
const projectName = 'p';
const sourceId = '1';
const sourcesApi = new PushSource.SourcesApi();
const addDataItemsSpy = jest.spyOn(sourcesApi, 'addDataItems').mockImplementation(async (a) => {
  console.log('spy', a);
});
const eventRecorder: EventRecorder = EventRecorder.WithEventBatcher(orgName, projectName, sourceId, sourcesApi, { maximum: 1 })

beforeEach(() => {
  addDataItemsSpy.mockClear();
});

describe('profile', () => {
  test('profile with pua', () => {
    eventRecorder.profile('p', 'u', 'a');
    expect(addDataItemsSpy).toBeCalledWith(expected({
      profile: [{
        profileId: 'p',
        user_identifier: 'u',
        account_identifier: 'a'
      }]
    }))
  });

  test('profile without account identifier', () => {
    [
      () => eventRecorder.profile('p', 'u'),
      // @ts-ignore
      () => eventRecorder.profile('p', 'u', null as string),
      () => eventRecorder.profile('p', 'u', undefined),
    ].forEach(f => {
      addDataItemsSpy.mockClear();
      f();
      expect(addDataItemsSpy).toBeCalledWith(expected({
        profile: [{
          profileId: 'p',
          user_identifier: 'u',
          account_identifier: null
        }]
      }));
    });
  });

  test('profile without undefind', () => {
    eventRecorder.profile('p', 'u', undefined);
    expect(addDataItemsSpy).toBeCalledWith(expected({
      profile: [{
        profileId: 'p',
        user_identifier: 'u',
        account_identifier: null
      }]
    }));
  });
});

describe('recordEvent', () => {
  test('empty name', () => {
    expect(() => eventRecorder.addEvent('', {})).toThrowError(Error);
  });

  test('event array', () => {
    eventRecorder.profile('p', 'u', undefined);
    expect(addDataItemsSpy).toBeCalledWith(expected({
      profile: [{
        profileId: 'p',
        user_identifier: 'u',
        account_identifier: null
      }]
    }));
  });
});

describe('trackConsents', () => {
  const profileId = 'bob';
  test('empty', () => {
    eventRecorder.trackConsents(profileId, [], undefined, 'test');
    expect(addDataItemsSpy).toBeCalled();
  });
  test('two', () => {
    eventRecorder.trackConsents(
      profileId,
      [
        {
          regulation: 'GDPR',
          purpose: 'advertising',
          consented: true
        }, {
          regulation: 'CCPA',
          purpose: 'advertising',
          consented: true
        }
      ],
      0,
      'test',
    );
    expect(addDataItemsSpy).toBeCalledTimes(1);
    expect(addDataItemsSpy)
      .toHaveBeenCalledWith(
        expected({
          consents: [{
            eventId: 'test',
            profileId: profileId,
            consents: [
              { "consented": true, "purpose": "advertising", "regulation": "GDPR" },
              { "consented": true, "purpose": "advertising", "regulation": "CCPA" }
            ],
            timestamp_unixtime_ms: 0,
            document: undefined,
          }]
        }));
  });
});

describe('trackConsents', () => {
  test('empty', () => {
    eventRecorder.addEvent('e', []);
    expect(addDataItemsSpy).not.toBeCalled();
  });
  test('empty', () => {
    EventRecorder.WithEventBatcher(orgName, projectName, sourceId, sourcesApi, { maximum: 2 })
      .addEvent('e', [{ v: 1 }, { v: 2 }]);
    expect(addDataItemsSpy)
      .toHaveBeenCalledWith(expected({ e: [{ v: 1 }, { v: 2 }] }));
  });
});

function expected(body: {}) {
  return {
    body: body,
    orgName: orgName,
    projectName: projectName,
    sourceId: sourceId,
  }
}

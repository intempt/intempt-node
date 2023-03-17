import { beforeEach, expect, jest, test } from '@jest/globals';
import { EventBatcher, PushSource } from '../src';

jest.useFakeTimers();

const sourcesApi = new PushSource.SourcesApi();
const addDataItemsSpy = jest.spyOn(sourcesApi, 'addDataItems').mockImplementation(async (a) => {
  console.log('spy', a);
});

beforeEach(() => {
  addDataItemsSpy.mockClear();
});

test('max 1 instant send', () => {
  const eb = newEventBatcher({ maximum: 1 });

  Array.from(Array(4).keys()).forEach(i => eb.addEvent('name' + (i % 3), { v: i }));
  expect(addDataItemsSpy).toBeCalledTimes(4);

  Array.from(Array(4).keys())
    .map(i => ({ ['name' + (i % 3)]: [{ v: i }] }))
    .forEach(a => expect(addDataItemsSpy).toHaveBeenCalledWith(expected(a)));
  addDataItemsSpy.mockClear();
  jest.runAllTimers();
  expect(addDataItemsSpy).not.toBeCalled();
});

test('max 3 with 4 message', () => {
  const eb = newEventBatcher({ maximum: 3 });

  Array.from(Array(4).keys()).forEach(i => eb.addEvent('name' + (i % 2), { v: i }));
  // At this point in time, the callback should not have been called yet
  expect(addDataItemsSpy).toBeCalledTimes(1);

  expect(addDataItemsSpy).toBeCalledWith(expected({ name0: [{ v: 0 }, { v: 2 }], name1: [{ v: 1 }] }));
  addDataItemsSpy.mockClear();
  jest.runAllTimers();
  expect(addDataItemsSpy).toBeCalledTimes(1);
  expect(addDataItemsSpy).toBeCalledWith(expected({ name1: [{ v: 3 }] }));

});

test('max 3 with 2 message', () => {
  const eb = newEventBatcher({ maximum: 3 });

  Array.from(Array(2).keys()).forEach(i => eb.addEvent('name', { v: i }));
  // At this point in time, the callback should not have been called yet
  expect(addDataItemsSpy).toBeCalledTimes(0);
  jest.runAllTimers();
  expect(addDataItemsSpy).toBeCalledTimes(1);
  expect(addDataItemsSpy).toBeCalledWith(expected({ name: [{ v: 0 }, { v: 1 }] }));

});

test('empty name', () => {
  const eb = newEventBatcher({ maximum: 3 });
  expect(() => eb.addEvent('', {})).toThrowError(Error);

});

test('without settings', () => {
  const eb = newEventBatcher();
  expect(() => eb.addEvent('', {})).toThrowError(Error);

});

function newEventBatcher(settings?: {
  interval?: number, // sec
  maximum?: number,
}){
  return new EventBatcher('o', 'p', '1', sourcesApi, settings);
}

function expected(body: {}) {
  return {
    body: body,
    orgName: 'o',
    projectName: 'p',
    sourceId: '1',
  }
}
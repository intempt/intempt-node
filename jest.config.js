/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/*.ts',
    'src/*.js',
    '!src/batcher.js',
    '!src/index.ts',
    '!src/runtime.ts',
  ],
};
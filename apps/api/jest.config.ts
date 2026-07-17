import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!**/*.module.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@nexus/database$': '<rootDir>/../../../packages/database/src/index.ts',
    '^@nexus/types$': '<rootDir>/../../../packages/types/src/index.ts',
  },
};

export default config;

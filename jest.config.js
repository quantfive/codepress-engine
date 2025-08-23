module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.(test|spec).ts', '**/*.(test|spec).js'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': 'babel-jest',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,js}',
    '!src/**/*.d.ts',
  ],
  setupFilesAfterEnv: [],
  testTimeout: 10000,
};
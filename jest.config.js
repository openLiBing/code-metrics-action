/**
 * Jest 配置（TypeScript + ts-jest）。
 * 覆盖率同时产出 json（供平台上报）与 cobertura（供 diff-cover 计算增量覆盖率）。
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  clearMocks: true,
  collectCoverage: true,
  // 与 .c8rc.json 口径保持一致：全量纳入 src，排除 action 入口壳、主流程与内置二进制目录
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/main.ts', '!src/types/**', '!src/bin/**'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'json', 'cobertura']
};

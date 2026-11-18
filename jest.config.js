/**
 * Jest 配置（替代原 node --test + c8）。
 * 覆盖率同时产出 json（供平台上报）与 cobertura（供 diff-cover 计算增量覆盖率）。
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  clearMocks: true,
  collectCoverage: true,
  // 与 .c8rc.json 口径保持一致：全量纳入 src，排除 action 入口与内置二进制目录
  collectCoverageFrom: ['src/**/*.js', '!src/index.js', '!src/bin/**'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'json', 'cobertura']
};

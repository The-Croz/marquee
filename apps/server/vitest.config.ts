import { defineConfig } from 'vitest/config';

// Times in answers ("tries again at 2:00 AM") use the process's time zone. Pin it so
// tests and the iPhone fixtures come out the same on a Mac and in CI.
process.env.TZ = 'UTC';

export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 20000 } });

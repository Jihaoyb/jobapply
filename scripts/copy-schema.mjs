import { cp } from 'node:fs/promises';
await cp('src/server/migrations', 'dist/server/migrations', {
  recursive: true,
});

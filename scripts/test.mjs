// Runs node --test on every *.test.mjs file of a folder (explicit paths work on every Node version >= 18).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test/unit';
const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => join(dir, name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);

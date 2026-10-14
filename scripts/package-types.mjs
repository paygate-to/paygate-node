// dist/cjs holds CommonJS while the package is "type": "module": mark the folder so Node loads it as CommonJS.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

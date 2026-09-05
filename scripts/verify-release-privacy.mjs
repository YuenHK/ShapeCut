import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const directory = resolve(process.argv[2] ?? 'docs/validation');
  const names = readdirSync(directory).filter(name => /^wasm-geometry-.*\.(json|jsonl)$/.test(name));
  if (names.length === 0) throw new Error('No release evidence');
  const forbidden = /(?:\/Users\/|\\+Users\\+|@|knight|fortress|\.stl|sha256|sourceHash)/i;
  for (const name of names) {
    if (forbidden.test(readFileSync(resolve(directory, name), 'utf8'))) throw new Error('Private content');
  }
  console.log(`Release evidence privacy scan passed (${names.length} files)`);
} catch {
  console.error('Release evidence privacy scan failed; missing, unreadable or disallowed evidence.');
  process.exitCode = 1;
}

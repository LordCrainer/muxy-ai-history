import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const utils = await import('../src/panel/utils.js');

function base64Encode(s) {
  return Buffer.from(s, 'utf-8').toString('base64');
}

const WRITE_CHUNK_SIZE = 60 * 1024;
const tmpDir = mkdtempSync(join(tmpdir(), 'ai-history-test-'));
const b64File = join(tmpDir, 'out.b64');
const outFile = join(tmpDir, 'out.md');

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${detail}`); }
}

function shell(cmd) {
  return execSync(cmd, { encoding: 'utf-8', shell: '/bin/sh' });
}

async function writeLargeStringToFile(filePath, content) {
  const b64 = base64Encode(content);
  const chunks = utils.chunkString(b64, WRITE_CHUNK_SIZE);
  // Clean
  shell(`/bin/rm -f '${b64File}'`);
  for (const chunk of chunks) {
    shell(`printf '%s' '${chunk}' >> '${b64File}'`);
  }
  shell(`/bin/mkdir -p '${tmpDir}' && /usr/bin/base64 -d < '${b64File}' > '${filePath}' && /bin/rm -f '${b64File}'`);
  return { ok: true, chunks: chunks.length };
}

console.log('Integration: chunked base64 round-trip');
for (const sizeLabel of ['small (1KB)', 'medium (50KB)', 'large (200KB)', 'huge (1MB)']) {
  let sizeBytes;
  if (sizeLabel.includes('1KB')) sizeBytes = 1024;
  else if (sizeLabel.includes('50KB')) sizeBytes = 50 * 1024;
  else if (sizeLabel.includes('200KB')) sizeBytes = 200 * 1024;
  else sizeBytes = 1024 * 1024;
  const content = 'x'.repeat(sizeBytes);

  const out = join(tmpDir, `test-${sizeLabel.replace(/[^a-z0-9]/gi, '')}.md`);
  const result = await writeLargeStringToFile(out, content);
  check(`${sizeLabel}: chunks reported`, result.chunks > 0, `got ${result.chunks}`);
  check(`${sizeLabel}: file exists`, existsSync(out));
  const readBack = readFileSync(out, 'utf-8');
  check(`${sizeLabel}: round-trip size matches`, readBack.length === sizeBytes, `got ${readBack.length}`);
  check(`${sizeLabel}: round-trip content matches`, readBack === content);
}

// Test with unicode (markdown can contain accents, emojis, etc.)
console.log('\nIntegration: unicode round-trip');
const unicodeContent = 'Hola mundo! 日本語 🚀 ñ á é í ó ú ' + '🎉'.repeat(1000);
const unicodeOut = join(tmpDir, 'unicode.md');
await writeLargeStringToFile(unicodeOut, unicodeContent);
const unicodeBack = readFileSync(unicodeOut, 'utf-8');
check('unicode round-trip exact', unicodeBack === unicodeContent);
check('unicode preserves emoji count', (unicodeBack.match(/🎉/g) || []).length === 1000);

// Test with shell-special characters
console.log('\nIntegration: shell-special characters');
const specialContent = `";'\\\`$()&|<>!{}[]
line 1
line 2 with "quotes" and 'apostrophes' and \`backticks\`
line 3 with $variables and ${'${braces}'} and (parens) and & ampersand
line 4 with |pipes| and <angles> and !exclaim
END`;
const specialOut = join(tmpDir, 'special.md');
await writeLargeStringToFile(specialOut, specialContent);
const specialBack = readFileSync(specialOut, 'utf-8');
check('shell-special round-trip exact', specialBack === specialContent);

// Test with newlines (markdown has lots of these)
console.log('\nIntegration: markdown with newlines');
const mdContent = '# Title\n\n## Section\n\n- bullet 1\n- bullet 2\n\n```\ncode block\n```\n\n' + 'line\n'.repeat(5000);
const mdOut = join(tmpDir, 'md.md');
await writeLargeStringToFile(mdOut, mdContent);
const mdBack = readFileSync(mdOut, 'utf-8');
check('markdown round-trip exact', mdBack === mdContent);

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

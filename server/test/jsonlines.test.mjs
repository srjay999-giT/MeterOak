import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { jsonLines, makeAdapters, parseCodexFile } from '../adapters.mjs';

function temporaryFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-jsonl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'records.jsonl');
}

const usage = (timestamp, total = null) => ({
  timestamp, type: 'event_msg', payload: {
    type: 'token_count', info: {
      last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10 },
      ...(total ? { total_token_usage: total } : {}),
    },
  },
});

test('chunked JSONL preserves UTF-8 across byte boundaries, CRLF, blanks and final unterminated records', (t) => {
  const file = temporaryFile(t);
  const first = { text: 'café — 東京 🪨', n: 1 };
  const second = { text: 'final', n: 2 };
  const content = JSON.stringify(first) + '\r\n \r\n' + JSON.stringify(second);
  fs.writeFileSync(file, content);
  const diagnostics = {};
  assert.deepEqual([...jsonLines(file, { chunkSize: 1, diagnostics })], [first, second]);
  assert.equal(diagnostics.bytesRead, Buffer.byteLength(content));
  assert.equal(diagnostics.linesRead, 3);
  assert.equal(diagnostics.malformedLines ?? 0, 0);
  assert.equal(diagnostics.pendingLines ?? 0, 0);
});

test('malformed complete rows and incomplete final rows are diagnosed separately and recover after append', (t) => {
  const file = temporaryFile(t);
  fs.writeFileSync(file, '{broken}\nnull\n[]\n{"ok":1}\n{"tail":');
  const diagnostics = {};
  assert.deepEqual([...jsonLines(file, { chunkSize: 7, diagnostics })], [{ ok: 1 }]);
  assert.equal(diagnostics.malformedLines, 3);
  assert.equal(diagnostics.pendingLines, 1);
  fs.appendFileSync(file, '2}\n');
  const later = {};
  assert.deepEqual([...jsonLines(file, { chunkSize: 7, diagnostics: later })], [{ ok: 1 }, { tail: 2 }]);
  assert.equal(later.malformedLines, 3);
  assert.equal(later.pendingLines ?? 0, 0);
});

test('oversized rows do not hide following Codex usage and adapter wrapper forwards diagnostics', (t) => {
  const file = temporaryFile(t);
  const rows = [
    { type: 'turn_context', payload: { model: 'fixture-model' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'x'.repeat(5000) } },
    usage('2026-09-24T10:00:00Z'),
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const diagnostics = {};
  const adapter = makeAdapters({ sources: ['codex'] })[0];
  const [session] = adapter.parseFile({ file }, { diagnostics, chunkSize: 31, maxLineBytes: 512 });
  assert.equal(diagnostics.oversizedLines, 1);
  assert.equal(session.usageEvents.length, 1);
  assert.equal(session.usageEvents[0].total, 130);
  assert.equal(session.usageEvents[0].model, 'fixture-model');
});

test('unreadable JSONL paths throw instead of pretending to be empty sessions', (t) => {
  const file = temporaryFile(t);
  assert.throws(() => [...jsonLines(file)], { code: 'ENOENT' });
  assert.throws(() => parseCodexFile(path.dirname(file)), { code: 'EISDIR' });
});

test('missing default Codex store is empty while inaccessible stores report scan errors', (t) => {
  const adapter = makeAdapters({ sources: ['codex'] })[0];
  let code = 'ENOENT';
  t.mock.method(fs, 'readdirSync', () => { throw Object.assign(new Error('Synthetic discovery failure'), { code }); });
  const missing = {};
  assert.deepEqual(adapter.findFiles({ diagnostics: missing }), []);
  assert.deepEqual(missing.issues ?? [], []);
  code = 'EACCES';
  const inaccessible = {};
  assert.deepEqual(adapter.findFiles({ diagnostics: inaccessible }), []);
  assert.equal(inaccessible.issues.length, 1);
  assert.equal(inaccessible.issues[0].kind, 'scan-error');
  assert.equal(inaccessible.issues[0].message, 'Synthetic discovery failure');
  assert.ok(inaccessible.issues[0].file.endsWith('sessions'));
});

test('Codex discovery reports stat failures while retaining accessible log descriptors', (t) => {
  const adapter = makeAdapters({ sources: ['codex'] })[0];
  t.mock.method(fs, 'readdirSync', () => ['blocked.jsonl', 'valid.jsonl']);
  t.mock.method(fs, 'statSync', (file) => {
    if (file.endsWith('blocked.jsonl')) throw Object.assign(new Error('Synthetic stat denial'), { code: 'EACCES' });
    return { isDirectory: () => false, isFile: () => true };
  });
  const diagnostics = {};
  const files = adapter.findFiles({ diagnostics });
  assert.equal(files.length, 1);
  assert.ok(files[0].file.endsWith('valid.jsonl'));
  assert.equal(diagnostics.issues.length, 1);
  assert.ok(diagnostics.issues[0].file.endsWith('blocked.jsonl'));
});

test('last-only equal-sized requests retain distinct timestamps and models', (t) => {
  const file = temporaryFile(t);
  const rows = [
    { type: 'turn_context', payload: { model: 'model-a' } },
    usage('2026-09-24T10:00:00Z'),
    usage('2026-09-24T10:00:01Z'),
    usage('2026-09-24T10:00:01Z'),
    { type: 'turn_context', payload: { model: 'model-b' } },
    usage('2026-09-24T10:00:01Z'),
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const [session] = parseCodexFile(file);
  assert.equal(session.usageEvents.length, 3);
  assert.deepEqual(session.usageEvents.map((event) => event.model), ['model-a', 'model-a', 'model-b']);
  assert.equal(session.usageEvents.reduce((n, event) => n + event.total, 0), 390);
});

test('large retained tool content is capped separately without changing usage or tool metadata', (t) => {
  const file = temporaryFile(t);
  const rows = [
    { timestamp: '2026-09-24T10:00:00Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'fixture', arguments: JSON.stringify({ text: 'x'.repeat(50_000) }) } },
    { timestamp: '2026-09-24T10:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 1\n' + 'x'.repeat(50_000) } },
    usage('2026-09-24T10:00:02Z'),
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const diagnostics = {};
  const [session] = parseCodexFile(file, { diagnostics });
  assert.equal(diagnostics.contentTruncations, 2);
  assert.equal(diagnostics.oversizedLines ?? 0, 0);
  assert.equal(session.events[0].tool.id, 'call-1');
  assert.equal(session.events[0].tool.isError, true);
  assert.equal(session.events[0].tool.resultTs, '2026-09-24T10:00:01Z');
  assert.ok(session.events[0].tool.result.length < 17_000);
  assert.equal(session.usageEvents[0].total, 130);
});

test('default record limit reads multi-megabyte tool output while retained content stays bounded', (t) => {
  const file = temporaryFile(t);
  const rows = [
    { timestamp: '2026-09-24T10:00:00Z', type: 'response_item', payload: { type: 'function_call', call_id: 'large-result', name: 'fixture', arguments: '{}' } },
    { timestamp: '2026-09-24T10:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'large-result', output: 'x'.repeat(2 * 1024 * 1024) } },
    usage('2026-09-24T10:00:02Z'),
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const diagnostics = {};
  const [session] = parseCodexFile(file, { diagnostics });
  assert.equal(diagnostics.oversizedLines ?? 0, 0);
  assert.equal(diagnostics.contentTruncations, 1);
  assert.equal(session.events[0].tool.resultTs, '2026-09-24T10:00:01Z');
  assert.ok(session.events[0].tool.result.length < 17_000);
  assert.equal(session.usageEvents[0].total, 130);
});

test('a sparse JSONL larger than Node string limits is parsed under a small heap', { timeout: 30_000 }, (t) => {
  const file = temporaryFile(t);
  const fd = fs.openSync(file, 'w');
  const offset = 513 * 1024 * 1024;
  const first = JSON.stringify({ type: 'turn_context', payload: { model: 'large-file-model' } }) + '\n';
  const tail = '\n' + JSON.stringify(usage('2026-09-24T10:00:00Z'));
  try {
    fs.writeSync(fd, first, 0, 'utf8');
    fs.writeSync(fd, tail, offset, 'utf8');
  } finally { fs.closeSync(fd); }
  const moduleUrl = new URL('../adapters.mjs', import.meta.url).href;
  const code = `import {parseCodexFile} from ${JSON.stringify(moduleUrl)};
    const diagnostics={}; const [s]=parseCodexFile(process.argv[1],{diagnostics});
    console.log(JSON.stringify({events:s.usageEvents.length,total:s.usageEvents[0].total,model:s.usageEvents[0].model,diagnostics}));`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', code, file], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const result = JSON.parse(child.stdout);
  assert.equal(result.events, 1);
  assert.equal(result.total, 130);
  assert.equal(result.model, 'large-file-model');
  assert.equal(result.diagnostics.oversizedLines, 1);
  assert.equal(result.diagnostics.bytesRead, fs.statSync(file).size);
  assert.ok(result.diagnostics.bytesRead > 0x1fffffe8);
});

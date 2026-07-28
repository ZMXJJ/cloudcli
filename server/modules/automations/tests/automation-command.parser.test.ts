import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeAutomationCommand } from '../automation-command.parser.js';

test('parses goal start, status, and every supported stop spelling', () => {
  assert.deepEqual(parseClaudeAutomationCommand('/goal ship only when tests pass'), {
    kind: 'goal',
    action: 'start',
    command: '/goal ship only when tests pass',
    prompt: 'ship only when tests pass',
  });
  assert.deepEqual(parseClaudeAutomationCommand('  /goal\n  '), {
    kind: 'goal',
    action: 'status',
    command: '/goal',
  });

  for (const stopArgument of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
    assert.deepEqual(parseClaudeAutomationCommand(`/goal ${stopArgument}`), {
      kind: 'goal',
      action: 'stop',
      command: `/goal ${stopArgument}`,
    });
  }
});

test('treats a goal stop word with additional text as a new goal condition', () => {
  assert.deepEqual(parseClaudeAutomationCommand('/goal clear the failing tests'), {
    kind: 'goal',
    action: 'start',
    command: '/goal clear the failing tests',
    prompt: 'clear the failing tests',
  });
});

test('rejects a bare loop and parses a scheduled loop as a start', () => {
  assert.equal(parseClaudeAutomationCommand('/loop'), null);
  assert.deepEqual(parseClaudeAutomationCommand('/loop 5m check the deployment'), {
    kind: 'loop',
    action: 'start',
    command: '/loop 5m check the deployment',
    prompt: '5m check the deployment',
  });
});

test('does not recognize embedded, quoted, fenced, or prefix-lookalike commands', () => {
  for (const input of [
    'please run /goal finish this',
    '"/goal finish this"',
    "'/loop 5m check'",
    '`/goal finish this`',
    '```\n/loop 5m check\n```',
    '/goalkeeper finish this',
    '/loops 5m check',
    '/Goal finish this',
    '/goal\0finish this',
  ]) {
    assert.equal(parseClaudeAutomationCommand(input), null, input);
  }
});

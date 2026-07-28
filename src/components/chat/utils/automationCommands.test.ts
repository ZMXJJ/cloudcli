import assert from 'node:assert/strict';
import test from 'node:test';

import { readAutomationCommand } from './automationCommands';

test('composer treats a bare loop as a normal chat command', () => {
  assert.equal(readAutomationCommand('/loop'), null);
  assert.deepEqual(readAutomationCommand('/loop 5m check the deployment'), {
    kind: 'loop',
    action: 'start',
  });
});

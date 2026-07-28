import assert from 'node:assert/strict';
import test from 'node:test';

import { sendAutomationControl } from './automationControls';

test('automation controls send the current session generation and preserve transport failure', () => {
  const frames: unknown[] = [];
  const sendMessage = (frame: unknown) => {
    frames.push(frame);
    return false;
  };

  assert.equal(
    sendAutomationControl(sendMessage, 'stop', 'session-1', 'automation-1'),
    false,
  );
  assert.deepEqual(frames[0], {
    type: 'automation.stop',
    sessionId: 'session-1',
    automationId: 'automation-1',
  });

  assert.equal(
    sendAutomationControl(() => true, 'dismiss', 'session-1', 'automation-1'),
    true,
  );
});

export type GoalAutomationCommand =
  | {
      kind: 'goal';
      action: 'start';
      command: string;
      prompt: string;
    }
  | {
      kind: 'goal';
      action: 'status';
      command: string;
    }
  | {
      kind: 'goal';
      action: 'stop';
      command: string;
    };

export type LoopAutomationCommand = {
  kind: 'loop';
  action: 'start';
  command: string;
  prompt: string;
};

export type ClaudeAutomationCommand = GoalAutomationCommand | LoopAutomationCommand;

const GOAL_STOP_ARGUMENTS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

/**
 * Recognizes only a slash command in the first non-whitespace token. Text that
 * quotes, embeds, or prefixes the command is intentionally left to Claude.
 */
export function parseClaudeAutomationCommand(input: string): ClaudeAutomationCommand | null {
  if (typeof input !== 'string' || input.includes('\0')) {
    return null;
  }

  const command = input.trim();
  const match = command.match(/^\/(goal|loop)(?=$|\s)([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const kind = match[1] as 'goal' | 'loop';
  const prompt = match[2].trim();

  if (kind === 'loop') {
    // A bare /loop creates no scheduler entry and would leave an idle tmux alive forever.
    if (!prompt) return null;
    return {
      kind,
      action: 'start',
      command,
      prompt,
    };
  }

  if (!prompt) {
    return {
      kind,
      action: 'status',
      command,
    };
  }

  if (GOAL_STOP_ARGUMENTS.has(prompt)) {
    return {
      kind,
      action: 'stop',
      command,
    };
  }

  return {
    kind,
    action: 'start',
    command,
    prompt,
  };
}

export const parseAutomationCommand = parseClaudeAutomationCommand;

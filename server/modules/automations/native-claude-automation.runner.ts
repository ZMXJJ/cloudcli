import {
  spawn as nodeSpawn,
  execFile as nodeExecFile,
  execFileSync as nodeExecFileSync,
  type ChildProcess,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

import { parseClaudeAutomationCommand } from './automation-command.parser.js';

const SUPPORTED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SUPPORTED_PERMISSION_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOP_LAUNCH_COMMAND = 'exec "$CLOUDCLI_AUTOMATION_NODE" "$CLOUDCLI_AUTOMATION_LAUNCHER"';
const GOAL_SUPERVISOR_EXIT_EVENT_TYPE = 'cloudcli_goal_supervisor_exit_v1';
const GOAL_RUNTIME_ID_PREFIX = 'cloudcli-goal-v1:';
const GOAL_AUTOMATION_ARG_PREFIX = '--cloudcli-automation-id=';
const GOAL_TOKEN_ARG_PREFIX = '--cloudcli-runtime-token=';
const GOAL_COMMAND_ARG_PREFIX = '--cloudcli-command=';
const GOAL_ARGS_ARG_PREFIX = '--cloudcli-args=';
const DEFAULT_ESCAPE_DELAY_MS = 150;
const DEFAULT_EXIT_DELAY_MS = 750;
const DEFAULT_GOAL_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_GOAL_TERMINATE_TIMEOUT_MS = 2_000;
const DEFAULT_GOAL_CLEAR_TIMEOUT_MS = 30_000;
const DEFAULT_GOAL_CLEAR_KILL_TIMEOUT_MS = 2_000;
const DEFAULT_LOOP_STARTUP_DELAY_MS = 300;
const DEFAULT_LOOP_ENVIRONMENT_HANDSHAKE_TIMEOUT_MS = 5_000;
const MINIMUM_CLAUDE_AUTOMATION_VERSION = [2, 1, 145] as const;
const MAX_AUTOMATION_COMMAND_BYTES = 64 * 1024;
const MAX_LOOP_INPUT_BYTES = 1024 * 1024;
const MAX_LOOP_ENVIRONMENT_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_LOOP_ENVIRONMENT_REQUEST_BYTES = 4 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const UNSAFE_LOOP_INPUT_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const AUTOMATION_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const LOOP_OBSERVER_PLUGIN_VERSION = 'v2';
const LOOP_ENVIRONMENT_DIRECTORY_PREFIX = 'cloudcli-loop-env-';
const LOOP_ENVIRONMENT_SOCKET_ENV = 'CLOUDCLI_AUTOMATION_ENV_SOCKET';
const LOOP_ENVIRONMENT_TOKEN_ENV = 'CLOUDCLI_AUTOMATION_ENV_TOKEN';
const LOOP_TMUX_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SSH_AUTH_SOCK',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TMUX',
  'TMUX_PANE',
  'TMUX_TMPDIR',
  'USER',
  'XDG_RUNTIME_DIR',
]);
const LOOP_OBSERVER_PLUGIN_MANIFEST = {
  name: 'cloudcli-loop-observer',
  description: 'Observes Claude Code Loop scheduler state for CloudCLI.',
  version: '2.0.0',
};
const LOOP_OBSERVER_HOOKS = {
  description: 'Writes non-blocking Loop scheduler snapshots for CloudCLI.',
  hooks: {
    Stop: [{
      hooks: [{
        type: 'command',
        command: '"${CLOUDCLI_AUTOMATION_HOOK_NODE}" "${CLOUDCLI_AUTOMATION_OBSERVER_SCRIPT}"',
        timeout: 5,
      }],
    }],
  },
};

export type ClaudeAutomationSessionTarget =
  | {
      providerSessionId: string;
      sessionId?: never;
    }
  | {
      providerSessionId?: never;
      sessionId: string;
    };

export type ClaudeAutomationCliPreferences = {
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  allowedTools?: readonly string[] | null;
  disallowedTools?: readonly string[] | null;
};

export type NativeClaudeAutomationStartOptions = ClaudeAutomationSessionTarget
  & ClaudeAutomationCliPreferences
  & {
    automationId: string;
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  };

export type NativeClaudeGoalClearOptions = ClaudeAutomationSessionTarget
  & ClaudeAutomationCliPreferences
  & {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  };

export type NativeClaudeRawEvent = {
  raw: string;
  value: unknown;
};

export type NativeClaudeGoalExit = {
  automationId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  interrupted: boolean;
  result: NativeClaudeResultSummary | null;
  error?: Error;
};

export type NativeClaudeResultSummary = {
  raw: string;
  value: unknown;
  subtype: string | null;
  isError: boolean;
  errors: string[];
  message: string | null;
};

export type NativeClaudeGoalCallbacks = {
  onRawEvent?: (event: NativeClaudeRawEvent) => void;
  onEvent?: (value: unknown, raw: string) => void;
  onMalformedOutput?: (raw: string, error: Error) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (result: NativeClaudeGoalExit) => void;
};

export type NativeClaudeGoalHandle = {
  automationId: string;
  runtimeId: string;
  pid: number | undefined;
  completion: Promise<NativeClaudeGoalExit>;
  interrupt: () => boolean;
};

export type NativeClaudeGoalCleanupStatus =
  | 'terminated'
  | 'not_found'
  | 'identity_mismatch'
  | 'unverifiable'
  | 'unsupported';

export type NativeClaudeGoalCleanupResult = {
  status: NativeClaudeGoalCleanupStatus;
  matchedProcessCount: number;
};

export type NativeClaudeProcessSnapshot = {
  pid: number;
  processGroupId: number;
  command: string;
};

export type NativeClaudeGoalClearResult = {
  success: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  events: NativeClaudeRawEvent[];
  result: NativeClaudeResultSummary | null;
  stderr: string;
  error?: Error;
};

export type NativeClaudeLoopHandle = {
  automationId: string;
  runtimeId: string;
};

export type NativeClaudeLoopObservation = {
  automationId: string;
  observedAt: string;
  sessionId: string | null;
  everScheduled: boolean;
  sessionCrons: unknown[];
  backgroundTasks: unknown[];
};

export type ExecFileResult = {
  stdout: string;
  stderr: string;
};

export type NativeClaudeAutomationDependencies = {
  spawn?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      shell: false;
      stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
      windowsHide: boolean;
      detached?: boolean;
    },
  ) => ChildProcess;
  execFile?: (
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env: NodeJS.ProcessEnv;
      windowsHide: boolean;
    },
  ) => Promise<ExecFileResult>;
  execFileSync?: (
    command: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      windowsHide: boolean;
      encoding: 'utf8';
      timeout: number;
    },
  ) => string;
  delay?: (milliseconds: number) => Promise<void>;
  setTimeout?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout?: (timeout: NodeJS.Timeout) => void;
  claudeCommand?: string;
  tmuxCommand?: string;
  launcherPath?: string;
  goalSupervisorPath?: string;
  nodeCommand?: string;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  escapeDelayMs?: number;
  exitDelayMs?: number;
  goalInterruptTimeoutMs?: number;
  goalTerminateTimeoutMs?: number;
  goalClearTimeoutMs?: number;
  goalClearKillTimeoutMs?: number;
  automationStateDir?: string;
  loopObserverScriptPath?: string;
  claudeVersion?: string;
  loopStartupDelayMs?: number;
  loopEnvironmentHandshakeTimeoutMs?: number;
  listProcesses?: () => NativeClaudeProcessSnapshot[];
  signalProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => boolean;
};

type ActiveGoal = {
  process: ChildProcess;
  interrupted: boolean;
  processGroupId: number | null;
  supervisedExit?: { code: number | null; signal: NodeJS.Signals | null };
  interruptResult?: boolean;
  terminateTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
};

type GoalRuntimeIdentity = {
  version: 1;
  automationId: string;
  runtimeToken: string;
  supervisorPid: number;
};

type LoopEnvironmentBroker = {
  socketPath: string;
  runtimeToken: string;
  acknowledged: Promise<void>;
  close: () => Promise<void>;
};

export class NativeClaudeAutomationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AUTOMATION_ALREADY_RUNNING'
      | 'AUTOMATION_NOT_FOUND'
      | 'INVALID_COMMAND'
      | 'INVALID_OPTIONS'
      | 'CLAUDE_VERSION_UNSUPPORTED'
      | 'TMUX_UNAVAILABLE'
      | 'UNSUPPORTED_PLATFORM',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NativeClaudeAutomationError';
  }
}

export function validateClaudeLoopInput(input: string): void {
  if (!input.trim()) {
    throw new NativeClaudeAutomationError(
      'Loop input must not be empty.',
      'INVALID_OPTIONS',
    );
  }
  if (UNSAFE_LOOP_INPUT_PATTERN.test(input)) {
    throw new NativeClaudeAutomationError(
      'Loop input contains an unsafe terminal control character.',
      'INVALID_OPTIONS',
    );
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_LOOP_INPUT_BYTES) {
    throw new NativeClaudeAutomationError(
      `Loop input exceeds the ${MAX_LOOP_INPUT_BYTES}-byte limit.`,
      'INVALID_OPTIONS',
    );
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: Parameters<NonNullable<NativeClaudeAutomationDependencies['spawn']>>[2],
): ChildProcess {
  return nodeSpawn(command, [...args], options);
}

function defaultExecFile(
  command: string,
  args: readonly string[],
  options: Parameters<NonNullable<NativeClaudeAutomationDependencies['execFile']>>[2],
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      command,
      [...args],
      {
        ...options,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function defaultExecFileSync(
  command: string,
  args: readonly string[],
  options: Parameters<NonNullable<NativeClaudeAutomationDependencies['execFileSync']>>[2],
): string {
  return nodeExecFileSync(command, [...args], options);
}

function parseProcessSnapshots(output: string): NativeClaudeProcessSnapshot[] {
  const snapshots: NativeClaudeProcessSnapshot[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const processGroupId = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0
      || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
      continue;
    }
    snapshots.push({ pid, processGroupId, command: match[3] });
  }
  return snapshots;
}

function defaultSignalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function createGoalRuntimeId(identity: GoalRuntimeIdentity): string {
  return `${GOAL_RUNTIME_ID_PREFIX}${Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url')}`;
}

function parseGoalRuntimeId(runtimeId: string | null | undefined): GoalRuntimeIdentity | null {
  if (!runtimeId?.startsWith(GOAL_RUNTIME_ID_PREFIX)) return null;
  try {
    const value = JSON.parse(
      Buffer.from(runtimeId.slice(GOAL_RUNTIME_ID_PREFIX.length), 'base64url').toString('utf8'),
    ) as Partial<GoalRuntimeIdentity>;
    if (value.version !== 1 || !AUTOMATION_ID_PATTERN.test(value.automationId ?? '')
      || typeof value.runtimeToken !== 'string' || !UUID_PATTERN.test(value.runtimeToken)
      || !Number.isSafeInteger(value.supervisorPid) || (value.supervisorPid ?? 0) <= 0) {
      return null;
    }
    return value as GoalRuntimeIdentity;
  } catch {
    return null;
  }
}

function encodeGoalSupervisorValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function readGoalSupervisorExit(
  value: unknown,
  automationId: string,
  runtimeToken: string,
): { code: number | null; signal: NodeJS.Signals | null } | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type !== GOAL_SUPERVISOR_EXIT_EVENT_TYPE
    || event.automation_id !== automationId || event.runtime_token !== runtimeToken) {
    return null;
  }
  const code = event.code === null || (typeof event.code === 'number' && Number.isInteger(event.code))
    ? event.code as number | null
    : null;
  const signal = event.signal === null || typeof event.signal === 'string'
    ? event.signal as NodeJS.Signals | null
    : null;
  return { code, signal };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0')) {
    throw new NativeClaudeAutomationError(`${label} must be a non-empty string without null bytes.`, 'INVALID_OPTIONS');
  }
  return normalized;
}

function assertAutomationId(value: string): string {
  const automationId = assertNonEmpty(value, 'automationId');
  if (!AUTOMATION_ID_PATTERN.test(automationId)) {
    throw new NativeClaudeAutomationError(
      'automationId may contain only letters, numbers, underscores, and hyphens.',
      'INVALID_OPTIONS',
    );
  }
  return automationId;
}

function normalizeToolRules(
  rules: readonly string[] | null | undefined,
  label: string,
): string[] {
  if (!rules) return [];
  if (!Array.isArray(rules) || rules.length > 256) {
    throw new NativeClaudeAutomationError(
      `${label} must be an array containing at most 256 tool rules.`,
      'INVALID_OPTIONS',
    );
  }

  return rules.map((rule) => {
    if (typeof rule !== 'string') {
      throw new NativeClaudeAutomationError(`${label} entries must be strings.`, 'INVALID_OPTIONS');
    }
    const normalized = rule.trim();
    if (!normalized || normalized.length > 1_024 || normalized.includes('\0')
      || normalized.includes(',')) {
      throw new NativeClaudeAutomationError(
        `${label} entries must be non-empty, at most 1024 characters, and contain no commas or null bytes.`,
        'INVALID_OPTIONS',
      );
    }
    return normalized;
  });
}

function buildSessionArgs(target: ClaudeAutomationSessionTarget): string[] {
  const providerSessionId = target.providerSessionId?.trim();
  const sessionId = target.sessionId?.trim();

  if (providerSessionId && sessionId) {
    throw new NativeClaudeAutomationError(
      'Provide either providerSessionId or sessionId, not both.',
      'INVALID_OPTIONS',
    );
  }

  if (providerSessionId) {
    if (providerSessionId.includes('\0')) {
      throw new NativeClaudeAutomationError('providerSessionId contains a null byte.', 'INVALID_OPTIONS');
    }
    return ['--resume', providerSessionId];
  }

  if (!sessionId || !UUID_PATTERN.test(sessionId)) {
    throw new NativeClaudeAutomationError(
      'A valid UUID sessionId is required when providerSessionId is not available.',
      'INVALID_OPTIONS',
    );
  }
  return ['--session-id', sessionId];
}

export function buildClaudeAutomationPreferenceArgs(
  preferences: ClaudeAutomationCliPreferences,
): string[] {
  const args: string[] = [];
  const model = preferences.model?.trim();
  if (model && model !== 'default' && !model.includes('\0')) {
    args.push('--model', model);
  }

  const effort = preferences.effort?.trim();
  if (effort && SUPPORTED_EFFORTS.has(effort)) {
    args.push('--effort', effort);
  }

  const permissionMode = preferences.permissionMode?.trim();
  if (permissionMode && SUPPORTED_PERMISSION_MODES.has(permissionMode)) {
    args.push('--permission-mode', permissionMode);
  }

  const allowedTools = normalizeToolRules(preferences.allowedTools, 'allowedTools');
  if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','));

  const disallowedTools = normalizeToolRules(preferences.disallowedTools, 'disallowedTools');
  if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','));
  return args;
}

function requireStartCommand(command: string, kind: 'goal' | 'loop'): string {
  const parsed = parseClaudeAutomationCommand(command);
  if (!parsed || parsed.kind !== kind || parsed.action !== 'start') {
    throw new NativeClaudeAutomationError(
      `Expected a /${kind} start command.`,
      'INVALID_COMMAND',
    );
  }
  if (Buffer.byteLength(parsed.command, 'utf8') > MAX_AUTOMATION_COMMAND_BYTES) {
    throw new NativeClaudeAutomationError(
      `/${kind} command exceeds the ${MAX_AUTOMATION_COMMAND_BYTES}-byte limit.`,
      'INVALID_OPTIONS',
    );
  }
  return parsed.command;
}

export function buildGoalClaudeArgs(options: NativeClaudeAutomationStartOptions): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    ...buildClaudeAutomationPreferenceArgs(options),
    ...buildSessionArgs(options),
    requireStartCommand(options.command, 'goal'),
  ];
}

export function buildGoalClearClaudeArgs(options: NativeClaudeGoalClearOptions): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    ...buildClaudeAutomationPreferenceArgs(options),
    ...buildSessionArgs(options),
    '/goal clear',
  ];
}

export function buildLoopClaudeArgs(
  options: NativeClaudeAutomationStartOptions,
  pluginDir?: string,
): string[] {
  return [
    '--ax-screen-reader',
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    ...buildClaudeAutomationPreferenceArgs(options),
    ...buildSessionArgs(options),
    requireStartCommand(options.command, 'loop'),
  ];
}

export function createTmuxSessionName(automationId: string): string {
  const normalizedId = assertAutomationId(automationId);
  const readable = normalizedId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'session';
  const digest = createHash('sha256').update(normalizedId).digest('hex').slice(0, 16);
  return `cloudcli-${readable}-${digest}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readClaudeResultSummary(raw: string, value: unknown): NativeClaudeResultSummary | null {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'result') {
    return null;
  }

  const result = value as Record<string, unknown>;
  const subtype = typeof result.subtype === 'string' ? result.subtype : null;
  const errors = readStringArray(result.errors);
  const resultText = typeof result.result === 'string' ? result.result.trim() : '';
  const terminalReason = typeof result.terminal_reason === 'string'
    ? result.terminal_reason.trim()
    : '';
  const isError = result.is_error === true
    || (subtype !== null && subtype !== 'success');
  return {
    raw,
    value,
    subtype,
    isError,
    errors,
    message: errors[0] ?? (isError ? resultText || terminalReason || null : null),
  };
}

function isSuccessfulClaudeResult(result: NativeClaudeResultSummary | null): boolean {
  return result?.subtype === 'success' && !result.isError;
}

export function parseClaudeVersion(value: string): [number, number, number] | null {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?=\s|$|[-+()])/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(
  actual: readonly number[],
  minimum: readonly number[],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isTmuxSessionAbsent(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1) {
    return false;
  }
  const record = error as Record<string, unknown>;
  const text = [record.stderr, record.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  return text.includes("can't find session")
    || text.includes('no server running on')
    || text.includes('connection refused');
}

function buildLoopChildEnvironment(
  environment: NodeJS.ProcessEnv,
  observerEnvironment: Record<string, string>,
): Record<string, string> {
  const childEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || key.startsWith('CLOUDCLI_AUTOMATION_')
      || key === 'TMUX' || key === 'TMUX_PANE') {
      continue;
    }
    childEnvironment[key] = value;
  }
  return {
    ...childEnvironment,
    // process.execPath is the Electron binary in desktop builds. Both the
    // launcher and Stop hook must execute it as Node, never as the desktop app.
    ELECTRON_RUN_AS_NODE: '1',
    ...observerEnvironment,
  };
}

function buildTmuxControlEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const controlEnvironment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && LOOP_TMUX_ENVIRONMENT_KEYS.has(key)) {
      controlEnvironment[key] = value;
    }
  }
  return controlEnvironment;
}

async function createLoopEnvironmentSocketDirectory(): Promise<{
  directoryPath: string;
  socketPath: string;
}> {
  const roots = [...new Set([tmpdir(), '/tmp'])];
  const failures: string[] = [];
  for (const root of roots) {
    let directoryPath: string | null = null;
    try {
      directoryPath = await mkdtemp(join(root, LOOP_ENVIRONMENT_DIRECTORY_PREFIX));
      await chmod(directoryPath, 0o700);
      const socketPath = join(directoryPath, 'environment.sock');
      if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
        failures.push(`${socketPath} exceeds the Unix socket path limit`);
        await rm(directoryPath, { recursive: true, force: true });
        continue;
      }
      return { directoryPath, socketPath };
    } catch (error) {
      failures.push(toError(error).message);
      if (directoryPath) await rm(directoryPath, { recursive: true, force: true });
    }
  }
  throw new NativeClaudeAutomationError(
    `Could not create a private Loop environment socket (${failures.join('; ')}).`,
    'INVALID_OPTIONS',
  );
}

async function createLoopEnvironmentBroker(
  environment: Record<string, string>,
  timeoutMs: number,
): Promise<LoopEnvironmentBroker> {
  const runtimeToken = randomUUID();
  const payload = `${JSON.stringify({
    type: 'environment',
    runtime_token: runtimeToken,
    environment,
  })}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_LOOP_ENVIRONMENT_PAYLOAD_BYTES) {
    throw new NativeClaudeAutomationError(
      `Loop environment exceeds the ${MAX_LOOP_ENVIRONMENT_PAYLOAD_BYTES}-byte in-memory transfer limit.`,
      'INVALID_OPTIONS',
    );
  }

  const { directoryPath, socketPath } = await createLoopEnvironmentSocketDirectory();
  const server: Server = createServer();
  const sockets = new Set<Socket>();
  let resolveAcknowledged: () => void = () => undefined;
  let rejectAcknowledged: (error: Error) => void = () => undefined;
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  let closePromise: Promise<void> | null = null;
  const acknowledged = new Promise<void>((resolve, reject) => {
    resolveAcknowledged = resolve;
    rejectAcknowledged = reject;
  });
  // The launcher can fail before startLoop reaches its await. Attach a handler
  // immediately so Node never reports a transient unhandled rejection.
  void acknowledged.catch(() => undefined);

  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (error) rejectAcknowledged(error);
    else resolveAcknowledged();
  };

  server.on('connection', (socket) => {
    sockets.add(socket);
    let buffer = '';
    let environmentSent = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LOOP_ENVIRONMENT_REQUEST_BYTES) {
        settle(new Error('Loop environment launcher request exceeded the protocol size limit.'));
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          settle(new Error('Loop environment launcher sent malformed JSON.'));
          socket.destroy();
          return;
        }
        if (!environmentSent) {
          if (message.type !== 'request' || message.runtime_token !== runtimeToken) {
            settle(new Error('Loop environment launcher failed the one-time token challenge.'));
            socket.destroy();
            return;
          }
          environmentSent = true;
          socket.write(payload);
        } else if (message.type === 'ack' && message.runtime_token === runtimeToken) {
          settle();
          socket.end();
          return;
        } else {
          settle(new Error('Loop environment launcher returned an invalid acknowledgement.'));
          socket.destroy();
          return;
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
    socket.once('error', (error) => settle(toError(error)));
    socket.once('close', () => {
      sockets.delete(socket);
      if (!settled) settle(new Error('Loop environment launcher disconnected before acknowledgement.'));
    });
  });
  server.once('error', (error) => settle(toError(error)));

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
    await rm(directoryPath, { recursive: true, force: true });
    throw error;
  }

  timeout = setTimeout(() => {
    settle(new Error(`Loop environment launcher did not acknowledge within ${timeoutMs}ms.`));
    for (const socket of sockets) socket.destroy();
  }, timeoutMs);

  return {
    socketPath,
    runtimeToken,
    acknowledged,
    close: () => {
      closePromise ??= (async () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await rm(directoryPath, { recursive: true, force: true });
      })();
      return closePromise;
    },
  };
}

export class NativeClaudeAutomationRunner {
  private readonly activeGoals = new Map<string, ActiveGoal>();
  private readonly activeLoops = new Map<string, string>();
  private readonly spawnProcess: NonNullable<NativeClaudeAutomationDependencies['spawn']>;
  private readonly executeFile: NonNullable<NativeClaudeAutomationDependencies['execFile']>;
  private readonly executeFileSync: NonNullable<NativeClaudeAutomationDependencies['execFileSync']>;
  private readonly wait: NonNullable<NativeClaudeAutomationDependencies['delay']>;
  private readonly scheduleTimeout: NonNullable<NativeClaudeAutomationDependencies['setTimeout']>;
  private readonly cancelTimeout: NonNullable<NativeClaudeAutomationDependencies['clearTimeout']>;
  private readonly claudeCommand: string;
  private readonly tmuxCommand: string;
  private readonly launcherPath: string;
  private readonly goalSupervisorPath: string;
  private readonly nodeCommand: string;
  private readonly platform: NodeJS.Platform;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly tmuxControlEnvironment: NodeJS.ProcessEnv;
  private readonly escapeDelayMs: number;
  private readonly exitDelayMs: number;
  private readonly goalInterruptTimeoutMs: number;
  private readonly goalTerminateTimeoutMs: number;
  private readonly goalClearTimeoutMs: number;
  private readonly goalClearKillTimeoutMs: number;
  private readonly automationStateDir: string;
  private readonly loopObserverScriptPath: string;
  private readonly configuredClaudeVersion?: string;
  private readonly loopStartupDelayMs: number;
  private readonly loopEnvironmentHandshakeTimeoutMs: number;
  private readonly listProcesses: () => NativeClaudeProcessSnapshot[];
  private readonly signalProcessGroup: (
    processGroupId: number,
    signal: NodeJS.Signals,
  ) => boolean;
  private claudeVersionChecked = false;
  private loopObserverPluginPromise: Promise<string> | null = null;
  private tmuxAvailable = false;

  constructor(dependencies: NativeClaudeAutomationDependencies = {}) {
    this.spawnProcess = dependencies.spawn ?? defaultSpawn;
    this.executeFile = dependencies.execFile ?? defaultExecFile;
    this.executeFileSync = dependencies.execFileSync ?? defaultExecFileSync;
    this.wait = dependencies.delay ?? delay;
    this.scheduleTimeout = dependencies.setTimeout ?? setTimeout;
    this.cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
    this.claudeCommand = dependencies.claudeCommand
      ?? resolveClaudeCodeExecutablePath(dependencies.processEnv?.CLAUDE_CLI_PATH);
    this.tmuxCommand = dependencies.tmuxCommand ?? 'tmux';
    this.launcherPath = dependencies.launcherPath
      ?? fileURLToPath(new URL('./tmux-claude-launcher.js', import.meta.url));
    this.goalSupervisorPath = dependencies.goalSupervisorPath
      ?? fileURLToPath(new URL('./goal-process-supervisor.js', import.meta.url));
    this.nodeCommand = dependencies.nodeCommand ?? process.execPath;
    this.platform = dependencies.platform ?? process.platform;
    this.processEnv = dependencies.processEnv ?? process.env;
    this.tmuxControlEnvironment = buildTmuxControlEnvironment(this.processEnv);
    this.escapeDelayMs = dependencies.escapeDelayMs ?? DEFAULT_ESCAPE_DELAY_MS;
    this.exitDelayMs = dependencies.exitDelayMs ?? DEFAULT_EXIT_DELAY_MS;
    this.goalInterruptTimeoutMs = dependencies.goalInterruptTimeoutMs
      ?? DEFAULT_GOAL_INTERRUPT_TIMEOUT_MS;
    this.goalTerminateTimeoutMs = dependencies.goalTerminateTimeoutMs
      ?? DEFAULT_GOAL_TERMINATE_TIMEOUT_MS;
    this.goalClearTimeoutMs = dependencies.goalClearTimeoutMs
      ?? DEFAULT_GOAL_CLEAR_TIMEOUT_MS;
    this.goalClearKillTimeoutMs = dependencies.goalClearKillTimeoutMs
      ?? DEFAULT_GOAL_CLEAR_KILL_TIMEOUT_MS;
    this.automationStateDir = dependencies.automationStateDir
      ?? this.processEnv.CLOUDCLI_AUTOMATION_STATE_DIR
      ?? join(homedir(), '.cloudcli', 'automations');
    this.loopObserverScriptPath = dependencies.loopObserverScriptPath
      ?? fileURLToPath(new URL('./loop-stop-observer.js', import.meta.url));
    this.configuredClaudeVersion = dependencies.claudeVersion;
    this.loopStartupDelayMs = dependencies.loopStartupDelayMs
      ?? DEFAULT_LOOP_STARTUP_DELAY_MS;
    this.loopEnvironmentHandshakeTimeoutMs = dependencies.loopEnvironmentHandshakeTimeoutMs
      ?? DEFAULT_LOOP_ENVIRONMENT_HANDSHAKE_TIMEOUT_MS;
    this.listProcesses = dependencies.listProcesses ?? (() => parseProcessSnapshots(
      this.executeFileSync('ps', ['-axo', 'pid=,pgid=,command='], {
        env: this.processEnv,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5_000,
      }),
    ));
    this.signalProcessGroup = dependencies.signalProcessGroup ?? defaultSignalProcessGroup;
  }

  startGoal(
    options: NativeClaudeAutomationStartOptions,
    callbacks: NativeClaudeGoalCallbacks = {},
  ): NativeClaudeGoalHandle {
    this.ensureClaudeVersionSupported();
    const automationId = assertAutomationId(options.automationId);
    const cwd = assertNonEmpty(options.cwd, 'cwd');
    if (this.hasLocal(automationId)) {
      throw new NativeClaudeAutomationError(
        `Automation ${automationId} is already running.`,
        'AUTOMATION_ALREADY_RUNNING',
      );
    }

    const args = buildGoalClaudeArgs(options);
    const environment = { ...this.processEnv, ...options.env };
    const supervised = this.platform !== 'win32';
    const runtimeToken = supervised ? randomUUID() : null;
    const child = supervised
      ? this.spawnProcess(this.nodeCommand, [
          this.goalSupervisorPath,
          `${GOAL_AUTOMATION_ARG_PREFIX}${automationId}`,
          `${GOAL_TOKEN_ARG_PREFIX}${runtimeToken}`,
          `${GOAL_COMMAND_ARG_PREFIX}${encodeGoalSupervisorValue(this.claudeCommand)}`,
          `${GOAL_ARGS_ARG_PREFIX}${encodeGoalSupervisorValue(args)}`,
        ], {
          cwd,
          env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: true,
        })
      : this.spawnProcess(this.claudeCommand, args, {
          cwd,
          env: environment,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
    const active: ActiveGoal = {
      process: child,
      interrupted: false,
      processGroupId: supervised && child.pid ? child.pid : null,
    };
    this.activeGoals.set(automationId, active);

    let resolveCompletion: (result: NativeClaudeGoalExit) => void = () => undefined;
    const completion = new Promise<NativeClaudeGoalExit>((resolve) => {
      resolveCompletion = resolve;
    });
    let finalized = false;
    let finalResult: NativeClaudeResultSummary | null = null;
    const finalize = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error?: Error,
    ) => {
      if (finalized) return;
      finalized = true;
      if (stdoutBuffer) {
        const event = this.emitNdjsonLine(stdoutBuffer, callbacks);
        finalResult = event ? readClaudeResultSummary(event.raw, event.value) ?? finalResult : finalResult;
        stdoutBuffer = '';
      }
      if (active.forceKillTimer) {
        this.cancelTimeout(active.forceKillTimer);
        active.forceKillTimer = undefined;
      }
      if (active.terminateTimer) {
        this.cancelTimeout(active.terminateTimer);
        active.terminateTimer = undefined;
      }
      if (this.activeGoals.get(automationId) === active) {
        this.activeGoals.delete(automationId);
      }
      const reportedExit = active.supervisedExit ?? { code, signal };
      const result: NativeClaudeGoalExit = {
        automationId,
        code: reportedExit.code,
        signal: reportedExit.signal,
        interrupted: active.interrupted,
        result: finalResult,
        ...(error ? { error } : {}),
      };
      callbacks.onExit?.(result);
      resolveCompletion(result);
    };

    let stdoutBuffer = '';
    const emitGoalLine = (line: string): NativeClaudeRawEvent | null => {
      if (runtimeToken) {
        try {
          const supervisorExit = readGoalSupervisorExit(
            JSON.parse(line) as unknown,
            automationId,
            runtimeToken,
          );
          if (supervisorExit) {
            active.supervisedExit = supervisorExit;
            return null;
          }
        } catch {
          // Normal Claude stream handling below reports malformed output.
        }
      }
      return this.emitNdjsonLine(line, callbacks);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = emitGoalLine(line);
        finalResult = event ? readClaudeResultSummary(event.raw, event.value) ?? finalResult : finalResult;
      }
    });
    child.stdout?.once('end', () => {
      if (stdoutBuffer) {
        const event = emitGoalLine(stdoutBuffer);
        finalResult = event ? readClaudeResultSummary(event.raw, event.value) ?? finalResult : finalResult;
        stdoutBuffer = '';
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      callbacks.onStderr?.(chunk.toString());
    });
    child.once('error', (error) => finalize(null, null, toError(error)));
    child.once('close', (code, signal) => finalize(code, signal));

    return {
      automationId,
      runtimeId: runtimeToken && child.pid
        ? createGoalRuntimeId({
            version: 1,
            automationId,
            runtimeToken,
            supervisorPid: child.pid,
          })
        : String(child.pid ?? automationId),
      pid: child.pid,
      completion,
      interrupt: () => this.interruptGoal(automationId),
    };
  }

  private emitNdjsonLine(
    line: string,
    callbacks: NativeClaudeGoalCallbacks,
  ): NativeClaudeRawEvent | null {
    if (!line.trim()) return null;
    try {
      const value: unknown = JSON.parse(line);
      const event = { raw: line, value };
      callbacks.onRawEvent?.(event);
      callbacks.onEvent?.(value, line);
      return event;
    } catch (error) {
      callbacks.onMalformedOutput?.(line, toError(error));
      return null;
    }
  }

  private collectNdjsonLine(
    line: string,
    events: NativeClaudeRawEvent[],
    callbacks: Omit<NativeClaudeGoalCallbacks, 'onExit'>,
  ): void {
    if (!line.trim()) return;
    try {
      const event = { raw: line, value: JSON.parse(line) as unknown };
      events.push(event);
      callbacks.onRawEvent?.(event);
      callbacks.onEvent?.(event.value, event.raw);
    } catch (error) {
      callbacks.onMalformedOutput?.(line, toError(error));
    }
  }

  interruptGoal(automationId: string): boolean {
    const active = this.activeGoals.get(automationId);
    if (!active) return false;
    if (active.interrupted) return active.interruptResult ?? false;

    active.interrupted = true;
    const interruptResult = this.signalActiveGoal(active, 'SIGINT');
    active.interruptResult = interruptResult;
    const terminateTimer = this.scheduleTimeout(() => {
      active.terminateTimer = undefined;
      if (this.activeGoals.get(automationId) === active) {
        this.signalActiveGoal(active, 'SIGTERM');
        const forceKillTimer = this.scheduleTimeout(() => {
          active.forceKillTimer = undefined;
          if (this.activeGoals.get(automationId) === active) {
            this.signalActiveGoal(active, 'SIGKILL');
          }
        }, this.goalTerminateTimeoutMs);
        forceKillTimer.unref();
        active.forceKillTimer = forceKillTimer;
      }
    }, this.goalInterruptTimeoutMs);
    terminateTimer.unref();
    active.terminateTimer = terminateTimer;
    return interruptResult;
  }

  /**
   * Reclaims a Goal supervisor left by a previous server generation. The
   * command marker and PG leader are both verified before any signal is sent,
   * so a recycled PID cannot cause an unrelated process to be terminated.
   */
  async cleanupGoalRuntime(
    automationId: string,
    runtimeId: string | null,
  ): Promise<NativeClaudeGoalCleanupResult> {
    const normalizedId = assertAutomationId(automationId);
    if (this.platform === 'win32') {
      return { status: 'unsupported', matchedProcessCount: 0 };
    }

    const identity = parseGoalRuntimeId(runtimeId);
    const snapshots = this.listProcesses();
    let identityMismatch = false;
    let matches: NativeClaudeProcessSnapshot[];
    if (identity) {
      if (identity.automationId !== normalizedId) {
        return { status: 'identity_mismatch', matchedProcessCount: 0 };
      }
      const pidSnapshot = snapshots.find(({ pid }) => pid === identity.supervisorPid);
      if (pidSnapshot && !this.isGoalSupervisorProcess(
        pidSnapshot,
        normalizedId,
        identity.runtimeToken,
      )) {
        identityMismatch = true;
      }
      if (!pidSnapshot && snapshots.some(({ processGroupId }) => (
        processGroupId === identity.supervisorPid
      ))) {
        // Descendants remain, but the random argv marker died with the leader.
        // We cannot distinguish that old PG from a later reuse safely.
        identityMismatch = true;
      }
      matches = snapshots.filter((snapshot) => (
        snapshot.pid === identity.supervisorPid
        && this.isGoalSupervisorProcess(snapshot, normalizedId, identity.runtimeToken)
      ));
    } else {
      // A crash can land between spawn and runtime_id persistence. The
      // automation id is persisted first and is also an exact argv marker, so
      // that narrow window remains discoverable without trusting a bare PID.
      matches = snapshots.filter((snapshot) => (
        this.isGoalSupervisorProcess(snapshot, normalizedId)
      ));
    }

    if (matches.length === 0) {
      return {
        status: identityMismatch
          ? 'identity_mismatch'
          : identity
            ? 'not_found'
            : runtimeId
            ? 'unverifiable'
            : 'not_found',
        matchedProcessCount: 0,
      };
    }

    for (const match of matches) {
      const terminated = await this.terminateGoalSupervisor(match, normalizedId);
      if (!terminated) {
        throw new Error(
          `Goal supervisor process group ${match.processGroupId} did not exit after SIGKILL.`,
        );
      }
    }
    return { status: 'terminated', matchedProcessCount: matches.length };
  }

  private signalActiveGoal(active: ActiveGoal, signal: NodeJS.Signals): boolean {
    if (active.processGroupId !== null) {
      return this.signalProcessGroup(active.processGroupId, signal);
    }
    return active.process.kill(signal);
  }

  private isGoalSupervisorProcess(
    snapshot: NativeClaudeProcessSnapshot,
    automationId: string,
    runtimeToken?: string,
  ): boolean {
    if (snapshot.pid !== snapshot.processGroupId
      || !snapshot.command.includes(this.goalSupervisorPath)) {
      return false;
    }
    const commandArguments = snapshot.command.split(/\s+/);
    if (!commandArguments.includes(`${GOAL_AUTOMATION_ARG_PREFIX}${automationId}`)) {
      return false;
    }
    if (runtimeToken) {
      return commandArguments.includes(`${GOAL_TOKEN_ARG_PREFIX}${runtimeToken}`);
    }
    const tokenArgument = commandArguments.find((argument) => (
      argument.startsWith(GOAL_TOKEN_ARG_PREFIX)
    ));
    return Boolean(tokenArgument && UUID_PATTERN.test(tokenArgument.slice(GOAL_TOKEN_ARG_PREFIX.length)));
  }

  private async terminateGoalSupervisor(
    snapshot: NativeClaudeProcessSnapshot,
    automationId: string,
  ): Promise<boolean> {
    // After the leader identity is trusted, cleanup tracks the PG itself. The
    // leader can exit before a tool grandchild; treating that as success would
    // recreate the original orphan process bug.
    const groupStillExists = () => this.listProcesses().some((candidate) => (
      candidate.processGroupId === snapshot.processGroupId
    ));
    for (const [signal, timeout] of [
      ['SIGINT', this.goalInterruptTimeoutMs],
      ['SIGTERM', this.goalTerminateTimeoutMs],
    ] as const) {
      if (!this.signalProcessGroup(snapshot.processGroupId, signal) || !groupStillExists()) return true;
      if (timeout > 0) await this.wait(timeout);
      if (!groupStillExists()) return true;
    }
    if (!this.signalProcessGroup(snapshot.processGroupId, 'SIGKILL') || !groupStillExists()) return true;
    await this.wait(100);
    return !groupStillExists();
  }

  /** Runs the native clear command without occupying the active Goal map. */
  clearGoal(
    options: NativeClaudeGoalClearOptions,
    callbacks: Omit<NativeClaudeGoalCallbacks, 'onExit'> = {},
  ): Promise<NativeClaudeGoalClearResult> {
    const cwd = assertNonEmpty(options.cwd, 'cwd');
    const args = buildGoalClearClaudeArgs(options);
    const environment = { ...this.processEnv, ...options.env };
    const supervised = this.platform !== 'win32';
    const automationId = supervised ? `clear-${randomUUID()}` : null;
    const runtimeToken = supervised ? randomUUID() : null;
    const child = supervised
      ? this.spawnProcess(this.nodeCommand, [
          this.goalSupervisorPath,
          `${GOAL_AUTOMATION_ARG_PREFIX}${automationId}`,
          `${GOAL_TOKEN_ARG_PREFIX}${runtimeToken}`,
          `${GOAL_COMMAND_ARG_PREFIX}${encodeGoalSupervisorValue(this.claudeCommand)}`,
          `${GOAL_ARGS_ARG_PREFIX}${encodeGoalSupervisorValue(args)}`,
        ], {
          cwd,
          env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: true,
        })
      : this.spawnProcess(this.claudeCommand, args, {
          cwd,
          env: environment,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
    const processGroupId = supervised && child.pid ? child.pid : null;
    const events: NativeClaudeRawEvent[] = [];
    let stderr = '';
    let stdoutBuffer = '';
    let supervisedExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const collectClearLine = (line: string) => {
      if (automationId && runtimeToken) {
        try {
          const exit = readGoalSupervisorExit(JSON.parse(line) as unknown, automationId, runtimeToken);
          if (exit) {
            supervisedExit = exit;
            return;
          }
        } catch {
          // Normal malformed output handling below owns non-supervisor lines.
        }
      }
      this.collectNdjsonLine(line, events, callbacks);
    };
    const signalClear = (signal: NodeJS.Signals) => (
      processGroupId === null
        ? child.kill(signal)
        : this.signalProcessGroup(processGroupId, signal)
    );

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        collectClearLine(line);
      }
    });
    child.stdout?.once('end', () => {
      if (stdoutBuffer) {
        collectClearLine(stdoutBuffer);
        stdoutBuffer = '';
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      callbacks.onStderr?.(text);
    });

    return new Promise((resolve) => {
      let finalized = false;
      let terminateTimer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let timeoutError: Error | undefined;
      const finalize = (
        code: number | null,
        signal: NodeJS.Signals | null,
        error?: Error,
      ) => {
        if (finalized) return;
        finalized = true;
        if (terminateTimer) this.cancelTimeout(terminateTimer);
        if (forceKillTimer) this.cancelTimeout(forceKillTimer);
        const reportedExit = supervisedExit ?? { code, signal };
        const result = [...events]
          .reverse()
          .map((event) => readClaudeResultSummary(event.raw, event.value))
          .find((event): event is NativeClaudeResultSummary => event !== null) ?? null;
        const finalError = error ?? timeoutError;
        resolve({
          success: !finalError && reportedExit.code === 0 && isSuccessfulClaudeResult(result),
          code: reportedExit.code,
          signal: reportedExit.signal,
          events,
          result,
          stderr,
          ...(finalError ? { error: finalError } : {}),
        });
      };
      child.once('error', (error) => finalize(null, null, toError(error)));
      child.once('close', (code, signal) => finalize(code, signal));

      terminateTimer = this.scheduleTimeout(() => {
        terminateTimer = undefined;
        timeoutError = new Error(
          `/goal clear timed out after ${this.goalClearTimeoutMs}ms and was terminated.`,
        );
        signalClear('SIGTERM');
        forceKillTimer = this.scheduleTimeout(() => {
          forceKillTimer = undefined;
          signalClear('SIGKILL');
          finalize(null, 'SIGKILL', timeoutError);
        }, this.goalClearKillTimeoutMs);
        forceKillTimer.unref();
      }, this.goalClearTimeoutMs);
      terminateTimer.unref();
    });
  }

  hasGoal(automationId: string): boolean {
    return this.activeGoals.has(automationId);
  }

  async startLoop(options: NativeClaudeAutomationStartOptions): Promise<NativeClaudeLoopHandle> {
    this.ensureClaudeVersionSupported();
    if (this.platform === 'win32') {
      throw new NativeClaudeAutomationError(
        'Loop automation requires tmux and is not supported on Windows.',
        'UNSUPPORTED_PLATFORM',
      );
    }

    const automationId = assertAutomationId(options.automationId);
    const cwd = assertNonEmpty(options.cwd, 'cwd');
    const runtimeId = createTmuxSessionName(automationId);
    await this.ensureTmuxAvailable();
    await this.cleanupStaleLoopEnvironmentFiles();
    if (this.hasLocal(automationId) || await this.hasTmuxSession(runtimeId)) {
      throw new NativeClaudeAutomationError(
        `Automation ${automationId} is already running.`,
        'AUTOMATION_ALREADY_RUNNING',
      );
    }

    const observerPluginDir = await this.ensureLoopObserverPlugin();
    await this.clearLoopObservation(automationId);
    const claudeArgs = buildLoopClaudeArgs(options, observerPluginDir);
    const encodedArgs = Buffer.from(JSON.stringify(claudeArgs), 'utf8').toString('base64url');
    const environment = { ...this.processEnv, ...options.env };
    const environmentBroker = await createLoopEnvironmentBroker(buildLoopChildEnvironment(environment, {
      CLOUDCLI_AUTOMATION_ID: automationId,
      CLOUDCLI_AUTOMATION_STATE_DIR: this.automationStateDir,
      CLOUDCLI_AUTOMATION_HOOK_NODE: this.nodeCommand,
      CLOUDCLI_AUTOMATION_OBSERVER_SCRIPT: this.loopObserverScriptPath,
    }), this.loopEnvironmentHandshakeTimeoutMs);
    const tmuxArgs = [
      'new-session',
      '-d',
      '-s',
      runtimeId,
      '-c',
      cwd,
      '-e',
      `CLOUDCLI_AUTOMATION_CLAUDE_COMMAND=${this.claudeCommand}`,
      '-e',
      `CLOUDCLI_AUTOMATION_CLAUDE_ARGS=${encodedArgs}`,
      '-e',
      `CLOUDCLI_AUTOMATION_NODE=${this.nodeCommand}`,
      '-e',
      `CLOUDCLI_AUTOMATION_LAUNCHER=${this.launcherPath}`,
      '-e',
      `${LOOP_ENVIRONMENT_SOCKET_ENV}=${environmentBroker.socketPath}`,
      '-e',
      `${LOOP_ENVIRONMENT_TOKEN_ENV}=${environmentBroker.runtimeToken}`,
      '-e',
      'ELECTRON_RUN_AS_NODE=1',
      LOOP_LAUNCH_COMMAND,
    ];

    let sessionCreated = false;
    try {
      await this.executeTmux(tmuxArgs, { cwd, env: this.tmuxControlEnvironment });
      sessionCreated = true;
      await environmentBroker.acknowledged;
      await this.wait(this.loopStartupDelayMs);
      if (!await this.hasTmuxSession(runtimeId)) {
        throw new NativeClaudeAutomationError(
          'Claude Loop exited during startup. Check the Claude and CloudCLI server logs.',
          'AUTOMATION_NOT_FOUND',
        );
      }
    } catch (error) {
      if (sessionCreated) {
        await this.executeTmux(['kill-session', '-t', runtimeId]).catch(() => undefined);
      }
      await this.clearLoopObservation(automationId);
      throw error;
    } finally {
      await environmentBroker.close();
    }
    this.activeLoops.set(automationId, runtimeId);
    return { automationId, runtimeId };
  }

  async hasLoop(automationId: string): Promise<boolean> {
    if (this.platform === 'win32') return false;
    await this.ensureTmuxAvailable();
    return this.hasTmuxSession(this.resolveLoopRuntimeId(automationId));
  }

  async sendLoopInput(automationId: string, input: string): Promise<void> {
    validateClaudeLoopInput(input);
    await this.ensureTmuxAvailable();
    const runtimeId = this.resolveLoopRuntimeId(automationId);
    if (!await this.hasTmuxSession(runtimeId)) {
      this.activeLoops.delete(automationId);
      throw new NativeClaudeAutomationError(
        `Loop automation ${automationId} is not running.`,
        'AUTOMATION_NOT_FOUND',
      );
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'cloudcli-loop-input-'));
    const inputPath = join(temporaryDirectory, 'input.txt');
    const bufferName = `cloudcli-input-${randomUUID()}`;
    try {
      await writeFile(inputPath, input.replace(/\r\n?/g, '\n'), { encoding: 'utf8', mode: 0o600 });
      await this.executeTmux(['load-buffer', '-b', bufferName, inputPath]);
      try {
        // Submit the paste and Enter as one tmux command list. Once tmux has
        // accepted this IPC request, CloudCLI cannot crash between those two
        // actions and leave invisible, unsubmitted text in Claude's prompt.
        await this.executeTmux([
          'paste-buffer',
          '-p',
          '-b',
          bufferName,
          '-t',
          runtimeId,
          ';',
          'send-keys',
          '-t',
          runtimeId,
          'Enter',
          ';',
          'delete-buffer',
          '-b',
          bufferName,
        ]);
      } catch (error) {
        await this.executeTmux(['delete-buffer', '-b', bufferName]).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async stopLoop(automationId: string): Promise<boolean> {
    await this.ensureTmuxAvailable();
    const runtimeId = this.resolveLoopRuntimeId(automationId);
    if (!await this.hasTmuxSession(runtimeId)) {
      this.activeLoops.delete(automationId);
      return false;
    }

    try {
      await this.executeTmux(['send-keys', '-t', runtimeId, 'Escape']);
      await this.wait(this.escapeDelayMs);
      if (await this.hasTmuxSession(runtimeId)) {
        await this.executeTmux(['send-keys', '-t', runtimeId, '-l', '--', '/exit']);
        await this.executeTmux(['send-keys', '-t', runtimeId, 'Enter']);
        await this.wait(this.exitDelayMs);
      }
      if (await this.hasTmuxSession(runtimeId)) {
        await this.executeTmux(['kill-session', '-t', runtimeId]);
      }
    } finally {
      this.activeLoops.delete(automationId);
    }
    return true;
  }

  async readLoopObservation(automationId: string): Promise<NativeClaudeLoopObservation | null> {
    const normalizedId = assertAutomationId(automationId);
    let serialized: string;
    try {
      serialized = await readFile(this.loopObservationPath(normalizedId), 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    try {
      const value = JSON.parse(serialized) as Record<string, unknown>;
      if (value.automation_id !== normalizedId || typeof value.observed_at !== 'string'
        || !Array.isArray(value.session_crons)) {
        return null;
      }
      return {
        automationId: normalizedId,
        observedAt: value.observed_at,
        sessionId: typeof value.session_id === 'string' ? value.session_id : null,
        // v1 snapshots did not persist the armed flag. A non-empty cron list
        // proves the Loop was armed; an empty legacy snapshot does not.
        everScheduled: value.ever_scheduled === true || value.session_crons.length > 0,
        sessionCrons: value.session_crons,
        backgroundTasks: Array.isArray(value.background_tasks) ? value.background_tasks : [],
      };
    } catch {
      return null;
    }
  }

  async clearLoopObservation(automationId: string): Promise<void> {
    const normalizedId = assertAutomationId(automationId);
    await rm(this.loopObservationPath(normalizedId), { force: true });
  }

  /** Removes secret-bearing environment files created by pre-socket releases. */
  async cleanupStaleLoopEnvironmentFiles(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.automationStateDir);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
    const staleFiles = entries.filter((entry) => entry.endsWith('.env.json'));
    await Promise.all(staleFiles.map((entry) => (
      rm(join(this.automationStateDir, entry), { force: true })
    )));
    return staleFiles.length;
  }

  hasLocal(automationId: string): boolean {
    return this.activeGoals.has(automationId) || this.activeLoops.has(automationId);
  }

  async has(automationId: string): Promise<boolean> {
    return this.hasGoal(automationId) || this.hasLoop(automationId);
  }

  sendInput(automationId: string, input: string): Promise<void> {
    return this.sendLoopInput(automationId, input);
  }

  async stop(automationId: string): Promise<boolean> {
    if (this.hasGoal(automationId)) {
      return this.interruptGoal(automationId);
    }
    return this.stopLoop(automationId);
  }

  getLoopRuntimeId(automationId: string): string {
    return this.resolveLoopRuntimeId(automationId);
  }

  private resolveLoopRuntimeId(automationId: string): string {
    return this.activeLoops.get(automationId) ?? createTmuxSessionName(automationId);
  }

  private loopObservationPath(automationId: string): string {
    return join(this.automationStateDir, `${automationId}.json`);
  }

  private ensureLoopObserverPlugin(): Promise<string> {
    if (this.loopObserverPluginPromise) return this.loopObserverPluginPromise;
    const operation = (async () => {
      const pluginDir = join(
        this.automationStateDir,
        `.loop-observer-plugin-${LOOP_OBSERVER_PLUGIN_VERSION}`,
      );
      const manifestDir = join(pluginDir, '.claude-plugin');
      const hooksDir = join(pluginDir, 'hooks');
      await Promise.all([
        mkdir(manifestDir, { recursive: true, mode: 0o700 }),
        mkdir(hooksDir, { recursive: true, mode: 0o700 }),
      ]);
      await Promise.all([
        this.writeAutomationFileAtomically(
          join(manifestDir, 'plugin.json'),
          `${JSON.stringify(LOOP_OBSERVER_PLUGIN_MANIFEST, null, 2)}\n`,
        ),
        this.writeAutomationFileAtomically(
          join(hooksDir, 'hooks.json'),
          `${JSON.stringify(LOOP_OBSERVER_HOOKS, null, 2)}\n`,
        ),
      ]);
      return pluginDir;
    })().catch((error) => {
      this.loopObserverPluginPromise = null;
      throw error;
    });
    this.loopObserverPluginPromise = operation;
    return operation;
  }

  private async writeAutomationFileAtomically(path: string, contents: string): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private ensureClaudeVersionSupported(): void {
    if (this.claudeVersionChecked) return;
    let versionOutput: string;
    try {
      versionOutput = this.configuredClaudeVersion ?? this.executeFileSync(
        this.claudeCommand,
        ['--version'],
        {
          env: this.processEnv,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
    } catch (error) {
      throw new NativeClaudeAutomationError(
        `Could not determine the Claude Code version (${this.claudeCommand} --version).`,
        'CLAUDE_VERSION_UNSUPPORTED',
        { cause: error },
      );
    }

    const version = parseClaudeVersion(versionOutput);
    if (!version || !isVersionAtLeast(version, MINIMUM_CLAUDE_AUTOMATION_VERSION)) {
      throw new NativeClaudeAutomationError(
        `Claude Code 2.1.145 or newer is required for Goal and Loop automation (found ${versionOutput.trim() || 'unknown'}).`,
        'CLAUDE_VERSION_UNSUPPORTED',
      );
    }
    this.claudeVersionChecked = true;
  }

  private async ensureTmuxAvailable(): Promise<void> {
    if (this.platform === 'win32') {
      throw new NativeClaudeAutomationError(
        'Loop automation requires tmux and is not supported on Windows.',
        'UNSUPPORTED_PLATFORM',
      );
    }
    if (this.tmuxAvailable) return;

    try {
      await this.executeFile(this.tmuxCommand, ['-V'], {
        env: this.tmuxControlEnvironment,
        windowsHide: true,
      });
      this.tmuxAvailable = true;
    } catch (error) {
      throw new NativeClaudeAutomationError(
        `tmux is required for /loop automation but could not be executed (${this.tmuxCommand}).`,
        'TMUX_UNAVAILABLE',
        { cause: error },
      );
    }
  }

  private async hasTmuxSession(runtimeId: string): Promise<boolean> {
    try {
      await this.executeTmux(['has-session', '-t', runtimeId]);
      return true;
    } catch (error) {
      if (isMissingExecutable(error)) {
        this.tmuxAvailable = false;
        throw new NativeClaudeAutomationError(
          `tmux is required for /loop automation but could not be executed (${this.tmuxCommand}).`,
          'TMUX_UNAVAILABLE',
          { cause: error },
        );
      }
      if (isTmuxSessionAbsent(error)) return false;
      throw error;
    }
  }

  private executeTmux(
    args: readonly string[],
    overrides: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<ExecFileResult> {
    return this.executeFile(this.tmuxCommand, args, {
      cwd: overrides.cwd,
      env: overrides.env ?? this.tmuxControlEnvironment,
      windowsHide: true,
    });
  }
}

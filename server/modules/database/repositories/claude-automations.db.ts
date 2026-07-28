import { getConnection } from '@/modules/database/connection.js';
import type {
  ClaudeAutomationKind,
  ClaudeAutomationRuntime,
  ClaudeAutomationState,
} from '@/shared/types.js';

export type {
  ClaudeAutomationKind,
  ClaudeAutomationRuntime,
  ClaudeAutomationState,
} from '@/shared/types.js';

export type ClaudeAutomationRow = {
  session_id: string;
  kind: ClaudeAutomationKind;
  state: ClaudeAutomationState;
  runtime: ClaudeAutomationRuntime;
  command: string;
  runtime_id: string | null;
  native_task_id: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ClaudeAutomationInputState = 'processing' | 'acknowledged' | 'uncertain';

export type ClaudeAutomationInputRow = {
  session_id: string;
  automation_id: string;
  request_id: string;
  content_hash: string;
  state: ClaudeAutomationInputState;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ReserveClaudeAutomationInput = {
  sessionId: string;
  automationId: string;
  requestId: string;
  contentHash: string;
};

export type StartClaudeAutomationInput = {
  sessionId: string;
  kind: ClaudeAutomationKind;
  runtime: ClaudeAutomationRuntime;
  command: string;
  runtimeId?: string | null;
  nativeTaskId?: string | null;
};

export type UpdateClaudeAutomationInput = {
  state?: ClaudeAutomationState;
  runtime?: ClaudeAutomationRuntime;
  runtimeId?: string | null;
  nativeTaskId?: string | null;
  error?: string | null;
};

const AUTOMATION_ROW_COLUMNS = `
  session_id,
  kind,
  state,
  runtime,
  command,
  runtime_id,
  native_task_id,
  error,
  started_at,
  updated_at,
  completed_at
`;

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const TERMINAL_STATES = new Set<ClaudeAutomationState>(['completed', 'stopped', 'failed']);

const AUTOMATION_INPUT_ROW_COLUMNS = `
  session_id,
  automation_id,
  request_id,
  content_hash,
  state,
  error,
  created_at,
  updated_at
`;

function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;

  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = new Date(normalizedValue);

  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function normalizeAutomationRow(
  row: ClaudeAutomationRow | undefined,
): ClaudeAutomationRow | null {
  if (!row) return null;

  return {
    ...row,
    started_at: normalizeTimestamp(row.started_at) ?? row.started_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
    completed_at: normalizeTimestamp(row.completed_at),
  };
}

function requireAutomationRow(row: ClaudeAutomationRow | undefined): ClaudeAutomationRow {
  const normalizedRow = normalizeAutomationRow(row);
  if (!normalizedRow) {
    throw new Error('Claude automation write did not return a row');
  }

  return normalizedRow;
}

function normalizeAutomationInputRow(
  row: ClaudeAutomationInputRow | undefined,
): ClaudeAutomationInputRow | null {
  if (!row) return null;
  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

export const claudeAutomationsDb = {
  getBySessionId(sessionId: string): ClaudeAutomationRow | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT ${AUTOMATION_ROW_COLUMNS} FROM claude_automations WHERE session_id = ?`)
      .get(sessionId) as ClaudeAutomationRow | undefined;

    return normalizeAutomationRow(row);
  },

  /**
   * Starts an automation, replacing any prior automation state for the session.
   * The session row must already exist so the automation cannot outlive its chat.
   */
  start(input: StartClaudeAutomationInput): ClaudeAutomationRow {
    const db = getConnection();
    const startAutomation = db.transaction((startInput: StartClaudeAutomationInput) => {
      db.prepare('DELETE FROM claude_automation_inputs WHERE session_id = ?').run(startInput.sessionId);
      return db.prepare(
        `INSERT INTO claude_automations (
           session_id, kind, state, runtime, command, runtime_id, native_task_id,
           error, started_at, updated_at, completed_at
         )
         VALUES (?, ?, 'starting', ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           kind = excluded.kind,
           state = 'starting',
           runtime = excluded.runtime,
           command = excluded.command,
           runtime_id = excluded.runtime_id,
           native_task_id = excluded.native_task_id,
           error = NULL,
           started_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           completed_at = NULL
         RETURNING ${AUTOMATION_ROW_COLUMNS}`,
      )
      .get(
        startInput.sessionId,
        startInput.kind,
        startInput.runtime,
        startInput.command,
        startInput.runtimeId ?? null,
        startInput.nativeTaskId ?? null,
      ) as ClaudeAutomationRow | undefined;
    });
    const row = startAutomation(input);

    return requireAutomationRow(row);
  },

  /**
   * Applies a partial state/runtime update. Undefined fields remain unchanged;
   * nullable fields accept null to explicitly clear stale runtime metadata.
   */
  update(
    sessionId: string,
    patch: UpdateClaudeAutomationInput,
  ): ClaudeAutomationRow | null {
    const existing = claudeAutomationsDb.getBySessionId(sessionId);
    if (!existing) return null;

    const nextState = patch.state ?? existing.state;
    const nextRuntime = patch.runtime ?? existing.runtime;
    const nextRuntimeId = patch.runtimeId === undefined ? existing.runtime_id : patch.runtimeId;
    const nextNativeTaskId =
      patch.nativeTaskId === undefined ? existing.native_task_id : patch.nativeTaskId;
    const nextError = patch.error === undefined ? existing.error : patch.error;
    const completedAtSql = TERMINAL_STATES.has(nextState)
      ? 'COALESCE(completed_at, CURRENT_TIMESTAMP)'
      : 'NULL';
    const db = getConnection();
    const row = db
      .prepare(
        `UPDATE claude_automations
         SET state = ?,
             runtime = ?,
             runtime_id = ?,
             native_task_id = ?,
             error = ?,
             updated_at = CURRENT_TIMESTAMP,
             completed_at = ${completedAtSql}
         WHERE session_id = ?
         RETURNING ${AUTOMATION_ROW_COLUMNS}`,
      )
      .get(
        nextState,
        nextRuntime,
        nextRuntimeId,
        nextNativeTaskId,
        nextError,
        sessionId,
      ) as ClaudeAutomationRow | undefined;

    return normalizeAutomationRow(row);
  },

  dismiss(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM claude_automations WHERE session_id = ?').run(sessionId).changes > 0;
  },

  listActive(): ClaudeAutomationRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${AUTOMATION_ROW_COLUMNS}
         FROM claude_automations
         WHERE state IN ('starting', 'running', 'stopping')
         ORDER BY datetime(started_at) ASC, session_id ASC`,
      )
      .all() as ClaudeAutomationRow[];

    return rows.map((row) => normalizeAutomationRow(row) as ClaudeAutomationRow);
  },

  getInput(automationId: string, requestId: string): ClaudeAutomationInputRow | null {
    const db = getConnection();
    const row = db.prepare(
      `SELECT ${AUTOMATION_INPUT_ROW_COLUMNS}
       FROM claude_automation_inputs
       WHERE automation_id = ? AND request_id = ?`,
    ).get(automationId, requestId) as ClaudeAutomationInputRow | undefined;
    return normalizeAutomationInputRow(row);
  },

  reserveInput(input: ReserveClaudeAutomationInput): {
    row: ClaudeAutomationInputRow;
    inserted: boolean;
  } {
    const db = getConnection();
    const inserted = db.prepare(
      `INSERT INTO claude_automation_inputs (
         session_id, automation_id, request_id, content_hash, state, error,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, 'processing', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(automation_id, request_id) DO NOTHING
       RETURNING ${AUTOMATION_INPUT_ROW_COLUMNS}`,
    ).get(
      input.sessionId,
      input.automationId,
      input.requestId,
      input.contentHash,
    ) as ClaudeAutomationInputRow | undefined;
    if (inserted) {
      return { row: normalizeAutomationInputRow(inserted) as ClaudeAutomationInputRow, inserted: true };
    }
    const existing = claudeAutomationsDb.getInput(input.automationId, input.requestId);
    if (!existing) throw new Error('Claude automation input reservation disappeared');
    return { row: existing, inserted: false };
  },

  updateInput(
    automationId: string,
    requestId: string,
    state: ClaudeAutomationInputState,
    error: string | null,
  ): ClaudeAutomationInputRow | null {
    const db = getConnection();
    const row = db.prepare(
      `UPDATE claude_automation_inputs
       SET state = ?, error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE automation_id = ? AND request_id = ?
       RETURNING ${AUTOMATION_INPUT_ROW_COLUMNS}`,
    ).get(state, error, automationId, requestId) as ClaudeAutomationInputRow | undefined;
    return normalizeAutomationInputRow(row);
  },
};

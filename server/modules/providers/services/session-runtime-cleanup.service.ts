export type SessionRuntimeCleanupHandler = (sessionId: string) => void | Promise<void>;

let cleanupHandler: SessionRuntimeCleanupHandler | null = null;

/** Registers the runtime owner that must release work before a session row is deleted. */
export function configureSessionRuntimeCleanup(
  handler: SessionRuntimeCleanupHandler | null,
): void {
  cleanupHandler = handler;
}

/** A cleanup failure aborts deletion so a live runtime cannot become orphaned. */
export async function cleanupSessionRuntimeBeforeDeletion(sessionId: string): Promise<void> {
  await cleanupHandler?.(sessionId);
}

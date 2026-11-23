/**
 * Every text the bot sends the owner about the retry queue itself, in one place. Plain text on purpose (no
 * parse_mode), so a title with `_`, `*` or `[` can never break the message. Never contains a stack trace.
 */
export const messages = {
  /** Feature 2, R2.5 */
  queueFileCorrupt: (backupPath: string) =>
    "The retry queue file was unreadable, so I started with an empty queue. " +
    `The old file was kept as ${backupPath} so it can be inspected.`,
} as const;

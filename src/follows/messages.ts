/**
 * Every text the bot sends the owner about following fics, in one place. Plain text on purpose (no
 * parse_mode), so a title with `_`, `*` or `[` can never break the message. Never contains a stack trace.
 */
export const messages = {
  /** Feature 5, R3.3 */
  nowFollowing: (title: string, chapters: number) =>
    `Following “${title}” — ${chapterCount(chapters)} delivered.`,
  /** Feature 5, R3.4 */
  alreadyFollowing: (title: string) => `You're already following “${title}”.`,
  /** Feature 5, R4.1 */
  unfollowed: (title: string) => `OK, I'm no longer following “${title}”.`,
  /** Feature 5, R4.2 */
  notFollowing: () => "I wasn't following that fic, so nothing changed.",
  /** Feature 5, R3.6: the fic is no longer among the recent deliveries. */
  followUnknown: () => "I don't have that fic any more. Send me its link again to follow it.",
  /** Feature 5, error handling: the follows file could not be written. */
  followSaveFailed: () => "I couldn't save that just now. Try the button again in a moment.",
  /** Feature 5, R5.2: the follows file was unreadable at startup. */
  followsFileCorrupt: (backupPath: string) =>
    "The file with your followed fics was unreadable, so I started with none followed. " +
    `The old file was kept as ${backupPath} so it can be inspected.`,
} as const;

/** `1` → `"1 chapter"`, `12` → `"12 chapters"`. */
function chapterCount(chapters: number): string {
  return `${chapters} ${chapters === 1 ? "chapter" : "chapters"}`;
}

/** Texts for the owner about the Kindle side of a delivery, reused by every context that sends to it. */
export const messages = {
  /** R5.2, R5.5 */
  uploadConfig: (detail: string) =>
    `I can't send to the Kindle because of a configuration problem: ${detail}`,
} as const;

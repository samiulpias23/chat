// Central registry for object URLs created during chat session
// Guarantees zero memory leaks and complete revocation upon lock
const urlSet = new Set<string>();

export const objectUrlRegistry = {
  create(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    urlSet.add(url);
    return url;
  },
  revoke(url: string): void {
    if (urlSet.has(url)) {
      URL.revokeObjectURL(url);
      urlSet.delete(url);
    }
  },
  revokeAll(): void {
    urlSet.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore errors during mass revocation
      }
    });
    urlSet.clear();
  },
};

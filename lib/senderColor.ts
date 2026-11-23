const SENDER_COLORS = ['#4ADE80', '#38BDF8', '#E879F9', '#FBBF24', '#FB7185', '#34D399', '#60A5FA', '#A78BFA'];

export function getSenderColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return SENDER_COLORS[hash % SENDER_COLORS.length];
}

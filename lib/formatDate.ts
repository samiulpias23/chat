/**
 * Standard application date formatter.
 * Produces strict "22 Dec 2026" (day month year) format across the application.
 */
export function formatAppDate(dateInput: string | Date | number | null | undefined): string {
  if (!dateInput) return '—';
  try {
    const d = typeof dateInput === 'object' && dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d);
  } catch {
    return '—';
  }
}

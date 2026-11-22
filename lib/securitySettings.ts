export interface ClientSecuritySettings {
  afkLockEnabled: boolean;
  afkTimeoutSeconds: number; // e.g. 15, 30, 60, 120, 300, 600
  minimizeLockEnabled: boolean;
  minimizeTimeoutSeconds: number; // 0 = Immediately, 10, 30, 60, 300
}

export const DEFAULT_SECURITY_SETTINGS: ClientSecuritySettings = {
  afkLockEnabled: true,
  afkTimeoutSeconds: 15,
  minimizeLockEnabled: true,
  minimizeTimeoutSeconds: 0,
};

const STORAGE_KEY = 'chataf_security_settings';

export function getSecuritySettings(): ClientSecuritySettings {
  if (typeof window === 'undefined') return DEFAULT_SECURITY_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SECURITY_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      afkLockEnabled: typeof parsed.afkLockEnabled === 'boolean' ? parsed.afkLockEnabled : DEFAULT_SECURITY_SETTINGS.afkLockEnabled,
      afkTimeoutSeconds: typeof parsed.afkTimeoutSeconds === 'number' ? parsed.afkTimeoutSeconds : DEFAULT_SECURITY_SETTINGS.afkTimeoutSeconds,
      minimizeLockEnabled: typeof parsed.minimizeLockEnabled === 'boolean' ? parsed.minimizeLockEnabled : DEFAULT_SECURITY_SETTINGS.minimizeLockEnabled,
      minimizeTimeoutSeconds: typeof parsed.minimizeTimeoutSeconds === 'number' ? parsed.minimizeTimeoutSeconds : DEFAULT_SECURITY_SETTINGS.minimizeTimeoutSeconds,
    };
  } catch {
    return DEFAULT_SECURITY_SETTINGS;
  }
}

export function saveSecuritySettings(settings: ClientSecuritySettings): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent('chataf_settings_changed', { detail: settings }));
  } catch (e) {
    console.error('Failed to save security settings:', e);
  }
}

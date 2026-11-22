import { DEFAULT_SECURITY_SETTINGS, getSecuritySettings, saveSecuritySettings } from '../lib/securitySettings.ts';

console.log('--- Testing Security Settings Model ---');

// Verify default values
console.log('Default settings:', DEFAULT_SECURITY_SETTINGS);
if (DEFAULT_SECURITY_SETTINGS.afkLockEnabled !== true) throw new Error('afkLockEnabled should be true by default');
if (DEFAULT_SECURITY_SETTINGS.afkTimeoutSeconds !== 15) throw new Error('afkTimeoutSeconds should be 15s by default');
if (DEFAULT_SECURITY_SETTINGS.minimizeLockEnabled !== true) throw new Error('minimizeLockEnabled should be true by default');
if (DEFAULT_SECURITY_SETTINGS.minimizeTimeoutSeconds !== 0) throw new Error('minimizeTimeoutSeconds should be 0 by default');

console.log('✓ [PASS] Security Settings module verified!');

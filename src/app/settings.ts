import type { Settings } from './contracts.ts';
import { readJson, writeJson } from './persist.ts';

export const DEFAULT_SETTINGS: Readonly<Settings> = { sound: true, haptics: true, quality: 'auto', name: '' };

const QUALITIES: readonly Settings['quality'][] = ['auto', 'high', 'low'];

export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    sound: typeof r.sound === 'boolean' ? r.sound : DEFAULT_SETTINGS.sound,
    haptics: typeof r.haptics === 'boolean' ? r.haptics : DEFAULT_SETTINGS.haptics,
    quality: QUALITIES.includes(r.quality as Settings['quality']) ? (r.quality as Settings['quality']) : DEFAULT_SETTINGS.quality,
    name: typeof r.name === 'string' ? r.name.slice(0, 24) : DEFAULT_SETTINGS.name,
  };
}

let current: Settings = normalizeSettings(readJson('settings'));
const listeners = new Set<(s: Settings) => void>();

export function getSettings(): Settings {
  return { ...current };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = normalizeSettings({ ...current, ...patch });
  writeJson('settings', current);
  for (const fn of listeners) fn(getSettings());
  return getSettings();
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

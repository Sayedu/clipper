export const CACHE_DIR: string;
export const DEFAULT_ENGINE: 'kokoro';
export const DEFAULT_RATE: string;
export const ENGINES: Record<string, { voice: string; ext: string; voiceRe: RegExp }>;
export interface TtsOptions { text: string; engine?: 'kokoro' | 'edge'; voice?: string; rate?: string }
export function checkTtsOptions(o: TtsOptions): { text: string; engine: string; voice: string; rate: string };
export function ttsLine(o: TtsOptions): Promise<{ path: string; cached: boolean; text: string; engine: string; voice: string; rate: string }>;

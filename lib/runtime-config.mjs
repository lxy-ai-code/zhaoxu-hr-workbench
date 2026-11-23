import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const INSTALLED = Boolean(process.env.HR_HOME);
export const WORKSPACE_ROOT = INSTALLED ? path.resolve(process.env.HR_HOME) : path.resolve(APP_ROOT);
// The installed edition can coexist with the development workspace on the same PC.
export const DEFAULT_WEB_PORT = INSTALLED ? 18788 : 18787;
export const DEFAULT_CDP_PORT = INSTALLED ? 19223 : 19222;

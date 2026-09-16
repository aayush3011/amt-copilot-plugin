import { fileURLToPath } from 'node:url';
import { runHookProcess } from '../runtime/hook.mjs';
await runHookProcess('cursor', { pluginRoot: fileURLToPath(new URL('..', import.meta.url)), rootVariable: 'CURSOR_PLUGIN_ROOT' });

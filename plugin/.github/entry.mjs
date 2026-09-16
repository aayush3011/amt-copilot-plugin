import { fileURLToPath } from 'node:url';
import { runHookProcess } from '../runtime/hook.mjs';
await runHookProcess('copilot', { pluginRoot: fileURLToPath(new URL('..', import.meta.url)), rootVariable: 'PLUGIN_ROOT' });

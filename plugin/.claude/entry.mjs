import { fileURLToPath } from 'node:url';
import { runHookProcess } from '../runtime/hook.mjs';
await runHookProcess('claude', { pluginRoot: fileURLToPath(new URL('..', import.meta.url)), rootVariable: 'CLAUDE_PLUGIN_ROOT' });

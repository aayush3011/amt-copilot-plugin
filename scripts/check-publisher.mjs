import { loadConfig, requirePublisherConfig } from '../src/config.mjs';
import { PLUGIN_ROOT } from './package-files.mjs';

try {
  const config = loadConfig({ env: {}, home: process.cwd(), pluginRoot: PLUGIN_ROOT });
  requirePublisherConfig(config);
  process.stdout.write('Publisher gateway and public Entra settings are present. Live sign-in and tenant consent still require a user.\n');
} catch (error) {
  process.stderr.write(`memory-house: ${error.message}\n`);
  process.exitCode = 1;
}

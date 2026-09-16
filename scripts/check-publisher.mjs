import { loadConfig, requirePublisherConfig } from '../src/config.mjs';

try {
  const config = loadConfig({ env: {}, home: process.cwd() });
  requirePublisherConfig(config);
  process.stdout.write('Publisher gateway and public Entra settings are present. Live sign-in and tenant consent still require a user.\n');
} catch (error) {
  process.stderr.write(`memory-house: ${error.message}\n`);
  process.exitCode = 1;
}

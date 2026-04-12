/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import postgres from 'postgres';

import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();

  // Check Apple Container
  let appleContainer: 'installed' | 'not_found' = 'not_found';
  if (commandExists('container')) {
    appleContainer = 'installed';
  }

  // Check Docker
  let docker: 'running' | 'installed_not_running' | 'not_found' = 'not_found';
  if (commandExists('docker')) {
    try {
      const { execSync } = await import('child_process');
      execSync('docker info', { stdio: 'ignore' });
      docker = 'running';
    } catch {
      docker = 'installed_not_running';
    }
  }

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  let hasRegisteredGroups = false;
  const _dbEnv = readEnvFile(['DATABASE_URL']);
  const dbUrl = process.env.DATABASE_URL || _dbEnv.DATABASE_URL;
  if (dbUrl) {
    try {
      const sql = postgres(dbUrl, { max: 1, connect_timeout: 5 });
      const rows = await sql`SELECT COUNT(*) as count FROM registered_groups`;
      if (Number(rows[0].count) > 0) hasRegisteredGroups = true;
      await sql.end();
    } catch {
      // Table might not exist yet or DB unreachable
    }
  }

  logger.info(
    {
      platform,
      wsl,
      appleContainer,
      docker,
      hasEnv,
      hasAuth,
      hasRegisteredGroups,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

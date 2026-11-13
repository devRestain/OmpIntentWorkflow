#!/usr/bin/env bun
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '@oh-my-pi/omptype/zod';

const NAME = 'omp-intent-workflow';
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export type PluginAction = 'install' | 'disable' | 'enable' | 'status';

const inventorySchema=z.object({npm:z.array(z.object({name:z.string(),version:z.string(),path:z.string(),enabled:z.boolean(),enabledFeatures:z.array(z.string()).nullable().optional()}))});

async function native(args: string[], capture = false): Promise<string> {
  const child = Bun.spawn(['omp', 'plugin', ...args], {
    cwd: PROJECT,
    stdin: 'inherit',
    stdout: capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
  });
  const text = capture ? await new Response(child.stdout).text() : '';
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`omp plugin ${args[0]} exited with ${exitCode}`);
  return text;
}

export async function runPluginLifecycle(action: PluginAction): Promise<void> {
  if (!['install', 'disable', 'enable', 'status'].includes(action)) {
    throw new Error('Usage: bun scripts/plugin.ts install|disable|enable|status');
  }
  if (action === 'install') await native(['link', '--scope', 'user', PROJECT]);
  else if (action !== 'status') await native([action, NAME]);

  const inventory = inventorySchema.parse(JSON.parse(await native(['list', '--json'], true)));
  const plugin = inventory.npm?.find(entry => entry.name === NAME);
  // Only this package's public install identity is retained, never the native inventory/config.
  const owned = plugin ? {
    name: NAME,
    installed: true,
    version: plugin.version,
    path: plugin.path,
    enabled: plugin.enabled,
    enabledFeatures: plugin.enabledFeatures,
  } : { name: NAME, installed: false };
  if (action === 'install') {
    if (!plugin) throw new Error('Native link returned success but the plugin is not in native inventory.');
    const directory = join(PROJECT, '.omp-workflow');
    const manifest = join(directory, 'plugin-install.json');
    const temporary = `${manifest}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ ...owned, project: PROJECT, installedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, manifest);
  }
  console.log(JSON.stringify(owned, null, 2));
}

if (import.meta.main) {
  try {
    await runPluginLifecycle(Bun.argv[2] as PluginAction);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

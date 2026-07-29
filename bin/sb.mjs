#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';
import pc from 'picocolors';
import { api, baseUrl } from './lib/client.mjs';
import { banner, dot, fail, info, money, ms, ok, table, warn } from './lib/render.mjs';
import { resolveDataDir } from './lib/dataDir.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readPackageVersion() {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    return String(JSON.parse(raw).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * Locate Next's CLI entry through node's own resolver.
 *
 * Hardcoding `<root>/node_modules/next` only works for a repo checkout. On a
 * global install npm hoists dependencies, so next can sit anywhere up the tree
 * — resolving it is the difference between `npm i -g switchboard-gateway` working and
 * failing with ENOENT on a path the user cannot see.
 */
function resolveNextBin() {
  try {
    return createRequire(import.meta.url).resolve('next/dist/bin/next');
  } catch {
    const local = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (existsSync(local)) return local;
    console.error(pc.red('Could not find the Next.js runtime.'));
    console.error(pc.dim('  Reinstall Switchboard:  npm install -g switchboard-gateway'));
    process.exit(1);
  }
}

const program = new Command();

program
  .name('sb')
  .description('Switchboard — a local-first AI gateway')
  // Read from the manifest rather than hardcoded: a literal here silently
  // drifts on every release, and `sb --version` reporting the wrong number is
  // worse than useless when someone is diagnosing an upgrade.
  .version(readPackageVersion())
  .option('--url <url>', 'gateway base URL', process.env.SWITCHBOARD_URL)
  .hook('preAction', (thisCommand) => {
    const url = thisCommand.opts().url;
    if (url !== undefined) process.env.SWITCHBOARD_URL = url;
  });

// ── start ────────────────────────────────────────────────────────────────────

program
  .command('start')
  .description('start the gateway and dashboard')
  .option('-p, --port <port>', 'port to listen on', '7272')
  .option('--open', 'open the dashboard once it is ready')
  .action(async (options) => {
    const port = Number(options.port);

    if (!existsSync(join(root, '.next'))) {
      fail('No production build found.');
      info('From a repo checkout, run:  npm run build');
      info('If you installed globally, reinstall:  npm install -g switchboard-gateway');
      process.exit(1);
    }

    // Pinned explicitly so the database never lands inside node_modules, where
    // the next `npm update -g` would delete it along with every stored key.
    const dataDir = resolveDataDir(root);

    banner(port, dataDir);

    const child = spawn(process.execPath, [resolveNextBin(), 'start', '-p', String(port)], {
      cwd: root,
      env: { ...process.env, PORT: String(port), SWITCHBOARD_DATA_DIR: dataDir },
      stdio: 'inherit',
    });

    if (options.open === true) {
      await waitForPort(port);
      openBrowser(`http://127.0.0.1:${port}/dashboard`);
    }

    child.on('exit', (code) => process.exit(code ?? 0));
  });

// ── status ───────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('show gateway health at a glance')
  .action(async () => {
    const status = await api('/api/system/status');
    console.log('');
    console.log(`  ${pc.bold('Switchboard')} ${pc.dim(`v${status.version}`)}`);
    console.log('');
    info(`Endpoint   ${baseUrl()}/v1`);
    info(`Data dir   ${status.dataDir}`);
    info(`Uptime     ${Math.round(status.uptimeMs / 1000)}s`);
    info(`Database   ${(status.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log('');
    console.log(
      `  Providers  ${pc.green(`${status.connections.healthy} healthy`)}  ` +
        `${pc.yellow(`${status.connections.degraded} degraded`)}  ` +
        `${pc.red(`${status.connections.down} down`)}  ` +
        pc.dim(`${status.connections.unconfigured} unconfigured`),
    );
    console.log(
      `  Today      ${status.today.requests} requests · $${status.today.costUsd.toFixed(4)} spent · ` +
        pc.green(`$${status.today.savedUsd.toFixed(4)} saved`),
    );
    console.log('');
  });

// ── providers ────────────────────────────────────────────────────────────────

const providers = program.command('providers').description('manage provider connections');

providers
  .command('list', { isDefault: true })
  .description('list configured connections')
  .action(async () => {
    const { items } = await api('/api/connections');
    console.log('');
    table(
      [
        { header: '' },
        { header: 'LABEL' },
        { header: 'PROVIDER' },
        { header: 'TIER' },
        { header: 'REQ', align: 'right' },
        { header: 'SPEND', align: 'right' },
        { header: 'p50', align: 'right' },
      ],
      items.map((item) => [
        dot(item.status),
        item.label,
        item.provider.name,
        item.tier,
        String(item.usage.requests),
        money(item.usage.costUsd),
        ms(item.health.p50LatencyMs),
      ]),
    );
    console.log('');
  });

providers
  .command('add <provider>')
  .description('connect a provider (prompts for the API key)')
  .option('-l, --label <label>', 'display label')
  .action(async (providerId, options) => {
    const key = await promptSecret(`API key for ${providerId}: `);
    if (key.length === 0) {
      fail('No key entered.');
      process.exit(1);
    }

    const connection = await api('/api/connections', {
      method: 'POST',
      body: JSON.stringify({
        providerId,
        apiKey: key,
        ...(options.label !== undefined ? { label: options.label } : {}),
      }),
    });

    const test = await api(`/api/connections/${connection.id}/test`, { method: 'POST' });
    if (test.ok) ok(`${providerId} connected — responded in ${ms(test.latencyMs)}`);
    else warn(`Saved, but the probe failed: ${test.error ?? 'unknown error'}`);
  });

providers
  .command('test <id>')
  .description('probe one connection')
  .action(async (id) => {
    const result = await api(`/api/connections/${id}/test`, { method: 'POST' });
    if (result.ok) ok(`Healthy — ${ms(result.latencyMs)}`);
    else fail(result.error ?? 'Probe failed');
  });

// ── models ───────────────────────────────────────────────────────────────────

program
  .command('models')
  .description('list available models')
  .option('--free', 'only free models')
  .action(async (options) => {
    const { items } = await api('/api/models');
    const rows = items
      .filter((item) => options.free !== true || item.bestTier === 'free')
      .map((item) => [
        item.id,
        String(item.providerCount),
        `${(item.contextWindow / 1000).toFixed(0)}K`,
        item.minInputCostPerMTok === 0 ? pc.green('free') : `$${item.minInputCostPerMTok.toFixed(2)}`,
        item.minOutputCostPerMTok === 0 ? pc.green('free') : `$${item.minOutputCostPerMTok.toFixed(2)}`,
      ]);

    console.log('');
    table(
      [
        { header: 'MODEL' },
        { header: 'PROVIDERS', align: 'right' },
        { header: 'CONTEXT', align: 'right' },
        { header: 'IN/MTOK', align: 'right' },
        { header: 'OUT/MTOK', align: 'right' },
      ],
      rows,
    );
    console.log('');
  });

// ── combos ───────────────────────────────────────────────────────────────────

program
  .command('combos')
  .description('list routing policies')
  .action(async () => {
    const { items } = await api('/api/combos');
    console.log('');
    table(
      [
        { header: 'SLUG' },
        { header: 'NAME' },
        { header: 'STRATEGY' },
        { header: 'MEMBERS', align: 'right' },
        { header: '' },
      ],
      items.map((combo) => [
        combo.slug,
        combo.name,
        combo.strategy,
        combo.members.length === 0 ? 'all' : String(combo.members.length),
        combo.isDefault ? pc.yellow('default') : '',
      ]),
    );
    console.log('');
  });

// ── keys ─────────────────────────────────────────────────────────────────────

const keys = program.command('keys').description('manage API keys');

keys
  .command('list', { isDefault: true })
  .action(async () => {
    const { items } = await api('/api/keys');
    console.log('');
    table(
      [{ header: 'NAME' }, { header: 'PREFIX' }, { header: 'SPENT', align: 'right' }, { header: 'ID' }],
      items.map((key) => [key.name, `${key.prefix}…`, `$${key.spentThisMonthUsd.toFixed(4)}`, key.id]),
    );
    console.log('');
  });

keys
  .command('new <name>')
  .description('create an API key')
  .action(async (name) => {
    const { secret } = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    console.log('');
    ok('Key created. This is the only time it is shown:');
    console.log('');
    console.log(`  ${pc.bold(pc.yellow(secret))}`);
    console.log('');
  });

keys
  .command('rm <id>')
  .description('revoke an API key')
  .action(async (id) => {
    await api(`/api/keys/${id}`, { method: 'DELETE' });
    ok('Key revoked.');
  });

// ── chat ─────────────────────────────────────────────────────────────────────

program
  .command('chat')
  .description('streaming chat REPL against the gateway')
  .option('-m, --model <model>', 'model or policy slug', 'auto')
  .action(async (options) => {
    console.log('');
    console.log(`  ${pc.bold('Switchboard chat')} ${pc.dim(`· model ${options.model} · Ctrl+C to exit`)}`);
    console.log('');

    const history = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = () => {
      rl.question(pc.yellow('› '), async (line) => {
        if (line.trim().length === 0) return ask();
        history.push({ role: 'user', content: line });

        const response = await fetch(`${baseUrl()}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: options.model, messages: history, stream: true }),
        });

        if (!response.ok || response.body === null) {
          const body = await response.text();
          console.log(pc.red(`  ${body}`));
          console.log('');
          return ask();
        }

        process.stdout.write('  ');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let answer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (data === undefined) continue;
            const payload = data.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') {
                answer += delta;
                process.stdout.write(delta);
              }
            } catch {
              // Ignore a malformed frame rather than ending the stream.
            }
          }
        }

        history.push({ role: 'assistant', content: answer });
        console.log('\n');
        ask();
      });
    };

    ask();
  });

// ── logs ─────────────────────────────────────────────────────────────────────

program
  .command('logs')
  .description('show recent requests')
  .option('-n, --limit <n>', 'how many', '20')
  .option('--errors', 'errors only')
  .action(async (options) => {
    const params = new URLSearchParams({ limit: options.limit });
    if (options.errors === true) params.set('status', 'error');
    const { rows } = await api(`/api/logs?${params.toString()}`);

    console.log('');
    table(
      [
        { header: '' },
        { header: 'TIME' },
        { header: 'MODEL' },
        { header: 'PROVIDER' },
        { header: 'MS', align: 'right' },
        { header: 'COST', align: 'right' },
      ],
      rows.map((row) => [
        row.status === 'success' ? pc.green('●') : pc.red('●'),
        new Date(row.ts).toLocaleTimeString(),
        row.resolvedModelId ?? row.requestedModel,
        row.resolvedProviderId ?? pc.dim('—'),
        String(row.durationMs),
        money(row.costUsd),
      ]),
    );
    console.log('');
  });

// ── usage ────────────────────────────────────────────────────────────────────

program
  .command('usage')
  .description('spend and token summary')
  .option('-d, --days <n>', 'window in days', '7')
  .action(async (options) => {
    const data = await api(`/api/analytics/summary?days=${options.days}`);
    console.log('');
    console.log(`  ${pc.bold(`Last ${data.days} day${data.days === 1 ? '' : 's'}`)}`);
    console.log('');
    info(`Requests   ${data.totals.requests}`);
    info(`Spend      $${data.totals.costUsd.toFixed(4)}`);
    console.log(`  ${pc.dim('Saved      ')}${pc.green(`$${data.totals.savedUsd.toFixed(4)}`)}`);
    info(`Success    ${(data.totals.successRate * 100).toFixed(1)}%`);
    console.log('');
    table(
      [
        { header: 'PROVIDER' },
        { header: 'REQ', align: 'right' },
        { header: 'SPEND', align: 'right' },
        { header: 'SAVED', align: 'right' },
      ],
      data.providers.map((p) => [
        p.label,
        String(p.requests),
        `$${p.costUsd.toFixed(4)}`,
        pc.green(`$${p.savedUsd.toFixed(4)}`),
      ]),
    );
    console.log('');
  });

// ── doctor ───────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('diagnose the local install')
  .action(async () => {
    console.log('');
    console.log(`  ${pc.bold('Switchboard doctor')}`);
    console.log('');

    // Compare minor too. node:sqlite exists from 22.5 but stayed behind
    // --experimental-sqlite until 22.13, so a major-only check would pass a
    // version that cannot actually open the database.
    const [major, minor] = process.versions.node.split('.').map(Number);
    const nodeOk = major > 22 || (major === 22 && minor >= 13);
    if (nodeOk) ok(`Node ${process.versions.node}`);
    else fail(`Node ${process.versions.node} — node:sqlite needs 22.13 or newer`);

    try {
      await import('node:sqlite');
      ok('node:sqlite available');
    } catch {
      fail('node:sqlite unavailable — upgrade Node');
    }

    let status;
    try {
      status = await api('/api/system/status');
      ok(`Gateway responding on ${baseUrl()}`);
    } catch {
      fail('Gateway is not responding');
      console.log('');
      return;
    }

    try {
      accessSync(status.dataDir, constants.W_OK);
      ok(`Data directory writable — ${status.dataDir}`);
    } catch {
      fail(`Data directory not writable — ${status.dataDir}`);
    }

    if (existsSync(join(root, '.next'))) ok('Production build present');
    else warn('No .next build — run `npm run build` before `sb start`');

    const { items } = await api('/api/connections');
    if (items.length === 0) {
      warn('No providers connected yet');
    } else {
      for (const item of items) {
        if (!item.hasCredential) fail(`${item.label} — no API key`);
        else if (item.status === 'healthy') ok(`${item.label} — healthy (${ms(item.health.p50LatencyMs)})`);
        else if (item.status === 'down') fail(`${item.label} — ${item.health.lastError ?? 'down'}`);
        else warn(`${item.label} — ${item.status}`);
      }
    }

    const { items: keyItems } = await api('/api/keys');
    if (keyItems.length === 0) warn('No API keys — the gateway is open to anything on localhost');
    else ok(`${keyItems.length} API key${keyItems.length === 1 ? '' : 's'} configured`);

    console.log('');
  });

// ── open ─────────────────────────────────────────────────────────────────────

program
  .command('open')
  .description('open the dashboard in your browser')
  .action(() => {
    openBrowser(`${baseUrl()}/dashboard`);
  });

program.parseAsync(process.argv);

// ── helpers ──────────────────────────────────────────────────────────────────

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) return reject(new Error('timed out'));
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** Reads a secret without echoing it to the terminal. */
function promptSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (char) => {
      if (char === '\r' || char === '\n' || char === '') {
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (char === '') {
        process.stdout.write('\n');
        process.exit(130);
      }
      if (char === '' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    stdin.on('data', onData);
  });
}

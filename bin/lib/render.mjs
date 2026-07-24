import pc from 'picocolors';

/** Visible width, ignoring ANSI colour codes so padding stays correct. */
const width = (value) => String(value).replace(/\[[0-9;]*m/g, '').length;

/**
 * Renders an aligned table. Column widths come from the content, so nothing is
 * truncated arbitrarily and nothing wastes space.
 */
export function table(columns, rows) {
  if (rows.length === 0) {
    console.log(pc.dim('  (nothing to show)'));
    return;
  }

  const widths = columns.map((column, index) =>
    Math.max(width(column.header), ...rows.map((row) => width(row[index] ?? ''))),
  );

  const line = columns
    .map((column, index) =>
      column.align === 'right'
        ? String(column.header).padStart(widths[index])
        : String(column.header).padEnd(widths[index]),
    )
    .join('  ');
  console.log(pc.dim(`  ${line}`));
  console.log(pc.dim(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`));

  for (const row of rows) {
    const rendered = columns
      .map((column, index) => {
        const cell = String(row[index] ?? '');
        const pad = widths[index] - width(cell);
        return column.align === 'right' ? ' '.repeat(Math.max(0, pad)) + cell : cell + ' '.repeat(Math.max(0, pad));
      })
      .join('  ');
    console.log(`  ${rendered}`);
  }
}

export function banner(port) {
  const url = `http://127.0.0.1:${port}`;
  console.log('');
  console.log(`  ${pc.bold(pc.yellow('Switchboard'))} ${pc.dim('· local-first AI gateway')}`);
  console.log('');
  console.log(`  ${pc.dim('Endpoint  ')}${pc.bold(`${url}/v1`)}`);
  console.log(`  ${pc.dim('Dashboard ')}${url}/dashboard`);
  console.log('');
  console.log(pc.dim('  Point any OpenAI-compatible tool at the endpoint above and'));
  console.log(pc.dim('  send model "auto" to let Switchboard choose the provider.'));
  console.log('');
}

export const dot = (status) => {
  switch (status) {
    case 'healthy':
      return pc.green('●');
    case 'degraded':
      return pc.yellow('●');
    case 'down':
      return pc.red('●');
    case 'disabled':
      return pc.dim('○');
    default:
      return pc.dim('◌');
  }
};

export const money = (value) => (value === 0 ? pc.green('free') : `$${Number(value).toFixed(4)}`);

export const ms = (value) =>
  value === null || value === undefined ? pc.dim('—') : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;

export const ok = (message) => console.log(`  ${pc.green('✓')} ${message}`);
export const fail = (message) => console.log(`  ${pc.red('✗')} ${message}`);
export const warn = (message) => console.log(`  ${pc.yellow('!')} ${message}`);
export const info = (message) => console.log(`  ${pc.dim(message)}`);

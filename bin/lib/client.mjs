import pc from 'picocolors';

export const baseUrl = () =>
  (process.env.SWITCHBOARD_URL ?? 'http://127.0.0.1:7272').replace(/\/$/, '');

/**
 * Thin fetch wrapper. Its whole job is turning ECONNREFUSED into a sentence a
 * human can act on rather than a stack trace.
 */
export async function api(path, options = {}) {
  const url = `${baseUrl()}${path}`;

  let response;
  try {
    // SWITCHBOARD_TOKEN lets `--url` point at a gateway on another machine;
    // locally the request is admitted as coming from this host.
    const token = process.env.SWITCHBOARD_TOKEN?.trim();
    response = await fetch(url, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-switchboard-token': token } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch (err) {
    const cause = err?.cause?.code ?? err?.code ?? '';
    if (cause === 'ECONNREFUSED' || cause === 'ENOTFOUND') {
      console.error(pc.red('Switchboard is not running.'));
      console.error(pc.dim(`  Tried ${url}`));
      console.error(pc.dim('  Start it with:  sb start'));
      process.exit(1);
    }
    throw err;
  }

  const text = await response.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const raw = typeof body === 'object' && body !== null ? (body.error ?? body.message) : body;
    // Admin errors are a string; the gateway's OpenAI envelope nests it.
    const message = typeof raw === 'object' && raw !== null ? raw.message : raw;
    console.error(pc.red(`Request failed (${response.status}): ${message ?? 'unknown error'}`));
    process.exit(1);
  }

  return body;
}

export const json = (value) => JSON.stringify(value);

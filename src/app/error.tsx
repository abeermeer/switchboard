'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    console.error('[switchboard] render error:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-ink">Something broke on this page</h1>
        <p className="max-w-md text-sm text-muted">{error.message}</p>
        {error.digest !== undefined && (
          <p className="font-mono text-xs text-faint">digest {error.digest}</p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-sb bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-sb border border-line-strong px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2"
        >
          Back to overview
        </Link>
      </div>
    </div>
  );
}

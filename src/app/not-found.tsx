import Link from 'next/link';

export default function NotFound(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-5xl font-semibold text-accent">404</p>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-ink">Nothing patched through here</h1>
        <p className="max-w-sm text-sm text-muted">
          That route does not exist on this gateway.
        </p>
      </div>
      <Link
        href="/dashboard"
        className="rounded-sb bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}

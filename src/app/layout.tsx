import type { Metadata, Viewport } from 'next';
import { ThemeScript } from '@/components/theme/ThemeScript';
import { ToastProvider } from '@/components/ui';
import './globals.css';

export const metadata: Metadata = {
  title: 'Switchboard',
  description:
    'A local-first AI gateway. One OpenAI-compatible endpoint, every provider, free-first routing with automatic fallback.',
  applicationName: 'Switchboard',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfa' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0b0d' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    // The theme attribute is written by ThemeScript before hydration, so React
    // will always see a mismatch here unless it is told to expect one.
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-bg text-ink antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

import { CommandPalette } from '@/components/shell/CommandPalette';
import { LiveProvider } from '@/components/shell/LiveProvider';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <LiveProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1600px] px-5 py-5">{children}</div>
          </main>
        </div>
      </div>
      <CommandPalette />
    </LiveProvider>
  );
}

import { LibraryBig } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SidebarIconButton } from '@/components/sidebar/SidebarIconButton';
import { cn } from '@/lib/utils';
import { useKosPreviewAvailability } from './useKosPreviewAvailability';

const PATH = '/kos-preview';

export function KosPreviewNavEntry({ compact }: { compact: boolean }) {
  return useKosPreviewAvailability() ? <KosPreviewNavButton compact={compact} /> : null;
}

function KosPreviewNavButton({ compact }: { compact: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = pathname === PATH;
  const open = () => navigate(PATH);
  if (compact) {
    return <div className="flex justify-center">
      <SidebarIconButton icon={LibraryBig} label="KOS" active={active} onClick={open} />
    </div>;
  }
  return <div className="px-3 pb-1">
    <button type="button" onClick={open} aria-current={active ? 'page' : undefined}
      className={cn('flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
        active && 'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground hover:bg-sidebar-item-active')}>
      <LibraryBig size={15} strokeWidth={1.8} aria-hidden="true" />
      KOS
    </button>
  </div>;
}

import { useLayoutEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KnowledgeApp, loadDesktopReaders, setLocale, setHostReaderLoader } from '@cindy/kos-workbench/desktop-view';
import { LibraryClient } from '@cindy/kos-workbench/library-client';
import { useKosPreviewAvailability } from './useKosPreviewAvailability';
import workbenchCss from '@cindy/kos-workbench/theme.css?inline';

const embeddedCss = `
@scope (.kos-preview) {
${workbenchCss.replace(/^:root\s*\{/m, ':scope {')}
:scope {
  position: relative;
  flex: 1;
  height: 100%;
  min-height: 0;
  background: var(--surface);
  color: var(--text-primary);
}
.knowledge-shell { height: 100%; }
.whiteboard-workspace > .empty { flex: 1; padding: 24px; }
.whiteboard-workspace > .empty h1 { margin-bottom: 12px; }
}
`;

setHostReaderLoader(loadDesktopReaders);

let previewStore: LibraryClient | undefined;

function WorkbenchPreview() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [view, setView] = useState<{ store: LibraryClient; locale: string }>();
  useLayoutEffect(() => {
    setLocale(locale);
    const api = window.electronAPI.kosPreview;
    previewStore ??= new LibraryClient({
      async call<T>(operation: string, payload?: unknown): Promise<T> {
        if (operation === 'openExternal') {
          const url = new URL((payload as { url: string }).url);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_EXTERNAL_URL');
          return await window.electronAPI.openExternal(url.href) as T;
        }
        if (operation !== 'library') throw new Error('KOS_PREVIEW_OPERATION_UNAVAILABLE');
        return await api.command(payload as Parameters<typeof api.command>[0]) as T;
      },
    }, listener => api.onChanged(listener));
    setView({ store: previewStore, locale });
  }, [locale]);

  return <div className="kos-preview"><style>{embeddedCss}</style>{view?.locale === locale && <KnowledgeApp store={view.store} hostManaged hideCardAi />}</div>;
}

export function KosPreviewPage() {
  const available = useKosPreviewAvailability();
  if (available === false) return <Navigate to="/" replace />;
  return available ? <WorkbenchPreview /> : null;
}

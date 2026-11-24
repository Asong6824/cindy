import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { openStagedKosLibrary } from './kosStagedLibrary';
import { openKosPreviewLibrary } from './kosPreviewStorage';
import type { LibraryService } from '@cindy/kos-workbench/library-service';
import { dispatchLibrary } from '@cindy/kos-workbench/library-rpc';
import { KOS_PREVIEW_AVAILABLE, KOS_PREVIEW_CHANGED, KOS_PREVIEW_COMMAND } from '../../shared/kosPreview';
import { isUiMockDataEnabled } from '../localDb/uiMockSeed';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer';
import { createLogger } from '../logger';
import { throwIpcError } from '../utils/ipcValidate';

const log = createLogger('kos-preview');

export function registerKosPreviewIpc(): void {
  const enabled = !app.isPackaged && isUiMockDataEnabled();
  ipcMain.handle(KOS_PREVIEW_AVAILABLE, event => {
    assertTrustedAppRendererEvent(event);
    return enabled;
  });
  if (!enabled) return;

  let opening: Promise<LibraryService> | undefined;
  const open = () => opening ??= (async () => {
    const root = path.join(app.getPath('userData'), 'kos-preview');
    const migrated = await openStagedKosLibrary(path.join(root, 'imported'));
    const service = migrated?.service ?? await openKosPreviewLibrary(path.join(root, 'library.json'));
    if (migrated) app.once('will-quit', () => { void migrated.close(); });
    service.subscribe(() => {
      const snapshot = service.getSnapshot();
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed() && isTrustedAppRendererWindow(win)) {
            win.webContents.send(KOS_PREVIEW_CHANGED, snapshot);
          }
        } catch {
          log.warn('Could not deliver KOS preview update');
        }
      }
    });
    return service;
  })().catch(error => {
    opening = undefined;
    throw error;
  });

  ipcMain.handle(KOS_PREVIEW_COMMAND, async (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    try {
      if ((JSON.stringify(request)?.length ?? 0) > 2 * 1024 * 1024) {
        throw new Error('KOS_PREVIEW_REQUEST_TOO_LARGE');
      }
      const service = await open();
      return await dispatchLibrary(service, request);
    } catch {
      throwIpcError('INVALID_PARAMS', 'KOS preview command could not be completed');
    }
  });
}

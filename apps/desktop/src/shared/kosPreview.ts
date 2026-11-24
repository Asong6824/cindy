import type { LibraryRequest } from '@cindy/kos-workbench/library-rpc';
import type { WorkbenchSnapshot } from '@cindy/kos-workbench/library-client';

export const KOS_PREVIEW_AVAILABLE = 'kos-preview:available';
export const KOS_PREVIEW_COMMAND = 'kos-preview:command';
export const KOS_PREVIEW_CHANGED = 'kos-preview:changed';

export interface KosPreviewApi {
  available(): Promise<boolean>;
  command(request: LibraryRequest): Promise<unknown>;
  onChanged(listener: (snapshot: WorkbenchSnapshot) => void): () => void;
}

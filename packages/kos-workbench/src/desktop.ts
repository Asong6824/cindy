export { KnowledgeApp } from './ui/KnowledgeApp';
export { setLocale } from './messages';
export { setHostReaderLoader } from './reader/load';
export const loadDesktopReaders = () => import('./reader/runtime');

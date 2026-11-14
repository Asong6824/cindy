/** Explicit build choice. It never grants Cindy cloud membership or creates account tokens. */
export const UMEDA_STANDALONE = process.env.EXPO_PUBLIC_UMEDA_MODE === '1';
export const UMEDA_LOCAL_OWNER = 'local-v1';

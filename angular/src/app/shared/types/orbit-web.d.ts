/** Optional capabilities supplied only by the local web adapter. */
interface Window {
  orbitWeb?: {
    chooseCover: (game: { identity: string; title: string; system: 'PS1' | 'PS2' }) => Promise<boolean>;
  };
}

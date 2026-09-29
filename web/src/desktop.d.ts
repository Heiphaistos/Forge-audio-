interface Window {
  /** Present only inside the Forge Audio desktop app (see desktop/preload.cjs). */
  forgeDesktop?: {
    platform: string;
    getServer: () => Promise<string | null>;
    setServer: (url: string | null) => Promise<string | null>;
  };
}

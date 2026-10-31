declare global {
  interface ImportMeta {
    /**
     * Vite's, where Vite served or built the page, and absent elsewhere.
     * freedom reads `DEV` alone, to tell development from a release.
     */
    readonly env?: { readonly DEV?: boolean };
  }
}

export {};

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the API when it is not served from the same origin as the app, e.g. https://api.example.in. */
  readonly VITE_API_URL?: string;
}

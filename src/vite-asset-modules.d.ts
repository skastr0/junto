/** Vite URL imports for static media bundled into the renderer. */
declare module "*.mp3?url" {
  const src: string;
  export default src;
}

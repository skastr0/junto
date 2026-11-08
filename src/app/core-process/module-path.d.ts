/** electron-vite bundles a `?modulePath` import as its own entry and gives its path (electron-vite/node.d.ts). */
declare module "*?modulePath" {
  const path: string;
  export default path;
}

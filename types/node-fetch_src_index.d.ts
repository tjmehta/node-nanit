declare module 'node-fetch/src/index.js' {
  export function fetch(url: string, options?: RequestInit): Promise<Response>
  // Add other type declarations as needed
}

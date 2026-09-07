import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tsconfig の paths と同じ対応。移植元の renderer が @/ と @shared/ で書かれている
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@': path.resolve(import.meta.dirname, 'src/ui')
    }
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] }
})

import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-server helper: GET /__assets lists files dropped into ./assets (the rigged Fortuner GLB, rigmap.json).
const assetsList = () => ({
  name: 'assets-list',
  configureServer(server: any) {
    server.middlewares.use('/__assets', (_req: any, res: any) => {
      const dir = path.resolve(__dirname, 'assets');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(files));
    });
  },
});

export default defineConfig({
  publicDir: 'public',
  plugins: [assetsList()],
  server: { fs: { allow: ['.'] } },
  assetsInclude: ['**/*.glb'],
});

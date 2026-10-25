import * as esbuild from 'esbuild';

export async function buildElectron() {
  await esbuild.build({
    entryPoints: ['electron/main.ts', 'electron/preload.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    external: [
      'electron',
      'ffmpeg-static',
      'ffprobe-static',
      'fluent-ffmpeg',
    ],
  });
  console.log('[Electron Build] Compiled electron/main.ts and electron/preload.ts');
}

if (process.argv[1] && process.argv[1].endsWith('build-electron.mjs')) {
  buildElectron().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

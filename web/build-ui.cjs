// Stage upstream's Angular workspace so web-only build settings never diverge
// in the tracked desktop workspace. The Pi serves the resulting static files.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const angular = path.join(repo, 'angular');
const staged = path.join(__dirname, '.build-ui');
const generated = spawnSync(process.execPath, [path.join(repo, 'scripts/generate-build-info.js')], { cwd: repo, stdio: 'inherit' });
if (generated.status !== 0) process.exit(generated.status || 1);
fs.rmSync(staged, { recursive: true, force: true });
fs.cpSync(angular, staged, { recursive: true, filter: source =>
  !['node_modules', '.angular', '.vscode', 'dist', 'out-tsc'].includes(path.basename(source)),
});
fs.symlinkSync(path.join(angular, 'node_modules'), path.join(staged, 'node_modules'), 'dir');
const configPath = path.join(staged, 'angular.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.cli = { ...config.cli, cache: { enabled: false } };
for (const project of Object.values(config.projects)) {
  if (project.architect?.build) project.architect.build.options.outputPath = path.join(repo, 'dist/angular');
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
const stylesPath = path.join(staged, 'src/styles.css');
const styles = fs.readFileSync(stylesPath, 'utf8');
fs.writeFileSync(stylesPath, styles.replace(/@import\s+url\(["']https:\/\/fonts\.googleapis\.com\/[^"']*["']\)\s*;/g, '/* Web: use existing system font fallbacks without a network request. */'));
const result = spawnSync(process.execPath, [path.join(angular, 'node_modules/@angular/cli/bin/ng.js'), 'build'], {
  cwd: staged, stdio: 'inherit', env: { ...process.env, NG_BUILD_MAX_WORKERS: process.env.NG_BUILD_MAX_WORKERS || '1' },
});
process.exit(result.status || (result.signal ? 1 : 0));

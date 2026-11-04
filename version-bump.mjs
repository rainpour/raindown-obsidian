// Run by "npm version minor" and the like: the manifest takes package.json's new version, and versions.json lists it
// with the oldest Obsidian it runs on, as Obsidian's community plugins need.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.env.npm_package_version;
const write = (file, json) => writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

write('manifest.json', { ...manifest, version });
write('versions.json', { ...versions, [version]: manifest.minAppVersion });

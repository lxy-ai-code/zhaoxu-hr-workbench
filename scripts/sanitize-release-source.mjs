import fs from 'node:fs/promises';
import path from 'node:path';

// Design references in the development workspace are private and optional.
// Keep them in the original workspace and omit them from distributed defaults.
export async function sanitizeReleaseSource(app) {
  const tenantDocument = /https:\/\/[a-z0-9-]+\.feishu\.cn\/(?:docx|wiki|base)\//i;
  for (const name of ['interview-copilot-policy.mjs', 'interview-report-policy.mjs', 'prompts.mjs']) {
    const file = path.join(app, 'lib', name);
    const source = await fs.readFile(file, 'utf8');
    const clean = source.split(/(?<=\n)/).filter(line => !(/^[ \t]*\{\s*title\s*:.*\burl\s*:/.test(line) && tenantDocument.test(line))).join('');
    await fs.writeFile(file, clean);
  }

  const privateString = /[a-z]:[\\/]+(?:users[\\/]+a|codex|cladue)[\\/]|\b(?:cli_[\da-f]{16,}|ou_[\da-f]{22,})\b|\b(?:ghp_|github_pat_)[a-z0-9_]{20,}/i;
  for (const directory of ['lib', 'public', 'scripts']) {
    for (const entry of await fs.readdir(path.join(app, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:m?js|css|html|svg|py)$/i.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      const source = await fs.readFile(file, 'utf8');
      if (tenantDocument.test(source) || privateString.test(source)) {
        throw new Error(`Release source contains a workstation path or private identifier in ${path.relative(app, file)}.`);
      }
    }
  }
}

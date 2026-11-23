import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sanitizeReleaseSource } from './sanitize-release-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packaging = path.join(root, 'packaging', 'windows');
const output = path.join(root, 'dist');
const cache = path.join(output, '.downloads');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

// Windows x64 runtime archives and resume-parser wheels, pinned to upstream SHA-256.
const nodeVersion = '24.22.3';
const nodeName = `node-v${nodeVersion}-win-x64`;
const nodeArchive = [
  `https://nodejs.org/dist/v${nodeVersion}/${nodeName}.zip`,
  'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
];
const pythonVersion = '3.13.17';
const pythonArchive = [
  `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`,
  '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38',
];
const pythonWheels = [
  ['5b/ef/11ed995bd10a1632f7fea3da38ae8d42bc3ccc5b9969fe04d8620c844408/pypdf-7.1.1-py3-none-any.whl', '04c5680d4b4cfa04ab505b09393fc949860c34a4dad6565284d11a2f5c3ce8b1'],
  ['25/27/0b40cb094fe566445fef76ff5c458b63031baf17c246b40b116d472ce2ac/pdfplumber-0.11.11-py3-none-any.whl', '81fd7c493ac69a0645a68da49320e4e2cace05d99824439accc7b5b3d955f3bc'],
  ['d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl', '3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7'],
  ['20/8b/28c4eaec9d6b036a52cb44720408f26b1a143ca9bce76cc19e8f5de00ab4/pdfminer_six-20260107-py3-none-any.whl', '366585ba97e80dffa8f00cebe303d2f381884d8637af4ce422f1df3ef38111a9'],
  ['9c/76/b8ec57f4e9ee3253541abf95e4a462c0175fe8032dcd070f1f2421240942/charset_normalizer-3.5.2-cp313-cp313-win_amd64.whl', '78456a747de8dc58360ffa581f30a002baf5aa28cb262536545e91f113ed7639'],
  ['9a/4f/adfc442765721292fff86d314ce385d3249d22db42295c0dd057727b60f3/cryptography-50.0.2-cp311-abi3-win_amd64.whl', '7afa5a6602a9f29af1f3a2965f831bae7c9d5d597b7cbb716d41ab3b7d89879c'],
  ['60/a6/8b149b2c3f2e11aaa1618ef64500b45f50f22c57a977a4dff1aff1f91042/cffi-2.1.1-cp313-cp313-win_amd64.whl', '1aa5645c30469b09530c4ebca77ebf8f17618293c58f8549cb1a543a50236e7d'],
  ['c0/28/e46a7702bd95e9043291f7c3539b6184cba66f96cea9936f20939b284eeb/lxml-6.1.3-cp313-cp313-win_amd64.whl', 'e477aca0bc0d19f3b4ae9e4f2a1cfd687c31bf772d78734910658186b40b2477'],
  ['d7/ed/1b16fb66a37e1b9e41370b93b2c614c7da761a5b2a41dc333f7af4639962/pillow-13.0.0-cp313-cp313-win_amd64.whl', '9dda0788a9932776a75d8bcc020076edc308ce2508b51f6739a45e3158b3fc42'],
  ['fe/7f/8aa446529fa14523e5c18f89e823afc95526689f76a75efe68a82a10d850/pypdfium2-5.15.2-py3-none-win_amd64.whl', '74d1bace34fb01c660d0b64344d5a4b7d276942b7c6623c88ab59ea21c5acfbd'],
  ['49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80/typing_extensions-4.16.0-py3-none-any.whl', '481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8'],
  ['b6/ae/315bbeee126a769cbde43cf4908acb4b40408d8bf8bbf334dd7368d8dadf/pycparser-3.12-py3-none-any.whl', 'a076f3f489b39b43ed13563a1dafe42447445bec2e294154ec5c57fcdda4c85e'],
];

function run(executable, args, { cwd, capture = false } = {}) {
  const command = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (command.error) throw command.error;
  if (command.status !== 0) throw new Error(`${path.basename(executable)} exited with ${command.status}.`);
  return command.stdout;
}

async function digest(file) {
  const sha256 = createHash('sha256');
  for await (const chunk of createReadStream(file)) sha256.update(chunk);
  return sha256.digest('hex');
}

async function download(url, expected) {
  const name = new URL(url).pathname.split('/').at(-1);
  const destination = path.join(cache, name);
  const downloadedHash = await digest(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (downloadedHash === expected) return destination;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    run('curl.exe', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--retry', '2', '--connect-timeout', '15', '--max-time', '120', '--output', temporary, url]);
    if (await digest(temporary) !== expected) throw new Error(`SHA-256 mismatch for ${name}.`);
    await fs.rename(temporary, destination);
    return destination;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function copyFile(source, destination) {
  const entry = await fs.lstat(source);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Release input is not a regular file: ${path.basename(source)}.`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copyCodeDirectory(name, extensionFilter, app) {
  const directory = path.join(root, name);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !extensionFilter.test(entry.name)) throw new Error(`Unexpected release input ${name}/${entry.name}.`);
    await copyFile(path.join(directory, entry.name), path.join(app, name, entry.name));
  }
}

async function packVersion(version, repository) {
  const work = await fs.mkdtemp(path.join(output, '.stage-'));
  const bundle = path.join(work, 'bundle');
  const app = path.join(bundle, 'app');
  const builderCache = path.join(work, 'node');
  const node = path.join(app, 'vendor', 'node');
  const python = path.join(app, 'vendor', 'python');
  const sitePackages = path.join(python, 'Lib', 'site-packages');
  try {
    for (const dir of [builderCache, sitePackages]) await fs.mkdir(dir, { recursive: true });
    for (const entry of ['Common.ps1', 'Install.cmd', 'Install.ps1', 'Start.cmd', 'Start.ps1', 'Stop.cmd', 'Update.cmd', 'Update.ps1', 'Boss.cmd']) {
      await copyFile(path.join(packaging, entry), path.join(bundle, entry));
    }
    for (const entry of ['package.json', 'server.mjs', 'scripts/background-workbench.mjs', 'scripts/extract-resume.py']) {
      await copyFile(path.join(root, entry), path.join(app, entry));
    }
    await copyCodeDirectory('lib', /^[a-z0-9-]+\.mjs$/, app);
    await copyCodeDirectory('public', /^[a-z0-9-]+\.(?:js|css|html)$/, app);
    await sanitizeReleaseSource(app);
    const packageJson = path.join(app, 'package.json');
    const packageInfo = JSON.parse(await fs.readFile(packageJson, 'utf8'));
    await fs.writeFile(packageJson, JSON.stringify({ ...packageInfo, version }, null, 2) + '\n');
    const metadata = JSON.stringify({ version, repository }, null, 2) + '\n';
    for (const directory of [bundle, app]) await fs.writeFile(path.join(directory, 'package-info.json'), metadata);

    run(tar, ['-xf', await download(...nodeArchive), '-C', builderCache, `${nodeName}/node.exe`, `${nodeName}/LICENSE`]);
    for (const entry of ['node.exe', 'LICENSE']) await copyFile(path.join(builderCache, nodeName, entry), path.join(node, entry));
    run(tar, ['-xf', await download(...pythonArchive), '-C', python]);
    for (const [wheel, hash] of pythonWheels) {
      const file = await download(`https://files.pythonhosted.org/packages/${wheel}`, hash);
      run(tar, ['-xf', file, '-C', sitePackages]);
    }
    await fs.writeFile(path.join(python, 'python313._pth'), 'python313.zip\r\n.\r\nLib/site-packages\r\n');
    run(path.join(node, 'node.exe'), ['--check', 'server.mjs'], { cwd: app });
    run(path.join(python, 'python.exe'), ['-B', '-c', 'import docx, lxml, pypdf, pdfplumber, pypdfium2; print("Resume parsers ready")'], { cwd: app });

    const name = `ZhaoxuHR-v${version}-windows-x64`;
    const archive = path.join(work, `${name}.zip`);
    const setup = path.join(work, `${name}-Setup.exe`);
    const checksum = `${await digestAfterPacking(archive, bundle)}  ${name}.zip\r\n`;
    const entries = run(tar, ['-tf', archive], { capture: true });
    if (!entries.includes('app/vendor/node/node.exe') || !entries.includes('app/vendor/python/python.exe')) throw new Error('Packaged runtime files are missing.');
    if (/(?:^|\/)(?:data|runtime|secrets|\.git|\.chrome-cdp)(?:\/|$)/m.test(entries.split('\n').filter(line => !line.startsWith('app/vendor/')).join('\n'))) {
      throw new Error('Private workspace content in the release file list.');
    }
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', `/out:${setup}`, `/resource:${archive},ZhaoxuHR.SetupPayload`, path.join(packaging, 'SetupLauncher.cs')]);
    run(setup, ['--verify-payload']);
    await fs.writeFile(`${archive}.sha256`, checksum);
    for (const file of [setup, archive, `${archive}.sha256`]) {
      const destination = path.join(output, path.basename(file));
      await fs.rename(file, destination);
      console.log(destination);
    }
  } finally {
    const [resolvedWork, resolvedOutput] = await Promise.all([fs.realpath(work), fs.realpath(output)]);
    if (path.dirname(resolvedWork) !== resolvedOutput || !path.basename(resolvedWork).startsWith('.stage-')) {
      throw new Error('Release staging path is outside the dist directory.');
    }
    await fs.rm(resolvedWork, { recursive: true, force: true });
  }
}

async function digestAfterPacking(archive, bundle) {
  run(tar, ['-a', '-cf', archive, '-C', bundle, ...await fs.readdir(bundle)]);
  return digest(archive);
}

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the x64 Windows release on Windows using x64 Node.js.');
const { values: { version, repository = '' } } = parseArgs({ options: { version: { type: 'string' }, repository: { type: 'string' } } });
if (!/^(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})$/.test(version || '')) throw new Error('Supply --version as MAJOR.MINOR.PATCH.');
if (repository && !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i.test(repository)) throw new Error('Supply --repository as OWNER/REPO.');
await fs.mkdir(cache, { recursive: true });
await packVersion(version, repository);

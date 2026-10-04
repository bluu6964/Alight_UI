#!/usr/bin/env node
/**
 * Motion Studio — local APK build pipeline.
 *
 * Builds a signed, installable Android APK from android/app without Gradle and
 * without the Android SDK being installed system-wide: the script uses a small
 * pinned toolchain that it can fetch on demand into ~/.cache/android-toolchain
 * (a JDK + javac, android.jar, D8, aapt2 and a pure-JS APK signer).
 *
 *   node tools/build.mjs                 # full build -> app/build/MotionStudio-1.0.apk
 *   node tools/build.mjs --verify        # also verify the APK with androguard, if available
 *   node tools/build.mjs --skip-sign     # unsigned APK (handy for debugging)
 *   node tools/build.mjs --fetch-tools   # only download the toolchain, then exit
 *
 * Requires network access only for the toolchain download (first run) and
 * `npm install` inside android/tools for the signer.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');            // android/
const REPO_DIR = path.resolve(APP_DIR, '..');        // repository root
const SRC = path.join(APP_DIR, 'app', 'src', 'main');
const OUT_DIR = path.join(APP_DIR, 'build');
const WORK = path.join(OUT_DIR, '.work');
const TC = process.env.ANDROID_TOOLCHAIN || path.join(os.homedir(), '.cache', 'android-toolchain');
const TMP = path.join(WORK, 'stage');

const APP_NAME = 'Motion Studio';
const VERSION_CODE = 1;
const VERSION_NAME = '1.0';
const MIN_SDK = 24;
const TARGET_SDK = 34;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

// --------------------------------------------------------------------------- ui
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m' };
const log = (...a) => console.log(...a);
const step = (n, msg) => log(`${C.cyan}${C.bold}▸ ${n}${C.reset} ${msg}`);
const ok = (msg) => log(`  ${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => log(`  ${C.yellow}!${C.reset} ${msg}`);
const die = (msg, code = 1) => { console.error(`\n${C.red}✗ ${msg}${C.reset}\n`); process.exit(code); };

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    if (opts.quiet && res.stderr) console.error(res.stderr.toString().slice(-2000));
    die(`Command failed (${res.status}): ${path.basename(cmd)} ${cmdArgs.slice(0, 3).join(' ')}…`);
  }
  return res;
}

// ------------------------------------------------------------- toolchain layout
const JAVA = path.join(TC, 'dl', 'jdk_extract', 'jdk4py', 'java-runtime', 'bin', 'java');
const TOOLS = path.join(TC, 'tools');
const AAPT2 = path.join(TOOLS, 'package', 'bin', 'x64', 'linux', 'aapt2');
const ANDROID_JAR = path.join(TC, 'dl', 'android.jar');
const D8_JAR = path.join(TOOLS, 'd8.jar');
const ECJ_JAR = path.join(TOOLS, 'ecj.jar');
const TOOLS_JAR = path.join(TOOLS, 'package', 'tools.jar');
const KEYSTORE_DIR = path.join(HERE, 'keystore');
const KEY_PEM = path.join(KEYSTORE_DIR, 'motion-studio.key.pem');
const CERT_PEM = path.join(KEYSTORE_DIR, 'motion-studio.cert.pem');
const KEYSTORE = path.join(KEYSTORE_DIR, 'motion-studio.p12');
const KEYSTORE_PASS = 'motionstudio';

async function fetchTools() {
  fs.mkdirSync(path.join(TC, 'dl'), { recursive: true });
  fs.mkdirSync(TOOLS, { recursive: true });
  const missing = [];
  if (!fs.existsSync(JAVA)) missing.push('jdk');
  if (!fs.existsSync(ANDROID_JAR)) missing.push('android.jar');
  if (!fs.existsSync(D8_JAR) || !fs.existsSync(ECJ_JAR)) missing.push('dex');
  if (!fs.existsSync(AAPT2)) missing.push('aapt2');
  if (!fs.existsSync(TOOLS_JAR)) missing.push('javac');
  if (!missing.length) { ok('toolchain already present'); return; }

  const { download } = await import('node:https');
  const downloadTo = (url, dest, opts = {}) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (target) => download(target, { headers: opts.headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return request(res.headers.location);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${target}`)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    request(url).on('error', reject);
  });

  if (missing.includes('jdk')) {
    log('  downloading JDK 21 (Temurin, ~34 MB)…');
    const meta = JSON.parse(await httpGet('https://pypi.org/pypi/jdk4py/21.0.8.2/json'));
    const wheel = meta.urls.find((u) => u.filename.includes('manylinux_2_17_x86_64'));
    const whl = path.join(TC, 'dl', 'jdk4py.whl');
    await downloadTo(wheel.url, whl);
    run('unzip', ['-q', '-o', whl, '-d', path.join(TC, 'dl', 'jdk_extract')], { quiet: true });
    fs.chmodSync(JAVA, 0o755);
  }
  if (missing.includes('android.jar')) {
    log('  downloading android.jar (API 34, ~26 MB)…');
    await downloadTo('https://api.github.com/repos/Sable/android-platforms/git/blobs/923bafccf73aef996495c559e919ad8be3cabd58',
      ANDROID_JAR, { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'motion-studio-build' } });
  }
  if (missing.includes('javac')) {
    log('  downloading javac (OpenJDK tools.jar)…');
    const tgz = path.join(TC, 'dl', 'toolsjar.tgz');
    await downloadTo('https://registry.npmjs.org/dataslope-tools-jar/-/dataslope-tools-jar-1.0.0.tgz', tgz);
    run('tar', ['xzf', tgz, '-C', TOOLS], { quiet: true });
  }
  if (missing.includes('dex')) {
    log('  downloading D8 + ECJ (JVM tool jars, ~42 MB)…');
    const tgz = path.join(TC, 'dl', 'minapk.tgz');
    if (!fs.existsSync(tgz)) {
      await downloadTo('https://registry.npmjs.org/@drxiaozhi/minapk/-/minapk-0.4.0.tgz', tgz);
    }
    const dir = path.join(WORK, 'dex-tools');
    fs.mkdirSync(dir, { recursive: true });
    run('tar', ['xzf', tgz, '-C', dir, 'package/tools/d8.jar', 'package/tools/ecj-3.45.0.jar', 'package/tools/apksigner.jar'], { quiet: true });
    fs.copyFileSync(path.join(dir, 'package', 'tools', 'd8.jar'), D8_JAR);
    fs.copyFileSync(path.join(dir, 'package', 'tools', 'ecj-3.45.0.jar'), ECJ_JAR);
    if (fs.existsSync(path.join(dir, 'package', 'tools', 'apksigner.jar'))) {
      fs.copyFileSync(path.join(dir, 'package', 'tools', 'apksigner.jar'), path.join(TOOLS, 'apksigner.jar'));
    }
  }
  if (missing.includes('aapt2')) {
    log('  downloading aapt2…');
    const tgz = path.join(TC, 'dl', 'aaptjs3.tgz');
    await downloadTo('https://registry.npmjs.org/aaptjs3/-/aaptjs3-2.0.2.tgz', tgz);
    run('tar', ['xzf', tgz, '-C', TOOLS], { quiet: true });
  }
  // make sure everything we execute is executable (tarballs keep losing the bit)
  for (const exe of [JAVA, AAPT2]) {
    if (fs.existsSync(exe)) fs.chmodSync(exe, 0o755);
  }
  const jdkBin = path.dirname(JAVA);
  if (fs.existsSync(jdkBin)) {
    for (const file of fs.readdirSync(jdkBin)) fs.chmodSync(path.join(jdkBin, file), 0o755);
  }
  ok(`toolchain ready in ${TC}`);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    import('node:https').then(({ get }) => {
      const req = get(url, { headers: { 'User-Agent': 'motion-studio-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(httpGet(res.headers.location));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });
  });
}

// ------------------------------------------------------------------ zip helpers
function findEOCD(buf) {
  const maxBack = Math.min(buf.length, 66 * 1024);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) die('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) die('bad central directory');
    const method = buf.readUInt16LE(offset + 10);
    const time = buf.readUInt16LE(offset + 12);
    const date = buf.readUInt16LE(offset + 14);
    const crc = buf.readUInt32LE(offset + 16);
    const compSize = buf.readUInt32LE(offset + 20);
    const rawSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const stored = buf.slice(dataStart, dataStart + compSize);
    entries.push({
      name, method, time, date, crc, compSize, rawSize,
      // keep raw (decompressed) bytes; writeZip re-compresses as needed
      data: method === 0 ? stored : zlib.inflateRawSync(stored)
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Writes an APK-compatible zip: every uncompressed entry is 4-byte aligned. */
function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0x6000; // 12:00:00
  const dosDate = 0x5a21; // 2025-01-01 (fixed for reproducible builds)

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const stored = entry.method === 0;
    const data = stored ? entry.data : zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = entry.crc !== undefined ? entry.crc : crc32(entry.data);
    // alignment padding for uncompressed entries (resources.arsc, dex, …):
    // the data must start on a 4-byte boundary. Extra fields are at least
    // 4 bytes (id + size), so pick the smallest size that lands on a boundary.
    let extra = Buffer.alloc(0);
    if (stored) {
      const need = (4 - ((offset + 30 + nameBuf.length) % 4)) % 4;
      const extraLen = need === 0 ? 4 : need + 4;
      extra = Buffer.alloc(extraLen);
      extra.writeUInt16LE(0xd935, 0);            // Android alignment extra field
      extra.writeUInt16LE(extraLen - 4, 2);
      extra.fill(0, 4);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);             // UTF-8 names
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);
    chunks.push(header, nameBuf, extra, data);

    const dirHeader = Buffer.alloc(46);
    dirHeader.writeUInt32LE(0x02014b50, 0);
    dirHeader.writeUInt16LE(20, 4);
    dirHeader.writeUInt16LE(20, 6);
    dirHeader.writeUInt16LE(0x0800, 8);
    dirHeader.writeUInt16LE(stored ? 0 : 8, 10);
    dirHeader.writeUInt16LE(dosTime, 12);
    dirHeader.writeUInt16LE(dosDate, 14);
    dirHeader.writeUInt32LE(crc, 16);
    dirHeader.writeUInt32LE(data.length, 20);
    dirHeader.writeUInt32LE(entry.data.length, 24);
    dirHeader.writeUInt16LE(nameBuf.length, 28);
    dirHeader.writeUInt16LE(extra.length, 30);
    dirHeader.writeUInt16LE(0, 32);
    dirHeader.writeUInt16LE(0, 34);
    dirHeader.writeUInt16LE(0, 36);
    dirHeader.writeUInt32LE(0, 38);
    dirHeader.writeUInt32LE(offset, 42);
    central.push(dirHeader, nameBuf, extra);
    offset += header.length + nameBuf.length + extra.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ------------------------------------------------------------------- packaging
function rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (!filter(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dest, filter);
    else fs.copyFileSync(src, dest);
  }
}

function stageSources() {
  rmrf(TMP);
  fs.mkdirSync(TMP, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'AndroidManifest.xml'), path.join(TMP, 'AndroidManifest.xml'));
  copyDir(path.join(SRC, 'res'), path.join(TMP, 'res'));
  copyDir(path.join(SRC, 'assets'), path.join(TMP, 'assets'));
  const javaSrc = path.join(TMP, 'java');
  copyDir(path.join(SRC, 'java'), javaSrc);
  return javaSrc;
}

function listFiles(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (!ext || full.endsWith(ext)) out.push(full);
  }
  return out;
}

async function ensureSigningKey() {
  if (fs.existsSync(KEY_PEM) && fs.existsSync(CERT_PEM)) return;
  fs.mkdirSync(path.dirname(KEY_PEM), { recursive: true });
  step('key', 'creating a local signing key (android/tools/keystore, valid 10 years)');
  const crypto = await import('node:crypto');
  const forge = (await import('node-forge')).default;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });   // WebCrypto needs PKCS#8

  const rsa = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(rsa.n, rsa.e);
  cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'Motion Studio' },
    { name: 'organizationName', value: 'Motion Studio' },
    { name: 'localityName', value: 'Dhaka' },
    { name: 'countryName', value: 'BD' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', codeSigning: true }
  ]);
  cert.sign(rsa, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(KEY_PEM, keyPem);
  fs.writeFileSync(CERT_PEM, certPem);
  // a PKCS#12 copy so the key can also be used with apksigner / jarsigner / Android Studio
  try {
    const p12 = forge.pkcs12.toPkcs12Asn1(rsa, [cert], KEYSTORE_PASS, { algorithm: '3des' });
    fs.writeFileSync(KEYSTORE, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  } catch (e) {
    warn(`could not write PKCS#12 copy: ${e.message}`);
  }
  ok('signing key ready');
}

async function sign(apkPath) {
  const { signApk } = await import('apk_sign_ts');
  const data = new Uint8Array(fs.readFileSync(apkPath));
  const { signedApk, signatureSize } = await signApk(
    data,
    fs.readFileSync(KEY_PEM, 'utf8'),
    fs.readFileSync(CERT_PEM, 'utf8')
  );
  fs.writeFileSync(apkPath, Buffer.from(signedApk));
  return signatureSize;
}

/** Independent check with Google's own apksigner, when the jar is available. */
function verifyWithApksigner(apkPath) {
  const jar = path.join(TOOLS, 'apksigner.jar');
  if (!fs.existsSync(jar)) return false;
  const res = spawnSync(JAVA, ['-jar', jar, 'verify', '--verbose', '--print-certs', apkPath], { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0) {
    const schemes = out.split('\n')
      .filter((l) => /^Verified using v\d/.test(l.trim()))
      .map((l) => l.trim().replace('Verified using ', ''))
      .join(' · ');
    if (schemes) ok(`apksigner: ${schemes}`);
    const signer = out.split('\n').find((l) => l.startsWith('Signer #1 certificate DN'));
    if (signer) ok(signer.trim());
    return true;
  }
  warn('apksigner could not verify the signature:');
  log(out.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n'));
  return false;
}

function verifyAlignment(apkPath) {
  const buf = fs.readFileSync(apkPath);
  const entries = readZip(buf);
  let checked = 0;
  // recompute local offsets: parse sequential local headers of the final file
  let offset = 0;
  const problems = [];
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLen + extraLen;
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    if (method === 0) {
      checked++;
      if (dataStart % 4 !== 0) problems.push(`${name} @ ${dataStart} (not 4-byte aligned)`);
    }
    offset = dataStart + compSize;
  }
  return { checked, problems, entries: entries.map((e) => e.name) };
}

// ------------------------------------------------------------------------ main
async function main() {
  log(`\n${C.bold}${APP_NAME}${C.reset} ${C.dim}— APK build${C.reset}\n`);

  step('tools', `checking toolchain in ${TC}`);
  await fetchTools();
  if (flag('--fetch-tools')) { log(`\n${C.green}Toolchain ready.${C.reset}\n`); return; }

  rmrf(WORK);
  fs.mkdirSync(WORK, { recursive: true });
  step('stage', 'collecting manifest, resources, assets and Java sources');
  const javaSrc = stageSources();
  const javaFiles = listFiles(javaSrc, '.java');
  ok(`${javaFiles.length} java file(s), assets from app/src/main/assets`);

  step('aapt2', 'compiling resources');
  const compiled = path.join(WORK, 'compiled.zip');
  run(AAPT2, ['compile', '--dir', path.join(TMP, 'res'), '-o', compiled]);
  ok('resources compiled');

  step('aapt2', 'linking resources + assets');
  const baseApk = path.join(WORK, 'base.apk');
  if (fs.existsSync(baseApk)) fs.unlinkSync(baseApk);
  run(AAPT2, [
    'link', '-o', baseApk,
    '-I', ANDROID_JAR,
    '--manifest', path.join(TMP, 'AndroidManifest.xml'),
    '-R', compiled,
    '-A', path.join(TMP, 'assets'),
    '--min-sdk-version', String(MIN_SDK),
    '--target-sdk-version', String(TARGET_SDK),
    '--version-code', String(VERSION_CODE),
    '--version-name', VERSION_NAME,
    '--auto-add-overlay',
    '--no-version-vectors'
  ]);
  ok(`base.apk (${(fs.statSync(baseApk).size / 1024).toFixed(0)} KB) with ${fs.readdirSync(path.join(SRC, 'assets', 'www')).length} www entries`);

  step('compile', 'compiling Java sources');
  const classesDir = path.join(WORK, 'classes');
  fs.mkdirSync(classesDir, { recursive: true });
  if (fs.existsSync(ECJ_JAR)) {
    // Eclipse compiler: modern, fast and happy with android.jar as the boot classpath
    run(JAVA, ['-Xmx1024m', '-jar', ECJ_JAR,
      '-source', '1.8', '-target', '1.8', '-nowarn', '-proc:none',
      '-bootclasspath', ANDROID_JAR, '-cp', ANDROID_JAR,
      '-d', classesDir, ...javaFiles]);
  } else {
    run(JAVA, [
      '-Xmx1024m', '-cp', TOOLS_JAR, 'com.sun.tools.javac.Main',
      '-source', '8', '-target', '8', '-nowarn',
      '-bootclasspath', ANDROID_JAR, '-cp', ANDROID_JAR,
      '-d', classesDir, ...javaFiles
    ]);
  }
  const classFiles = listFiles(classesDir, '.class');
  ok(`${classFiles.length} class file(s)`);

  step('d8', 'dexing');
  const dexDir = path.join(WORK, 'dex');
  fs.mkdirSync(dexDir, { recursive: true });
  run(JAVA, ['-Xmx1024m', '-cp', D8_JAR, 'com.android.tools.r8.D8',
    '--min-api', String(MIN_SDK), '--output', dexDir, ...classFiles]);
  const dex = path.join(dexDir, 'classes.dex');
  if (!fs.existsSync(dex)) die('D8 produced no classes.dex');
  ok(`classes.dex (${(fs.statSync(dex).size / 1024).toFixed(0)} KB)`);

  step('package', 'assembling the APK');
  const baseEntries = readZip(fs.readFileSync(baseApk));
  const entries = baseEntries.map((entry) => ({ ...entry, crc: undefined }));
  entries.push({ name: 'classes.dex', method: 0, data: fs.readFileSync(dex) });
  const apk = writeZip(entries);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outName = `MotionStudio-${VERSION_NAME}.apk`;
  const outPath = path.join(OUT_DIR, outName);
  fs.writeFileSync(outPath, apk);
  ok(`unsigned apk ${(apk.length / 1024 / 1024).toFixed(2)} MB`);

  const alignment = verifyAlignment(outPath);
  if (alignment.problems.length) warn(`alignment: ${alignment.problems.join(', ')}`);
  else ok(`alignment ok (${alignment.checked} uncompressed entries at 4-byte boundaries)`);

  if (!flag('--skip-sign')) {
    step('sign', 'APK Signature Scheme v2');
    await ensureSigningKey();
    const signatureSize = await sign(outPath);
    ok(`signed (${(signatureSize / 1024).toFixed(1)} KB signature)`);
    step('verify', 'checking the signature with Google apksigner');
    verifyWithApksigner(outPath);
  }

  if (flag('--verify')) {
    step('verify', 'parsing the APK with androguard (if available)');
    const res = spawnSync('python3', ['-c', `
import sys
try:
    from androguard.core.apk import APK
except Exception:
    try:
        from androguard.core.bytecodes.apk import APK
    except Exception as e:
        print('SKIP', e); sys.exit(0)
a = APK(sys.argv[1])
print('package', a.get_package())
print('version', a.get_androidversion_name(), a.get_androidversion_code())
print('minSdk', a.get_min_sdk_version(), 'targetSdk', a.get_target_sdk_version())
print('activities', a.get_main_activity())
print('files', len(a.get_files()))
print('assets sample', [f for f in a.get_files() if f.startswith('assets/www')][:5])
`, outPath], { encoding: 'utf8' });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }

  const sha = createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
  fs.writeFileSync(outPath + '.sha256', `${sha}  ${outName}\n`);
  const dest = path.join(REPO_DIR, 'MotionStudio.apk');
  try { fs.copyFileSync(outPath, dest); } catch (e) { warn(`could not copy to repo root: ${e.message}`); }

  log(`\n${C.green}${C.bold}Build complete${C.reset}`);
  log(`  ${C.bold}${outPath}${C.reset}`);
  log(`  ${C.dim}copy: ${dest}${C.reset}`);
  log(`  ${C.dim}sha256: ${sha}${C.reset}\n`);
  log(`  ${C.dim}install with: adb install -r "${outPath}"${C.reset}\n`);
}

main().catch((err) => die(err && err.stack ? err.stack : String(err)));

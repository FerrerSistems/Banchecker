/**
 * MÓDULO DE BACKUP/RESTORE DE SESIÓN
 * Zipea wa_session/ y la sube a GitHub
 */

const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const github = require('./github');
const { dbg } = config;

const BACKUP_FILENAME = 'session.zip';
const MAX_SIZE_MB = 60;

// Carpetas a excluir del zip
const EXCLUDE_PATTERNS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'ShaderCache',
  'GrShaderCache',
  'Crashpad',
  'blob_storage',
  'logs',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
];

function shouldExclude(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.some(part => EXCLUDE_PATTERNS.includes(part));
}

function walkDir(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(baseDir, fullPath);

    if (shouldExclude(relative)) continue;

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push({ fullPath, relative });
    }
  }

  return results;
}

function createSessionZip() {
  const sessionDir = config.paths.session;

  if (!fs.existsSync(sessionDir)) {
    return { success: false, reason: 'no_session_dir' };
  }

  const files = walkDir(sessionDir);

  if (files.length === 0) {
    return { success: false, reason: 'empty_session' };
  }

  const zip = new AdmZip();

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.fullPath);
      zip.addFile(file.relative, content);
    } catch (e) {
      dbg('BACKUP', `⚠️ No se pudo leer ${file.relative}: ${e.message}`);
    }
  }

  const buffer = zip.toBuffer();

  dbg('BACKUP', `Zip creado: ${files.length} archivos, ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  return { success: true, buffer, fileCount: files.length };
}

async function backupSession(commitMessage = null) {
  dbg('BACKUP', '🔼 Iniciando backup de sesión...');

  try {
    const result = createSessionZip();

    if (!result.success) {
      dbg('BACKUP', `⚠️ Backup cancelado: ${result.reason}`);
      return { success: false, reason: result.reason };
    }

    const sizeMB = result.buffer.length / 1024 / 1024;

    if (sizeMB > MAX_SIZE_MB) {
      dbg('BACKUP', `❌ Zip demasiado grande: ${sizeMB.toFixed(2)} MB (máx: ${MAX_SIZE_MB})`);
      return { success: false, reason: 'too_large', sizeMB };
    }

    await github.writeBinaryFile(
      BACKUP_FILENAME,
      result.buffer,
      commitMessage || `Session backup (${result.fileCount} files, ${sizeMB.toFixed(2)} MB) [bot]`
    );

    dbg('BACKUP', `✅ Backup completado (${sizeMB.toFixed(2)} MB, ${result.fileCount} archivos)`);
    return {
      success: true,
      sizeMB,
      fileCount: result.fileCount,
    };
  } catch (e) {
    dbg('BACKUP', `❌ Error en backup: ${e.message}`);
    return { success: false, reason: 'error', error: e.message };
  }
}

async function restoreSession() {
  dbg('BACKUP', '🔽 Iniciando restauración...');

  try {
    const buffer = await github.readBinaryFile(BACKUP_FILENAME);

    if (!buffer) {
      dbg('BACKUP', '⚠️ No hay backup en GitHub');
      return { success: false, reason: 'no_backup' };
    }

    dbg('BACKUP', `Backup descargado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

    const sessionDir = config.paths.session;
    if (fs.existsSync(sessionDir)) {
      dbg('BACKUP', 'Limpiando sesión local...');
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionDir, { recursive: true });

    const zip = new AdmZip(buffer);
    zip.extractAllTo(sessionDir, true);

    const fileCount = walkDir(sessionDir).length;
    dbg('BACKUP', `✅ Sesión restaurada: ${fileCount} archivos`);

    return { success: true, fileCount };
  } catch (e) {
    dbg('BACKUP', `❌ Error restaurando: ${e.message}`);
    return { success: false, reason: 'error', error: e.message };
  }
}

async function deleteSession() {
  dbg('BACKUP', '🗑️ Eliminando sesión...');

  try {
    const sessionDir = config.paths.session;
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    await github.deleteFile(BACKUP_FILENAME, 'Session deleted [bot]');

    dbg('BACKUP', '✅ Sesión eliminada');
    return { success: true };
  } catch (e) {
    dbg('BACKUP', `❌ Error eliminando: ${e.message}`);
    return { success: false, error: e.message };
  }
}

function hasLocalSession() {
  const sessionDir = config.paths.session;
  if (!fs.existsSync(sessionDir)) return false;

  const files = walkDir(sessionDir);
  return files.length > 0;
}

async function hasRemoteBackup() {
  return await github.fileExists(BACKUP_FILENAME);
}

async function getRemoteBackupInfo() {
  try {
    const buffer = await github.readBinaryFile(BACKUP_FILENAME);
    if (!buffer) return null;

    return {
      sizeMB: buffer.length / 1024 / 1024,
      exists: true,
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  backupSession,
  restoreSession,
  deleteSession,
  hasLocalSession,
  hasRemoteBackup,
  getRemoteBackupInfo,
  createSessionZip,
};

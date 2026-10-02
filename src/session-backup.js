/**
 * MÓDULO DE BACKUP/RESTORE DE SESIÓN
 * Guarda zips con el número de teléfono en el nombre: session_51999999999.zip
 * Soporta múltiples sesiones + mensajes de error inteligentes
 */

const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const github = require('./github');
const { dbg } = config;

// ══════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════

const MAX_SIZE_MB = 60;
const SESSION_PREFIX = 'session_';
const LEGACY_FILENAME = 'session.zip'; // compatibilidad con backups viejos

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
  'component_crx_cache',
  'extensions_crx_cache',
];

// Mensajes de error inteligentes
const ERROR_MESSAGES = {
  no_session_dir: 'No existe la carpeta de sesión',
  empty_session: 'No hay sesiones activas todavía',
  too_large: 'La sesión es demasiado grande para subir a GitHub',
  no_backup: 'No hay backup guardado en GitHub',
  no_phone: 'No se pudo identificar el número de la sesión',
  error: 'Ocurrió un error inesperado',
};

function smartError(reason) {
  return ERROR_MESSAGES[reason] || reason || 'Error desconocido';
}

// ══════════════════════════════════════════
// UTILIDADES DE ARCHIVOS
// ══════════════════════════════════════════

function shouldExclude(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.some(part => EXCLUDE_PATTERNS.includes(part));
}

function walkDir(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error(`[BACKUP] Error leyendo ${dir}: ${e.message}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(baseDir, fullPath);

    if (shouldExclude(relative)) continue;

    try {
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, baseDir));
      } else if (entry.isFile()) {
        results.push({ fullPath, relative });
      }
    } catch (e) {
      console.error(`[BACKUP] Error procesando ${fullPath}: ${e.message}`);
    }
  }

  return results;
}

// ══════════════════════════════════════════
// NOMBRES DE ARCHIVO
// ══════════════════════════════════════════

/**
 * Devuelve el nombre del archivo de backup para un número dado.
 * session_51999999999.zip
 */
function sessionFilename(phone) {
  if (!phone) return LEGACY_FILENAME;
  const clean = String(phone).replace(/\D/g, '');
  return `${SESSION_PREFIX}${clean}.zip`;
}

/**
 * Verifica si un archivo es un backup de sesión
 */
function isSessionFile(filename) {
  return filename === LEGACY_FILENAME ||
    (filename.startsWith(SESSION_PREFIX) && filename.endsWith('.zip'));
}

/**
 * Extrae el número de un nombre de archivo de sesión
 */
function phoneFromFilename(filename) {
  if (filename === LEGACY_FILENAME) return null;
  if (!filename.startsWith(SESSION_PREFIX)) return null;
  return filename.replace(SESSION_PREFIX, '').replace('.zip', '');
}

/**
 * Formatea un número para mostrar: 51999999999 → +51 999999999
 */
function prettyPhone(raw) {
  if (!raw) return 'Desconocido';
  const ddi = raw.length >= 12 ? raw.substring(0, 3) : raw.substring(0, 2);
  const number = raw.substring(ddi.length);
  return `+${ddi} ${number}`;
}

// ══════════════════════════════════════════
// CREAR ZIP DE SESIÓN
// ══════════════════════════════════════════

function createSessionZip() {
  console.log('[BACKUP] ═══ Creando ZIP de sesión ═══');
  const sessionDir = config.paths.session;

  if (!fs.existsSync(sessionDir)) {
    console.log(`[BACKUP] ⚠️ No existe ${sessionDir}`);
    return { success: false, reason: 'no_session_dir' };
  }

  const files = walkDir(sessionDir);
  console.log(`[BACKUP] Archivos encontrados: ${files.length}`);

  if (files.length === 0) {
    console.log('[BACKUP] ⚠️ Carpeta de sesión vacía');
    return { success: false, reason: 'empty_session' };
  }

  const zip = new AdmZip();
  let added = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.fullPath);
      zip.addFile(file.relative, content);
      added++;
    } catch (e) {
      console.log(`[BACKUP] ⚠️ No se pudo leer ${file.relative}: ${e.message}`);
    }
  }

  if (added === 0) {
    console.log('[BACKUP] ⚠️ Ningún archivo se pudo leer');
    return { success: false, reason: 'empty_session' };
  }

  const buffer = zip.toBuffer();
  const sizeMB = buffer.length / 1024 / 1024;

  console.log(`[BACKUP] ✅ ZIP creado: ${added} archivos, ${sizeMB.toFixed(2)} MB`);

  return { success: true, buffer, fileCount: added, sizeMB };
}

// ══════════════════════════════════════════
// BACKUP
// ══════════════════════════════════════════

/**
 * Sube la sesión a GitHub.
 * @param {string} commitMessage - Mensaje de commit
 * @param {string} phone - Número de teléfono (opcional pero recomendado)
 * @returns {Promise<object>}
 */
async function backupSession(commitMessage = null, phone = null) {
  console.log('\n[BACKUP] ═══ Iniciando backup ═══');
  console.log(`[BACKUP] Phone: ${phone || 'no especificado'}`);

  try {
    const result = createSessionZip();

    if (!result.success) {
      console.log(`[BACKUP] ⚠️ Backup cancelado: ${result.reason}`);
      return {
        success: false,
        reason: result.reason,
        message: smartError(result.reason),
      };
    }

    if (result.sizeMB > MAX_SIZE_MB) {
      console.log(`[BACKUP] ❌ ZIP muy grande: ${result.sizeMB.toFixed(2)} MB`);
      return {
        success: false,
        reason: 'too_large',
        message: `Sesión demasiado grande (${result.sizeMB.toFixed(2)} MB, máx ${MAX_SIZE_MB} MB)`,
        sizeMB: result.sizeMB,
      };
    }

    const filename = sessionFilename(phone);
    console.log(`[BACKUP] Nombre de archivo: ${filename}`);

    const msg = commitMessage ||
      `Session backup ${phone ? prettyPhone(phone) : ''} (${result.fileCount} files, ${result.sizeMB.toFixed(2)} MB) [bot]`;

    await github.writeBinaryFile(filename, result.buffer, msg);

    console.log(`[BACKUP] ✅ Backup completado: ${filename} (${result.sizeMB.toFixed(2)} MB)\n`);

    return {
      success: true,
      filename,
      phone: phone || null,
      sizeMB: result.sizeMB,
      fileCount: result.fileCount,
    };
  } catch (e) {
    console.error(`[BACKUP] ❌ Error en backup: ${e.message}`);
    console.error(e.stack);
    return {
      success: false,
      reason: 'error',
      error: e.message,
      message: `Error al subir: ${e.message}`,
    };
  }
}

// ══════════════════════════════════════════
// RESTORE
// ══════════════════════════════════════════

/**
 * Descarga y extrae una sesión desde GitHub.
 * @param {string} phone - Número específico (opcional)
 * @returns {Promise<object>}
 */
async function restoreSession(phone = null) {
  console.log(`\n[BACKUP] ═══ Restaurando sesión${phone ? ' (' + phone + ')' : ''} ═══`);

  try {
    const filename = phone ? sessionFilename(phone) : LEGACY_FILENAME;
    console.log(`[BACKUP] Archivo objetivo: ${filename}`);

    let buffer = await github.readBinaryFile(filename);

    // Si no existe el específico, intentar el legacy
    if (!buffer && phone) {
      console.log(`[BACKUP] No existe ${filename}, probando legacy...`);
      buffer = await github.readBinaryFile(LEGACY_FILENAME);
    }

    // Si no hay legacy, buscar cualquier sesión disponible
    if (!buffer) {
      console.log('[BACKUP] No hay backup específico ni legacy, buscando cualquier sesión...');
      const sessions = await listSessions();
      if (sessions.length > 0) {
        const first = sessions[0];
        console.log(`[BACKUP] Usando ${first.filename}...`);
        buffer = await github.readBinaryFile(first.filename);
      }
    }

    if (!buffer) {
      console.log('[BACKUP] ⚠️ No hay backup en GitHub');
      return {
        success: false,
        reason: 'no_backup',
        message: smartError('no_backup'),
      };
    }

    console.log(`[BACKUP] Backup descargado: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Limpiar carpeta actual
    const sessionDir = config.paths.session;
    if (fs.existsSync(sessionDir)) {
      console.log('[BACKUP] Limpiando sesión local...');
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionDir, { recursive: true });

    // Extraer
    const zip = new AdmZip(buffer);
    zip.extractAllTo(sessionDir, true);

    const fileCount = walkDir(sessionDir).length;
    console.log(`[BACKUP] ✅ Sesión restaurada: ${fileCount} archivos\n`);

    return { success: true, fileCount, filename };
  } catch (e) {
    console.error(`[BACKUP] ❌ Error restaurando: ${e.message}`);
    console.error(e.stack);
    return {
      success: false,
      reason: 'error',
      error: e.message,
      message: `Error al restaurar: ${e.message}`,
    };
  }
}

// ══════════════════════════════════════════
// DELETE
// ══════════════════════════════════════════

/**
 * Borra la sesión local Y el backup remoto.
 * @param {string} phone - Número específico (opcional)
 */
async function deleteSession(phone = null) {
  console.log(`\n[BACKUP] ═══ Eliminando sesión${phone ? ' (' + phone + ')' : ''} ═══`);

  try {
    const sessionDir = config.paths.session;
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      console.log('[BACKUP] Carpeta local limpiada');
    }

    // Borrar en GitHub
    const filename = phone ? sessionFilename(phone) : LEGACY_FILENAME;
    try {
      await github.deleteFile(filename, 'Session deleted [bot]');
      console.log(`[BACKUP] ${filename} eliminado de GitHub`);
    } catch (e) {
      console.log(`[BACKUP] ⚠️ No se pudo borrar ${filename}: ${e.message}`);
    }

    // Si no se especificó phone, borrar TODAS las sesiones
    if (!phone) {
      const sessions = await listSessions();
      for (const s of sessions) {
        try {
          await github.deleteFile(s.filename, 'Session deleted [bot]');
          console.log(`[BACKUP] ${s.filename} eliminado`);
        } catch (e) {
          console.log(`[BACKUP] ⚠️ Error borrando ${s.filename}: ${e.message}`);
        }
      }
    }

    console.log('[BACKUP] ✅ Sesión eliminada\n');
    return { success: true };
  } catch (e) {
    console.error(`[BACKUP] ❌ Error eliminando: ${e.message}`);
    return { success: false, error: e.message, message: `Error: ${e.message}` };
  }
}

// ══════════════════════════════════════════
// LISTAR SESIONES EN GITHUB
// ══════════════════════════════════════════

/**
 * Lista todos los backups de sesión disponibles en GitHub.
 * @returns {Promise<Array>} [{ filename, phone, pretty }]
 */
async function listSessions() {
  console.log('[BACKUP] Listando sesiones en GitHub...');

  try {
    const files = await github.listLogsFiles();
    const sessionFiles = files.filter(isSessionFile);

    const sessions = sessionFiles.map(f => {
      const phone = phoneFromFilename(f);
      return {
        filename: f,
        phone,
        pretty: phone ? prettyPhone(phone) : 'Legacy (sin número)',
        isLegacy: f === LEGACY_FILENAME,
      };
    });

    console.log(`[BACKUP] Sesiones encontradas: ${sessions.length}`);
    return sessions;
  } catch (e) {
    console.error(`[BACKUP] Error listando: ${e.message}`);
    return [];
  }
}

// ══════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════

function hasLocalSession() {
  const sessionDir = config.paths.session;
  if (!fs.existsSync(sessionDir)) return false;

  const files = walkDir(sessionDir);
  return files.length > 0;
}

/**
 * Verifica si hay backup remoto (para un phone específico o cualquiera).
 */
async function hasRemoteBackup(phone = null) {
  try {
    if (phone) {
      const filename = sessionFilename(phone);
      const exists = await github.fileExists(filename);
      if (exists) return true;

      // Fallback al legacy
      return await github.fileExists(LEGACY_FILENAME);
    }

    // Sin phone: buscar cualquier sesión
    const sessions = await listSessions();
    return sessions.length > 0;
  } catch (e) {
    console.error(`[BACKUP] Error verificando backup: ${e.message}`);
    return false;
  }
}

/**
 * Info del backup remoto.
 */
async function getRemoteBackupInfo(phone = null) {
  try {
    let filename = phone ? sessionFilename(phone) : null;
    let buffer = null;

    if (filename) {
      buffer = await github.readBinaryFile(filename);
    }

    // Fallback: buscar cualquier sesión
    if (!buffer) {
      const sessions = await listSessions();
      if (sessions.length > 0) {
        filename = sessions[0].filename;
        buffer = await github.readBinaryFile(filename);
      }
    }

    if (!buffer) return null;

    return {
      filename,
      phone: filename ? phoneFromFilename(filename) : null,
      sizeMB: buffer.length / 1024 / 1024,
      exists: true,
    };
  } catch (e) {
    console.error(`[BACKUP] Error getRemoteBackupInfo: ${e.message}`);
    return null;
  }
}

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = {
  // Core
  backupSession,
  restoreSession,
  deleteSession,

  // Estado
  hasLocalSession,
  hasRemoteBackup,
  getRemoteBackupInfo,
  listSessions,

  // Utilidades
  createSessionZip,
  sessionFilename,
  phoneFromFilename,
  prettyPhone,
  smartError,
};

/**
 * MÓDULO DE GITHUB (Octokit)
 * Maneja la lectura y escritura de archivos JSON en el repositorio
 */

const { Octokit } = require('@octokit/rest');
const config = require('./config');
const { dbg } = config;

// ══════════════════════════════════════════
// INICIALIZAR OCTOKIT
// ══════════════════════════════════════════

const octokit = new Octokit({
  auth: config.github.token,
  userAgent: 'BancheckerBot/1.0.0',
});

// ══════════════════════════════════════════
// UTILIDADES
// ══════════════════════════════════════════

function repoPath(filename) {
  return `${config.github.logsPath}/${filename}`;
}

async function readJson(filename, defaultValue = null, createIfNotExists = true) {
  const path = repoPath(filename);
  dbg('GITHUB', `Leyendo ${path}...`);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.github.owner,
      repo: config.github.repo,
      path,
      ref: config.github.branch,
    });

    if (data.type === 'file' && data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      const parsed = JSON.parse(content);
      dbg('GITHUB', `✅ ${filename} leído (SHA: ${data.sha})`);
      return parsed;
    }

    throw new Error(`'${path}' es un directorio, no un archivo`);
  } catch (e) {
    if (e.status === 404) {
      dbg('GITHUB', `⚠️ ${filename} no existe, usando valor por defecto`);
      if (createIfNotExists && defaultValue !== null) {
        await writeJson(filename, defaultValue, `Crear ${filename} automáticamente`);
      }
      return defaultValue;
    }
    dbg('GITHUB', `❌ Error leyendo ${filename}: ${e.message}`);
    throw e;
  }
}

async function writeJson(filename, content, commitMessage = null) {
  const path = repoPath(filename);
  const message = commitMessage || `Update ${filename} [bot]`;
  const contentStr = JSON.stringify(content, null, 2);
  const contentBase64 = Buffer.from(contentStr, 'utf8').toString('base64');

  dbg('GITHUB', `Escribiendo ${path}...`);

  try {
    let sha = undefined;
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: config.github.owner,
        repo: config.github.repo,
        path,
        ref: config.github.branch,
      });
      sha = data.sha;
      dbg('GITHUB', `SHA actual de ${filename}: ${sha}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      dbg('GITHUB', `${filename} no existe, será creado`);
    }

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.github.owner,
      repo: config.github.repo,
      path,
      message,
      content: contentBase64,
      sha,
      branch: config.github.branch,
    });

    dbg('GITHUB', `✅ ${filename} actualizado (commit: ${data.commit.sha.substring(0, 7)})`);
    return data;
  } catch (e) {
    dbg('GITHUB', `❌ Error escribiendo ${filename}: ${e.message}`);
    throw e;
  }
}

// ══════════════════════════════════════════
// LECTURA/ESCRITURA BINARIA
// ══════════════════════════════════════════

async function writeBinaryFile(filename, buffer, commitMessage = null) {
  const path = repoPath(filename);
  const message = commitMessage || `Update ${filename} [bot]`;
  const contentBase64 = buffer.toString('base64');

  dbg('GITHUB', `Escribiendo binario ${path} (${(buffer.length / 1024).toFixed(1)} KB)`);

  try {
    let sha = undefined;
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: config.github.owner,
        repo: config.github.repo,
        path,
        ref: config.github.branch,
      });
      sha = data.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.github.owner,
      repo: config.github.repo,
      path,
      message,
      content: contentBase64,
      sha,
      branch: config.github.branch,
    });

    dbg('GITHUB', `✅ ${filename} subido (commit: ${data.commit.sha.substring(0, 7)})`);
    return data;
  } catch (e) {
    dbg('GITHUB', `❌ Error escribiendo ${filename}: ${e.message}`);
    throw e;
  }
}

async function readBinaryFile(filename) {
  const path = repoPath(filename);
  dbg('GITHUB', `Leyendo binario ${path}...`);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.github.owner,
      repo: config.github.repo,
      path,
      ref: config.github.branch,
    });

    if (data.type !== 'file') {
      throw new Error(`${path} no es un archivo`);
    }

    if (data.content && data.content.length > 0) {
      return Buffer.from(data.content, 'base64');
    }

    if (data.download_url) {
      dbg('GITHUB', `Descargando desde URL (${(data.size / 1024).toFixed(1)} KB)...`);
      const response = await fetch(data.download_url, {
        headers: {
          Authorization: `token ${config.github.token}`,
          Accept: 'application/vnd.github.v3.raw',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    throw new Error('No se pudo obtener el contenido');
  } catch (e) {
    if (e.status === 404) {
      dbg('GITHUB', `⚠️ ${filename} no existe en el repo`);
      return null;
    }
    dbg('GITHUB', `❌ Error leyendo ${filename}: ${e.message}`);
    throw e;
  }
}

async function deleteFile(filename, commitMessage = null) {
  const path = repoPath(filename);
  const message = commitMessage || `Delete ${filename} [bot]`;

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.github.owner,
      repo: config.github.repo,
      path,
      ref: config.github.branch,
    });

    await octokit.rest.repos.deleteFile({
      owner: config.github.owner,
      repo: config.github.repo,
      path,
      message,
      sha: data.sha,
      branch: config.github.branch,
    });

    dbg('GITHUB', `🗑️ ${filename} eliminado`);
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

async function fileExists(filename) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.github.owner,
      repo: config.github.repo,
      path: repoPath(filename),
      ref: config.github.branch,
    });
    return data.type === 'file';
  } catch (e) {
    return false;
  }
}

// ══════════════════════════════════════════
// FUNCIONES ESPECÍFICAS DEL BOT
// ══════════════════════════════════════════

async function listLogsFiles() {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.github.owner,
      repo: config.github.repo,
      path: config.github.logsPath,
      ref: config.github.branch,
    });

    if (Array.isArray(data)) {
      return data.map(f => f.name);
    }
    return [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

async function getAuthorizedUsers() {
  return readJson('authorized.json', { users: {} });
}

async function setAuthorizedUsers(data) {
  return writeJson('authorized.json', data, 'Update authorized users [bot]');
}

async function getSuspendedNumbers() {
  return readJson('suspended.json', { numbers: [] });
}

async function setSuspendedNumbers(data) {
  return writeJson('suspended.json', data, 'Update suspended numbers [bot]');
}

async function getUserMonitorList(userId) {
  return readJson(`monitor_${userId}.json`, { userId, numbers: [] });
}

async function setUserMonitorList(userId, data) {
  return writeJson(
    `monitor_${userId}.json`,
    data,
    `Update monitor list for user ${userId} [bot]`
  );
}

async function isUserAuthorized(userId) {
  try {
    const data = await getAuthorizedUsers();
    const user = data.users[userId];
    if (!user) return { authorized: false, reason: 'No autorizado' };

    if (user.expiresAt) {
      const expiry = new Date(user.expiresAt);
      if (expiry < new Date()) {
        return { authorized: false, reason: 'Acceso expirado' };
      }
    }

    return { authorized: true, user };
  } catch (e) {
    dbg('GITHUB', `Error verificando autorización: ${e.message}`);
    return { authorized: false, reason: `Error: ${e.message}` };
  }
}

async function addAuthorizedUser(userId, durationMs) {
  const data = await getAuthorizedUsers();
  const expiresAt = new Date(Date.now() + durationMs).toISOString();

  data.users[userId] = {
    addedAt: new Date().toISOString(),
    expiresAt,
    active: true,
  };

  await setAuthorizedUsers(data);
  return data.users[userId];
}

async function removeAuthorizedUser(userId) {
  const data = await getAuthorizedUsers();
  delete data.users[userId];
  await setAuthorizedUsers(data);
  return true;
}

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = {
  readJson,
  writeJson,
  listLogsFiles,
  getAuthorizedUsers,
  setAuthorizedUsers,
  getSuspendedNumbers,
  setSuspendedNumbers,
  getUserMonitorList,
  setUserMonitorList,
  isUserAuthorized,
  addAuthorizedUser,
  removeAuthorizedUser,
  writeBinaryFile,
  readBinaryFile,
  deleteFile,
  fileExists,
  octokit,
};

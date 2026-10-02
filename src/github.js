// ══════════════════════════════════════════
// LECTURA/ESCRITURA BINARIA (para sesión)
// ══════════════════════════════════════════

/**
 * Escribe un archivo binario en el repositorio.
 * @param {string} filename - Nombre del archivo (ej: 'session.zip')
 * @param {Buffer} buffer - Contenido binario
 * @param {string} commitMessage - Mensaje del commit
 */
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

/**
 * Lee un archivo binario del repositorio.
 * @param {string} filename - Nombre del archivo
 * @returns {Promise<Buffer|null>}
 */
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

    // Si content está disponible directamente (archivo < 1MB)
    if (data.content && data.content.length > 0) {
      return Buffer.from(data.content, 'base64');
    }

    // Archivo entre 1MB y 100MB → usar download_url
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

/**
 * Elimina un archivo del repositorio.
 */
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

/**
 * Verifica si un archivo existe en el repositorio.
 */
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

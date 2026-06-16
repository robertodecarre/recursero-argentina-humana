// api/guardar.js — Vercel Serverless Function
// Recibe el contenido completo de programas.json o recursos.json desde el panel
// /admin y lo commitea directamente a main en el repo, usando la API de GitHub.
//
// Variables de entorno necesarias (cargar en el dashboard de Vercel):
//   GITHUB_TOKEN    -> token fine-grained con permiso Contents: read/write sobre este repo
//   ADMIN_PASSWORD  -> contraseña del panel (se valida acá, del lado del servidor)

const OWNER = 'robertodecarre';
const REPO = 'recursero-argentina-humana';
const BRANCH = 'main';
// Deploy Hook de Vercel: se dispara tras el commit para forzar el redeploy (POST sin body ni auth)
const VERCEL_DEPLOY_HOOK = 'https://api.vercel.com/v1/integrations/deploy/prj_b1VO46n9TNCrII9XHvkahxByFpcg/htlYzjbn6i';

// Solo se permite escribir estos archivos
const ARCHIVOS_PERMITIDOS = ['programas.json', 'recursos.json'];
// Orden canónico de las categorías de recursos.json
const CATEGORIAS_RECURSOS = ['dormir', 'comedores', 'duchas', 'roperos', 'juridico', 'defensorias'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido' });
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!token || !adminPassword) {
    res.status(500).json({ ok: false, error: 'Faltan variables de entorno en el servidor (GITHUB_TOKEN / ADMIN_PASSWORD).' });
    return;
  }

  // El body puede venir ya parseado o como string según el runtime
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Cuerpo de la petición inválido' });
    return;
  }

  const { password, programas, recursos, mensaje, version } = body;
  const archivo = body.archivo || 'programas.json';

  if (password !== adminPassword) {
    res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
    return;
  }

  if (ARCHIVOS_PERMITIDOS.indexOf(archivo) === -1) {
    res.status(400).json({ ok: false, error: 'Archivo no permitido: ' + archivo });
    return;
  }

  const fecha = new Date().toISOString().slice(0, 10);
  let out;

  // ===== Construcción + validación según el archivo =====
  if (archivo === 'programas.json') {
    if (!Array.isArray(programas) || programas.length === 0) {
      res.status(400).json({ ok: false, error: 'Falta el array de programas o está vacío' });
      return;
    }
    for (const p of programas) {
      if (!p || typeof p !== 'object' || !p.id || !p.nombre) {
        res.status(400).json({ ok: false, error: 'Hay un programa sin id o sin nombre' });
        return;
      }
    }
    const ids = programas.map(function (p) { return p.id; });
    if (new Set(ids).size !== ids.length) {
      res.status(400).json({ ok: false, error: 'Hay ids de programa repetidos' });
      return;
    }
    out = { version: typeof version === 'number' ? version : 1, actualizado: fecha, programas: programas };

  } else { // recursos.json
    if (!recursos || typeof recursos !== 'object' || Array.isArray(recursos)) {
      res.status(400).json({ ok: false, error: 'Falta el objeto de recursos' });
      return;
    }
    const cats = Object.keys(recursos);
    if (cats.length === 0) {
      res.status(400).json({ ok: false, error: 'No hay categorías de recursos' });
      return;
    }
    for (const c of cats) {
      if (!Array.isArray(recursos[c])) {
        res.status(400).json({ ok: false, error: 'La categoría "' + c + '" no es una lista' });
        return;
      }
    }
    // Reconstruir en orden canónico (categorías conocidas primero, luego cualquier extra)
    out = { version: typeof version === 'number' ? version : 1, actualizado: fecha };
    CATEGORIAS_RECURSOS.forEach(function (c) { if (recursos[c]) out[c] = recursos[c]; });
    cats.forEach(function (c) { if (typeof out[c] === 'undefined') out[c] = recursos[c]; });
  }

  // ===== Commit a GitHub (lógica compartida) =====
  const ghHeaders = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'recursero-admin',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const apiUrl = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + archivo;

  try {
    // 1) SHA actual del archivo (se relee justo antes de escribir para no pisar cambios externos)
    const getRes = await fetch(apiUrl + '?ref=' + BRANCH, { headers: ghHeaders });
    let sha;
    if (getRes.status === 200) {
      const cur = await getRes.json();
      sha = cur.sha;
    } else if (getRes.status === 404) {
      sha = undefined; // el archivo no existe aún (no debería pasar)
    } else {
      const t = await getRes.text();
      res.status(502).json({ ok: false, error: 'No se pudo leer el archivo actual de GitHub', detalle: t });
      return;
    }

    // 2) Contenido nuevo
    const contenido = JSON.stringify(out, null, 2) + '\n';
    const contentB64 = Buffer.from(contenido, 'utf8').toString('base64');

    // 3) PUT -> commit directo a main
    const putBody = {
      message: mensaje || ('Actualizar ' + archivo + ' desde el panel (' + fecha + ')'),
      content: contentB64,
      branch: BRANCH
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: Object.assign({}, ghHeaders, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(putBody)
    });

    if (putRes.status === 200 || putRes.status === 201) {
      const result = await putRes.json();
      // Disparar el redeploy de Vercel. No es crítico: el commit ya se hizo, así que
      // si el hook falla igual respondemos OK al panel (solo lo registramos).
      let deploy = true;
      try {
        const hookRes = await fetch(VERCEL_DEPLOY_HOOK, { method: 'POST' });
        deploy = hookRes.ok;
      } catch (e) {
        deploy = false;
      }
      res.status(200).json({
        ok: true,
        commit: result.commit && result.commit.html_url,
        actualizado: fecha,
        deploy: deploy
      });
    } else {
      const t = await putRes.text();
      res.status(502).json({ ok: false, error: 'GitHub rechazó el commit', detalle: t });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error inesperado: ' + (e && e.message) });
  }
};

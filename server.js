// ============================================================
// ANT Licencias API — server.js  (versión completa con PLACA)
// Render.com compatible — Node.js 18+ sin Puppeteer
// ============================================================

const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const iconv     = require('iconv-lite');
const { wrapper }   = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cors      = require('cors');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://sistematransito.ant.gob.ec/PortalWEB/paginas/clientes';

// ── Ruta raíz explícita ────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Crea un cliente axios con cookie jar dedicado por sesión.
 * Cada consulta usa su propia sesión para evitar conflictos.
 */
function crearCliente() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 25000,
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept-Language': 'es-EC,es;q=0.9,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection'     : 'keep-alive'
    }
  }));
}

/**
 * Decodifica buffer ISO-8859-1 (encoding del portal ANT).
 */
function dec(data) {
  return Buffer.isBuffer(data) ? iconv.decode(data, 'ISO-8859-1') : String(data);
}

// ══════════════════════════════════════════════════════════════
// PARSER — PERSONA (cédula / RUC / pasaporte)
// ══════════════════════════════════════════════════════════════

/**
 * Extrae datos del conductor desde el HTML de clp_grid_citaciones.jsp
 * Selectores confirmados con HTML real del portal:
 *   td.titulo1        → nombre (1er td) y puntos (td con solo dígitos)
 *   td.MarcoTitulo    → cédula  "CED - XXXXXXXXXX"
 *   td.detalle_formulario → "LICENCIA TIPO: C  / VALIDEZ: 17-09-2024 - 16-09-2029"
 */
function parsearPersona($) {
  const p = {};

  // NOMBRE — primer td.titulo1
  const nombreTxt = $('td.titulo1').first().text().replace(/\s+/g, ' ').trim();
  if (nombreTxt) p.nombre = nombreTxt;

  // PUNTOS — td.titulo1 cuyo texto es solo dígitos
  $('td.titulo1').each((_, td) => {
    const txt = $(td).text().replace(/\s+/g, ' ').trim();
    if (/^\d+$/.test(txt)) p.puntos = txt;
  });

  // CÉDULA / RUC / PASAPORTE — td.MarcoTitulo "CED - XXXXXXXXXX"
  $('td.MarcoTitulo').each((_, td) => {
    const txt = $(td).text().replace(/[\s\u00A0]+/g, ' ').trim();
    const m = txt.match(/(?:CED|RUC|PAS|PLA)\s*[-\u2013]\s*(\w+)/i);
    if (m) p.cedula = m[1];
  });

  // LICENCIAS — array (puede haber varias: A, B, C, D, E…)
  // HTML: "LICENCIA TIPO: A  / VALIDEZ: 23-01-2025 - 22-01-2030"
  p.licencias = [];

  $('td.detalle_formulario').each((_, td) => {
    const txt = $(td)
      .text()
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!/LICENCIA\s+TIPO/i.test(txt)) return;

    const lic = {};

    const mTipo = txt.match(/LICENCIA\s+TIPO\s*:\s*([A-Z0-9]+)/i);
    if (mTipo) lic.tipo = mTipo[1].trim();

    // Fecha inicio = primera fecha del rango
    const mIni = txt.match(/VALIDEZ\s*:\s*([\d\-\/]+)\s*-\s*[\d\-\/]+/i);
    if (mIni) lic.fecha_inicio = mIni[1].trim();

    // Fecha caducidad = segunda fecha del rango
    const mCad = txt.match(/VALIDEZ\s*:\s*[\d\-\/]+\s*-\s*([\d\-\/]+)/i);
    if (mCad) lic.fecha_caducidad = mCad[1].trim();

    // Rango completo
    const mRango = txt.match(/VALIDEZ\s*:\s*([\d\-\/]+\s*-\s*[\d\-\/]+)/i);
    if (mRango) lic.validez_completa = mRango[1].replace(/\s+/g, ' ').trim();

    if (lic.tipo) p.licencias.push(lic);
  });

  // Atajos de compatibilidad para frontends que usan campos raíz
  if (p.licencias.length > 0) {
    p.tipo_licencia   = p.licencias.map(l => l.tipo).join(' / ');
    p.fecha_caducidad = p.licencias[0].fecha_caducidad || '';
  }

  return p;
}

// ══════════════════════════════════════════════════════════════
// PARSER — VEHÍCULO (placa)
// ══════════════════════════════════════════════════════════════

/**
 * Extrae datos del vehículo desde el HTML de clp_grid_citaciones.jsp?tipo=PLA
 *
 * Estructura REAL confirmada con HTML del portal:
 *   td.titulo2 > strong     → placa  "GTO8639"
 *   td.titulo               → label  ("Marca:", "Modelo:", etc.)
 *   td.detalle_formulario   → valor  ("SUZUKI", "SWIFT ISG…", etc.)
 *
 * Pares label/valor en orden de aparición en el HTML:
 *   Fila 1: Marca | Color | Año de Matrícula
 *   Fila 2: Modelo | Clase | Fecha de Matrícula
 *   Fila 3: Año | Servicio | Fecha de Caducidad
 *   Fila 4: Polarizado | Fecha Caducidad (polarizado)
 *
 * Además extrae ps_id_persona y ps_id_contrato de los iframes
 * para poder encadenar la consulta de propietario/puntos.
 */
function parsearVehiculo($) {
  const v = {};

  // PLACA — td.titulo2 > strong
  const placaTxt = $('td.titulo2 strong').first().text().trim();
  if (placaTxt) v.placa = placaTxt;

  // Construir arrays paralelos de labels y valores
  const labels = [];
  const values = [];

  $('td.titulo').each((_, td) => {
    labels.push(
      $(td).text()
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/:$/, '')
        .toLowerCase()
        // normalizar tildes para matching robusto
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    );
  });

  $('td.detalle_formulario').each((_, td) => {
    values.push(
      $(td).text()
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  });

  // Tabla de mapeo: label normalizado → campo de salida
  const mapaLabels = {
    'marca'                  : 'marca',
    'modelo'                 : 'modelo',
    'color'                  : 'color',
    'clase'                  : 'clase',
    'ano'                    : 'anio',
    'servicio'               : 'servicio',
    'ano de matricula'       : 'anio_matricula',
    'fecha de matricula'     : 'fecha_matricula',
    'fecha de caducidad'     : 'fecha_caducidad_matricula',
    'polarizado'             : 'polarizado',
    'fecha caducidad'        : 'fecha_caducidad_polarizado',
  };

  labels.forEach((label, i) => {
    const campo = mapaLabels[label];
    if (campo && values[i] !== undefined) {
      v[campo] = values[i];
    }
  });

  // IDs internos embebidos en los iframes — útiles para consultas encadenadas
  // src="clp_estado_cuenta.jsp?ps_persona=74270169&ps_id_contrato=703798498..."
  // src="clp_grid_puntos.jsp?ps_id_persona=74270169"
  const html = $.html();

  const mPersona  = html.match(/ps_id_persona=(\d+)/);
  const mPersona2 = html.match(/ps_persona=(\d+)/);
  const mContrato = html.match(/ps_id_contrato=(\d+)/);

  if (mPersona)  v._id_persona  = mPersona[1];
  else if (mPersona2) v._id_persona = mPersona2[1];
  if (mContrato) v._id_contrato = mContrato[1];

  return v;
}

// ══════════════════════════════════════════════════════════════
// CONSULTA ADICIONAL — Propietario y puntos por id_persona
// ══════════════════════════════════════════════════════════════

/**
 * Hace una segunda petición a clp_grid_puntos.jsp para obtener
 * nombre del propietario y saldo de puntos cuando consultamos por placa.
 * No es crítica — si falla se retorna el vehículo sin propietario.
 */
async function consultarPropietario(client, idPersona) {
  try {
    const res = await client.get(`${BASE}/clp_grid_puntos.jsp`, {
      params: { ps_id_persona: idPersona },
      responseType: 'arraybuffer',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    const $p = cheerio.load(dec(res.data));

    const propietario = {};

    // Nombre — primer td.titulo1
    const nombre = $p('td.titulo1').first().text().replace(/\s+/g, ' ').trim();
    if (nombre) propietario.nombre = nombre;

    // Puntos — td.titulo1 con solo dígitos
    $p('td.titulo1').each((_, td) => {
      const txt = $p(td).text().replace(/\s+/g, ' ').trim();
      if (/^\d+$/.test(txt)) propietario.puntos = txt;
    });

    // Cédula — td.MarcoTitulo "CED - XXXXXXXXXX"
    $p('td.MarcoTitulo').each((_, td) => {
      const txt = $p(td).text().replace(/[\s\u00A0]+/g, ' ').trim();
      const m = txt.match(/(?:CED|RUC|PAS)\s*[-\u2013]\s*(\w+)/i);
      if (m) propietario.cedula = m[1];
    });

    return propietario;
  } catch (err) {
    console.warn('[ANT API] No se pudo obtener propietario:', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// GET /api/consulta
// ══════════════════════════════════════════════════════════════

/**
 * Parámetros:
 *   identificacion  → cédula / RUC / pasaporte / placa
 *   tipo            → CED (default) | RUC | PAS | PLA
 *
 * Ejemplos:
 *   /api/consulta?identificacion=1712345678&tipo=CED
 *   /api/consulta?identificacion=GTO8639&tipo=PLA
 */
app.get('/api/consulta', async (req, res) => {
  const { identificacion, tipo = 'CED' } = req.query;

  if (!identificacion) {
    return res.status(400).json({
      success: false,
      error  : 'Parámetro identificacion requerido'
    });
  }

  const tipos = {
    CED: 'Cedula',
    RUC: 'RUC',
    PAS: 'Pasaporte',
    PLA: 'Placa'
  };

  if (!tipos[tipo]) {
    return res.status(400).json({
      success: false,
      error  : 'Tipo inválido. Usa: CED, RUC, PAS, PLA'
    });
  }

  const client = crearCliente();

  try {

    // ── PASO 1: Obtener JSESSIONID (cookie de sesión Tomcat) ──────
    await client.get(`${BASE}/clp_criterio_consulta.jsp`, {
      responseType: 'arraybuffer',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });

    // ── PASO 2: Validar persona/placa vía AJAX interno ────────────
    // POST clp_json_consulta_persona.jsp
    // Responde: {"mensaje":"OK"} o {"mensaje":"<error>"}
    const valRes = await client.post(
      `${BASE}/clp_json_consulta_persona.jsp`,
      '',
      {
        params: {
          ps_tipo_identificacion: tipo,
          ps_identificacion     : identificacion
        },
        responseType: 'arraybuffer',
        headers: {
          'Content-Type'    : 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer'         : `${BASE}/clp_criterio_consulta.jsp`
        }
      }
    );

    const valText = dec(valRes.data).trim();
    let valJson = {};
    try   { valJson = JSON.parse(valText); }
    catch { valJson = { mensaje: valText }; }

    if (valJson.mensaje !== 'OK') {
      return res.json({
        success: false,
        error  : valJson.mensaje || 'Registro no encontrado'
      });
    }

    // ── PASO 3: Obtener página del grid con todos los datos ───────
    // GET clp_grid_citaciones.jsp?ps_tipo_identificacion=PLA&ps_identificacion=GTO8639&ps_placa=
    const gridRes = await client.get(`${BASE}/clp_grid_citaciones.jsp`, {
      params: {
        ps_tipo_identificacion: tipo,
        ps_identificacion     : identificacion,
        ps_placa              : tipo === 'PLA' ? identificacion : ''
      },
      responseType: 'arraybuffer',
      headers: {
        Accept  : 'text/html,application/xhtml+xml',
        Referer : `${BASE}/clp_criterio_consulta.jsp`
      }
    });

    const gridHtml = dec(gridRes.data);
    const $        = cheerio.load(gridHtml);

    // ── PASO 4: Parsear según tipo de consulta ────────────────────

    if (tipo === 'PLA') {

      // Datos del vehículo
      const vehiculo = parsearVehiculo($);

      // Propietario (segunda petición encadenada, no crítica)
      let propietario = null;
      if (vehiculo._id_persona) {
        propietario = await consultarPropietario(client, vehiculo._id_persona);
      }

      return res.json({
        success      : true,
        tipo_consulta: 'Placa',
        identificacion,
        vehiculo,
        propietario  : propietario || {}
      });

    } else {

      // Datos del conductor
      const persona = parsearPersona($);

      return res.json({
        success      : true,
        tipo_consulta: tipos[tipo],
        identificacion,
        persona
      });
    }

  } catch (err) {
    console.error('[ANT API]', err.message);
    return res.status(500).json({
      success: false,
      error  : err.message,
      hint   : 'Verifica conectividad al servidor ANT o que el identificador sea válido'
    });
  }
});

// ══════════════════════════════════════════════════════════════
// Health check (para Render.com / uptime monitors)
// ══════════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({
  status: 'ok',
  ts    : new Date().toISOString()
}));

// ══════════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => console.log(`ANT Licencias API — Puerto ${PORT}`));

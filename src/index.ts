import express from 'express';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  getDocs,
  limit,
} from 'firebase/firestore';

import {
  restoreSessionFromFirestore,
  syncLocalSessionToFirestore,
  queueSessionSync,
} from './sessionSync.js';

// 1. Configuración de Firebase Firestore (aimre-pos)
const firebaseConfig = {
  apiKey: "AIzaSyA-XWp040IodI4PHP28kbg1sSLBZCYBSgA",
  authDomain: "aimre-pos.firebaseapp.com",
  projectId: "aimre-pos",
  storageBucket: "aimre-pos.firebasestorage.app",
  messagingSenderId: "702473681511",
  appId: "1:702473681511:web:53fe800e42afaa197f32c2"
};

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// 2. Estado de conexión del puente WhatsApp
let currentQrDataUrl: string | null = null;
let connectionState: 'esperando_qr' | 'conectado' | 'desconectado' = 'esperando_qr';
let connectedPhoneNumber: string | null = null;
let sock: WASocket | null = null;

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const app = express();
app.use(express.json());

// Mapeo persistente de contactos
const CONTACTS_FILE = path.resolve('auth_session', 'contacts_map.json');
let contactsMap: Record<string, string> = {};

function saveContactsMap() {
  try {
    if (!fs.existsSync('auth_session')) fs.mkdirSync('auth_session', { recursive: true });
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contactsMap, null, 2), 'utf-8');
    queueSessionSync(db, 'auth_session');
  } catch (e) {}
}

function registerContactMapping(lid?: string | null, phoneOrJid?: string | null) {
  if (!lid || !phoneOrJid) return;
  const cleanLid = lid.split('@')[0].split(':')[0];
  const digits = phoneOrJid.split('@')[0].replace(/\D/g, '');
  if (!digits || !cleanLid) return;

  const cleanPhone = digits.startsWith('521') && digits.length === 13 ? `52${digits.substring(3)}` : digits;
  if (cleanLid !== cleanPhone && cleanLid.length > 8) {
    if (contactsMap[cleanLid] !== cleanPhone) {
      contactsMap[cleanLid] = cleanPhone;
      saveContactsMap();
    }
  }
}

// Sincronizar estado a Firestore para que el POS y Admin lo lean en tiempo real
async function updateFirestoreState(state: 'conectado' | 'esperando_qr' | 'desconectado', phone: string | null) {
  try {
    await setDoc(doc(db, 'config', 'whatsapp_estado'), {
      estado: state,
      telefono: phone || null,
      ultimaActualizacion: serverTimestamp(),
      activo: state === 'conectado'
    }, { merge: true });
    console.log(`📡 [Estado Sincronizado a Firestore] ${state}${phone ? ` (+${phone})` : ''}`);
  } catch (err: any) {
    console.warn('⚠️ No se pudo sincronizar estado en Firestore:', err.message);
  }
}

// Formatear JID de WhatsApp garantizando '521' en números mexicanos o JID válido
function formatWhatsAppJid(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  if (trimmed.endsWith('@g.us') || trimmed.endsWith('@lid')) {
    return trimmed;
  }

  if (trimmed.endsWith('@s.whatsapp.net')) {
    const user = trimmed.split('@')[0].split(':')[0];
    return formatWhatsAppJid(user);
  }

  const digits = trimmed.replace(/\D/g, '');
  const cleanPhone = digits.startsWith('521') && digits.length === 13 ? `52${digits.substring(3)}` : digits;

  // Búsqueda en mapa LID
  const mappedLid = Object.keys(contactsMap).find(lid => contactsMap[lid] === cleanPhone || contactsMap[lid] === digits);
  if (mappedLid) {
    return `${mappedLid}@lid`;
  }

  if (digits.length === 10) {
    return `521${digits}@s.whatsapp.net`;
  }
  if (digits.startsWith('52') && digits.length === 12) {
    return `521${digits.substring(2)}@s.whatsapp.net`;
  }
  if (digits.startsWith('521') && digits.length === 13) {
    return `${digits}@s.whatsapp.net`;
  }
  return `${digits}@s.whatsapp.net`;
}

function normalizePhoneNumber(rawJid: string): string {
  if (rawJid.includes('@g.us')) {
    return rawJid.split('@')[0];
  }
  const digitsOnly = rawJid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (digitsOnly.startsWith('521') && digitsOnly.length === 13) {
    return `52${digitsOnly.substring(3)}`;
  }
  return digitsOnly;
}

// 3. Inicialización del cliente Baileys (Multi-Device)
async function startWhatsAppBridge() {
  await restoreSessionFromFirestore(db, 'auth_session');

  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      contactsMap = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'));
      console.log(`📋 [Contactos] ${Object.keys(contactsMap).length} mapeos de contactos disponibles.`);
    }
  } catch (e) {}

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`📡 Iniciando WhatsApp Multi-Device AIMRE (v${version.join('.')}, isLatest: ${isLatest})...`);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    queueSessionSync(db, 'auth_session');
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      registerContactMapping(c.lid, c.jid || c.id);
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      registerContactMapping(c.lid, c.jid || c.id);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = 'esperando_qr';
      currentQrDataUrl = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
      console.log(`\n📱 [QR Generado] Ábrelo en tu navegador: http://localhost:${PORT}/qr`);
      await updateFirestoreState('esperando_qr', null);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Conexión cerrada. Razón: ${statusCode}. Reconectando: ${shouldReconnect}`);
      connectionState = 'desconectado';
      currentQrDataUrl = null;
      connectedPhoneNumber = null;
      await updateFirestoreState('desconectado', null);

      if (shouldReconnect) {
        setTimeout(startWhatsAppBridge, 3000);
      }
    } else if (connection === 'open') {
      connectionState = 'conectado';
      currentQrDataUrl = null;
      const jid = sock?.user?.id || '';
      connectedPhoneNumber = normalizePhoneNumber(jid);
      console.log(`\n=====================================================`);
      console.log(`🟢 ¡WHATSAPP DE LA TIENDA CONECTADO EXITOSAMENTE!`);
      console.log(`📱 Número: +${connectedPhoneNumber}`);
      console.log(`🏪 Vinculado a Punto de Venta AIMRE`);
      console.log(`=====================================================\n`);

      syncLocalSessionToFirestore(db, 'auth_session');
      await updateFirestoreState('conectado', connectedPhoneNumber);

      // Despachar inmediatamente mensajes encolados mientras estaba desconectado
      setTimeout(() => {
        procesarColaPendiente();
      }, 2000);
    }
  });

  listenOutgoingQueue();
}

let listenerActivo = false;
let procesandoCola = false;

async function despacharItem(docId: string, item: any): Promise<boolean> {
  if (!sock || connectionState !== 'conectado') return false;
  try {
    const targetJid = formatWhatsAppJid(item.jid || item.telefono || '');
    console.log(`📤 [Enviando WhatsApp] Hacia ${targetJid} (Doc: ${docId})...`);
    await sock.sendMessage(targetJid, { text: item.texto });

    await updateDoc(doc(db, 'cola_salida_whatsapp', docId), {
      estado: 'enviado',
      fechaEnvio: serverTimestamp(),
    });
    console.log(`✅ [Enviado exitosamente a WhatsApp] Doc: ${docId}`);
    return true;
  } catch (err: any) {
    console.error(`❌ [Error enviando a WhatsApp con primary JID]:`, err.message);
    try {
      const digits = (item.telefono || '').replace(/\D/g, '');
      const altJid = digits.length === 10
        ? `521${digits}@s.whatsapp.net`
        : (digits.startsWith('52') && digits.length === 12
          ? `521${digits.substring(2)}@s.whatsapp.net`
          : `${digits}@s.whatsapp.net`);

      console.log(`🔄 [Reintentando con fallback JID]: ${altJid}...`);
      await sock.sendMessage(altJid, { text: item.texto });

      await updateDoc(doc(db, 'cola_salida_whatsapp', docId), {
        estado: 'enviado',
        fechaEnvio: serverTimestamp(),
        nota: `Enviado con fallback ${altJid}`
      });
      console.log(`✅ [Fallback exitoso a WhatsApp] Doc: ${docId}`);
      return true;
    } catch (err2: any) {
      console.error(`❌ [Fallback también falló]:`, err2.message);
      await updateDoc(doc(db, 'cola_salida_whatsapp', docId), {
        estado: 'error',
        error: err.message,
      });
      return false;
    }
  }
}

export async function procesarColaPendiente() {
  if (procesandoCola) return;
  if (!sock || connectionState !== 'conectado') return;

  procesandoCola = true;
  try {
    const q = query(
      collection(db, 'cola_salida_whatsapp'),
      where('estado', '==', 'pendiente'),
      limit(25)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      console.log(`📬 [Cola Salida] Despachando ${snap.size} mensaje(s) pendiente(s)...`);
      for (const docSnap of snap.docs) {
        if (!sock || connectionState !== 'conectado') break;
        await despacharItem(docSnap.id, docSnap.data());
      }
    }
  } catch (e: any) {
    console.error('⚠️ [Cola] Error al procesar mensajes pendientes:', e?.message || e);
  } finally {
    procesandoCola = false;
  }
}

// 4. Escuchar cola de salida de mensajes en Firestore
function listenOutgoingQueue() {
  if (listenerActivo) return;
  listenerActivo = true;

  console.log(`📬 [Cola Salida] Escuchando colección "cola_salida_whatsapp"...`);

  const q = query(
    collection(db, 'cola_salida_whatsapp'),
    where('estado', '==', 'pendiente'),
    limit(25)
  );

  onSnapshot(q, async (snapshot) => {
    if (snapshot.empty) return;
    if (!sock || connectionState !== 'conectado') {
      console.log(`⏳ [Cola Salida] ${snapshot.size} mensaje(s) pendiente(s). Esperando conexión de WhatsApp...`);
      return;
    }
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added' || change.type === 'modified') {
        const item = change.doc.data();
        if (item.estado === 'pendiente') {
          await despacharItem(change.doc.id, item);
        }
      }
    }
  }, (err) => {
    console.error('❌ Error en el listener de cola_salida_whatsapp:', err.message);
    listenerActivo = false;
    setTimeout(listenOutgoingQueue, 5000);
  });

  // Barrido periódico cada 30 segundos
  setInterval(() => {
    if (sock && connectionState === 'conectado') {
      procesarColaPendiente();
    }
  }, 30000);
}

// 5. Interfaz Web para escanear el QR
app.get('/qr', (_req, res) => {
  const isConnected = connectionState === 'conectado';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Vincular WhatsApp de la Tienda — AIMRE POS</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #1e293b;
      border-radius: 20px;
      padding: 36px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      border: 1px solid #334155;
    }
    .badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .badge-waiting { background: #fef08a; color: #854d0e; }
    .badge-connected { background: #bbf7d0; color: #166534; font-size: 15px; }
    h1 { font-size: 22px; margin: 0 0 10px 0; color: #f8fafc; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin: 0 0 24px 0; }
    .qr-box {
      background: #fff;
      padding: 16px;
      border-radius: 16px;
      display: inline-block;
      border: 2px dashed #64748b;
      margin-bottom: 24px;
    }
    .qr-box img { display: block; max-width: 260px; height: auto; }
    .steps {
      text-align: left;
      background: #0f172a;
      border-radius: 12px;
      padding: 16px 20px;
      font-size: 13px;
      color: #cbd5e1;
      line-height: 1.6;
      border: 1px solid #334155;
    }
    .steps ol { margin: 0; padding-left: 20px; }
    .success-box {
      padding: 30px 10px;
    }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
  </style>
  ${!isConnected ? '<script>setTimeout(() => { location.reload(); }, 4000);</script>' : ''}
</head>
<body>
  <div class="card">
    ${
      isConnected
        ? `
      <div class="badge badge-connected">🟢 Conexión Activa</div>
      <div class="success-box">
        <div class="success-icon">🏪</div>
        <h1>¡WhatsApp de la Tienda Conectado!</h1>
        <p>Número enlazado: <strong>+${connectedPhoneNumber || ''}</strong></p>
        <p style="color: #4ade80; font-size: 13px;">Los reportes diarios y tickets se enviarán automáticamente en segundo plano desde este número.</p>
      </div>
    `
        : `
      <div class="badge badge-waiting">⏳ Esperando Escaneo</div>
      <h1>Vincular WhatsApp de la Tienda</h1>
      <p>Escanea este código QR desde el celular de la tienda para conectar el Punto de Venta AIMRE:</p>
      
      <div class="qr-box">
        ${
          currentQrDataUrl
            ? `<img src="${currentQrDataUrl}" alt="Código QR WhatsApp" />`
            : `<div style="padding: 40px 20px; color: #888;">Generando código QR...</div>`
        }
      </div>

      <div class="steps">
        <strong>Instrucciones:</strong>
        <ol>
          <li>Abre WhatsApp en el celular de la tienda.</li>
          <li>Toca en <strong>Ajustes / Menú (los 3 puntos)</strong>.</li>
          <li>Selecciona <strong>Dispositivos vinculados</strong>.</li>
          <li>Toca en <strong>Vincular un dispositivo</strong> y apunta con la cámara aquí.</li>
        </ol>
      </div>
    `
    }
  </div>
</body>
</html>
  `;

  res.send(html);
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'whatsapp-aimre-bridge',
    connection: connectionState,
    phone: connectedPhoneNumber,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (_req, res) => {
  res.redirect('/qr');
});

// Mecanismo Keep-Alive automático para plataformas gratuitas
const PING_URL = process.env.PING_URL || process.env.RENDER_EXTERNAL_URL;
if (PING_URL) {
  console.log(`⏱️ Keep-alive activado para ${PING_URL} cada 9 minutos.`);
  setInterval(async () => {
    try {
      const pingEndpoint = PING_URL.endsWith('/health') ? PING_URL : `${PING_URL}/health`;
      await fetch(pingEndpoint);
      console.log(`🏓 [Keep-alive] Ping exitoso a ${pingEndpoint}`);
    } catch (e: any) {
      console.warn(`⚠️ [Keep-alive] Error ping:`, e.message);
    }
  }, 9 * 60 * 1000);
}

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`\n=====================================================`);
  console.log(`🚀 Servidor Puente WhatsApp AIMRE iniciado en puerto ${PORT}`);
  console.log(`👉 Abre en tu navegador para ver estado/QR:`);
  console.log(`   http://localhost:${PORT}/qr`);
  console.log(`=====================================================\n`);
  startWhatsAppBridge();
});

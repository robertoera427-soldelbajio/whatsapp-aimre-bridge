import fs from 'fs';
import path from 'path';
import {
  Firestore,
  collection,
  getDocs,
  doc,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore';

const COLLECTION_NAME = 'whatsapp_bridge_auth';

// Caché en memoria para evitar escribir archivos sin cambios
const fileModCache = new Map<string, number>();

/**
 * Restaura todos los archivos de sesión desde Firestore a la carpeta local (ej: auth_session)
 */
export async function restoreSessionFromFirestore(db: Firestore, sessionDir: string): Promise<boolean> {
  try {
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    console.log('🔄 [Firestore Sync] Verificando sesión remota en Firestore...');
    const snapshot = await getDocs(collection(db, COLLECTION_NAME));

    if (snapshot.empty) {
      console.log('ℹ️ [Firestore Sync] No se encontró sesión previa en Firestore.');
      return false;
    }

    let restoredCount = 0;
    for (const docSnap of snapshot.docs) {
      const docId = docSnap.id;
      const data = docSnap.data();

      // Decodificar el nombre de archivo
      const filename = decodeURIComponent(docId);
      const filePath = path.join(sessionDir, filename);

      if (data.content && typeof data.content === 'string') {
        fs.writeFileSync(filePath, data.content, 'utf-8');
        restoredCount++;
      }
    }

    console.log(`✅ [Firestore Sync] Sesión restaurada con éxito: ${restoredCount} archivos recuperados.`);
    return restoredCount > 0;
  } catch (error: any) {
    console.error('❌ [Firestore Sync] Error al restaurar sesión de Firestore:', error.message);
    return false;
  }
}

/**
 * Sube a Firestore solo los archivos que hayan cambiado o sean nuevos
 */
export async function syncLocalSessionToFirestore(db: Firestore, sessionDir: string): Promise<void> {
  try {
    if (!fs.existsSync(sessionDir)) return;

    const files = fs.readdirSync(sessionDir);
    let uploadedCount = 0;

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const lastModified = stat.mtimeMs;
      const cachedTime = fileModCache.get(file);

      // Si no ha cambiado, no gastar cuota de Firestore
      if (cachedTime && cachedTime >= lastModified) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const docId = encodeURIComponent(file);

        await setDoc(doc(db, COLLECTION_NAME, docId), {
          content,
          size: stat.size,
          updatedAt: serverTimestamp(),
        });

        fileModCache.set(file, lastModified);
        uploadedCount++;
      } catch (err: any) {
        // Ignorar errores individuales temporales
      }
    }

    if (uploadedCount > 0) {
      console.log(`☁️ [Firestore Sync] ${uploadedCount} archivos de sesión actualizados en Firestore.`);
    }
  } catch (error: any) {
    console.error('❌ [Firestore Sync] Error al respaldar sesión en Firestore:', error.message);
  }
}

let syncTimeout: NodeJS.Timeout | null = null;

/**
 * Dispara una sincronización diferida (debounce de 4 segundos) para agrupar múltiples cambios de claves
 */
export function queueSessionSync(db: Firestore, sessionDir: string) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    syncLocalSessionToFirestore(db, sessionDir);
  }, 4000);
}

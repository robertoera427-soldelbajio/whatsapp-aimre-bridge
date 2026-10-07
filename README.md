# 🏪 WhatsApp Real Bridge — Punto de Venta AIMRE

Servidor puente en tiempo real para conectar WhatsApp Multi-Device con el Punto de Venta AIMRE (`aimre-pos`) mediante Firebase Firestore.

## Características
- **Multi-Device Oficial:** Conexión nativa con Baileys vía QR.
- **Reportes Diarios Automáticos:** Envía el resumen y corte del día a las 22:00 hrs directamente al WhatsApp del dueño/gerente.
- **Envío de Tickets en Segundo Plano:** Los tickets de venta y comprobantes de abono se envían al cliente sin abrir ventanas de WhatsApp Web en la laptop de la tienda.
- **Persistencia en la Nube:** Las credenciales de sesión se respaldan automáticamente en Firestore (`whatsapp_bridge_auth`), permitiendo reiniciar el servicio sin perder la vinculación.
- **Keep-Alive 24/7:** Endpoint `/health` para mantener el servicio activo en plataformas gratuitas (Render / Koyeb).

## Despliegue en la Nube Gratuito (Render.com)

1. Crear repositorio en GitHub con esta carpeta (`whatsapp-aimre-bridge`).
2. Conectar el repositorio a [Render.com](https://dashboard.render.com).
3. Seleccionar **New Web Service** -> Repositorio `whatsapp-aimre-bridge`.
4. Configuración:
   - **Environment:** `Node`
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Agregar variable de entorno opcional:
   - `PING_URL`: La URL pública asignada por Render (ej: `https://whatsapp-aimre-bridge.onrender.com`), para mantenerlo despierto las 24 horas.
6. Abrir la URL `/qr` en tu navegador, escanear el código QR con el WhatsApp de la tienda y ¡listo!

# Escúchame

PWA de llamadas de voz de apoyo entre personas anónimas. Tocás **Llamar** y te conecta con alguien disponible en ese horario que hable un idioma en común.

## Qué incluye
- **Emparejamiento** por horario (con zona horaria, sirve para llamadas internacionales) e **idioma en común**. Reparte las llamadas con equidad.
- **Llamada de voz** directa entre ambos (WebRTC). No se graba nada. Silenciar, cortar, pantalla siempre encendida.
- **TURN**: el audio funciona aunque las redes bloqueen la conexión directa (datos móviles, wifis de empresas).
- **Notificaciones push**: suena aunque la app esté cerrada (solo dentro del horario elegido).
- **Reconexión**: si se corta internet en plena llamada, tienen 20 s para volver sin que se corte.
- **Seguridad y moderación**: solo +18, bloquear/reportar (también después de la llamada), suspensión automática con reportes de 3 personas distintas en 7 días, panel `/admin`, límites de uso, cabeceras de seguridad, solo acepta conexiones de la propia página.
- **Privacidad**: términos y privacidad en `/legal.html`, desbloquear a todas las personas, "Borrar mis datos", perfiles inactivos se borran a los 90 días.
- **Instalable** como app (Android: "Instalar app"; iPhone: Compartir → Añadir a pantalla de inicio).

## Variables de entorno (Render → tu servicio → Environment)
Ninguna es obligatoria para que funcione; cada una activa una mejora.

| Variable | Para qué sirve |
|---|---|
| `ADMIN_KEY` | Clave larga que inventás para entrar al panel `https://TU-APP.onrender.com/admin` |
| `DATABASE_URL` | Base Postgres. **Necesaria para que las notificaciones y los bloqueos/suspensiones sobrevivan a reinicios** (el disco de Render gratis se borra) |
| `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` | TURN de Cloudflare (credenciales temporales automáticas) |
| `METERED_APP` + `METERED_API_KEY` | Alternativa: TURN de Metered / Open Relay |
| `ICE_SERVERS` | Alternativa manual (JSON con el array `iceServers`) |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT` | Activan las notificaciones push |
| `BAN_THRESHOLD` | Reportes de personas distintas para suspender (por defecto 3) |

## Puesta en marcha paso a paso

### 1. Subir los cambios a GitHub
En tu repo `escuchame`: **Add file → Upload files**, arrastrá el contenido de la carpeta (reemplaza los archivos anteriores; incluí las carpetas `public`, `lib`, `admin`, `scripts`, `test`) y **Commit changes**. Render se actualiza solo.

### 2. Base de datos gratis (para push, bloqueos y suspensiones)
1. Creá una cuenta en **neon.tech** y un proyecto nuevo.
2. Copiá la *connection string* (empieza con `postgresql://`).
3. En Render → Environment → agregá `DATABASE_URL` con ese valor.
(La base gratis de Render vence a los 30 días; Neon o Supabase no. Con Supabase usá la cadena del *Session pooler*.) La app crea las tablas sola.

### 3. TURN (para que el audio funcione en cualquier red)
1. Cuenta gratis en **cloudflare.com** → *Realtime* → *TURN Server* → **Create**.
2. Copiá el **Turn Token ID** y el **API Token**.
3. En Render agregá `CF_TURN_KEY_ID` (el ID) y `CF_TURN_API_TOKEN` (el token).

### 4. Notificaciones push
1. En Render agregá `ADMIN_KEY` (una clave larga) y esperá el redeploy.
2. Entrá a `https://TU-APP.onrender.com/admin`, escribí la clave y tocá **Generar claves**.
3. Copiá las tres líneas en Render → Environment (en `VAPID_SUBJECT` poné tu correo después de `mailto:`). **No las cambies después**: si cambian, hay que reactivar las notificaciones en cada celular.
4. En cada celular: Ajustes ⚙️ → *Avisarme cuando alguien quiera hablar*. En iPhone primero hay que instalar la app en la pantalla de inicio.

### 5. Probar
Dos celulares, dos alias, "Cualquier hora del día". Probá también con datos móviles en uno y wifi en otro (eso comprueba el TURN) y con la app cerrada en uno (eso comprueba las notificaciones).

El arranque del servidor imprime una línea con lo que está activo: `Datos: postgres | TURN: cloudflare | Push: activado | Admin: activado`. Podés verla en Render → Logs.

## Moderación
- `/admin` muestra conectados, disponibles, suspendidos y los últimos reportes; permite suspender y reactivar.
- Ojo: tres reportes falsos podrían suspender a alguien. Revisá el panel seguido y reactivá si hace falta.

## Probar en tu compu
    npm install
    npm start                  # http://localhost:3000
    npm test                   # servidor (horarios, idiomas, push, reconexión, reportes, admin...) y TURN
    DATABASE_URL=... npm run test:pg
    python3 test/e2e.py        # Chrome con micrófono falso (requiere playwright)

## Antes de abrirla al público
- Pedí que un profesional legal de tu país revise `public/legal.html`.
- Con muchos usuarios simultáneos: el emparejamiento vive en la memoria de **una sola instancia** (para escalar a varias hay que sumar Redis).
- El plan gratis de Render se duerme tras 15 minutos sin uso: la primera visita tarda ~1 minuto, y mientras duerme nadie puede recibir llamadas por la app abierta. Con notificaciones activadas se despierta cuando alguien llama, pero conviene un plan pago para un servicio de apoyo emocional.
- Es apoyo entre personas, no terapia: mantené visibles los avisos y la ayuda urgente.

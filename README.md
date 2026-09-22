# Puente GLPI ⇄ Slack

Los usuarios no leen los correos de GLPI. Este puente lleva cada respuesta del técnico a un
canal privado de Slack, devuelve a GLPI lo que el usuario conteste allí, y hace desaparecer
la conversación cuando el ticket se resuelve.

```
                  ┌──────────────────────────┐
   sondeo 30 s    │                          │  Socket Mode (WebSocket saliente)
 ┌───────────────►│   glpi-slack-bridge      │◄──────────────────────────┐
 │  REST apirest  │   (Node.js + SQLite)     │   Slack Events API        │
 │                │                          │                           │
┌┴──────────┐     │  · cursor temporal       │                     ┌─────┴─────┐
│   GLPI    │◄────┤  · mapa ticket↔canal     ├────────────────────►│   Slack   │
│ (on-prem) │ POST│  · idempotencia          │  chat.postMessage   │           │
└───────────┘ f/u │  · anti-bucle            │  conversations.*    └───────────┘
                  └──────────────────────────┘
```

**Qué hace, en concreto:**

| Evento en GLPI | Qué ocurre en Slack |
|---|---|
| Se crea un ticket | Se abre un canal privado con el solicitante y se publica su solicitud |
| El técnico añade un seguimiento | Llega al canal, con sus adjuntos |
| El técnico edita un seguimiento | Se reescribe el mensaje, marcado como editado |
| El ticket se resuelve o cierra | Se publica la solución y el canal desaparece del Slack del usuario |

| Evento en Slack | Qué ocurre en GLPI |
|---|---|
| El usuario escribe en el canal | Se añade como seguimiento del ticket |
| El usuario edita su mensaje | Se reescribe ese seguimiento |
| El usuario sube un archivo | Se adjunta al ticket como documento |
| El usuario escribe tras el cierre | El ticket se reabre y se avisa al técnico por mensaje directo |

**Regla de oro:** en el primer arranque el cursor se fija en ese instante. Nada anterior —ni
tickets históricos ni el historial de los que están abiertos— se procesa jamás.

---

## 0. Arranque rápido

Dos formas de levantarlo, equivalentes. Elige una.

**En local** (Node ≥ 22.5):

```bash
npm install
cp .env.example .env
./set-secret.sh GLPI_APP_TOKEN     # y los otros tres secretos
npm run check                      # verifica todo sin escribir nada
npm start
```

**En Docker** (no necesita Node instalado):

```bash
cp .env.example .env
./set-secret.sh GLPI_APP_TOKEN     # y los otros tres secretos
docker compose run --rm glpi-slack-bridge node src/tools/preflight.js
docker compose up -d
```

En los dos casos hay que rellenar antes el `.env`: las **secciones 2, 3 y 4** explican de dónde
sale cada valor. Sin credenciales válidas, `npm run check` te dirá exactamente qué falta.

---

## 1. Requisitos

- **Node.js ≥ 22.5** (usa el módulo `node:sqlite` integrado: cero dependencias nativas que
  compilar). En Node 22 hay que añadir `--experimental-sqlite`; en Node 24 no hace falta.
  Como alternativa, Docker.
- **GLPI 9.5 o superior** con la API REST activable, y permiso para crear un usuario de
  servicio con perfil de técnico.
- **Slack**: permiso para crear e instalar una app en el workspace. No hace falta ser
  administrador salvo que el workspace restrinja la instalación de apps.
- **Red**: el puente necesita salida hacia GLPI y hacia Slack. **No hace falta abrir ningún
  puerto entrante**, ni exponer nada a internet, ni certificados.

---

## 2. Credenciales necesarias

Son **seis valores obligatorios**. Cuatro son secretos y dos son números que se leen de la
interfaz de GLPI.

| Variable | Qué es | Dónde se obtiene | Formato |
|---|---|---|---|
| `GLPI_URL` | Raíz de la API REST | GLPI → Configurar → General → API | `https://tu-glpi/apirest.php` |
| `GLPI_APP_TOKEN` 🔒 | Token del cliente API | Misma pantalla → *Añadir cliente API* | 40 alfanuméricos |
| `GLPI_USER_TOKEN` 🔒 | Token del usuario de servicio | Ficha del usuario → *Token de API* | 40 alfanuméricos |
| `GLPI_BRIDGE_USER_ID` | `users_id` del usuario de servicio | URL de su ficha: `user.form.php?id=**896**` | número |
| `GLPI_PROFILE_ID` | Perfil con el que trabaja la sesión | Administración → Perfiles → URL del perfil Técnico | número |
| `SLACK_BOT_TOKEN` 🔒 | Token del bot | Slack app → OAuth & Permissions | `xoxb-…` |
| `SLACK_APP_TOKEN` 🔒 | Token de Socket Mode | Slack app → Basic Information → App-Level Tokens | `xapp-…` |

Opcionales:

| Variable | Para qué | Cuándo hace falta |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Verificar peticiones HTTP | Solo si desactivas Socket Mode |
| `SLACK_ADMIN_TOKEN` 🔒 | Borrar canales de verdad | Solo en Enterprise Grid |

> **Los secretos nunca se escriben a mano en un fichero ni se pegan en un chat.** Usa el script
> incluido, que los pide a ciegas y no deja rastro en el historial del shell:
>
> ```bash
> ./set-secret.sh GLPI_APP_TOKEN
> ```

---

## 3. Configurar GLPI

### 3.1 Activar la API

**Configurar → General → pestaña API**

- *Habilitar la API REST* → **Sí**
- *Habilitar el login con token externo* → **Sí** ← se olvida a menudo, y sin esto no hay sesión
- Anota la **URL de la API REST** → es tu `GLPI_URL`

### 3.2 Crear el cliente API

En la misma pantalla, abajo, **+ Añadir** un cliente API:

- **Nombre**: `Slack Bridge`
- **Activo**: Sí
- **Rango de IPv4**: la IP del servidor donde correrá el puente (recomendado)
- **Token de aplicación**: marca la casilla **Regenerar** ← si no la marcas, el campo se
  queda vacío al guardar

Guarda, vuelve a abrir el cliente y ahí aparece el token → `GLPI_APP_TOKEN`.

### 3.3 Crear la cuenta de servicio

**Administración → Usuarios → + Añadir**

- **Login**: `slack-bridge`
- **Activo**: Sí

Después, en su ficha:

1. Pestaña **Autorizaciones**: asígnale el perfil **Técnico** (o un clon recortado) sobre la
   entidad que corresponda, marcando **Recursivo** si hay subentidades.
2. Pestaña principal → campo **Token de API** → marca **Regenerar** y guarda. Al recargar
   aparece el token → `GLPI_USER_TOKEN`.
3. La URL de la ficha contiene el id: `user.form.php?id=896` → `GLPI_BRIDGE_USER_ID=896`.

> **El perfil tiene que ver *todos* los tickets, no solo los suyos.** Si la cuenta se queda con
> el perfil **Self-Service**, la API devuelve **cero tickets** y el puente no envía nada sin dar
> ningún error. Es el fallo más común de esta instalación.

### 3.4 Fijar el perfil

Una cuenta puede tener varios perfiles, y GLPI abre la sesión con el predeterminado —que suele
ser Self-Service—. Para no depender de eso, el puente lo fija explícitamente:

**Administración → Perfiles → Técnico** → el id está en la URL → `GLPI_PROFILE_ID`.

### 3.5 Permisos del directorio de documentos

Para que los adjuntos que llegan desde Slack se guarden, el directorio de datos de GLPI debe
ser escribible por el usuario del servidor web:

```bash
ls -ld /var/www/glpi/files        # ajusta la ruta a tu instalación
sudo chown -R www-data:www-data /var/www/glpi/files
```

Si alguna carpeta de tipo (`PDF/`, `TXT/`, `XLSX/`…) pertenece a `root`, GLPI **acepta la subida
y no guarda el fichero**: crea un documento de 0 bytes sin avisar. El puente lo detecta y borra
la ficha vacía, pero el arreglo es este.

### 3.6 Comprobar

```bash
curl -s -H "App-Token: TU_APP_TOKEN" \
     -H "Authorization: user_token TU_USER_TOKEN" \
     "https://tu-glpi/apirest.php/initSession"
```

Debe devolver un `session_token`.

---

## 4. Configurar la app de Slack

### 4.1 Crear la app

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Elige el workspace
3. Pega el contenido de [`slack-app-manifest.yml`](slack-app-manifest.yml) — el editor tiene
   pestañas **JSON** y **YAML**: asegúrate de estar en la de YAML
4. **Next** → **Create**

### 4.2 Instalar y obtener los tokens

1. **Install App** → **Install to Workspace** → **Allow**
2. Copia el **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
3. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**
   - Nombre: `socket`
   - Scope: `connections:write`
   - **Generate** → copia el `xapp-…` → `SLACK_APP_TOKEN`

### 4.3 Permisos que pide, y por qué

Todos son **Bot Token Scopes**. Si los añades por error en *User Token Scopes*, la app actuaría
suplantando a una persona y no funcionará.

| Scope | Para qué |
|---|---|
| `chat:write` | Publicar, editar y borrar sus propios mensajes |
| `groups:write` | Crear, invitar, expulsar y archivar canales privados |
| `groups:history` | Recibir los mensajes que escribe el usuario |
| `groups:read` | Listar canales y sus miembros |
| `users:read` | Nombre real del autor de cada respuesta |
| `users:read.email` | **La pieza clave**: traduce el correo de GLPI a un usuario de Slack |
| `reactions:write` | El ✅ de acuse de recibo |
| `files:read` | Descargar los archivos que sube el usuario, para llevarlos a GLPI |
| `files:write` | Subir a Slack los adjuntos de GLPI, y borrarlos al cerrar |
| `im:write`, `im:history`, `im:read` | Solo si usas `CONVERSATION_MODE=dm` |

**La correspondencia de identidades se hace por correo electrónico.** El correo principal del
solicitante en GLPI tiene que ser el mismo que el de su cuenta de Slack. Si no coincide, ese
usuario no recibe nada — y el puente lo registra en el log en vez de reintentarlo en bucle.

---

## 5. Puesta en marcha

```bash
npm install
cp .env.example .env
```

Rellena en `.env` los valores no secretos (`GLPI_URL`, `GLPI_BRIDGE_USER_ID`,
`GLPI_PROFILE_ID`) y mete los cuatro secretos con el script:

```bash
./set-secret.sh GLPI_APP_TOKEN
./set-secret.sh GLPI_USER_TOKEN
./set-secret.sh SLACK_BOT_TOKEN
./set-secret.sh SLACK_APP_TOKEN
```

**Antes de arrancar nada**, con GLPI y Slack simulados:

```bash
npm test
```

Y contra los sistemas reales, sin escribir nada en ninguno:

```bash
npm run check
```

Verifica credenciales, el perfil de GLPI, la visibilidad de tickets, los scopes de Slack y que
los correos de la lista blanca existen en ambos sistemas. **No arranques hasta que dé `Todo listo`.**

Entonces:

```bash
npm start
```

La primera línea del log debe ser `Primera activacion. Cursor fijado en …`.

---

## 6. Rodaje sin afectar a nadie

El sondeo mira **todos** los tickets modificados. Sin protección, el primer técnico que
responda a cualquier ticket le abriría un canal a un usuario real. Dos interruptores:

```bash
ALLOWED_REQUESTER_EMAILS=tu.correo@empresa.com   # lista blanca de solicitantes
DRY_RUN=true                                     # no escribe en Slack ni en GLPI
```

Con la lista blanca puesta, cualquier ticket cuyo solicitante no esté en ella se descarta
entero: ni canal, ni mensaje, ni seguimiento.

Si quieres que el aislamiento lo garantice el propio GLPI y no tu configuración, crea una
**entidad de pruebas** y da al usuario de servicio acceso *solo* a esa entidad: la API deja de
devolver los demás tickets.

Recorrido recomendado: `DRY_RUN=true` unos días → lista blanca contigo → añadir dos o tres
compañeros → vaciar la lista.

---

## 7. Configuración completa

### GLPI

| Variable | Por defecto | Qué hace |
|---|---|---|
| `GLPI_URL` | — | Raíz de `apirest.php`, sin barra final |
| `GLPI_APP_TOKEN` | — | Token del cliente API |
| `GLPI_USER_TOKEN` | — | Token del usuario de servicio |
| `GLPI_BRIDGE_USER_ID` | `0` | Sus seguimientos nunca se reenvían a Slack (anti-bucle) |
| `GLPI_PROFILE_ID` | `0` | Perfil que fija la sesión. Sin esto puede entrar como Self-Service |

### Slack

| Variable | Por defecto | Qué hace |
|---|---|---|
| `SLACK_BOT_TOKEN` | — | Token del bot |
| `SLACK_APP_TOKEN` | — | Socket Mode. Si lo dejas vacío, necesitas `SLACK_SIGNING_SECRET` y un puerto público |
| `SLACK_ADMIN_TOKEN` | vacío | Enterprise Grid: permite el borrado real del canal |

### Conversación

| Variable | Por defecto | Qué hace |
|---|---|---|
| `CONVERSATION_MODE` | `channel` | `channel` (canal privado por ticket) o `dm`. Solo `channel` permite que la conversación desaparezca |
| `CHANNEL_PREFIX` | `ticket-glpi-` | Prefijo del nombre del canal |
| `CHANNEL_INCLUDE_TITLE` | `false` | Añade el título del ticket al nombre |
| `REPLY_MODE` | `inline` | `inline` (escribir en el canal) o `modal` (botón + ventana; no deja ningún mensaje humano en el canal) |
| `MESSAGE_COLORS` | `true` | Barra de color lateral por tipo de mensaje |
| `INVITE_TECHNICIAN` | `false` | Invita también al técnico asignado al canal |
| `HISTORY_MESSAGES` | `3` | Mensajes previos que se resumen al abrir el canal de un ticket que ya existía |

### Cierre y limpieza

| Variable | Por defecto | Qué hace |
|---|---|---|
| `CLEANUP_MODE` | `purge` | `archive`, `purge` (borra mensajes + expulsa + archiva) o `delete` (solo Grid) |
| `CLEANUP_DELAY_MINUTES` | `0` | Margen de gracia antes de limpiar |
| `CLEANUP_DELAY_SECONDS` | vacío | Si está puesto, manda sobre los minutos. Para pruebas |
| `REOPEN_ON_REPLY` | `true` | Si el usuario escribe en el margen de gracia, reabre el ticket |
| `REOPEN_STATUS` | `2` | Estado al que vuelve (2 = en curso, 1 = nuevo) |
| `NOTIFY_TECHNICIAN` | `true` | Avisa por mensaje directo al técnico asignado de las reaperturas |
| `TEAM_CHANNEL` | vacío | Canal del equipo para los avisos sin técnico asignado. El bot debe estar dentro |

### Sondeo y seguridad

| Variable | Por defecto | Qué hace |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `30` | Cada cuánto se consulta GLPI |
| `POLL_OVERLAP_SECONDS` | `60` | Solape del cursor, para absorber desfases de reloj |
| `MAX_CATCHUP_HOURS` | `0` | Si el puente ha estado parado más de esto, no recupera lo acumulado. `0` = sin límite |
| `SWEEP_INTERVAL_MINUTES` | `10` | Cada cuánto se repasan las conversaciones abiertas para detectar tickets eliminados en GLPI. `0` = desactivado |
| `WATCHDOG_MINUTES` | `5` | Si el sondeo deja de progresar durante este tiempo, el proceso se cierra solo para que el supervisor lo reinicie. `0` = desactivado |
| `ALLOWED_REQUESTER_EMAILS` | vacío | Lista blanca de solicitantes. Vacío = todos |
| `DRY_RUN` | `false` | Solo registra en el log lo que haría |
| `ONLY_TICKETS_CREATED_AFTER_ACTIVATION` | `false` | `true` ignora los tickets anteriores a la activación aunque tengan actividad nueva |
| `ENFORCE_PRIVACY` | `true` | Expulsa de los canales a quien entre sin haber sido invitado por el puente |
| `PRIVACY_ALLOWLIST` | vacío | IDs de Slack que pueden entrar siempre |
| `DB_PATH` | `./data/bridge.sqlite` | Ruta de la base de datos |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` o `debug` |
| `PORT` | `3000` | Solo si no usas Socket Mode |

---

## 8. Despliegue en un servidor

No hace falta abrir ningún puerto: con Socket Mode el puente solo abre conexiones **salientes**
hacia Slack y hacia GLPI. Puede vivir detrás de cualquier cortafuegos.

### En Ubuntu, de cero

```bash
# 1. Docker, si no está
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER" && newgrp docker

# 2. El proyecto
git clone https://github.com/PauAguilarYerves/GLPI-Slack.git /opt/glpi-slack-bridge
cd /opt/glpi-slack-bridge

# 3. Configuración
cp .env.example .env
chmod 600 .env
nano .env                          # GLPI_URL, GLPI_BRIDGE_USER_ID, GLPI_PROFILE_ID
./set-secret.sh GLPI_APP_TOKEN     # y los otros tres secretos
./set-secret.sh GLPI_USER_TOKEN
./set-secret.sh SLACK_BOT_TOKEN
./set-secret.sh SLACK_APP_TOKEN

# 4. Verificar antes de arrancar (no escribe nada)
docker compose run --rm glpi-slack-bridge node src/tools/preflight.js

# 5. Arrancar
docker compose up -d
docker compose logs -f
```

El `.env` no entra en la imagen (está en `.dockerignore`); lo lee el contenedor en arranque.
El proyecto se llama siempre `glpi-slack-bridge` aunque la carpeta tenga otro nombre, así que
el volumen de datos es `glpi-slack-bridge_bridge-data`.

**Antes de arrancar en el servidor:**

1. **Llévate `data/bridge.sqlite`** de la máquina donde estuviera corriendo. Ahí viven el
   cursor y el mapa ticket ⇄ canal, y **no está en el repositorio** (`data/` va en
   `.gitignore`). Si arrancas de cero no se reenvía nada antiguo —eso sigue garantizado— pero
   las conversaciones abiertas quedan huérfanas: sus canales ya no se limpiarían al cerrarse
   el ticket y se crearían duplicados.

   Desde la máquina antigua:

   ```bash
   scp data/bridge.sqlite usuario@servidor:/opt/glpi-slack-bridge/data/
   ```

   Y en el servidor, metiéndolo en el volumen:

   ```bash
   docker compose up -d && docker compose stop
   docker run --rm -v glpi-slack-bridge_bridge-data:/d -v "$PWD/data":/src alpine \
     cp /src/bridge.sqlite /d/bridge.sqlite
   docker compose start
   ```

   Si arrancas limpio, cierra antes los canales que tengas abiertos en Slack, o quedarán
   sueltos para siempre.

2. **Cuadra la zona horaria** con la del servidor de GLPI (`TZ` en el compose). La API de GLPI
   devuelve fechas sin offset; si los relojes no coinciden, el cursor se desajusta.

3. **Pon los tiempos de producción**: `CLEANUP_DELAY_MINUTES=1440` y `CLEANUP_DELAY_SECONDS`
   vacío. Considera `MAX_CATCHUP_HOURS=12`.

4. **Haz copia de `bridge.sqlite`** periódicamente. Es el único estado que no se puede
   reconstruir.

**Operación:**

```bash
docker compose logs -f
docker compose run --rm glpi-slack-bridge node src/tools/preflight.js    # verificar
docker compose run --rm glpi-slack-bridge node src/tools/test-alert.js   # probar el canal de alertas
docker compose up -d            # tras cambiar el .env
```

**Cómo se recupera solo de un cuelgue.** El sondeo deja un latido en la base de datos cada vez
que avanza. El **healthcheck** marca el contenedor como `unhealthy` si se enfría, y el
**watchdog** interno cierra el proceso si no hay progreso durante `WATCHDOG_MINUTES`, que es
lo que de verdad lo recupera: `restart: unless-stopped` solo reacciona ante procesos muertos,
nunca ante procesos quietos.

---

## 9. Cómo funciona por dentro

### Por qué sondeo y no webhooks

Los webhooks salientes nativos llegan con **GLPI 11**. En GLPI 10 y anteriores no existen en el
core, y además obligan a exponer un endpoint alcanzable desde el servidor de GLPI. El sondeo
funciona en cualquier versión, sin plugins ni puertos, y convierte el requisito de «nada
retroactivo» en algo trivial: **el cursor es el interruptor de activación**.

Si estás en GLPI 11 y prefieres webhooks, sustituye `src/poller.js` por un endpoint que valide
la firma y llame a las mismas funciones. Deja el sondeo como red de seguridad: un webhook
perdido es un mensaje que el usuario nunca recibe.

### Por qué canal privado y no mensaje directo

**Slack no permite borrar un canal** salvo `admin.conversations.delete`, que solo existe en
Enterprise Grid. Tampoco se puede borrar el historial de un DM. Y **archivar no oculta nada**:
el canal archivado le sigue apareciendo a quien fue miembro.

Lo que sí funciona: **un canal privado del que no eres miembro no existe para ti**. No está en
la barra lateral, ni en archivados, ni en la búsqueda. Por eso `CLEANUP_MODE=purge` borra los
mensajes del bot, **expulsa a los miembros** y archiva, en ese orden —en un canal archivado ya
no se puede expulsar a nadie—.

Límite honesto: un bot solo puede borrar sus propios mensajes. Los del usuario siguen
existiendo en el canal archivado, donde solo un administrador del workspace podría llegar. Con
`REPLY_MODE=modal` no llega a haber mensajes de usuario.

### Estado

Todo en SQLite (`data/bridge.sqlite`):

| Tabla | Para qué |
|---|---|
| `kv` | `cursor`, `activated_at`, `heartbeat` |
| `conversations` | **El vínculo**: `ticket_id` ⇄ `channel_id`, con índice único en ambos |
| `bot_messages`, `bot_files` | Qué publicó el bot, para poder borrarlo al cerrar |
| `followup_messages` | Seguimiento de GLPI ⇄ mensaje de Slack, para reflejar ediciones |
| `outbound_messages` | Mensaje de Slack ⇄ seguimiento de GLPI, para reflejar ediciones |
| `seen_followups` | Idempotencia y anti-bucle |
| `channel_members` | A quién invitó el bot; el resto sobra en el canal |

### Anti-bucle

Sin esto, cada respuesta escrita en GLPI desde Slack vuelve a Slack, que la reescribe en GLPI…
Tres capas:

1. Al crear un seguimiento desde Slack, su `id` se guarda en `seen_followups` con origen
   `slack`. El sondeo nunca lo reenvía.
2. Se descarta todo seguimiento cuyo autor sea `GLPI_BRIDGE_USER_ID`.
3. En Slack se ignora cualquier evento con `bot_id`.

### El cursor

- Primer arranque: `cursor = activated_at = now()`. Nada retroactivo.
- Cada pasada avanza a `inicio − POLL_OVERLAP_SECONDS`. Los duplicados que genere el solape los
  filtra `seen_followups`.
- **Si algún ticket falla, el cursor no avanza.** Los seguimientos nuevos se filtran por fecha
  posterior al cursor, así que moverlo tras un error de red dejaría ese mensaje fuera para
  siempre. Repetir el ciclo es inofensivo.
- Para descartar lo acumulado tras una parada larga: `npm run cursor:reset`.

---

## 10. Resolución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| `npm run check` dice **«la cuenta de servicio no ve NINGÚN ticket»** | La sesión entra con perfil Self-Service | Pon `GLPI_PROFILE_ID` con el id del perfil Técnico |
| **No llega nada a Slack** y el log no da errores | El solicitante no está en `ALLOWED_REQUESTER_EMAILS`, o su correo no coincide entre GLPI y Slack | `npm run check` verifica los correos en ambos sistemas |
| `users_not_found` | El correo de GLPI no existe en Slack | Corrige el correo en uno de los dos |
| `missing_scope` | Falta un permiso en la app | Añádelo en *Bot Token Scopes* y **reinstala** la app |
| `invalid_auth` | Token caducado o mal copiado | `./set-secret.sh SLACK_BOT_TOKEN` |
| `restricted_action` al expulsar | El workspace restringe quitar miembros de canales privados | *Workspace settings → Permissions* |
| **Los adjuntos llegan a GLPI vacíos** (0 bytes) | GLPI no puede escribir en su directorio de documentos | `chown -R www-data:www-data` sobre el directorio `files` |
| `ERROR_GLPI_ADD: Fallo al mover el archivo` | Lo mismo | Igual |
| **Se ven etiquetas `<p>` en los mensajes** | El HTML de GLPI llega escapado y hay que decodificar antes de limpiar | Ya resuelto en `src/format.js`; si reaparece, revisa el orden de `decodeEntities` |
| **Se abren canales de tickets antiguos** | El cursor viene de una parada larga | `npm run cursor:reset`, o `MAX_CATCHUP_HOURS` |
| **El puente parece vivo pero no hace nada** | El sondeo se colgó | `node src/tools/healthcheck.js` lo detecta; en Docker lo marca `unhealthy` |
| `name_taken` al crear un canal | Quedó un canal huérfano de un arranque anterior | El puente lo reutiliza solo; si no, archívalo o renómbralo a mano |

Sube el detalle del log con `LOG_LEVEL=debug`.

---

## 11. Límites conocidos

- **Los mensajes del usuario no se pueden borrar.** Ningún bot puede. `purge` retira el acceso;
  para que no existan, `REPLY_MODE=modal`.
- **`purge` no borra de los servidores de Slack.** Una exportación del workspace seguiría
  incluyendo los mensajes del usuario.
- **Los canales archivados siguen contando** en el workspace aunque nadie los vea. Con volumen
  alto, conviene un barrido manual periódico desde la consola de administración.
- **Autoría en GLPI**: los seguimientos creados por la API se atribuyen a la cuenta de servicio.
  El puente antepone *«Respuesta recibida desde Slack — Nombre Apellido»* al contenido.
- **Una sola instancia.** SQLite y el cursor no están pensados para dos procesos en paralelo.
  Para alta disponibilidad hay que mover el estado a PostgreSQL y añadir un lock.
- **Las notas privadas** (`is_private`) nunca salen a Slack. Es deliberado.
- **Sin cobertura automática de los manejadores de Slack**: `npm test` ejercita el sondeo y el
  ciclo completo con sistemas simulados, pero los eventos de Slack se verifican a mano.

---

## 12. Estructura

```
src/
  index.js       Arranque, manejadores de eventos de Slack (Slack → GLPI)
  poller.js      Ciclo de sondeo de GLPI (GLPI → Slack)
  glpi.js        Cliente de la API REST de GLPI
  slack.js       Conversaciones, bloques de mensaje y limpieza
  store.js       Estado en SQLite
  format.js      Conversión HTML de GLPI ⇄ mrkdwn de Slack
  config.js      Lectura y validación del entorno
  tools/
    preflight.js    npm run check
    healthcheck.js  Sonda para Docker
    reset-cursor.js npm run cursor:reset
test/
  e2e-mock.mjs      Ciclo completo con GLPI y Slack simulados
```

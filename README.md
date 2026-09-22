# Puente GLPI ⇄ Slack

Middleware que lleva las respuestas de los técnicos de GLPI a Slack, devuelve a GLPI lo que
el usuario conteste en Slack, y **hace desaparecer la conversación del cliente del usuario**
cuando el ticket se resuelve.

**Regla de oro:** en el primer arranque el cursor se fija en ese instante. Nada anterior
—ni tickets históricos ni el historial de los tickets abiertos— se procesa jamás.

---

## 1. Arquitectura

```
                  ┌──────────────────────────┐
   sondeo 30 s    │                          │  Socket Mode (WSS saliente)
 ┌───────────────►│   glpi-slack-bridge      │◄──────────────────────────┐
 │  REST apirest  │   (Node.js + SQLite)     │   Slack Events API        │
 │                │                          │                           │
┌┴──────────┐     │  · cursor temporal       │                     ┌─────┴─────┐
│   GLPI    │◄────┤  · mapa ticket↔canal     ├────────────────────►│   Slack   │
│ (on-prem) │ POST│  · idempotencia          │  chat.postMessage   │           │
└───────────┘ f/u │  · anti-bucle            │  conversations.*    └───────────┘
                  └──────────────────────────┘
```

### Por qué sondeo (polling) y no webhooks

Los webhooks salientes **nativos** llegan con **GLPI 11** (Administración → Configuración →
Webhooks: itemtype, evento, URL, secreto compartido y payload con `{{variables}}`). En
**GLPI 10 y anteriores no existen en el core**: harían falta plugins de terceros o un cron
propio. Además, un webhook requiere exponer un endpoint HTTP alcanzable desde el servidor GLPI,
algo que en instalaciones on-premise suele chocar con la red corporativa.

El sondeo de la API REST:

- funciona en **cualquier versión de GLPI** con la API activada,
- no necesita plugins ni abrir puertos entrantes,
- y hace trivial el requisito crítico: **el cursor es el interruptor de activación**.

Si estás en GLPI 11 y prefieres webhooks, el diseño no cambia: sustituye `src/poller.js` por un
endpoint HTTP que valide la firma SHA-256 del secreto y llame a las mismas funciones
(`handleNewFollowups`, `handleClosure`). Mantén de todos modos el sondeo como red de seguridad:
un webhook perdido es un mensaje que el usuario nunca recibe.

### Por qué Socket Mode

Slack necesita alcanzar tu bot para entregarte los eventos. Con **Socket Mode** la conexión la
abre el bridge hacia Slack (WebSocket saliente): cero puertos abiertos, cero certificados, cero
túneles. Si prefieres Request URL clásica, borra `SLACK_APP_TOKEN` del `.env`, pon
`SLACK_SIGNING_SECRET` y publica el puerto 3000 detrás de tu reverse proxy.

### Canal privado por ticket vs Mensaje Directo

| | DM | **Canal privado por ticket (recomendado)** |
|---|---|---|
| Aislar conversaciones | Solo por hilos | Total, un canal por ticket |
| Borrar mensajes del bot | Sí (`chat.delete`) | Sí |
| Borrar mensajes del usuario | **No**, quedan para siempre | No, pero se le retira el acceso |
| Que desaparezca del cliente del usuario | **Imposible** | **Sí** |
| Añadir al técnico | No | Sí |

### Cómo se consigue que el ticket desaparezca del usuario

Dos límites duros de la API de Slack, para que no haya sorpresas:

1. **Un bot solo puede borrar sus propios mensajes.** `chat.delete` con un token de bot no
   toca lo que ha escrito una persona. Borrarlo requeriría un token *de usuario* de cada
   empleado (que tendría que autorizar la app individualmente) o Enterprise Grid.
2. **Un bot no puede borrar un canal.** Solo `admin.conversations.delete`, que exige
   Enterprise Grid y un token de organización.

Y una tercera cosa que suele pillar por sorpresa: **archivar no oculta nada**. Un canal
archivado sigue apareciéndole a quien fue miembro en *Canales → Archivados*, y sus mensajes
siguen saliendo en la búsqueda.

La salida es no intentar borrar lo que no se puede borrar, sino **quitar el acceso**:

> **`CLEANUP_MODE=purge` (por defecto)** — al cerrarse el ticket:
> 1. `chat.delete` de todos los mensajes del bot;
> 2. `conversations.kick` de todos los miembros humanos;
> 3. `conversations.archive` del canal.
>
> Un canal privado del que no eres miembro **no existe para ti**: no está en la barra
> lateral, no está en "canales archivados", no aparece en la búsqueda y no se puede abrir
> por URL. Para el usuario, el ticket y la conversación se han esfumado.

El orden importa: en un canal ya archivado no se puede expulsar a nadie, así que el `kick`
va antes del `archive`. La prueba `npm test` lo verifica explícitamente.

#### Si quieres que además no quede nada *dentro* del canal

Con `purge` el usuario no ve nada, pero sus mensajes siguen existiendo en el canal (un
administrador del workspace podría llegar a ellos, y saldrían en una exportación de datos).
Si necesitas que no quede ni eso, **`REPLY_MODE=modal`**: el mensaje del bot lleva un botón
*Responder* que abre una ventana emergente; el texto viaja directo a GLPI sin publicarse
nunca en Slack. Los avisos de confirmación se envían como mensajes efímeros, que tampoco se
almacenan. Resultado: **todo lo que hay en el canal lo ha escrito el bot, y el bot lo borra
entero**. El coste es un clic extra antes de escribir.

| Lo que quieres | Configuración |
|---|---|
| El usuario no vuelve a ver el ticket | `CLEANUP_MODE=purge` (por defecto) |
| Además, el canal queda literalmente vacío | `CLEANUP_MODE=purge` + `REPLY_MODE=modal` |
| Borrado real del canal (Enterprise Grid) | `CLEANUP_MODE=delete` + `SLACK_ADMIN_TOKEN` |

Un detalle de permisos: si `conversations.kick` devuelve `restricted_action`, tu workspace
limita quién puede retirar miembros de canales privados. Se ajusta en *Settings &
administration → Workspace settings → Permissions*. El bridge lo registra como error
explícito en el log en lugar de fallar en silencio.

## 2. Gestión de estado

Todo vive en SQLite (`data/bridge.sqlite`), tres piezas:

> Con `CLEANUP_DELAY_MINUTES=0` el mensaje de resolución se publica y se borra en la misma
> pasada: el usuario apenas lo verá. Si quieres que lea la solución antes de que desaparezca
> todo, pon 60. El canal desaparece igual, solo que una hora después.

| Tabla | Para qué |
|---|---|
| `kv` | `cursor` (última marca temporal sondeada) y `activated_at` (momento de activación, inmutable) |
| `conversations` | **El vínculo**: `ticket_id` ⇄ `channel_id`, más `slack_user_id`, `root_ts`, `cleanup_at`, `cleaned_at` |
| `bot_messages` | `(channel_id, ts)` de cada mensaje publicado, para poder borrarlos al cerrar |
| `seen_followups` | Idempotencia y anti-bucle |

**El vínculo va en los dos sentidos y con índice único**: `ticket_id` es clave primaria y
`channel_id` tiene índice único. Slack te entrega un evento con `channel`, buscas por
`channel_id` y sabes a qué ticket escribir; GLPI te da un `ticket_id`, buscas por él y sabes
dónde publicar. No hace falta parsear el nombre del canal ni meter metadatos en los mensajes.

### Anti-bucle (el fallo clásico de estas integraciones)

Sin esto, cada respuesta escrita en GLPI desde Slack vuelve a Slack, que la reescribe en GLPI…
Tres defensas, en capas:

1. Al crear un seguimiento desde Slack, GLPI devuelve su `id` → se inserta en `seen_followups`
   con origen `slack`. El sondeo nunca lo reenviará.
2. Se descarta todo seguimiento cuyo `users_id` sea `GLPI_BRIDGE_USER_ID` (la cuenta de servicio).
3. En Slack se ignora cualquier evento con `bot_id` o `subtype`.

### El cursor

- Primer arranque: `cursor = activated_at = now()`. **Nada retroactivo.**
- Cada pasada avanza el cursor a `inicio_de_la_pasada − POLL_OVERLAP_SECONDS` (60 s por defecto)
  para absorber desfases de reloj entre el bridge y GLPI. Los duplicados que genere ese solape
  los filtra `seen_followups`.
- Si el bridge ha estado caído y **no** quieres recuperar lo acumulado: `npm run cursor:reset`.
- Ejecuta el bridge en la **misma zona horaria que el servidor GLPI** (variable `TZ`): la API
  devuelve fechas sin offset.

---

## 3. Configuración de GLPI

1. **Activar la API**: Configurar → General → API.
   - *Habilitar la API REST* → Sí.
   - *Habilitar el login con credenciales / con token externo* → Sí (token externo).
   - Anota la **URL de la API**: `https://tu-glpi/apirest.php`.
2. **Cliente API**: en la misma pantalla, *Añadir cliente API*. Nombre `Slack Bridge`,
   activo, rango de IPs = la del servidor del bridge (recomendado). Guarda el **App-Token**.
3. **Cuenta de servicio**: crea un usuario GLPI, p. ej. `slack-bridge`, con un perfil que
   permita: leer tickets de las entidades implicadas, **añadir seguimientos**, y leer usuarios.
   Asígnale las entidades con herencia recursiva.
4. En la ficha de ese usuario → pestaña principal → **Token de API (user_token)**: genera y copia.
5. Anota su `users_id` (está en la URL de su ficha: `user.form.php?id=**42**`) → `GLPI_BRIDGE_USER_ID`.
6. **Comprueba los IDs de búsqueda** de tu instalación (deberían ser 2/12/19, pero verifícalo):

```bash
curl -s -H "App-Token: $GLPI_APP_TOKEN" -H "Session-Token: $SESSION" \
  "$GLPI_URL/listSearchOptions/Ticket" | head -c 2000
```

Prueba rápida de extremo a extremo:

```bash
curl -s -H "App-Token: TU_APP_TOKEN" -H "Authorization: user_token TU_USER_TOKEN" "https://tu-glpi/apirest.php/initSession"
```

> **Importante sobre la autoría:** los seguimientos creados por la API se atribuyen a la cuenta
> de servicio, no al usuario real. Por eso el bridge antepone *"Respuesta recibida desde Slack —
> Nombre Apellido"* al contenido. Si necesitas autoría real, GLPI exige el `user_token` de cada
> usuario (inviable) o un plugin que permita suplantación.

---

## 4. Configuración de la app de Slack

1. https://api.slack.com/apps → **Create New App** → **From an app manifest** → pega
   [`slack-app-manifest.yml`](slack-app-manifest.yml).
2. **Basic Information → App-Level Tokens** → *Generate Token and Scopes*: nombre `socket`,
   scope `connections:write` → copia el `xapp-…` en `SLACK_APP_TOKEN`.
3. **Install to Workspace** → copia el **Bot User OAuth Token** `xoxb-…` en `SLACK_BOT_TOKEN`.
4. **Socket Mode** e **Interactivity** deben quedar activados (el manifiesto ya lo hace;
   Interactivity solo hace falta para `REPLY_MODE=modal`).
5. Solo si vas a usar `CLEANUP_MODE=delete`: un **Owner de la organización** (Enterprise Grid)
   debe generar un token con `admin.conversations:write` y ponerlo en `SLACK_ADMIN_TOKEN`.

### Scopes y para qué sirve cada uno

| Scope | Uso |
|---|---|
| `chat:write` | `chat.postMessage`, `chat.delete` (el bot solo puede borrar lo suyo) |
| `groups:write` | `conversations.create` / `invite` / **`kick`** / `archive` en canales privados |
| `groups:history` | recibir `message.groups` (las respuestas del usuario) |
| `groups:read` | `conversations.list` y `conversations.members` |
| `im:write`, `im:history`, `im:read` | solo si usas `CONVERSATION_MODE=dm` |
| `users:read.email` | `users.lookupByEmail`: **el puente entre la identidad GLPI y la de Slack** |
| `users:read` | nombre real del autor |
| `reactions:write` | ✅ como acuse de recibo al usuario |

La correspondencia de identidades se hace **por email**: el email principal del solicitante en
GLPI debe coincidir con el de su cuenta de Slack. Si no hay coincidencia, el ticket se registra
como *sin destinatario* y no se reintenta en bucle.

---

## 5. Puesta en marcha

Requiere **Node.js ≥ 22.5** (usa el módulo `node:sqlite` integrado: cero dependencias nativas
que compilar en el servidor). En Node 22 añade `--experimental-sqlite`; en Node 24 no hace falta.

```bash
cd glpi-slack-bridge && npm install && cp .env.example .env
```

Rellena `.env` y arranca:

```bash
npm start
```

## 6. Despliegue en un servidor

No hace falta abrir ningún puerto: con Socket Mode el puente solo abre conexiones
**salientes** hacia Slack y hacia GLPI. Puede vivir detrás de cualquier cortafuegos.

```bash
scp -r glpi-slack-bridge usuario@servidor:/opt/
ssh usuario@servidor 'cd /opt/glpi-slack-bridge && docker compose up -d --build'
```

El `.env` viaja con el proyecto y no se copia a la imagen (está en `.dockerignore`):
lo lee el contenedor en arranque a través de `env_file`.

### Antes de arrancar en el servidor

1. **Llévate `data/bridge.sqlite`** de la máquina donde estaba corriendo. Ahí viven el
   cursor y el mapa ticket ⇄ canal. Si arrancas de cero, el puente no reenvía nada antiguo
   —eso está garantizado— pero deja huérfanas las conversaciones que estuvieran abiertas:
   sus canales ya no se limpiarían al cerrarse el ticket, y se crearían duplicados.

   ```bash
   docker compose up -d                      # crea el volumen
   docker compose stop
   docker run --rm -v glpi-slack-bridge_bridge-data:/d -v "$PWD/data":/src alpine \
     cp /src/bridge.sqlite /d/bridge.sqlite
   docker compose start
   ```

2. **Cuadra la zona horaria** con la del servidor de GLPI (`TZ` en el compose). La API de
   GLPI devuelve fechas sin offset; si los relojes no coinciden, el cursor se desajusta y
   se pierden o se repiten eventos.

3. **Pon los tiempos de producción** en el `.env`: `CLEANUP_DELAY_MINUTES=1440` y
   `CLEANUP_DELAY_SECONDS` vacío. Los 30 segundos son solo para probar.

### Operación

```bash
docker compose logs -f                        # seguir el log
docker compose exec glpi-slack-bridge node src/tools/preflight.js   # comprobar credenciales
docker compose restart                        # tras cambiar el .env
```

El contenedor lleva un **healthcheck**: el sondeo deja un latido en la base de datos en cada
ciclo y, si deja de latir más de tres ciclos, Docker marca el contenedor como `unhealthy`.
Con `restart: unless-stopped` se levanta solo si el proceso muere; para que además se
reinicie cuando se queda colgado sin morir, añade un supervisor tipo `autoheal` o revisa
`docker compose ps` en tu monitorización.

Los logs rotan a 3 ficheros de 10 MB, así que no llenan el disco.

Antes de tocar nada real, la prueba con GLPI y Slack simulados:

```bash
npm test
```

Y con tus credenciales ya puestas, la comprobación previa — verifica tokens, permisos del
perfil de GLPI, `GLPI_BRIDGE_USER_ID`, scopes de Slack y que los emails de la lista blanca
existen en Slack, **sin escribir nada en ningún sitio**:

```bash
npm run check
```

Cubre las cinco cosas que se rompen en producción: alta de la conversación, entrega del
seguimiento, idempotencia, anti-bucle y limpieza al cerrar.

### Pilotar sin afectar a nadie

El sondeo mira **todos** los tickets modificados, así que sin protección el primer técnico que
responda a cualquier ticket le abriría un canal a un usuario real. Dos interruptores:

```bash
ALLOWED_REQUESTER_EMAILS=tu.email@empresa.com   # lista blanca de solicitantes
DRY_RUN=true                                    # no escribe en Slack ni en GLPI
```

Con la lista blanca puesta, cualquier ticket cuyo solicitante no esté en ella se descarta
entero: ni canal, ni mensaje, ni seguimiento. Es un filtro en el puente, no en GLPI.

Si quieres que el aislamiento lo garantice el propio GLPI y no tu configuración, lo sólido es
crear una **entidad de pruebas** y dar a la cuenta de servicio acceso *solo* a esa entidad: la
API deja de devolver los demás tickets, y ningún error de configuración del bridge puede
alcanzarlos.

Recorrido sugerido: `DRY_RUN=true` unos días contra producción para ver en el log qué habría
enviado → lista blanca con tu email para probar el ciclo completo de verdad → añadir dos o tres
compañeros → vaciar la lista.

Prueba de aceptación contra los sistemas reales:

1. Arranca el bridge y confirma en el log `Primera activacion. Cursor fijado en …`.
2. Abre un ticket de prueba en GLPI con un usuario cuyo email exista en Slack.
3. Responde como técnico → debe aparecer el canal privado `tkt-000123` con el texto exacto.
4. Contesta en Slack → debe aparecer como seguimiento en GLPI, con ✅ en tu mensaje.
5. Resuelve el ticket → mensaje de cierre, borrado de los mensajes del bot, expulsión y
   archivado. **Comprueba desde la cuenta del usuario que el canal ya no aparece** ni en la
   barra lateral, ni en *Canales → Archivados*, ni en la búsqueda.
6. Comprueba que **ningún** ticket antiguo generó canal.

---

## 7. Límites conocidos y siguientes pasos

- **Adjuntos**: no se sincronizan en ninguna dirección. Añadir `files:read` + `GET /Document`
  y subida con `files.uploadV2` / `POST /Document`.
- **Rate limits de Slack**: `conversations.create` es Tier 2 (~20/min). Con picos de tickets,
  encola las creaciones.
- **Número de canales**: los canales archivados siguen contando en el workspace aunque el
  usuario no los vea. Si generas cientos al mes, valora el borrado real en Enterprise Grid.
- **Retención y exportaciones**: `purge` retira el acceso, no borra de los servidores de
  Slack. Una exportación de datos del workspace (o el modo Discovery en Grid) seguiría
  incluyendo los mensajes del usuario. Con `REPLY_MODE=modal` no hay mensajes de usuario que
  exportar.
- **Alta disponibilidad**: una sola instancia. SQLite y el cursor no están pensados para dos
  procesos en paralelo; si necesitas HA, mueve el estado a PostgreSQL y añade un lock.
- **Notas privadas**: los seguimientos con `is_private = 1` nunca salen a Slack (deliberado).
- **Reapertura**: si un ticket cerrado se reabre, el bridge crea un canal nuevo (el anterior
  queda archivado). Si prefieres desarchivar, `ensureConversation` ya contempla `unarchive`.

Fuentes: [Webhooks en GLPI](https://help.glpi-project.org/documentation/modules/configuration/webhook.md) ·
[Foro GLPI — llamadas a APIs externas](https://forum.glpi-project.org/viewtopic.php?id=288646)

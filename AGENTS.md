# Instrucciones para agentes

Guía para un asistente de IA que tenga que poner en marcha, modificar o diagnosticar este
proyecto. El [README](README.md) es la referencia completa; esto es lo mínimo operativo.

## Qué es

Puente bidireccional entre GLPI (gestor de tickets) y Slack. Sondea la API REST de GLPI cada 30
segundos y usa Socket Mode para Slack. Node.js, sin framework, estado en SQLite (`node:sqlite`,
sin dependencias nativas).

## Reglas que no se saltan

1. **No manejes tokens.** No los pidas por chat, no los escribas en ficheros, no los leas de
   `.env` para mostrarlos. Para guardarlos existe `./set-secret.sh NOMBRE_VARIABLE`, que los
   pide a ciegas. Si alguien te pega un token, dile que lo regenere.
2. **Nunca commitees `.env` ni `data/`.** Ya están en `.gitignore`; no lo toques.
3. **`npm run check` antes de arrancar.** No lances `npm start` sin que dé `Todo listo`: un
   arranque con la configuración mal deja conversaciones huérfanas en Slack.
4. **`ALLOWED_REQUESTER_EMAILS` es el freno de mano.** Mientras tenga valores, el puente solo
   actúa sobre tickets de esos solicitantes. No lo vacíes sin que te lo pidan explícitamente.
5. **No borres `data/bridge.sqlite`.** Contiene el cursor y el mapa ticket ⇄ canal. Borrarlo no
   reenvía nada antiguo, pero deja huérfanas todas las conversaciones abiertas.

## Puesta en marcha

```bash
npm install
cp .env.example .env
# Rellenar GLPI_URL, GLPI_BRIDGE_USER_ID, GLPI_PROFILE_ID a mano.
# Los cuatro secretos, con: ./set-secret.sh NOMBRE
npm test        # sistemas simulados, no toca nada real
npm run check   # credenciales reales, solo lectura
npm start
```

En Docker es lo mismo cambiando los dos últimos por `docker compose up -d --build`.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm test` | Ciclo completo con GLPI y Slack simulados. Rápido, sin red |
| `npm run check` | Verifica credenciales, permisos y correspondencia de correos. No escribe |
| `npm start` | Arranca el puente |
| `npm run cursor:reset` | Fija el cursor en «ahora»: descarta lo acumulado durante una parada |
| `npm run alert:test` | Manda un aviso de prueba al canal de alertas |

## Dónde tocar cada cosa

| Quieres cambiar… | Fichero |
|---|---|
| Qué se publica y cómo se ve en Slack | `src/slack.js` (funciones `*Blocks`) |
| Cuándo se publica, el ciclo de sondeo | `src/poller.js` |
| Reacción a lo que ocurre en Slack | `src/index.js` |
| Llamadas a la API de GLPI | `src/glpi.js` |
| Conversión HTML ⇄ mrkdwn | `src/format.js` |
| Esquema de estado | `src/store.js` |
| Avisos de fallos del puente | `src/alerts.js` |
| Nueva variable de entorno | `src/config.js` **y** `.env.example` **y** la tabla del README |

## Trampas conocidas

- **El HTML de GLPI llega escapado** (`&#60;p&#62;`). Hay que decodificar entidades **antes** de
  quitar etiquetas, o el usuario ve los `<p>` en Slack.
- **Los adjuntos van por dos caminos**: las imágenes incrustadas en el contenido del seguimiento
  (`document.send.php?docid=N`) y el resto en `Document_Item`. Hay que mirar en los dos.
- **Al subir un documento a GLPI**, no metas `itemtype`/`items_id` en el `uploadManifest`: GLPI
  responde 201 y no guarda el fichero. Créalo suelto y vincúlalo con `Document_Item`.
- **Una cuenta de GLPI con varios perfiles** abre sesión con el predeterminado, que suele ser
  Self-Service y no ve ningún ticket. Por eso existe `GLPI_PROFILE_ID`.
- **El `kick` va antes del `archive`**: en un canal archivado ya no se puede expulsar a nadie.
- **Si un ticket falla en un ciclo, el cursor no avanza.** No lo «optimices»: los seguimientos
  se filtran por fecha posterior al cursor, y moverlo tras un error pierde ese mensaje.
- **Con barra de color, el texto va en `fallback`**, no en `text`: mandar los dos hace que
  Slack pinte el titulo dos veces, una encima del adjunto y otra dentro.
- **Los avisos de fallo se agrupan por tipo.** Con el sondeo cada pocos segundos, publicar cada
  error inunda el canal y acaban silenciandolo. Si anades un aviso nuevo, dale un `tipo`
  estable y deja que `alerts.js` haga el enfriamiento.
- **Slack archiva un canal privado en cuanto se queda sin miembros humanos**, y sobre un canal
  archivado no se puede publicar ni invitar. Si el ticket sigue vivo hay que desarchivarlo, o
  el puente entra en bucle sobre ese ticket y, como el cursor no avanza mientras algo falla,
  bloquea la cola entera.
- **Un 404 al consultar un ticket no es un fallo que reintentar**: es un ticket borrado, y de
  su canal huerfano se ocupa el barrido. Contarlo como error bloquea el cursor para siempre.
- **Lo que se deshace en GLPI hay que deshacerlo en Slack.** Un seguimiento marcado como
  privado o borrado se retira, con sus adjuntos; por eso `bot_files` guarda de que seguimiento
  vino cada fichero. Al retirarlo se marca `origin = 'retirado'` en vez de olvidarlo, para
  poder republicarlo si vuelve a ser visible.
- **Comparar solicitantes cuesta caro.** `getRequesterKeys` hace una sola llamada y devuelve
  identificadores; solo cuando aparece alguien desconocido se resuelven correo y cuenta de
  Slack. No lo sustituyas por `getRequesters` en el bucle de sondeo.
- **Los avisos al equipo no miran la lista blanca**, a diferencia de todo lo demas: al equipo
  le interesan todos los tickets, a los usuarios solo el suyo.
- **Tres capas de anti-bucle** (`seen_followups`, `GLPI_BRIDGE_USER_ID`, `bot_id`). Si tocas el
  flujo de escritura, comprueba que ninguna se rompe: el síntoma es un ping-pong infinito.

## Al terminar un cambio

```bash
npm test
```

Si el cambio afecta a Slack o GLPI de verdad, verifícalo también con `npm run check` y, si es
posible, con un ticket de prueba cuyo solicitante esté en la lista blanca.

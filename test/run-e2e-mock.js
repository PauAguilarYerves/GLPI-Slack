// Lanza la prueba simulada con un entorno de juguete y una BD temporal.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glpi-bridge-')), 'test.sqlite');
const res = spawnSync(process.execPath, [new URL('./e2e-mock.mjs', import.meta.url).pathname], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GLPI_URL: 'https://glpi.test/apirest.php',
    GLPI_APP_TOKEN: 'test', GLPI_USER_TOKEN: 'test', GLPI_BRIDGE_USER_ID: '99',
    GLPI_PROFILE_ID: '6',
    ALERT_CHANNEL: 'C_ALERTAS', ALERT_COOLDOWN_MINUTES: '30', STUCK_ALERT_MINUTES: '0',
    SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: '',
    DB_PATH: dbPath, LOG_LEVEL: 'info', CLEANUP_MODE: 'purge', CONVERSATION_MODE: 'channel',
    // Explicitos para que un .env real no se cuele en la prueba (dotenv solo
    // rellena lo que no venga ya definido).
    REPLY_MODE: 'inline', CHANNEL_PREFIX: 'ticket-', CHANNEL_INCLUDE_TITLE: 'true', DRY_RUN: 'false', ALLOWED_REQUESTER_EMAILS: '',
    CLEANUP_DELAY_MINUTES: '0', CLEANUP_DELAY_SECONDS: '', ONLY_TICKETS_CREATED_AFTER_ACTIVATION: 'false',
    INVITE_TECHNICIAN: 'false', SLACK_ADMIN_TOKEN: '', POLL_OVERLAP_SECONDS: '60',
  },
});
process.exit(res.status ?? 1);

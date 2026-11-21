# Bookcarrier

[🇬🇧 English](./README.md) · 🇪🇸 Español

Un pequeño demonio personal que lleva libros a tu Kindle desde el celular, a través de un bot privado de Telegram. Hoy maneja fanfics de [Archive of Our Own](https://archiveofourown.org) (AO3): compartís un link de AO3 con el bot y, unos momentos después, el EPUB está en la Kindle, listo para leer en KOReader. Más adelante también va a recibir ebooks y PDFs enviados al bot como archivos (ver [Roadmap](#roadmap)).

```
celular ──compartir link──▶ bot de Telegram ──▶ Bookcarrier (en tu Mac) ──FanFicFare──▶ EPUB ──scp──▶ Kindle
                                 ◀──────── "Delivered “Título” to your Kindle." ◀─────────────────────┘
```

> **Estado:** la Feature 1 (enviar un fic de AO3) está terminada y verificada de punta a punta. La Feature 2 (cola de reintentos + arranque al iniciar sesión con launchd) está terminada y verificada con la Kindle real. El envío de ebooks y PDFs como archivos (feature 3) está especificado pero todavía no construido.
>
> El proyecto se llamaba **Ficarrier** mientras solo manejaba fanfics; cambió de nombre cuando su alcance creció a libros en general.

## Qué hace hoy

- Acepta un link a un work de AO3 compartido con el bot, incluso cuando el menú de compartir manda el título y la URL juntos.
- Descarga el fic como EPUB con [FanFicFare](https://github.com/JimmXinu/FanFicFare), con el nombre `<id-del-work>-<título>.epub`, para que el nombre sea estable.
- Lo copia a la Kindle con `scp`.
- Te avisa en el chat si se entregó o qué falló exactamente.
- Si el fallo es transitorio (AO3 caído o limitando pedidos, el WiFi de la Kindle dormido), **guarda el pedido en una cola persistente y lo reintenta por su cuenta** durante hasta 30 minutos (ver [Cola de reintentos](#cola-de-reintentos)).
- Puede correr como LaunchAgent de macOS: arranca al iniciar sesión y vuelve solo si se cae (ver [Ejecutalo como LaunchAgent](#4-ejecutalo-como-launchagent)).
- Solo le responde a **vos**: los mensajes de cualquier otra cuenta de Telegram se ignoran sin responder.

> Los mensajes del bot están en inglés. Todos viven en un solo archivo, `src/messages.ts`, por si querés traducirlos.

## Requisitos

| Qué | Notas |
|---|---|
| macOS | Desarrollado y probado en macOS (Apple Silicon). |
| Node 24.15+ | `nvm use` lee `.nvmrc` para desarrollo; el LaunchAgent usa el `node@24` de Homebrew (`brew install node@24`). |
| [pnpm](https://pnpm.io) | |
| [FanFicFare](https://github.com/JimmXinu/FanFicFare) | `brew install fanficfare` |
| Un bot de Telegram | Crealo con [@BotFather](https://t.me/BotFather) y guardá su token. |
| Una Kindle con acceso SSH | Una Kindle con jailbreak que corra un servidor SSH, por ejemplo el de KOReader (escucha en el puerto **2222**). La Mac y la Kindle tienen que estar en la misma red. |
| Una llave SSH dedicada | Ya autorizada en la Kindle, con permisos `600` o `400`. |

## Instalación

```bash
nvm use
pnpm install
pnpm build
```

### 1. Averiguá tu ID de Telegram

El bot solo le responde al dueño, así que necesita tu ID numérico de Telegram (no tu @usuario). Una forma rápida es escribir unas pocas líneas con [grammY](https://grammy.dev) que respondan con `ctx.from.id`, o usar cualquier bot de tipo "cuál es mi ID".

### 2. Creá el archivo de configuración

La config real vive **fuera** del repositorio, en `~/.bookcarrier/config.json`. El repo solo trae `config.example.json`, con valores de relleno.

```bash
mkdir -p ~/.bookcarrier
cp config.example.json ~/.bookcarrier/config.json
chmod 600 ~/.bookcarrier/config.json
```

Después editalo:

| Campo | Obligatorio | Default | Significado |
|---|:---:|---|---|
| `telegramToken` | ✔ | | Token de @BotFather. **Nunca lo subas al repo.** |
| `ownerId` | ✔ | | Tu ID numérico de Telegram. |
| `kindleUser` | ✔ | | Usuario SSH de la Kindle (normalmente `root`). |
| `kindleHost` | ✔ | | Solo IP o hostname, **sin** el usuario. |
| `sshKeyPath` | ✔ | | Ruta a la llave privada. Un `~` inicial se expande. |
| `kindlePort` | | `2222` | Puerto SSH de la Kindle (`22` si usás el sshd de USBNetwork). |
| `remotePath` | | `/mnt/us/documents/books/` | Carpeta destino en la Kindle. **Tiene que existir ya**: `scp` no crea carpetas. |
| `downloadTimeoutMs` | | `600000` | Tiempo máximo de una descarga (10 min). |
| `uploadTimeoutMs` | | `120000` | Tiempo máximo de la copia (2 min). |
| `sshConnectTimeoutSec` | | `10` | `ConnectTimeout` de SSH. |
| `queuePath` | | `~/.bookcarrier/queue.json` | Archivo de estado de la cola de reintentos. Un `~` inicial se expande. |
| `spoolDir` | | `~/.bookcarrier/spool` | Dónde esperan su entrega los EPUB descargados. Nunca la carpeta temporal del sistema. El `~` se expande. |
| `giveUpAfterMs` | | `1800000` | Se abandona un pedido en cola este tiempo después de haberse encolado por primera vez (30 min). |
| `retryBackoffMinutes` | | `[1, 2, 4, 8, 15]` | Espera antes de cada reintento, en minutos. Una lista no vacía de enteros positivos. |

Si falta un campo obligatorio o tiene un tipo equivocado, el demonio no arranca y el log dice cuál es el campo con problemas.

### 3. Ejecutalo

```bash
pnpm start        # node dist/index.js
```

Volvé a correr `pnpm build` después de cambiar el código. Se detiene con `Ctrl+C` (una salida limpia). Solo puede haber **una** instancia escuchando un mismo bot a la vez; una segunda recibe de Telegram un `409 Conflict`.

Al arrancar, el demonio verifica que `fanficfare` y `scp` se encuentren en el `PATH`. Si falta alguno, registra un error que lo nombra (junto con el `PATH` en el que buscó), pero arranca igual.

Para dejarlo corriendo en segundo plano, instalalo como LaunchAgent (sección siguiente) en lugar de usar `pnpm start`.

### 4. Ejecutalo como LaunchAgent

El repo trae un plist de plantilla, [`launchd/com.codebymaribel.bookcarrier.plist`](./launchd/com.codebymaribel.bookcarrier.plist). Arranca el demonio al iniciar sesión (`RunAtLoad`), lo relanza si se cae pero no después de una salida limpia (`KeepAlive: { SuccessfulExit: false }`), espera 10 s entre relanzamientos (`ThrottleInterval`) y escribe sus logs en `~/Library/Logs/Bookcarrier/`.

```bash
brew install node@24                      # ruta estable: /opt/homebrew/opt/node@24/bin/node
pnpm build
mkdir -p ~/Library/Logs/Bookcarrier
cp launchd/com.codebymaribel.bookcarrier.plist ~/Library/LaunchAgents/
```

Editá `~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist` y reemplazá los valores de relleno por rutas absolutas (launchd no expande `~` ni `$HOME`):

- `__REPO__` → la ruta absoluta de este repositorio (`pwd` en su raíz).
- `__HOME__` → tu carpeta personal (`echo $HOME`).

Después validalo y cargalo:

```bash
plutil -lint ~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist
launchctl print gui/$(id -u)/com.codebymaribel.bookcarrier     # estado, PID, último código de salida
```

Para detenerlo y descargarlo (por ejemplo, antes de editar el plist):

```bash
launchctl bootout gui/$(id -u)/com.codebymaribel.bookcarrier
```

Algunas cosas para tener en cuenta:

- **No saques la entrada `EnvironmentVariables.PATH`.** launchd les da a sus procesos un `PATH` casi vacío, y los subprocesos lo heredan. Sin el prefijo de Homebrew, `fanficfare` no se encuentra y cada descarga falla como si la configuración estuviera rota. La verificación de arranque de arriba lo registra si eso pasa.
- **La ruta de node es la de Homebrew con versión** (`/opt/homebrew/opt/node@24/bin/node`): sobrevive a las actualizaciones de parche y no salta de versión mayor. La ruta de nvm incluye la versión de parche y se rompe al actualizar.
- Solo una instancia puede escuchar el bot: detené cualquier `pnpm start` antes de cargar el LaunchAgent.
- Logs: `~/Library/Logs/Bookcarrier/bookcarrier.out.log` y `bookcarrier.err.log` (sin rotación).

## Cómo se usa

Compartí (o pegá) un link a un work de AO3 con el bot. Responde enseguida y otra vez cuando termina.

| Vos mandás | El bot responde |
|---|---|
| Un link a un work (también `…/works/123/chapters/456`, `…/collections/x/works/123`) | `Got it, downloading…` y después `Delivered “Título” to your Kindle.` |
| Texto sin ningún link de AO3 | No reconoce un link válido de AO3. |
| Un link a una serie, a un usuario, a una colección… | Ese tipo de link todavía no está soportado. |
| Un link, pero AO3 está caído, limita pedidos (429/403) o no responde a tiempo | No lo pudo descargar por ahora y lo va a seguir reintentando durante hasta 30 minutos. |
| Un link a un work que no existe | La causa; **no** se reintenta. |
| Un link, pero la Kindle está apagada o dormida | El fic se descargó pero no se pudo enviar; lo va a seguir reintentando durante hasta 30 minutos. |
| (más tarde) un pedido en cola llega a destino | `Delivered “Título” to your Kindle.` |
| (más tarde) pasan 30 minutos sin éxito | Que lo abandonó, con el último error. Volvé a compartir el link para intentarlo otra vez. |
| Un link, pero la llave SSH o `scp` están mal configurados | Un error de configuración que nombra el problema (llave ausente, permisos abiertos, `scp` no encontrado). |

Si un mensaje trae varios links de AO3, solo se usa el primero.

## Cola de reintentos

Cada fallo se clasifica como **transitorio** o **permanente**:

- **Transitorio** — fallo de red, `429`/`403` de AO3, un timeout, la Kindle que no responde. Reintentar puede resolverlo, así que el pedido entra en la cola.
- **Permanente** — el work no existe, no se puede lanzar `fanficfare` o `scp`, la llave SSH falta o tiene permisos abiertos. Reintentar no lo va a resolver, así que el bot lo informa en el momento y no se encola nada.

Un pedido en cola recuerda su **etapa**. Si falló la descarga, el reintento vuelve a descargar; si solo falló la copia a la Kindle, el EPUB ya está en el spool y el reintento solo corre `scp`: no se vuelve a pedir nada a AO3.

- **Backoff:** los reintentos se hacen con 1, 2, 4, 8 y 15 minutos de separación (acumulado: 1, 3, 7, 15, 30).
- **Abandono:** 30 minutos después de encolarse por primera vez, el pedido se abandona y su EPUB se borra del spool.
- **Avisos:** un mensaje al encolarse, uno al entregarse (con el título) y uno al abandonarse (con el último error). Los intentos fallidos intermedios no generan avisos.
- **Persistencia:** la cola vive en `~/.bookcarrier/queue.json` (escrita de forma atómica) y los EPUB en `~/.bookcarrier/spool/`. Después de un reinicio, el demonio restaura la cola, reprograma los reintentos y borra del spool los archivos que ningún pedido en cola referencia. Si el archivo de la cola no se puede leer, se conserva aparte como `queue.json.corrupt-<timestamp>`, el demonio arranca con la cola vacía y te avisa.
- **Sin trabajo en reposo:** con la cola vacía no hay ningún timer; si no, un único timer apunta al próximo reintento pendiente.

La ventana y la escalera de esperas se configuran (`giveUpAfterMs`, `retryBackoffMinutes`).

## Cómo funciona

1. `ownerOnly` descarta todo update que no sea del dueño, sin responder.
2. `extractWorkLink` encuentra la URL de AO3 dentro del texto (verificando el hostname exacto) y reconstruye la URL canónica `https://archiveofourown.org/works/<id>`.
3. `downloadEpub` ejecuta `fanficfare` como subproceso en una carpeta vacía del spool y toma el único `.epub` que deja ahí. El propio FanFicFare nombra y sanitiza el archivo.
4. `uploadToKindle` revisa primero la llave SSH (con el mismo criterio que usa SSH) y después ejecuta `scp`.
5. El bot responde. Si salió bien, el EPUB se borra del spool; ante un fallo transitorio el pedido entra en la cola de reintentos; ante uno permanente se informa el error y se borra el EPUB.

Algunas decisiones deliberadas:

- **Los subprocesos usan `spawn`, nunca `exec`**, y todo es asíncrono: nada bloquea el event loop.
- **Los problemas de configuración y los fallos de entrega se distinguen sin mirar el código de salida de `scp`**: una llave mala se detecta *antes* de lanzar `scp`, un binario ausente por el evento `error`, y cualquier otro fallo es un fallo de entrega.
- **Los mensajes se procesan de a uno**, en orden de llegada (el long polling de grammY). Un segundo link se confirma cuando termina el primero. Los pedidos nuevos y los reintentos comparten la misma fila, así que AO3 y la Kindle nunca ven más de una operación a la vez.
- Los mensajes de error muestran solo la última línea útil del stderr de un subproceso, nunca un stack trace. El detalle completo va al log.

## Estructura del proyecto

```
src/
  index.ts        punto de entrada: carga la config, verifica binarios e inicia el long polling
  daemon.ts       arranque: restaura la cola, reconcilia el spool, arma el timer de reintentos
  bot.ts          filtro de dueño + el flujo de cada pedido (orquestación)
  errors.ts       clasificación de fallos en transitorios y permanentes
  binaries.ts     verificación de arranque de que fanficfare y scp estén en el PATH
  queue/          cola de reintentos: archivo de estado, backoff, spool, timer único
  messages.ts     todos los textos al dueño, y el mapeo error → mensaje
  ao3-link.ts     encuentra y valida el link a un work de AO3 en un mensaje
  downloader.ts   wrapper del subproceso de FanFicFare
  uploader.ts     wrapper del subproceso de scp (+ chequeo de la llave SSH)
  subprocess.ts   utilidades compartidas por los dos wrappers
  config.ts       carga y valida ~/.bookcarrier/config.json
  logger.ts       logger simple (niveles + timestamps)
test/             tests con Vitest, un archivo por módulo
docs/specs/       las especificaciones (ver abajo)
launchd/          plist de plantilla para el LaunchAgent
```

## Desarrollo

```bash
pnpm test          # corre los tests una vez
pnpm test:watch    # modo watch
pnpm typecheck     # tsc --noEmit
pnpm build         # compila src/ a dist/
```

Los tests nunca llaman a AO3 ni a la Kindle: los subprocesos y la API de Telegram se reemplazan por falsos.

## Especificaciones

El proyecto se construye primero con especificaciones. Cada feature tiene su carpeta en [`docs/specs/`](./docs/specs) con `requirements.md` (requisitos en EARS), `research.md`, `design.md` y `tasks.md`; las reglas comunes a todas las features están en [`_principles.md`](./docs/specs/_principles.md). Las specs son la fuente de verdad (están escritas en inglés).

## Roadmap

| #   | Feature                                                      | Estado          |
| --- | ------------------------------------------------------------ | --------------- |
| 1   | Enviar un fic de AO3 desde un link                           | ✅ Hecha        |
| 2   | Cola de reintentos + arranque al iniciar sesión con launchd  | ✅ Hecha                             |
| 3   | Enviar un ebook o un PDF como archivo (EPUB, MOBI, PDF)      | 📝 Especificada |
| 4   | Botón “Seguir” y seguimiento de capítulos                    | Planeada        |
| 5   | Revisión diaria de capítulos nuevos                          | Planeada        |
| 6   | Comandos `/list`, `/drop`, `/status`                         | Planeada        |

## Limitaciones conocidas

- Los reintentos terminan 30 minutos después del primer fallo: si la Kindle queda apagada más tiempo, el pedido se abandona y hay que volver a compartir el link (un toque desde el celular). La ventana se configura (`giveUpAfterMs`).
- Un pedido que todavía está en su primer intento cuando el demonio se detiene se pierde; solo los pedidos que ya están en la cola sobreviven a un reinicio.
- Los títulos con acentos los pierden en el nombre del archivo y en el mensaje de confirmación (`Corazón` → `Coraz_n`), porque FanFicFare sanitiza los nombres de archivo.
- Solo se soportan works individuales de AO3 (no series ni colecciones).
- Los archivos enviados al bot (ebooks, PDFs) todavía no se manejan: eso es la feature 3. Por ahora el bot solo responde a links de AO3.
- Los archivos de log en `~/Library/Logs/Bookcarrier/` no se rotan.

## Una nota sobre AO3

Es una herramienta personal para tu propia lectura. Respetá los [Términos de Servicio de AO3](https://archiveofourown.org/tos) y no saturés el sitio. FanFicFare ya espera y reintenta ante errores, y Bookcarrier hace un pedido a la vez.

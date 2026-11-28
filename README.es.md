# Bookcarrier

[🇬🇧 English](./README.md) · 🇪🇸 Español

Un pequeño demonio personal que lleva libros a tu Kindle desde el celular, a través de un bot privado de Telegram, listos para leer en KOReader.

Le mandás al bot ebooks y PDFs (EPUB, MOBI, PDF) como archivos y los copia a una carpeta de libros de la Kindle. También maneja fanfics de [Archive of Our Own](https://archiveofourown.org) (AO3): compartís un link de AO3 con el bot y, unos momentos después, el EPUB está en la Kindle.

## Detrás de escena

```
celular ──compartir link──▶ bot de Telegram ──▶ Bookcarrier ──FanFicFare──▶ EPUB ──scp──▶ Kindle

celular ──enviar archivo──▶ bot de Telegram ──▶ Bookcarrier ──getFile──▶ EPUB/MOBI/PDF ──scp──▶ Kindle
```

## Qué hace hoy

- Acepta un link a un work de AO3 compartido con el bot, incluso cuando el menú de compartir manda el título y la URL juntos (descarga el fic como EPUB con [FanFicFare](https://github.com/JimmXinu/FanFicFare), con el nombre `<id-del-work>-<título>.epub`, para que el nombre sea estable).
- Acepta un documento enviado al bot como archivo (por defecto EPUB, MOBI o PDF, de hasta 20 MB) y lo copia a su carpeta en la Kindle (`/mnt/us/documents/books/` por defecto, no la carpeta de los fics). Si ya hay un archivo con ese nombre, pregunta si lo reemplaza.
- Lo copia a la Kindle con `scp`.
- En un fic de AO3 **en curso**, el mensaje de entrega trae un botón **Follow**: guarda el fic con la cantidad de capítulos entregados, para que la revisión diaria (feature 6) sepa desde qué capítulo mirar. **Unfollow** lo deja de seguir, y un fic seguido que se completa se deja de seguir solo. Esta feature no consulta AO3 por capítulos nuevos.
- Te avisa en el chat si se entregó o qué falló exactamente.
- Si el fallo es transitorio (AO3 caído o limitando pedidos, el WiFi de la Kindle dormido), **guarda el pedido en una cola persistente y lo reintenta por su cuenta** durante hasta 30 minutos; si para entonces AO3 sigue limitando pedidos (`429`), guarda el pedido y lo vuelve a intentar cada 2 horas durante hasta 24 horas (ver [Cola de reintentos](#cola-de-reintentos)). Los documentos **no** se reintentan: si la Kindle no responde, volvés a mandar el archivo.

- Puede correr como LaunchAgent de macOS: arranca al iniciar sesión y vuelve solo si se cae (ver [Ejecutalo como LaunchAgent](#4-ejecutalo-como-launchagent)).
- Tiene un panel de control: `bookcarrierctl` en la terminal y un ítem en la barra de menú (SwiftBar) para arrancar, frenar y revisar el demonio (ver [Panel de control](#panel-de-control)).
- Solo le responde a **vos**: los mensajes de cualquier otra cuenta de Telegram se ignoran sin responder.

> Los mensajes del bot están en inglés. Cada contexto tiene los suyos en su `messages.ts` (`src/fanfic/`, `src/documents/`, `src/retry-queue/`, `src/kindle/`, `src/shared/`), por si querés traducirlos.

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
| `remotePath` | | `/mnt/us/documents/books/` | Carpeta destino de los fics en la Kindle. **Tiene que existir ya**: `scp` no crea carpetas. |
| `documentFolders` | | `{ "epub": "/mnt/us/documents/books/", "mobi": "/mnt/us/documents/books/", "pdf": "/mnt/us/documents/books/" }` | Qué formatos de documento se aceptan y adónde va cada uno. Las claves son extensiones en minúscula sin el punto (`pdf`, no `PDF` ni `.pdf`); los valores, carpetas absolutas en la Kindle (si falta la `/` final, se agrega). Si está presente, **reemplaza** al default entero (no se combina con él): para dejar de aceptar un formato, sacalo. Cada carpeta tiene que existir ya. Se puede agregar un formato que KOReader no abre (por ejemplo `azw3`), pero no se va a poder leer ahí. |
| `downloadTimeoutMs` | | `600000` | Tiempo máximo de una descarga (10 min). |
| `uploadTimeoutMs` | | `120000` | Tiempo máximo de la copia (2 min). |
| `sshConnectTimeoutSec` | | `10` | `ConnectTimeout` de SSH. |
| `queuePath` | | `~/.bookcarrier/queue.json` | Archivo de estado de la cola de reintentos. Un `~` inicial se expande. |
| `followsPath` | | `~/.bookcarrier/follows.json` | Archivo de estado de los fics seguidos (guarda también los últimos 10 fics entregados que ofrecieron Follow). Un `~` inicial se expande. |
| `spoolDir` | | `~/.bookcarrier/spool` | Dónde esperan su entrega los EPUB descargados. Nunca la carpeta temporal del sistema. El `~` se expande. |
| `giveUpAfterMs` | | `1800000` | Se abandona un pedido en cola este tiempo después de haberse encolado por primera vez (30 min). |
| `retryBackoffMinutes` | | `[1, 2, 4, 8, 15]` | Espera antes de cada reintento, en minutos. Una lista no vacía de enteros positivos. |
| `deferredRetryMs` | | `7200000` | Cuando AO3 sigue respondiendo `429` pasado `giveUpAfterMs`, el pedido se guarda y se reintenta con esta frecuencia (2 h). Ver [Cola de reintentos](#cola-de-reintentos). |
| `deferredGiveUpAfterMs` | | `86400000` | Un pedido diferido por el límite de AO3 se abandona cuando su próximo reintento caería más allá de este tiempo desde que se encoló por primera vez (24 h). |

Si falta un campo obligatorio o tiene un tipo equivocado, el demonio no arranca y el log dice cuál es el campo con problemas.

### 3. Ejecutalo

```bash
pnpm start        # node dist/index.js
```

Volvé a correr `pnpm build` después de cambiar el código. Se detiene con `Ctrl+C` (una salida limpia). Solo puede haber **una** instancia escuchando un mismo bot a la vez; una segunda recibe de Telegram un `409 Conflict`.

Al arrancar, el demonio verifica que `fanficfare`, `scp` y `ssh` se encuentren en el `PATH`. Si falta alguno, registra un error que lo nombra (junto con el `PATH` en el que buscó), pero arranca igual.

Para dejarlo corriendo en segundo plano, instalalo como LaunchAgent (sección siguiente) en lugar de usar `pnpm start`.

### 4. Ejecutalo como LaunchAgent

El repo trae un plist de plantilla, [`launchd/com.codebymaribel.bookcarrier.plist`](./launchd/com.codebymaribel.bookcarrier.plist). Arranca el demonio al iniciar sesión (`RunAtLoad`), lo relanza si se cae pero no después de una salida limpia (`KeepAlive: { SuccessfulExit: false }`), espera 10 s entre relanzamientos (`ThrottleInterval`) y escribe sus logs en `~/Library/Logs/Bookcarrier/`.

`bin/bookcarrierctl install` lo instala por vos: copia la plantilla a `~/Library/LaunchAgents/`, completa las rutas absolutas del repo y de tu carpeta personal (launchd no expande `~` ni `$HOME`), crea la carpeta de logs, valida el plist con `plutil -lint` y lo carga. No hay que editar nada a mano.

```bash
brew install node@24          # ruta estable: /opt/homebrew/opt/node@24/bin/node
pnpm build                    # install necesita dist/index.js
bin/bookcarrierctl install
bin/bookcarrierctl status     # Bookcarrier: running (PID 30046) · 0 in retry queue
```

- Si falta Node 24 o `dist/index.js`, `install` te dice cuál y qué correr, y no escribe nada.
- Si volvés a correr `install`, reemplaza el plist instalado por una copia nueva de la plantilla y recarga el job: así se aplican los cambios a la plantilla. Si el plist nuevo no es válido, no se cambia nada.
- `bookcarrierctl uninstall` descarga el job y borra el plist. Conserva los logs, la cola y el spool.

`bookcarrierctl` no tiene un bin de npm (tiene que andar sin Node en el `PATH`, para la barra de menú). Para correrlo desde cualquier lado, hacé un symlink en una carpeta que esté en tu `PATH`, o agregá el `bin/` del repo a tu `PATH`:

```bash
ln -s "$PWD/bin/bookcarrierctl" ~/bin/bookcarrierctl    # desde la raíz del repo; ~/bin tiene que estar en tu PATH
# o, en ~/.zshrc:
export PATH="/ruta/absoluta/a/bookcarrier/bin:$PATH"
```

Anda desde cualquier carpeta y a través de un symlink. En el resto de este README aparece como `bookcarrierctl`; todos sus comandos están en [Panel de control](#panel-de-control).

Algunas cosas para tener en cuenta:

- **No saques la entrada `EnvironmentVariables.PATH`.** launchd les da a sus procesos un `PATH` casi vacío, y los subprocesos lo heredan. Sin el prefijo de Homebrew, `fanficfare` no se encuentra y cada descarga falla como si la configuración estuviera rota. La verificación de arranque de arriba lo registra si eso pasa.
- **La ruta de node es la de Homebrew con versión** (`/opt/homebrew/opt/node@24/bin/node`): sobrevive a las actualizaciones de parche y no salta de versión mayor. La ruta de nvm incluye la versión de parche y se rompe al actualizar.
- **Editá la plantilla de `launchd/`, no la copia instalada**: `install` sobrescribe `~/Library/LaunchAgents/com.codebymaribel.bookcarrier.plist`.
- Solo una instancia puede escuchar el bot: detené cualquier `pnpm start` antes de instalar el LaunchAgent.
- Logs: un solo archivo, `~/Library/Logs/Bookcarrier/bookcarrier.log` (sin rotación), con las líneas INFO, WARN y ERROR del demonio en orden. `bookcarrierctl logs` muestra sus últimas líneas. Una instalación de antes del log único sigue escribiendo en los viejos `bookcarrier.out.log` y `bookcarrier.err.log` hasta que volvés a correr `bookcarrierctl install`; los archivos viejos no se borran.

### 5. Reiniciá el daemon

El daemon lee `~/.bookcarrier/config.json` y carga `dist/` solo al arrancar, así que necesita un reinicio después de cualquier cambio. Qué correr depende de qué cambiaste:

| Cambiaste | Corré |
| --- | --- |
| El código (`src/`) | `pnpm build` y después `bookcarrierctl restart` |
| `~/.bookcarrier/config.json` | `bookcarrierctl restart` (no hace falta build) |
| La plantilla del plist (`launchd/…plist`) | `bookcarrierctl install` |

`restart` frena el proceso que está corriendo y lo arranca de nuevo. Si cambiaste la plantilla no alcanza, porque launchd se queda con la copia que cargó; `install` escribe un plist nuevo y recarga el job.

Fijate que haya vuelto a arrancar:

```bash
bookcarrierctl status     # Bookcarrier: running (PID 30046) · 0 in retry queue
bookcarrierctl logs       # últimas 50 líneas de bookcarrier.log
```

`running` con un PID quiere decir que está andando. Si dice `crashed` o `stopped`, las últimas líneas `WARN`/`ERROR` de `bookcarrier.log` dicen por qué (por ejemplo, un error de configuración nombra el campo).

Si lo corrés con `pnpm start`, frenalo con `Ctrl+C` y corré `pnpm start` de nuevo.

## Panel de control

`bin/bookcarrierctl` es lo único que habla con `launchctl` para Bookcarrier, y el ítem de la barra de menú solo llama a `bookcarrierctl`. Es Bash pelado y no necesita Node. En [Ejecutalo como LaunchAgent](#4-ejecutalo-como-launchagent) está cómo ponerlo en tu `PATH`.

| Comando | Qué hace | Salida |
|---|---|---|
| `status [--porcelain]` | El estado (`running` con su PID, `stopped`, `crashed` con el último código de salida, `not-loaded`, `not-installed`) y la cantidad de pedidos en la cola de reintentos, separados entre los que esperan descargarse y los que esperan enviarse (`2 in retry queue (1 to download, 1 to send)`). `--porcelain` imprime líneas `state=`, `pid=`, `last_exit=`, `queue_items=`, `queue_download=` y `queue_send=` para scripts (`-` cuando no hay valor, `?` en los conteos de la cola cuando no se puede leer el archivo). | 0 si está corriendo, 3 si no |
| `start` | Arranca el demonio (carga el job si no está cargado). Si ya está corriendo, lo dice y no hace nada. | 0 / 1 |
| `stop` | Manda SIGTERM, así el demonio sale limpio y launchd no lo relanza hasta `bookcarrierctl start`. Espera hasta 15 s; si sigue corriendo, lo dice y sale con 1. Nunca manda SIGKILL. | 0 / 1 |
| `restart` | Frena el demonio y lo arranca de nuevo, por ejemplo después de `pnpm build` (carga el job si no está cargado). | 0 / 1 |
| `install` | Instala el LaunchAgent y lo carga; volvé a correrlo para aplicar cambios a la plantilla (ver [Ejecutalo como LaunchAgent](#4-ejecutalo-como-launchagent)). | 0 / 1 |
| `uninstall` | Descarga el job y borra su plist. Conserva los logs, la cola y el spool. | 0 / 1 |
| `logs [-f]` | Las últimas 50 líneas de `bookcarrier.log`. `-f` (o `--follow`) lo sigue hasta `Ctrl+C`. | la de `tail` |
| `menubar install <carpeta>` | Instala el plugin de SwiftBar en `<carpeta>` (ver abajo). | 0 / 1 |
| `help` | Muestra el uso. | 0 |

Un comando u opción desconocidos muestran el uso y salen con 2. Si el LaunchAgent no está instalado, `start`, `stop` y `restart` salen con 1 y `Bookcarrier is not installed. Run: bookcarrierctl install`.

> Los mensajes de `bookcarrierctl` y del menú están en inglés, como los del bot.

**`queuePath` propio:** `bookcarrierctl` y la barra de menú leen la cola de `~/.bookcarrier/queue.json`. Si configuraste `queuePath` en `config.json`, definí también `BOOKCARRIER_QUEUE_FILE` con la misma ruta (no lee `config.json`).

Por debajo usa `launchctl list`, `bootstrap`, `bootout`, `kickstart [-k]` y `kill SIGTERM` sobre `gui/$(id -u)/com.codebymaribel.bookcarrier`, así que siguen andando a mano si alguna vez los necesitás.

### Barra de menú (SwiftBar)

[SwiftBar](https://github.com/swiftbar/SwiftBar) muestra el estado del demonio en la barra de menú y te deja arrancarlo o frenarlo con un clic.

1. `brew install swiftbar`
2. Abrí SwiftBar y elegí una carpeta de plugins cuando te la pida (por ejemplo `~/SwiftBarPlugins`).
3. Instalá el plugin en esa carpeta:

   ```bash
   bookcarrierctl menubar install ~/SwiftBarPlugins
   ```

   Escribe ahí `bookcarrier.10s.sh`, con la ruta de este repo completada. Volvé a correrlo si movés el repo.

El ícono tiene un símbolo distinto para cada estado, así que no depende del color:

| Estado | Ícono | Primera línea del menú | Acciones |
|---|---|---|---|
| Corriendo | libro relleno (`book.fill`) | `Running · PID 30046` | Stop, Restart |
| Frenado o no cargado | libro con contorno (`book`) | `Stopped` | Start |
| Caído | triángulo de advertencia (`exclamationmark.triangle.fill`) | `Crashed (last exit 9) — launchd will retry` | Start |
| No instalado | libro cerrado (`book.closed`) | `Not installed` | Install |
| `bookcarrierctl` falta o falla | signo de pregunta (`questionmark.circle`) | el error | ninguna |

- La segunda línea muestra la cola de reintentos separada por etapa: `Retry queue: 1 to download · 1 to send` (siempre las dos partes, aunque una sea 0), `Retry queue: empty` cuando no tiene pedidos, o `Retry queue unreadable`.
- Las acciones corren el comando de `bookcarrierctl` correspondiente en segundo plano (sin ventana de Terminal) y refrescan el menú enseguida.
- Todos los menús tienen además **Open logs** (`bookcarrier.log` en Console), **Open spool folder** (`~/.bookcarrier/spool` en Finder) y **Open queue file**.
- El plugin se refresca cada 10 segundos (el `10s` de su nombre). Un comando de `bookcarrierctl` que cambia el estado, corrido en la terminal, también lo refresca en el momento.
- Para que SwiftBar arranque al iniciar sesión, usá su propia opción "Launch at login".

## Cómo se usa

Compartí (o pegá) un link a un work de AO3 con el bot, o mandale un documento como archivo. Responde enseguida y otra vez cuando termina.

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
| (más tarde) pasan 30 minutos y AO3 sigue respondiendo `429` | Que FanFicFare tiene problemas con AO3; guardó el pedido y lo va a volver a intentar en unas 2 horas, durante hasta 24 horas. |
| Un link mientras hay un pedido esperando por el `429` de AO3 | Lo guarda sin descargarlo (no toca AO3) y te dice cuándo lo va a intentar. |
| (más tarde) pasan 24 horas y AO3 sigue respondiendo `429` | Que lo abandonó porque AO3 siguió limitando a FanFicFare, con el último error. |
| Un link, pero la llave SSH o `scp` están mal configurados | Un error de configuración que nombra el problema (llave ausente, permisos abiertos, `scp` no encontrado). |

Si un mensaje trae varios links de AO3, solo se usa el primero.

Seguir un fic (solo fics de AO3 **en curso**; los documentos nunca se siguen):

| Pasa esto | El bot responde |
|---|---|
| Se entrega un fic en curso | `Delivered “Título” to your Kindle.` con un botón **Follow**. |
| → tocás **Follow** | `Following “Título” — 12 chapters delivered.` y el botón pasa a **Unfollow**. |
| → tocás **Unfollow** | `OK, I'm no longer following “Título”.` y el botón desaparece. |
| Volvés a mandar el link de un fic seguido | `Delivered “Título” to your Kindle. I updated your follow: now 14 chapters.` con el botón **Unfollow**: se actualizan solos la cantidad de capítulos y el estado guardados. |
| Se entrega un fic que ya está completo | `Delivered “Título” to your Kindle.` **sin** botón: los fics completos no se siguen. |
| Volvés a mandar un fic seguido y ya está completo | `Delivered “Título” to your Kindle. It's complete now, so I'm no longer following it.` Se deja de seguir solo, sin botón. |
| → tocás un **Follow** viejo, después de que se entregaron 10 fics más (o si el fic no figura) | `I don't have that fic any more. Send me its link again to follow it.` No se guarda nada. |
| FanFicFare no deja metadatos de capítulos utilizables | El fic se entrega igual, **sin** botón **Follow**, y queda un aviso en el log. |
| El archivo de fics seguidos está ilegible al arrancar | `The file with your followed fics was unreadable, so I started with none followed. The old file was kept as <ruta> so it can be inspected.` (el archivo viejo queda como `follows.json.corrupt-<timestamp>`). |

El botón **Follow** de un fic sigue andando para los últimos 10 fics entregados, incluso después de reiniciar el demonio. Los fics seguidos no cuentan para ese límite. Un pedido diferido por el límite de AO3 también ofrece **Follow** cuando por fin se entrega.

Para un documento (EPUB, MOBI, PDF, como archivo; el texto que lo acompaña se ignora):

| Vos mandás | El bot responde |
|---|---|
| `Libro.epub`, que todavía no está en la Kindle | `Got it, checking your Kindle…` y después `Delivered “Libro.epub” to your Kindle.` |
| Un archivo en un formato no aceptado (`.azw3`, `.jpg`, un GIF…) | `I can't send that kind of file. Send me one of: EPUB, MOBI, PDF.` (la lista sale de `documentFolders`) |
| Un archivo de más de 20 MB | `That file is 25 MB; I can only fetch files up to 20 MB from Telegram.` No se descarga nada. |
| `Libro.epub`, que ya está en la Kindle | `“Libro.epub” is already on your Kindle. Replace it?` con dos botones, **Replace** y **Cancel**. |
| → tocás **Replace** | Se descarga el archivo y se sobrescribe, y después `Delivered “Libro.epub” to your Kindle.` |
| → tocás **Cancel** | `OK, I left “Libro.epub” as it was. Nothing was sent.` |
| → tocás un botón después de 10 minutos, o después de reiniciar el demonio | `That request is no longer pending. Send me the file again.` |
| Un archivo, pero la Kindle está apagada o dormida | `I couldn't send “Libro.epub” to your Kindle (…). Is it awake and on the Wi-Fi? Send me the file again when it is.` **No** se encola. |
| Un archivo, pero falla la descarga desde Telegram | `I couldn't get that file from Telegram: …` |
| Un archivo, pero la llave SSH o `ssh`/`scp` están mal configurados | Un error de configuración que nombra el problema. |

El nombre en la Kindle es el del archivo, con los caracteres que la partición FAT32 de la Kindle rechaza (`\ / : * ? " < > |`) cambiados por `_`: `Dune: Messiah.epub` llega como `Dune_ Messiah.epub`. Los acentos se conservan (`Corazón.pdf`). La extensión se compara sin importar mayúsculas (`Report.PDF` se acepta).

## Cola de reintentos

Cada fallo se clasifica como **transitorio** o **permanente**:

- **Transitorio** — fallo de red, `429`/`403` de AO3, un timeout, la Kindle que no responde. Reintentar puede resolverlo, así que el pedido entra en la cola.
- **Permanente** — el work no existe, no se puede lanzar `fanficfare` o `scp`, la llave SSH falta o tiene permisos abiertos. Reintentar no lo va a resolver, así que el bot lo informa en el momento y no se encola nada.

Un pedido en cola recuerda su **etapa**. Si falló la descarga, el reintento vuelve a descargar; si solo falló la copia a la Kindle, el EPUB ya está en el spool y el reintento solo corre `scp`: no se vuelve a pedir nada a AO3.

- **Backoff:** los reintentos se hacen con 1, 2, 4, 8 y 15 minutos de separación (acumulado: 1, 3, 7, 15, 30).
- **Abandono:** 30 minutos después de encolarse por primera vez, el pedido se abandona y su EPUB se borra del spool — salvo cuando AO3 sigue limitando pedidos (`429`), ver [más abajo](#cuando-ao3-sigue-limitando-pedidos-429).
- **Avisos:** un mensaje al encolarse, uno al entregarse (con el título) y uno al abandonarse (con el último error). Los intentos fallidos intermedios no generan avisos.
- **Persistencia:** la cola vive en `~/.bookcarrier/queue.json` (escrita de forma atómica) y los EPUB en `~/.bookcarrier/spool/`. Después de un reinicio, el demonio restaura la cola, reprograma los reintentos y borra del spool los archivos que ningún pedido en cola referencia. Si el archivo de la cola no se puede leer, se conserva aparte como `queue.json.corrupt-<timestamp>`, el demonio arranca con la cola vacía y te avisa.
- **Sin trabajo en reposo:** con la cola vacía no hay ningún timer; si no, un único timer apunta al próximo reintento pendiente.

La ventana y la escalera de esperas se configuran (`giveUpAfterMs`, `retryBackoffMinutes`).

### Cuando AO3 sigue limitando pedidos (`429`)

AO3 puede responder `429 Too Many Requests` durante horas. Un pedido cuya ventana de 30 minutos se agota mientras el último error sigue siendo un `429` **no** se abandona:

- Queda **diferido** (en el archivo de la cola, así que sobrevive a un reinicio) y se reintenta **cada 2 horas**.
- Recibís un mensaje diciendo que FanFicFare tiene problemas con AO3 y cuándo lo va a volver a intentar. Los reintentos diferidos fallidos son silenciosos; una entrega se avisa como siempre.
- Se abandona (y te avisa, con el último error) cuando su próximo reintento caería más de **24 horas** después de haberse encolado por primera vez.
- Mientras haya algún pedido diferido, se considera que AO3 está **en enfriamiento**: un link nuevo no se descarga, se guarda como diferido y se intenta junto con el pedido diferido más próximo. Así no se alarga el límite. Del mismo modo, si un reintento diferido recibe otro `429`, los demás pedidos diferidos que vencían en ese momento esperan otras 2 horas sin tocar AO3.
- Solo se difieren los fallos por límite de pedidos. Cualquier otro fallo (`403`/`5xx` de AO3, un timeout, la Kindle dormida) se sigue abandonando a los 30 minutos. Un pedido diferido que se descarga pero después no llega a la Kindle mantiene la frecuencia de 2 horas.

Los dos límites se configuran (`deferredRetryMs`, `deferredGiveUpAfterMs`).

## Cómo funciona

1. `ownerOnly` descarta todo update que no sea del dueño, sin responder.
2. `extractWorkLink` encuentra la URL de AO3 dentro del texto (verificando el hostname exacto) y reconstruye la URL canónica `https://archiveofourown.org/works/<id>`.
3. `downloadEpub` ejecuta `fanficfare` como subproceso en una carpeta vacía del spool y toma el único `.epub` que deja ahí. El propio FanFicFare nombra y sanitiza el archivo.
4. `uploadToKindle` revisa primero la llave SSH (con el mismo criterio que usa SSH) y después ejecuta `scp`.
5. Junto con el EPUB, `fanficfare` escribe `<nombre>.epub.json` (`--json-meta-file`). `parseFicMeta` lee de ahí la cantidad de capítulos publicados (`numChapters`) y el estado (`Completed` / `In-Progress`); no hace ningún pedido extra a AO3. Si el JSON falta o no sirve, el fic se entrega igual pero sin botón **Follow**. Con el fic entregado, `follows.onDelivered` decide si ofrece **Follow**, actualiza un fic seguido o lo deja de seguir (`follows.json`). Un pedido diferido por el límite de AO3 lee estos metadatos cuando por fin se descarga, así que ofrece **Follow** cuando se entrega.
6. El bot responde. Si salió bien, el EPUB se borra del spool; ante un fallo transitorio el pedido entra en la cola de reintentos; ante uno permanente se informa el error y se borra el EPUB.

Para un documento:

1. `ownerOnly` también descarta los documentos y los toques de botón que no son del dueño.
2. `validateDocument` acepta el archivo solo si su extensión es una clave de `documentFolders` y Telegram declara que pesa como mucho 20 MB, y `sanitizeFileName` arma el nombre que va a tener en la Kindle.
3. `existsOnKindle` ejecuta `ssh … test -e '<carpeta><nombre>'`, con la ruta entre comillas simples para que el shell de la Kindle nunca interprete ningún carácter del nombre. Salida `0` significa que existe, `1` que no; cualquier otra cosa significa que la Kindle no responde, y no se descarga nada.
4. Si existe, el bot pregunta con los botones **Replace** / **Cancel** y vuelve enseguida. Solo se guardan el `file_id` de Telegram, el nombre y la carpeta, en memoria, durante 10 minutos.
5. Para entregarlo, el archivo se descarga de Telegram (`getFile` + `fetch`) en una carpeta temporal propia (nunca el spool), se envía con `uploadToKindle` a su carpeta y la carpeta temporal se borra pase lo que pase. Los documentos nunca entran en la cola de reintentos, y el token del bot nunca aparece en el log ni en un mensaje.

Algunas decisiones deliberadas:

- **Los subprocesos usan `spawn`, nunca `exec`**, y todo es asíncrono: nada bloquea el event loop.
- **Los problemas de configuración y los fallos de entrega se distinguen sin mirar el código de salida de `scp`**: una llave mala se detecta *antes* de lanzar `scp`, un binario ausente por el evento `error`, y cualquier otro fallo es un fallo de entrega.
- **Los mensajes se procesan de a uno**, en orden de llegada (el long polling de grammY). Un segundo link se confirma cuando termina el primero. Los pedidos nuevos y los reintentos comparten la misma fila, así que AO3 y la Kindle nunca ven más de una operación a la vez.
- Los mensajes de error muestran solo la última línea útil del stderr de un subproceso, nunca un stack trace. El detalle completo va al log.

## Estructura del proyecto

```
src/              una carpeta por contexto (bounded context); cada una expone un index.ts, lo único
                  que importan los demás contextos; los tests unitarios van junto al módulo (*.test.ts)
  index.ts        punto de entrada: carga la config, verifica binarios e inicia el long polling
  app/            raíz de composición
    daemon.ts       arranque: restaura la cola, reconcilia el spool, arma el timer de reintentos
    binaries.ts     verificación de arranque de que fanficfare, scp y ssh estén en el PATH
  telegram/       interfaz de Telegram
    bot.ts          filtro de dueño, handlers de texto y documentos, y los botones Replace/Cancel
  fanfic/         fics compartidos como links de AO3
    pipeline.ts     el flujo de pedidos y reintentos (orquestación), de a una operación por vez
    ao3-link.ts     encuentra y valida el link a un work de AO3 en un mensaje
    downloader.ts   wrapper del subproceso de FanFicFare
    fic-meta.ts     lee del archivo de metadatos de FanFicFare la cantidad de capítulos y el estado de un fic
    failure.ts      clasificación de fallos en transitorios y permanentes, detección del límite de AO3 (429)
    messages.ts     todos los textos sobre fics, y su mapeo error → mensaje
  follows/        fics seguidos
    follows.ts      Follow, Unfollow, los últimos 10 fics entregados y el estado de follows.json
    messages.ts     todos los textos sobre seguir fics, y el aviso de archivo de seguidos corrupto
  documents/      documentos enviados al bot como archivo
    flow.ts         el flujo de documentos (orquestación), incluida la pregunta Replace/Cancel
    document.ts     validación de documentos y sanitización del nombre de archivo
    telegram-file.ts descarga un archivo enviado al bot (getFile + fetch) sin filtrar el token
    pending.ts      preguntas Replace/Cancel pendientes, en memoria, con vencimiento a los 10 minutos
    messages.ts     todos los textos sobre documentos, y su mapeo error → mensaje
  retry-queue/    cola de reintentos
    queue.ts        política de backoff, ventana de reintentos y diferido por el límite de AO3
    state.ts        el archivo persistido de la cola (escrituras atómicas, respaldo si está corrupto)
    spool.ts        un directorio por pedido en cola, con su EPUB
    scheduler.ts    el timer único que despierta para el próximo pedido pendiente
    messages.ts     el aviso de archivo de cola corrupto
  kindle/         entrega a la Kindle
    uploader.ts     wrapper del subproceso de scp
    ssh.ts          opciones SSH y chequeo de la llave compartidos por scp y ssh; chequeo de existencia en la Kindle
    messages.ts     el texto de problema de configuración de la Kindle
  shared/         config.ts (carga y valida ~/.bookcarrier/config.json), logger.ts,
                  json-file.ts (lectura/escritura atómica de un JSON con versión, compartida por la cola y los fics seguidos),
                  subprocess.ts (utilidades de los wrappers de subprocesos), messages.ts (texto genérico)
test/             tests con Vitest de bookcarrierctl, el plist de launchd y la plantilla de SwiftBar
docs/specs/       las especificaciones (ver abajo)
launchd/          plist de plantilla para el LaunchAgent
bin/              bookcarrierctl, el script del panel de control
swiftbar/         plantilla del plugin de SwiftBar para la barra de menú
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

| #   | Feature                                                       | Estado          |
| --- | ------------------------------------------------------------- | --------------- |
| 1   | Enviar un fic de AO3 desde un link                            | ✅ Hecha        |
| 2   | Cola de reintentos + arranque al iniciar sesión con launchd (+ diferimiento ante el `429` de AO3) | ✅ Hecha        |
| 3   | Enviar un documento como archivo (EPUB, MOBI, PDF)            | ✅ Hecha        |
| 4   | Panel de control: `bookcarrierctl` + barra de menú (SwiftBar) | ✅ Hecha        |
| 5   | Botón “Follow” y seguimiento de capítulos                     | ✅ Hecha        |
| 6   | Revisión diaria de capítulos nuevos                           | Planeada        |
| 7   | Comandos `/list`, `/drop`, `/status`                          | Planeada        |

## Limitaciones conocidas

- Los reintentos terminan 30 minutos después del primer fallo: si la Kindle queda apagada más tiempo, el pedido se abandona y hay que volver a compartir el link (un toque desde el celular). La ventana se configura (`giveUpAfterMs`). Solo el límite `429` de AO3 tiene el diferimiento más largo, de 24 horas.
- Un pedido que todavía está en su primer intento cuando el demonio se detiene se pierde; solo los pedidos que ya están en la cola sobreviven a un reinicio.
- Los títulos con acentos los pierden en el nombre del archivo y en el mensaje de confirmación (`Corazón` → `Coraz_n`), porque FanFicFare sanitiza los nombres de archivo.
- Solo se soportan works individuales de AO3 (no series ni colecciones).
- Los documentos enviados como archivo tienen un límite de 20 MB (el límite de descarga de la Bot API) y no se reintentan: si la Kindle no responde, hay que volver a mandar el archivo.
- Un documento se valida solo por su extensión; no se revisa su contenido.
- Los archivos de log en `~/Library/Logs/Bookcarrier/` no se rotan.

## Una nota sobre AO3

Es una herramienta personal para tu propia lectura. Respetá los [Términos de Servicio de AO3](https://archiveofourown.org/tos) y no saturés el sitio. FanFicFare ya espera y reintenta ante errores, y Bookcarrier hace un pedido a la vez.

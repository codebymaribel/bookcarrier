# Bookcarrier

[🇬🇧 English](./README.md) · 🇪🇸 Español

Un pequeño demonio personal que lleva libros a tu Kindle desde el celular, a través de un bot privado de Telegram. Hoy maneja fanfics de [Archive of Our Own](https://archiveofourown.org) (AO3): compartís un link de AO3 con el bot y, unos momentos después, el EPUB está en la Kindle, listo para leer en KOReader. Más adelante también va a recibir ebooks y PDFs enviados al bot como archivos (ver [Roadmap](#roadmap)).

```
celular ──compartir link──▶ bot de Telegram ──▶ Bookcarrier (en tu Mac) ──FanFicFare──▶ EPUB ──scp──▶ Kindle
                                 ◀──────── "Delivered “Título” to your Kindle." ◀─────────────────────┘
```

> **Estado:** la Feature 1 (enviar un fic de AO3) está terminada y verificada de punta a punta. La cola de reintentos (feature 2) y el envío de ebooks y PDFs como archivos (feature 3) están especificados pero todavía no construidos.
>
> El proyecto se llamaba **Ficarrier** mientras solo manejaba fanfics; cambió de nombre cuando su alcance creció a libros en general.

## Qué hace hoy

- Acepta un link a un work de AO3 compartido con el bot, incluso cuando el menú de compartir manda el título y la URL juntos.
- Descarga el fic como EPUB con [FanFicFare](https://github.com/JimmXinu/FanFicFare), con el nombre `<id-del-work>-<título>.epub`, para que el nombre sea estable.
- Lo copia a la Kindle con `scp`.
- Te avisa en el chat si se entregó o qué falló exactamente.
- Solo le responde a **vos**: los mensajes de cualquier otra cuenta de Telegram se ignoran sin responder.

> Los mensajes del bot están en inglés. Todos viven en un solo archivo, `src/messages.ts`, por si querés traducirlos.

## Requisitos

| Qué | Notas |
|---|---|
| macOS | Desarrollado y probado en macOS (Apple Silicon). |
| Node 24 | `nvm use` lee `.nvmrc`. |
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

Si falta un campo obligatorio o tiene un tipo equivocado, el demonio no arranca y el log dice cuál es el campo con problemas.

### 3. Ejecutalo

```bash
pnpm start        # node dist/index.js
```

Volvé a correr `pnpm build` después de cambiar el código. Se detiene con `Ctrl+C` (una salida limpia). Solo puede haber **una** instancia escuchando un mismo bot a la vez; una segunda recibe de Telegram un `409 Conflict`.

## Cómo se usa

Compartí (o pegá) un link a un work de AO3 con el bot. Responde enseguida y otra vez cuando termina.

| Vos mandás | El bot responde |
|---|---|
| Un link a un work (también `…/works/123/chapters/456`, `…/collections/x/works/123`) | `Got it, downloading…` y después `Delivered “Título” to your Kindle.` |
| Texto sin ningún link de AO3 | No reconoce un link válido de AO3. |
| Un link a una serie, a un usuario, a una colección… | Ese tipo de link todavía no está soportado. |
| Un link, pero la descarga falla | La causa (por ejemplo un error de AO3 o de Cloudflare). |
| Un link, pero la Kindle está apagada o dormida | El fic se descargó pero no se pudo enviar; volvé a compartirlo cuando la Kindle esté despierta. |
| Un link, pero la llave SSH o `scp` están mal configurados | Un error de configuración que nombra el problema (llave ausente, permisos abiertos, `scp` no encontrado). |

Si un mensaje trae varios links de AO3, solo se usa el primero.

## Cómo funciona

1. `ownerOnly` descarta todo update que no sea del dueño, sin responder.
2. `extractWorkLink` encuentra la URL de AO3 dentro del texto (verificando el hostname exacto) y reconstruye la URL canónica `https://archiveofourown.org/works/<id>`.
3. `downloadEpub` ejecuta `fanficfare` como subproceso en una carpeta temporal vacía y toma el único `.epub` que deja ahí. El propio FanFicFare nombra y sanitiza el archivo.
4. `uploadToKindle` revisa primero la llave SSH (con el mismo criterio que usa SSH) y después ejecuta `scp`.
5. El bot responde, y la carpeta temporal se borra siempre.

Algunas decisiones deliberadas:

- **Los subprocesos usan `spawn`, nunca `exec`**, y todo es asíncrono: nada bloquea el event loop.
- **Los problemas de configuración y los fallos de entrega se distinguen sin mirar el código de salida de `scp`**: una llave mala se detecta *antes* de lanzar `scp`, un binario ausente por el evento `error`, y cualquier otro fallo es un fallo de entrega.
- **Los mensajes se procesan de a uno**, en orden de llegada (el long polling de grammY). Un segundo link se confirma cuando termina el primero.
- Los mensajes de error muestran solo la última línea útil del stderr de un subproceso, nunca un stack trace. El detalle completo va al log.

## Estructura del proyecto

```
src/
  index.ts        punto de entrada: carga la config e inicia el long polling
  bot.ts          filtro de dueño + el flujo de cada pedido (orquestación)
  messages.ts     todos los textos al dueño, y el mapeo error → mensaje
  ao3-link.ts     encuentra y valida el link a un work de AO3 en un mensaje
  downloader.ts   wrapper del subproceso de FanFicFare
  uploader.ts     wrapper del subproceso de scp (+ chequeo de la llave SSH)
  subprocess.ts   utilidades compartidas por los dos wrappers
  config.ts       carga y valida ~/.bookcarrier/config.json
  logger.ts       logger simple (niveles + timestamps)
test/             tests con Vitest, un archivo por módulo
docs/specs/       las especificaciones (ver abajo)
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
| 2   | Cola de reintentos + arranque al iniciar sesión con launchd  | 📝 Especificada |
| 3   | Enviar un ebook o un PDF como archivo (EPUB, MOBI, PDF)      | 📝 Especificada |
| 4   | Botón “Seguir” y seguimiento de capítulos                    | Planeada        |
| 5   | Revisión diaria de capítulos nuevos                          | Planeada        |
| 6   | Comandos `/list`, `/drop`, `/status`                         | Planeada        |

## Limitaciones conocidas

- Todavía no hay cola: si la Kindle no está alcanzable el bot lo informa y **no reintenta por su cuenta**.
- Si el demonio se detiene mientras corre una descarga, ese pedido se pierde.
- Los títulos con acentos los pierden en el nombre del archivo y en el mensaje de confirmación (`Corazón` → `Coraz_n`), porque FanFicFare sanitiza los nombres de archivo.
- Solo se soportan works individuales de AO3 (no series ni colecciones).
- Los archivos enviados al bot (ebooks, PDFs) todavía no se manejan: eso es la feature 3. Por ahora el bot solo responde a links de AO3.
- El demonio todavía no arranca solo; eso llega con la feature 2.

## Una nota sobre AO3

Es una herramienta personal para tu propia lectura. Respetá los [Términos de Servicio de AO3](https://archiveofourown.org/tos) y no saturés el sitio. FanFicFare ya espera y reintenta ante errores, y Bookcarrier hace un pedido a la vez.

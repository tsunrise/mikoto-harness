# Mikoto Terminal Notify

Adds an authenticated `POST /update` capability to Mikoto Garden. Managed
commands can use it to send bounded, rate-limited notifications to Pi's UI.
The bundled `terminal-notify` skill explains when and how to call it.

## Load

Load Mikoto Policy first, Mikoto Garden second, and this package afterward:

```sh
pi \
  -e extensions/mikoto-policy \
  -e extensions/mikoto-garden \
  -e extensions/mikoto-terminal-notify
```

The implementation is contained in `index.ts`.

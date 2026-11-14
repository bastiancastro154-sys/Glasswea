# Glass Island

Isla dinámica de cristal para Windows: se queda arriba al centro de la pantalla, deja ver el escritorio
a través de ella y toma el color de la carátula de lo que suena.

- **Música**: lo que reproduzca Windows (Spotify, navegador, etc.), con carátula, progreso y controles.
- **Claude Code**: muestra si está pensando, qué herramienta usa, cuándo termina o cuándo te necesita.
- **Temporizador de enfoque**: 25 min de enfoque / 5 de descanso.
- **Volumen**: deslizador, silencio e indicador al cambiarlo.
- **Acciones rápidas**: recorte de pantalla, silenciar micrófono, bloquear equipo.
- **Apps favoritas**: hasta 10 accesos directos, configurables.

Pasa el ratón por encima para expandirla. Fuera de la isla los clics atraviesan la ventana.

## Instalación

Descarga el instalador de la última versión en la página de Releases del repositorio. La app instalada
se actualiza sola: al publicarse una versión nueva la descarga y ofrece reiniciar desde el icono de la bandeja.

## Publicar una versión

1. Sube el número de `version` en `package.json`.
2. Crea y sube una etiqueta con ese número, por ejemplo `v1.2.0`.

GitHub Actions compila el instalador y lo publica como release.

## Desarrollo (Windows 10/11, Node.js 18+)

```bash
npm install
npm start
```

Conectar Claude Code (añade hooks a `~/.claude/settings.json`, con copia de seguridad):

```bash
npm run install-hooks
```

Quitar los hooks: `npm run uninstall-hooks`. Generar un `.exe` portable: `npm run dist`.

Para abrirla sin terminal, haz doble clic en `Glass Island.vbs`.

Se cierra desde el icono de la bandeja del sistema, donde también está "Iniciar con Windows".

Si `npm start` dice "Electron failed to install correctly", ejecuta `node node_modules\electron\install.js`;
si sigue igual, descarga el zip `electron-v<versión>-win32-x64.zip` de las releases de Electron, extráelo en
`node_modules\electron\dist` y crea `node_modules\electron\path.txt` con el texto `electron.exe`.

## Vista previa sin Electron

Abre `renderer/index.html` en un navegador: carga datos de demostración.

// FadeAway - pont minimal entre l'interface et l'app Windows.
// L'interface dit à l'app quel serveur elle utilise : c'est de là que viennent les mises à jour.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fadeaway', {
  isApp: true,
  setServer: url => ipcRenderer.send('server-url', String(url)),
});

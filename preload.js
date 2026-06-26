const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
    // Fonctions de jeu
    playGame: (modded) => ipcRenderer.send('launch-game', modded),
    selectMods: () => ipcRenderer.invoke('select-mods'),
    downloadDependencies: (modded) => ipcRenderer.invoke('download-dependencies', modded),
    
    // Fonctions de connexion
    setAuthData: (data) => ipcRenderer.send('set-auth', data),
    loginMicrosoft: () => ipcRenderer.send('login-microsoft'),
    logout: () => ipcRenderer.send('logout'), // Ajouté pour le bouton déconnexion
    
    // Écouteurs pour le HTML
    onMicrosoftSuccess: (callback) => ipcRenderer.on('microsoft-success', (event, profile) => callback(profile)),
    onMicrosoftFailed: (callback) => ipcRenderer.on('microsoft-failed', (event, ...args) => callback(...args)), // Ajouté pour débloquer le bouton en cas d'erreur
    onProgress: (callback) => ipcRenderer.on('launcher-progress', (event, data) => callback(data)),
    onLog: (callback) => ipcRenderer.on('launcher-log', (event, log) => callback(log)),
    onMicrosoftDevice: (callback) => ipcRenderer.on('microsoft-device', (event, data) => callback(data)),
    onModsInstalled: (callback) => ipcRenderer.on('mods-installed', (event, data) => callback(data)),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: (downloadUrl) => ipcRenderer.invoke('download-update', downloadUrl),
    // Diagnostic ping for debugging UI→main IPC
    diagnosticPing: () => ipcRenderer.send('diagnostic-ping'),
    onDiagnosticPong: (callback) => ipcRenderer.on('diagnostic-pong', (event, data) => callback(data))
});

// Événement signalant la fin du lancement (succès/échec)
contextBridge.exposeInMainWorld('launcherAPIEvents', {
    onLaunchFinished: (callback) => ipcRenderer.on('launch-finished', (event, data) => callback(data))
});

// Expose helper to open external URLs via main
contextBridge.exposeInMainWorld('launcherAPIOpen', {
    openExternal: (url) => ipcRenderer.send('open-external', url)
});
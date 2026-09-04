const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherAPI', {
    // Fonctions de jeu
    playGame: (modded) => ipcRenderer.send('launch-game', modded),
    selectMods: () => ipcRenderer.invoke('select-mods'),
    downloadDependencies: (modded) => ipcRenderer.invoke('download-dependencies', modded),
    listInstalledMods: () => ipcRenderer.invoke('list-installed-mods'),
    setModEnabled: (payload) => ipcRenderer.invoke('set-mod-enabled', payload),
    importCurseForgePack: () => ipcRenderer.invoke('import-curseforge-pack'),
    importTLauncherProfile: () => ipcRenderer.invoke('import-tlauncher-profile'),
    exportModPack: () => ipcRenderer.invoke('export-modpack'),
    searchCurseForge: (payload) => ipcRenderer.invoke('curseforge-search', payload),
    getCurseForgeProjectFiles: (payload) => ipcRenderer.invoke('curseforge-project-files', payload),
    installCurseForgeProject: (payload) => ipcRenderer.invoke('curseforge-install-latest', payload),
    getCurseForgeKeyStatus: () => ipcRenderer.invoke('curseforge-key-status'),
    setCurseForgeKey: (payload) => ipcRenderer.invoke('set-curseforge-key', payload),
    listCustomModpacks: () => ipcRenderer.invoke('list-custom-modpacks'),
    createCustomModpack: (payload) => ipcRenderer.invoke('create-custom-modpack', payload),
    syncGithubMods: (payload) => ipcRenderer.invoke('sync-github-mods', payload),
    checkCustomModpacksUpdates: () => ipcRenderer.invoke('check-custom-modpacks-updates'),
    installCustomModpackUpdate: (payload) => ipcRenderer.invoke('install-custom-modpack-update', payload),
    getLauncherProfiles: () => ipcRenderer.invoke('get-launcher-profiles'),
    saveLauncherProfile: (payload) => ipcRenderer.invoke('save-launcher-profile', payload),
    deleteLauncherProfile: (payload) => ipcRenderer.invoke('delete-launcher-profile', payload),
    applyLauncherProfile: (payload) => ipcRenderer.invoke('apply-launcher-profile', payload),
    verifyLauncherIntegrity: () => ipcRenderer.invoke('verify-launcher-integrity'),
    getLauncherSettings: () => ipcRenderer.invoke('get-launcher-settings'),
    saveLauncherSettings: (payload) => ipcRenderer.invoke('save-launcher-settings', payload),
    fetchImageDataUrl: (payload) => ipcRenderer.invoke('fetch-image-data-url', payload),
    saveLauncherSkin: (payload) => ipcRenderer.invoke('save-launcher-skin', payload),
    getLauncherSkin: () => ipcRenderer.invoke('get-launcher-skin'),

    // Fonctions de connexion
    setAuthData: (data) => ipcRenderer.invoke('set-auth', data),
    loginEly: (payload) => ipcRenderer.invoke('login-ely', payload),
    loginMicrosoft: () => ipcRenderer.send('login-microsoft'),
    loginDiscord: () => ipcRenderer.send('login-discord'),
    logout: () => ipcRenderer.invoke('logout'), // Ajouté pour le bouton déconnexion
    getAuthState: () => ipcRenderer.invoke('get-auth-state'),
    getActiveAuths: () => ipcRenderer.invoke('get-active-auths'), // Récupère tous les auths actifs avec détails

    // NEW: JVM Settings handlers (improvement #2)
    getJVMSettings: () => ipcRenderer.invoke('get-jvm-settings'),
    saveJVMSettings: (settings) => ipcRenderer.invoke('save-jvm-settings', settings),

    // GPU selection handlers
    getGpuSettings: () => ipcRenderer.invoke('get-gpu-settings'),
    saveGpuSettings: (payload) => ipcRenderer.invoke('save-gpu-settings', payload),

    // NEW: Action History handlers (improvement #3)
    getActionHistory: () => ipcRenderer.invoke('get-action-history'),
    clearActionHistory: () => ipcRenderer.invoke('clear-action-history'),
    getRecentGameLogs: () => ipcRenderer.invoke('get-recent-game-logs'),

    // NEW: Minecraft Profiles handlers (improvement #5)
    getMinecraftProfiles: () => ipcRenderer.invoke('get-minecraft-profiles'),
    saveMinecraftProfile: (profile) => ipcRenderer.invoke('save-minecraft-profile', profile),
    deleteMinecraftProfile: (id) => ipcRenderer.invoke('delete-minecraft-profile', id),
    selectMinecraftProfile: (id) => ipcRenderer.invoke('select-minecraft-profile', id),

    // NEW: System stats handlers (improvement #8 - Performance Monitor)
    getSystemStats: () => ipcRenderer.invoke('get-system-stats'),

    // Écouteurs pour le HTML
    onMicrosoftSuccess: (callback) => ipcRenderer.on('microsoft-success', (event, profile) => callback(profile)),
    onMicrosoftFailed: (callback) => ipcRenderer.on('microsoft-failed', (event, ...args) => callback(...args)), // Ajouté pour débloquer le bouton en cas d'erreur
    onDiscordSuccess: (callback) => ipcRenderer.on('discord-success', (event, profile) => callback(profile)),
    onDiscordFailed: (callback) => ipcRenderer.on('discord-failed', (event, error) => callback(error)),
    onActiveAuthsUpdated: (callback) => ipcRenderer.on('update-active-auths', (event, authTypes) => callback(authTypes)),
    onProgress: (callback) => ipcRenderer.on('launcher-progress', (event, data) => callback(data)),
    onDownloadStatus: (callback) => ipcRenderer.on('launcher-download-status', (event, data) => callback(data)),
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
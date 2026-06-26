const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const axios = require('axios');
const unzipper = require('unzipper');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc'); 

const launcher = new Client();
let mainWindow;
let userAuth = null; 
let loginInProgress = false;
const modsFolderPath = path.join(__dirname, '.mon-launcher', 'mods');
const appModsPath = path.join(__dirname, 'mods');

const authFilePath = path.join(__dirname, '.mon-launcher', 'auth.json');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000, height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.setMenuBarVisibility(false); 
    mainWindow.loadFile('index.html');
    // Ouvrir les DevTools pour debugging
    try { mainWindow.webContents.openDevTools({ mode: 'detach' }); } catch (e) { console.log('Impossible d ouvrir DevTools :', e); }

    mainWindow.webContents.on('did-finish-load', async () => {
        try {
            const syncedMods = syncModsFromAppFolder();
            if (syncedMods.length) {
                mainWindow.webContents.send('mods-installed', { installed: syncedMods, folder: modsFolderPath });
            }
            if (fs.existsSync(authFilePath)) {
                const savedData = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
                if (savedData.type === 'crack') {
                    userAuth = Authenticator.getAuth(savedData.pseudo);
                    mainWindow.webContents.send('microsoft-success', { name: userAuth.name, type: 'crack' });
                } else if (savedData.type === 'microsoft' && savedData.token) {
                    const authManager = new Auth("select_account");
                    const xboxManager = await authManager.refresh(savedData.token);
                    const token = await xboxManager.getMinecraft();
                    userAuth = token.mclc();
                    fs.writeFileSync(authFilePath, JSON.stringify({ type: 'microsoft', token: xboxManager.save() }), 'utf-8');
                    mainWindow.webContents.send('microsoft-success', { name: userAuth.name, type: 'microsoft' });
                }
            }
        } catch (err) { console.log("Auto-auth impossible : " + err); }
    });
}

app.whenReady().then(createWindow);

function findSystemJava() {
    const result = spawnSync('where', ['java'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout) {
        const paths = result.stdout.split('\r\n').map(p => p.trim()).filter(Boolean);
        if (paths.length) return paths[0];
    }
    return null;
}

async function downloadJavaExecutable() {
    const javaDir = path.join(__dirname, '.mon-launcher', 'java21');
    const javaExePath = path.join(javaDir, 'bin', 'java.exe');
    if (fs.existsSync(javaExePath)) return javaExePath;
    const url = "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk";
    const zipPath = path.join(__dirname, '.mon-launcher', 'java21.zip');
    if (!fs.existsSync(path.join(__dirname, '.mon-launcher'))) fs.mkdirSync(path.join(__dirname, '.mon-launcher'), { recursive: true });
    const writer = fs.createWriteStream(zipPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: javaDir })).promise();
    fs.unlinkSync(zipPath); 
    const subDirs = fs.readdirSync(javaDir);
    const extractedFolder = path.join(javaDir, subDirs[0]);
    fs.cpSync(extractedFolder, javaDir, { recursive: true });
    fs.rmSync(extractedFolder, { recursive: true, force: true });
    return javaExePath;
}

async function downloadNeoForgeInstaller() {
    const forgeDir = path.join(__dirname, '.mon-launcher');
    const forgePath = path.join(forgeDir, 'neoforge-installer.jar');
    if (fs.existsSync(forgePath)) return forgePath; 
    if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });
    const url = "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.233/neoforge-21.1.233-installer.jar";
    const writer = fs.createWriteStream(forgePath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    return forgePath;
}

const UPDATE_INFO_URL = "https://raw.githubusercontent.com/leomenard56-cell/mon-launcher-mc/main/update.json";
const UPDATE_DOWNLOAD_DIR = path.join(__dirname, '.mon-launcher', 'updates');

function compareVersions(v1, v2) {
    const a = String(v1).split('.').map(Number);
    const b = String(v2).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const na = a[i] || 0;
        const nb = b[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

async function fetchUpdateMetadata() {
    const response = await axios.get(UPDATE_INFO_URL, { timeout: 15000 });
    return response.data;
}

async function downloadUpdateInstaller(url) {
    if (!fs.existsSync(UPDATE_DOWNLOAD_DIR)) fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    const installerPath = path.join(UPDATE_DOWNLOAD_DIR, 'latest-updater.exe');
    const writer = fs.createWriteStream(installerPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    return installerPath;
}

ipcMain.handle('check-for-updates', async () => {
    try {
        const metadata = await fetchUpdateMetadata();
        if (!metadata || !metadata.version || !metadata.downloadUrl) {
            return { success: false, message: 'Méta de mise à jour invalide.' };
        }
        const currentVersion = app.getVersion();
        const isNewer = compareVersions(metadata.version, currentVersion) === 1;
        return {
            success: true,
            available: isNewer,
            currentVersion,
            latestVersion: metadata.version,
            notes: metadata.notes || '',
            downloadUrl: metadata.downloadUrl
        };
    } catch (error) {
        return { success: false, message: error.message || String(error) };
    }
});

ipcMain.handle('download-update', async (event, downloadUrl) => {
    try {
        if (!downloadUrl) return { success: false, message: 'URL de téléchargement manquante.' };
        const installerPath = await downloadUpdateInstaller(downloadUrl);
        await shell.openPath(installerPath);
        return { success: true, installerPath };
    } catch (error) {
        return { success: false, message: error.message || String(error) };
    }
});

function syncModsFromAppFolder() {
    if (!fs.existsSync(appModsPath)) return [];
    if (!fs.existsSync(modsFolderPath)) fs.mkdirSync(modsFolderPath, { recursive: true });
    const files = fs.readdirSync(appModsPath)
        .filter(name => name.toLowerCase().endsWith('.jar') || name.toLowerCase().endsWith('.zip'));
    const installed = [];
    for (const file of files) {
        try {
            const src = path.join(appModsPath, file);
            const dest = path.join(modsFolderPath, file);
            if (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
                fs.copyFileSync(src, dest);
                installed.push({ name: file, path: dest });
            }
        } catch (err) {
            console.error('Erreur syncModsFromAppFolder:', err);
        }
    }
    return installed;
}

ipcMain.handle('download-dependencies', async (event, useForge = false) => {
    try {
        const javaPath = findSystemJava();
        let installedJava = false;
        let javaResult = javaPath;
        if (!javaPath) {
            mainWindow.webContents.send('launcher-log', 'Java non trouvé : téléchargement de Java 21 en cours...');
            javaResult = await downloadJavaExecutable();
            installedJava = true;
        } else {
            mainWindow.webContents.send('launcher-log', `Java trouvé : ${javaPath}`);
        }
        let forgeResult = null;
        if (useForge) {
            mainWindow.webContents.send('launcher-log', 'Téléchargement de NeoForge en cours...');
            forgeResult = await downloadNeoForgeInstaller();
        }
        return { success: true, javaPath: javaResult, installedJava, forgePath: forgeResult };
    } catch (err) {
        console.error('Erreur download-dependencies :', err);
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.on('set-auth', (event, data) => {
    if (data.type === 'crack') {
        userAuth = Authenticator.getAuth(data.pseudo);
        if (!fs.existsSync(path.dirname(authFilePath))) fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
        fs.writeFileSync(authFilePath, JSON.stringify({ type: 'crack', pseudo: data.pseudo }), 'utf-8');
    }
});

ipcMain.on('login-microsoft', async (event) => {
    console.log('[IPC] login-microsoft reçu');
    if (loginInProgress) {
        console.log('[IPC] Une tentative de connexion est déjà en cours. Ignoré.');
        return mainWindow.webContents.send('launcher-log', 'Connexion déjà en cours...');
    }
    loginInProgress = true;
    const authManager = new Auth("select_account");
    try {
        mainWindow.webContents.send('launcher-log', 'Démarrage connexion Microsoft...');
        mainWindow.webContents.send('launcher-log', 'Ouverture du navigateur système pour connexion...');
        const systemManager = await authManager.launch('system');
        if (!systemManager || typeof systemManager.getMinecraft !== 'function') {
            throw new Error('Impossible d\'initialiser le gestionnaire de connexion Microsoft.');
        }
        const token = await systemManager.getMinecraft();
        if (!token || typeof token.mclc !== 'function') {
            throw new Error('Aucun token Microsoft valide reçu.');
        }
        userAuth = token.mclc();
        if (!userAuth || !userAuth.name) {
            throw new Error('Impossible de récupérer le profil Microsoft après connexion.');
        }
        if (!fs.existsSync(path.dirname(authFilePath))) fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
        fs.writeFileSync(authFilePath, JSON.stringify({ type: 'microsoft', token: systemManager.save ? systemManager.save() : null }), 'utf-8');
        mainWindow.webContents.send('launcher-log', 'Connexion Microsoft réussie pour: ' + userAuth.name);
        mainWindow.webContents.send('microsoft-success', { name: userAuth.name, type: 'microsoft' });
        return;
    } catch (error) {
        const errMsg = error && error.stack ? error.stack : (error && error.message ? error.message : String(error));
        console.error('[Erreur Microsoft]', errMsg);
        mainWindow.webContents.send('launcher-log', '[Erreur Microsoft] : ' + errMsg);
        mainWindow.webContents.send('launcher-log', 'Tentative fallback avec device-code...');
        try {
            const deviceManager = await authManager.launch('device');
            const code = deviceManager.user_code || deviceManager.userCode || deviceManager.code || deviceManager.userCode;
            const verificationUri = deviceManager.verification_uri || deviceManager.verificationUri || deviceManager.verificationUrl || 'https://microsoft.com/devicelogin';
            mainWindow.webContents.send('microsoft-device', { code, verificationUri });
            const token = await deviceManager.getMinecraft();
            if (!token || typeof token.mclc !== 'function') {
                throw new Error('Aucun token device valide reçu.');
            }
            userAuth = token.mclc();
            if (!userAuth || !userAuth.name) {
                throw new Error('Impossible de récupérer le profil Microsoft après device login.');
            }
            if (!fs.existsSync(path.dirname(authFilePath))) fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
            fs.writeFileSync(authFilePath, JSON.stringify({ type: 'microsoft', token: deviceManager.save ? deviceManager.save() : null }), 'utf-8');
            mainWindow.webContents.send('launcher-log', 'Connexion Microsoft (device) réussie pour: ' + userAuth.name);
            mainWindow.webContents.send('microsoft-success', { name: userAuth.name, type: 'microsoft' });
            return;
        } catch (devErr) {
            const devMsg = devErr && devErr.stack ? devErr.stack : (devErr && devErr.message ? devErr.message : String(devErr));
            console.error('[Device flow] Erreur :', devMsg);
            mainWindow.webContents.send('launcher-log', '[Device flow] Erreur : ' + devMsg);
            mainWindow.webContents.send('microsoft-device', { code: null, verificationUri: 'https://microsoft.com/devicelogin' });
            mainWindow.webContents.send('microsoft-failed', devMsg);
            return;
        }
    } finally {
        loginInProgress = false;
    }
});

ipcMain.on('logout', () => {
    userAuth = null;
    if (fs.existsSync(authFilePath)) fs.unlinkSync(authFilePath);
});

ipcMain.handle('select-mods', async () => {
    try {
        if (!fs.existsSync(modsFolderPath)) fs.mkdirSync(modsFolderPath, { recursive: true });
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Sélectionnez des mods à installer',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Mods Minecraft', extensions: ['jar', 'zip'] }
            ]
        });
        if (result.canceled) return { canceled: true };
        const installed = [];
        for (const file of result.filePaths) {
            try {
                const fileName = path.basename(file);
                const dest = path.join(modsFolderPath, fileName);
                fs.copyFileSync(file, dest);
                installed.push({ name: fileName, path: dest });
            } catch (copyErr) {
                console.error('Erreur copie mod:', copyErr);
            }
        }
        mainWindow.webContents.send('mods-installed', { installed, folder: modsFolderPath });
        return { canceled: false, installed };
    } catch (err) {
        console.error('Erreur select-mods:', err);
        return { canceled: true, error: err.message || String(err) };
    }
});

ipcMain.on('open-external', (event, url) => {
    try { shell.openExternal(url); } catch (e) { console.error('open-external failed', e); }
});

ipcMain.on('launch-game', async (event, useForge = false) => {
    if (!userAuth) return mainWindow.webContents.send('launcher-log', "Erreur : Connectez-vous !");
    const syncedMods = syncModsFromAppFolder();
    if (syncedMods.length) {
        mainWindow.webContents.send('mods-installed', { installed: syncedMods, folder: modsFolderPath });
    }
    const javaPath = findSystemJava();
    if (!javaPath) {
        mainWindow.webContents.send('launcher-log', 'Java introuvable. Cliquez sur Télécharger pour installer Java et NeoForge.' );
        return;
    }
    mainWindow.webContents.send('launcher-log', `Java trouvé : ${javaPath}`);

    let opts = {
        clientPackage: null,
        authorization: userAuth, 
        root: "./.mon-launcher",                             
        version: { number: "1.21.1", type: "release" },
        javaPath: javaPath, 
        memory: { max: "6G", min: "2G" }
    };
    if (useForge) {
        const forgePath = await downloadNeoForgeInstaller();
        opts.forge = forgePath;
        mainWindow.webContents.send('launcher-log', 'Mode moddé activé : utilisation de Forge.');
    } else {
        mainWindow.webContents.send('launcher-log', 'Lancement en mode vanilla (sans Forge / mods).');
    }
    launcher.on('progress', (e) => mainWindow.webContents.send('launcher-progress', e));
    await launcher.launch(opts);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
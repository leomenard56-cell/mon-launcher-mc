const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const axios = require('axios');
const unzipper = require('unzipper');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc'); 

const launcher = new Client();
let mainWindow;
let userAuth = null; 
let loginInProgress = false;
let gameLaunchInProgress = false;
const launcherDataPath = path.join(app.getPath('userData'), '.mon-launcher');
const modsFolderPath = path.join(launcherDataPath, 'mods');
const appModsPath = path.join(__dirname, 'mods');

const authFilePath = path.join(launcherDataPath, 'auth.json');
const curseForgeKeyFilePath = path.join(launcherDataPath, 'curseforge_api_key.txt');
const customModpacksFilePath = path.join(launcherDataPath, 'custom_modpacks.json');
const updateUrlFilePath = path.join(launcherDataPath, 'update_url.txt');
const launcherSettingsFilePath = path.join(launcherDataPath, 'launcher_settings.json');
const UPDATE_URL_PLACEHOLDER = 'https://PASTE_PUBLIC_UPDATE_JSON_URL_HERE';
const DEFAULT_LAUNCHER_SETTINGS = {
    windowWidth: 1000,
    windowHeight: 600,
    minecraftRamGb: 6
};

function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function ensureLauncherDataDirectories() {
    ensureDirectory(launcherDataPath);
    ensureDirectory(modsFolderPath);
}

function normalizeLauncherSettings(rawSettings = {}) {
    const width = Number(rawSettings.windowWidth);
    const height = Number(rawSettings.windowHeight);
    const ramGb = Number(rawSettings.minecraftRamGb);
    return {
        windowWidth: Number.isFinite(width) ? Math.min(2560, Math.max(820, Math.round(width))) : DEFAULT_LAUNCHER_SETTINGS.windowWidth,
        windowHeight: Number.isFinite(height) ? Math.min(1600, Math.max(560, Math.round(height))) : DEFAULT_LAUNCHER_SETTINGS.windowHeight,
        minecraftRamGb: Number.isFinite(ramGb) ? Math.min(32, Math.max(2, Math.round(ramGb))) : DEFAULT_LAUNCHER_SETTINGS.minecraftRamGb
    };
}

function readLauncherSettings() {
    ensureLauncherDataDirectories();
    if (!fs.existsSync(launcherSettingsFilePath)) {
        return { ...DEFAULT_LAUNCHER_SETTINGS };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(launcherSettingsFilePath, 'utf-8'));
        return { ...DEFAULT_LAUNCHER_SETTINGS, ...normalizeLauncherSettings(raw) };
    } catch (_) {
        return { ...DEFAULT_LAUNCHER_SETTINGS };
    }
}

function writeLauncherSettings(rawSettings) {
    const normalized = normalizeLauncherSettings(rawSettings);
    ensureLauncherDataDirectories();
    fs.writeFileSync(launcherSettingsFilePath, JSON.stringify(normalized, null, 2), 'utf-8');
    return normalized;
}

function copyDirectoryContents(sourceDir, destinationDir) {
    if (!fs.existsSync(sourceDir)) return [];
    ensureDirectory(destinationDir);
    const copied = [];
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const destinationPath = path.join(destinationDir, entry.name);
        if (entry.isDirectory()) {
            copied.push(...copyDirectoryContents(sourcePath, destinationPath));
        } else {
            fs.copyFileSync(sourcePath, destinationPath);
            copied.push(destinationPath);
        }
    }
    return copied;
}

function getModEntryInfo(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (lower.endsWith('.jar') || lower.endsWith('.zip')) {
        return { displayName: fileName, enabled: true };
    }
    if (lower.endsWith('.jar.disabled') || lower.endsWith('.zip.disabled')) {
        return { displayName: fileName.slice(0, -'.disabled'.length), enabled: false };
    }
    return null;
}

function listInstalledModFiles() {
    if (!fs.existsSync(modsFolderPath)) return [];
    return fs.readdirSync(modsFolderPath)
        .map(name => {
            const modInfo = getModEntryInfo(name);
            if (!modInfo) return null;
            const filePath = path.join(modsFolderPath, name);
            const stat = fs.statSync(filePath);
            return {
                name: modInfo.displayName,
                fileName: name,
                enabled: modInfo.enabled,
                path: filePath,
                size: stat.size,
                modified: stat.mtimeMs
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getCurseForgeApiKey() {
    const fromEnv = (process.env.CURSEFORGE_API_KEY || '').trim();
    if (fromEnv) return fromEnv;
    if (!fs.existsSync(curseForgeKeyFilePath)) return null;
    const fromFile = String(fs.readFileSync(curseForgeKeyFilePath, 'utf-8') || '').trim();
    if (!fromFile || fromFile === 'PASTE_CURSEFORGE_API_KEY_HERE') return null;
    return fromFile;
}

function getSafeFileNameFromUrl(downloadUrl, fallback) {
    try {
        const urlObj = new URL(downloadUrl);
        const raw = decodeURIComponent(path.basename(urlObj.pathname));
        if (raw && !raw.includes('..') && !raw.includes('/')) return raw;
    } catch (_) {
        // ignore parsing error and use fallback
    }
    return fallback;
}

async function downloadCurseForgeModFile(projectId, fileId, apiKey) {
    const headers = { 'x-api-key': apiKey, Accept: 'application/json' };
    const urlResp = await axios.get(`https://api.curseforge.com/v1/mods/${projectId}/files/${fileId}/download-url`, {
        headers,
        timeout: 20000
    });
    const downloadUrl = urlResp && urlResp.data && urlResp.data.data ? String(urlResp.data.data) : null;
    if (!downloadUrl) throw new Error(`URL introuvable pour mod ${projectId}/${fileId}`);

    ensureDirectory(modsFolderPath);
    const fallbackName = `curseforge-${projectId}-${fileId}.jar`;
    const targetName = getSafeFileNameFromUrl(downloadUrl, fallbackName);
    const targetPath = path.join(modsFolderPath, targetName);

    const response = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: 60000
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(targetPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    return { name: targetName, path: targetPath };
}

async function fetchCurseForgeJson(endpoint, apiKey, params = {}) {
    const headers = { 'x-api-key': apiKey, Accept: 'application/json' };
    const response = await axios.get(`https://api.curseforge.com/v1${endpoint}`, {
        headers,
        params,
        timeout: 20000
    });
    return response && response.data ? response.data.data : null;
}

async function findLatestCurseForgeFile(projectId, gameVersion, apiKey) {
    const files = await fetchCurseForgeJson(`/mods/${projectId}/files`, apiKey, {
        gameVersion: gameVersion || '1.21.1',
        pageSize: 20,
        index: 0
    });
    if (!Array.isArray(files) || !files.length) return null;
    const sorted = [...files].sort((a, b) => {
        const aDate = new Date(a && a.fileDate ? a.fileDate : 0).getTime();
        const bDate = new Date(b && b.fileDate ? b.fileDate : 0).getTime();
        return bDate - aDate;
    });
    return sorted[0] || null;
}

async function importCurseForgePackFromZip(zipPath) {
    const tempDir = await extractZipToTemp(zipPath, 'curseforge-');
    const manifest = readManifestIfPresent(tempDir);
    const overridesDir = path.join(tempDir, 'overrides');

    const importedFiles = [];
    const importRoots = [overridesDir, tempDir];
    for (const root of importRoots) {
        if (!fs.existsSync(root)) continue;
        for (const folderName of ['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks']) {
            const sourceFolder = path.join(root, folderName);
            if (fs.existsSync(sourceFolder)) {
                importedFiles.push(...copyDirectoryContents(sourceFolder, path.join(launcherDataPath, folderName)));
            }
        }
    }

    const remoteFiles = manifest && Array.isArray(manifest.files)
        ? manifest.files.filter(f => f && f.projectID && f.fileID && f.required !== false)
        : [];
    const apiKey = getCurseForgeApiKey();
    const downloadedMods = [];
    const failedDownloads = [];

    if (remoteFiles.length && apiKey) {
        for (const fileRef of remoteFiles) {
            const projectId = Number(fileRef.projectID);
            const fileId = Number(fileRef.fileID);
            if (!Number.isFinite(projectId) || !Number.isFinite(fileId)) continue;
            try {
                mainWindow.webContents.send('launcher-log', `CurseForge: téléchargement mod ${projectId}/${fileId}...`);
                const downloaded = await downloadCurseForgeModFile(projectId, fileId, apiKey);
                downloadedMods.push(downloaded);
            } catch (downloadErr) {
                failedDownloads.push({
                    projectID: projectId,
                    fileID: fileId,
                    error: downloadErr && downloadErr.message ? downloadErr.message : String(downloadErr)
                });
            }
        }
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
    const remoteFileCount = manifest && Array.isArray(manifest.files) ? manifest.files.length : 0;
    mainWindow.webContents.send('mods-installed', { installed: listInstalledModFiles(), folder: modsFolderPath });

    let message = `${importedFiles.length} fichiers importés depuis le pack.`;
    if (remoteFiles.length && !apiKey) {
        message += ` ${remoteFiles.length} dépendances CurseForge détectées, ajoute une clé API pour téléchargement auto.`;
    } else if (remoteFiles.length && apiKey) {
        message += ` ${downloadedMods.length}/${remoteFiles.length} mods CurseForge téléchargés.`;
        if (failedDownloads.length) {
            message += ` ${failedDownloads.length} échec(s) (voir logs).`;
        }
    }

    return {
        success: true,
        packName: manifest && manifest.name ? manifest.name : path.basename(zipPath, '.zip'),
        manifestType: manifest && manifest.manifestType ? manifest.manifestType : null,
        remoteFiles: remoteFileCount,
        importedFiles: importedFiles.length,
        downloadedMods: downloadedMods.length,
        failedDownloads,
        message
    };
}

function importTLauncherProfileFrom(sourceRoot) {
    ensureLauncherDataDirectories();
    const sourceDir = path.resolve(String(sourceRoot || '').trim());
    if (!sourceDir || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        throw new Error('Dossier source TLauncher invalide.');
    }

    const importedFolders = [];
    const importedFiles = [];
    const folderNames = ['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks'];
    const fileNames = ['options.txt', 'optionsof.txt', 'servers.dat', 'launcher_profiles.json', 'tl_skin_cape.json', 'tlauncher_profiles.json'];

    for (const folderName of folderNames) {
        const sourceFolder = path.join(sourceDir, folderName);
        if (!fs.existsSync(sourceFolder) || !fs.statSync(sourceFolder).isDirectory()) continue;
        const copied = copyDirectoryContents(sourceFolder, path.join(launcherDataPath, folderName));
        importedFolders.push({ name: folderName, count: copied.length });
    }

    for (const fileName of fileNames) {
        const sourceFile = path.join(sourceDir, fileName);
        if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) continue;
        const destinationFile = path.join(launcherDataPath, fileName);
        fs.copyFileSync(sourceFile, destinationFile);
        importedFiles.push(fileName);
    }

    return {
        sourceDir,
        importedFolders,
        importedFiles,
        importedFolderCount: importedFolders.reduce((sum, row) => sum + Number(row.count || 0), 0)
    };
}

async function extractZipToTemp(zipPath, prefix = 'pack-') {
    ensureDirectory(launcherDataPath);
    const tempDir = fs.mkdtempSync(path.join(launcherDataPath, prefix));
    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: tempDir })).promise();
    return tempDir;
}

function readManifestIfPresent(rootDir) {
    const manifestPath = path.join(rootDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
        return { parseError: err.message || String(err) };
    }
}

async function createPackZipFromLauncherData(destinationPath, packName) {
    ensureLauncherDataDirectories();
    const stagingDir = fs.mkdtempSync(path.join(launcherDataPath, 'export-'));
    const overridesDir = path.join(stagingDir, 'overrides');
    ensureDirectory(overridesDir);

    const exportFolders = ['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks', 'saves'];
    const exportedFolders = [];
    for (const folder of exportFolders) {
        const sourcePath = path.join(launcherDataPath, folder);
        if (fs.existsSync(sourcePath)) {
            copyDirectoryContents(sourcePath, path.join(overridesDir, folder));
            exportedFolders.push(folder);
        }
    }

    const manifest = {
        minecraft: {
            version: '1.21.1',
            modLoaders: [{ id: 'neoforge-21.1.233', primary: true }]
        },
        manifestType: 'minecraftModpack',
        manifestVersion: 1,
        name: packName,
        version: '1.0.0',
        author: 'Mon Launcher MC',
        overrides: 'overrides',
        exportedFolders
    };
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    const safeStaging = stagingDir.replace(/'/g, "''");
    const safeDestination = destinationPath.replace(/'/g, "''");
    const psScript = [
        "$ErrorActionPreference = 'Stop'",
        `if (Test-Path -LiteralPath '${safeDestination}') { Remove-Item -LiteralPath '${safeDestination}' -Force }`,
        `Compress-Archive -Path '${safeStaging}\\*' -DestinationPath '${safeDestination}' -Force`
    ].join('; ');

    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
        encoding: 'utf8',
        windowsHide: true
    });

    fs.rmSync(stagingDir, { recursive: true, force: true });

    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || 'Compression du pack impossible.');
    }

    return { exportedFolders };
}

function createWindow() {
    const launcherSettings = readLauncherSettings();
    mainWindow = new BrowserWindow({
        width: launcherSettings.windowWidth,
        height: launcherSettings.windowHeight,
        title: 'KuroVerse',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.setMenuBarVisibility(false); 
    mainWindow.loadFile('index.html');

    mainWindow.webContents.on('did-finish-load', async () => {
        try {
            const syncedMods = syncModsFromAppFolder();
            if (syncedMods.length) {
                mainWindow.webContents.send('mods-installed', { installed: syncedMods, folder: modsFolderPath });
            }
            if (fs.existsSync(authFilePath)) {
                const savedData = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
                if (savedData.type === 'crack') {
                    const offlinePseudo = String(savedData.pseudo || '').trim();
                    userAuth = Authenticator.getAuth(offlinePseudo);
                    const displayName = (userAuth && userAuth.name ? String(userAuth.name).trim() : '') || offlinePseudo || 'Joueur';
                    mainWindow.webContents.send('microsoft-success', { name: displayName, type: 'crack' });
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

const REQUIRED_JAVA_MAJOR = 21;

function probeJavaExecutable(javaPath) {
    try {
        const probe = spawnSync(javaPath, ['-version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000
        });
        const combined = `${probe && probe.stdout ? probe.stdout : ''}\n${probe && probe.stderr ? probe.stderr : ''}`;
        const match = combined.match(/version\s+"(\d+)(?:\.(\d+))?/i);
        const major = match ? Number(match[1]) : null;
        const valid = !!probe && probe.status === 0;
        return { valid, major, raw: combined.trim() };
    } catch (_) {
        return { valid: false, major: null, raw: '' };
    }
}

function findSystemJava() {
    const result = spawnSync('where', ['java'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0 && result.stdout) {
        const paths = result.stdout.split('\r\n').map(p => p.trim()).filter(Boolean);
        for (const candidate of paths) {
            const info = probeJavaExecutable(candidate);
            if (info.valid && info.major && info.major >= REQUIRED_JAVA_MAJOR) return candidate;
        }
    }

    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const javaFromHome = path.join(javaHome, 'bin', 'java.exe');
        if (fs.existsSync(javaFromHome)) {
            const info = probeJavaExecutable(javaFromHome);
            if (info.valid && info.major && info.major >= REQUIRED_JAVA_MAJOR) return javaFromHome;
        }
    }

    return null;
}

function findBundledJava() {
    const bundledJava = path.join(launcherDataPath, 'java21', 'bin', 'java.exe');
    if (fs.existsSync(bundledJava)) {
        const info = probeJavaExecutable(bundledJava);
        if (info.valid && info.major && info.major >= REQUIRED_JAVA_MAJOR) return bundledJava;
    }
    return null;
}

async function resolveJavaPath(autoDownload = false) {
    const systemJava = findSystemJava();
    if (systemJava) return { javaPath: systemJava, source: 'system', installedNow: false };

    const bundledJava = findBundledJava();
    if (bundledJava) return { javaPath: bundledJava, source: 'bundled', installedNow: false };

    if (!autoDownload) return { javaPath: null, source: null, installedNow: false };

    const downloadedJava = await downloadJavaExecutable();
    return { javaPath: downloadedJava, source: 'downloaded', installedNow: true };
}

async function downloadJavaExecutable() {
    const javaDir = path.join(launcherDataPath, 'java21');
    const javaExePath = path.join(javaDir, 'bin', 'java.exe');
    if (fs.existsSync(javaExePath)) return javaExePath;
    const url = "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk";
    const zipPath = path.join(launcherDataPath, 'java21.zip');
    if (!fs.existsSync(launcherDataPath)) fs.mkdirSync(launcherDataPath, { recursive: true });
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
    const forgeDir = launcherDataPath;
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

const DEFAULT_UPDATE_INFO_URL = "https://raw.githubusercontent.com/leomenard56-cell/mon-launcher-mc/main/update.json";
const UPDATE_DOWNLOAD_DIR = path.join(launcherDataPath, 'updates');

function getUpdateInfoUrl() {
    const envUrl = (process.env.MON_LAUNCHER_UPDATE_URL || '').trim();
    if (envUrl && !/paste_public_update_json_url_here/i.test(envUrl)) return envUrl;
    if (fs.existsSync(updateUrlFilePath)) {
        const fileUrl = String(fs.readFileSync(updateUrlFilePath, 'utf-8') || '').trim();
        if (fileUrl && !/paste_public_update_json_url_here/i.test(fileUrl)) return fileUrl;
    }
    return DEFAULT_UPDATE_INFO_URL;
}

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
    try {
        const updateInfoUrl = getUpdateInfoUrl();
        if (!updateInfoUrl || updateInfoUrl === UPDATE_URL_PLACEHOLDER) {
            throw new Error(`Aucune URL de mise à jour configurée. Mets une vraie URL publique dans ${updateUrlFilePath}.`);
        }
        const response = await axios.get(updateInfoUrl, { timeout: 15000 });
        return response.data;
    } catch (error) {
        const status = error && error.response ? Number(error.response.status) : 0;
        if (status === 404) {
            throw new Error(`update.json introuvable en ligne. Mets une URL publique dans ${updateUrlFilePath} ou publie le fichier sur une URL accessible.`);
        }
        if (error && /ENOTFOUND/i.test(String(error.message || error))) {
            throw new Error(`URL de mise à jour invalide. Remplace le contenu de ${updateUrlFilePath} par une vraie URL publique vers update.json.`);
        }
        throw error;
    }
}

async function downloadUpdateInstaller(url, onProgress) {
    if (!fs.existsSync(UPDATE_DOWNLOAD_DIR)) fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    const installerPath = path.join(UPDATE_DOWNLOAD_DIR, 'latest-updater.exe');
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 180000,
            maxRedirects: 10
        });
        const totalBytes = Number(response && response.headers && response.headers['content-length'] ? response.headers['content-length'] : 0);

        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(installerPath);
            let settled = false;
            let downloadedBytes = 0;
            let stallTimer = null;

            const cleanup = () => {
                if (stallTimer) clearTimeout(stallTimer);
                stallTimer = null;
                writer.removeAllListeners();
                response.data.removeAllListeners('data');
                response.data.removeAllListeners('error');
            };

            const fail = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                try { response.data.destroy(); } catch (_) { }
                try { writer.destroy(); } catch (_) { }
                reject(err);
            };

            const armStallTimer = () => {
                if (stallTimer) clearTimeout(stallTimer);
                stallTimer = setTimeout(() => {
                    fail(new Error('DOWNLOAD_STALL_TIMEOUT: aucun progrès de téléchargement.'));
                }, 25000);
            };

            armStallTimer();
            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                armStallTimer();
                if (typeof onProgress === 'function') {
                    onProgress({ current: downloadedBytes, total: totalBytes, files: 1, name: 'update-installer' });
                }
            });

            response.data.on('error', fail);
            writer.on('error', fail);
            writer.on('finish', () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            });

            response.data.pipe(writer);
        });

        return installerPath;
    } catch (error) {
        const status = error && error.response ? Number(error.response.status) : 0;
        if (status === 404) {
            throw new Error("Le fichier .exe de mise à jour est introuvable en ligne. Vérifie la release GitHub et l'URL dans update.json.");
        }
        throw error;
    }
}

function normalizeManifestUrl(inputUrl) {
    if (!inputUrl) return '';
    let url = String(inputUrl).trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    try {
        const u = new URL(url);
        // Convert GitHub blob links to raw links automatically.
        if (u.hostname.toLowerCase() === 'github.com') {
            const parts = u.pathname.split('/').filter(Boolean);
            // /owner/repo/blob/branch/path/to/file.json
            if (parts.length >= 5 && parts[2] === 'blob') {
                const owner = parts[0];
                const repo = parts[1];
                const branch = parts[3];
                const rest = parts.slice(4).join('/');
                return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest}`;
            }
        }
        return u.toString();
    } catch (_) {
        return url;
    }
}

function readCustomModpacks() {
    ensureLauncherDataDirectories();
    if (!fs.existsSync(customModpacksFilePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(customModpacksFilePath, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function writeCustomModpacks(entries) {
    ensureLauncherDataDirectories();
    fs.writeFileSync(customModpacksFilePath, JSON.stringify(entries, null, 2), 'utf-8');
}

function upsertCustomModpackEntry(entry) {
    const existing = readCustomModpacks();
    const idx = existing.findIndex(e => e && e.id === entry.id);
    if (idx >= 0) existing[idx] = entry;
    else existing.push(entry);
    writeCustomModpacks(existing);
    return entry;
}

async function downloadFileToPath(url, destinationPath) {
    ensureDirectory(path.dirname(destinationPath));
    const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 90000 });
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destinationPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    return destinationPath;
}

async function getCustomModpackRemoteMeta(entry) {
    if (!entry || !entry.manifestUrl) return null;
    const manifestUrl = normalizeManifestUrl(entry.manifestUrl);
    const response = await axios.get(manifestUrl, { timeout: 20000 });
    let body = response && response.data ? response.data : null;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch (_) {
            return null;
        }
    }
    if (!body || !body.version || !body.downloadUrl) return null;
    const resolvedDownloadUrl = new URL(String(body.downloadUrl), manifestUrl).toString();
    return {
        version: String(body.version),
        downloadUrl: resolvedDownloadUrl,
        notes: body.notes ? String(body.notes) : '',
        name: body.name ? String(body.name) : entry.name
    };
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
        const installerPath = await downloadUpdateInstaller(downloadUrl, (progress) => {
            try {
                mainWindow.webContents.send('launcher-download-status', progress);
            } catch (_) { }
        });

        let launchError = '';
        try {
            const child = spawn(installerPath, [], {
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });
            child.unref();
        } catch (spawnErr) {
            launchError = spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr);
        }

        if (launchError) {
            const shellResult = await shell.openPath(installerPath);
            if (shellResult) {
                return {
                    success: false,
                    message: `Installateur téléchargé mais impossible de le lancer automatiquement. Fichier: ${installerPath}. Erreur: ${launchError || shellResult}`
                };
            }
        }

        setTimeout(() => {
            try { app.quit(); } catch (_) { }
        }, 1200);

        return {
            success: true,
            installerPath,
            message: 'Installateur lancé. Le launcher va se fermer pour appliquer la mise à jour.'
        };
    } catch (error) {
        const rawError = String(error && error.message ? error.message : error);
        const canFallbackToBrowser = /DOWNLOAD_STALL_TIMEOUT|timeout|ECONNABORTED|ETIMEDOUT/i.test(rawError);
        if (canFallbackToBrowser) {
            try {
                await shell.openExternal(downloadUrl);
                return {
                    success: true,
                    installerPath: null,
                    message: 'Le téléchargement direct est bloqué. Ouverture du lien dans le navigateur pour finir la mise à jour.'
                };
            } catch (_) { }
        }
        return { success: false, message: rawError };
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
            const disabledDest = `${dest}.disabled`;
            if (fs.existsSync(disabledDest)) continue;
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
        const javaInfo = await resolveJavaPath(true);
        let installedJava = javaInfo.installedNow;
        let javaResult = javaInfo.javaPath;
        if (javaInfo.source === 'downloaded') {
            mainWindow.webContents.send('launcher-log', 'Java non trouvé : téléchargement de Java 21 en cours...');
        } else if (javaInfo.source === 'bundled') {
            mainWindow.webContents.send('launcher-log', `Java local détecté : ${javaResult}`);
        } else if (javaInfo.source === 'system') {
            mainWindow.webContents.send('launcher-log', `Java système trouvé : ${javaResult}`);
        } else {
            mainWindow.webContents.send('launcher-log', 'Java introuvable.');
            return { success: false, error: 'Java introuvable après tentative de téléchargement.' };
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

ipcMain.handle('set-auth', async (event, data) => {
    try {
        if (!data || data.type !== 'crack' || !data.pseudo) {
            return { success: false, error: 'Données de connexion hors-ligne invalides.' };
        }
        const offlinePseudo = String(data.pseudo || '').trim();
        if (!offlinePseudo) {
            return { success: false, error: 'Pseudo hors-ligne invalide.' };
        }
        userAuth = Authenticator.getAuth(offlinePseudo);
        if (!fs.existsSync(path.dirname(authFilePath))) fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
        fs.writeFileSync(authFilePath, JSON.stringify({ type: 'crack', pseudo: offlinePseudo }), 'utf-8');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.on('login-microsoft', async (event) => {
    console.log('[IPC] login-microsoft reçu');
    if (loginInProgress) {
        console.log('[IPC] Une tentative de connexion est déjà en cours. Ignoré.');
        return mainWindow.webContents.send('launcher-log', 'Connexion déjà en cours...');
    }
    loginInProgress = true;
    const defaultAuthManager = new Auth('select_account');
    const deviceClientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
    const deviceAuthManager = new Auth({
        client_id: deviceClientId,
        redirect: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
        prompt: 'select_account'
    });

    const formatMicrosoftError = (error) => {
        const raw = error && error.stack ? error.stack : (error && error.message ? error.message : String(error));
        const message = String(raw || '').toLowerCase();
        const firstLine = String(raw || '').split(/\r?\n/)[0] || String(raw || 'Erreur inconnue');

        if (message.includes('error.gui.closed')) {
            return 'Connexion annulée: la fenêtre Microsoft a été fermée.';
        }
        if (message.includes('entitlements') || message.includes('profile') || message.includes('does not own minecraft') || message.includes('404')) {
            return 'Connexion réussie côté Microsoft, mais ce compte ne possède pas Minecraft Java.';
        }
        if (message.includes('xsts') && message.includes('child')) {
            return 'Compte Microsoft enfant: autorisation Xbox requise dans les paramètres famille.';
        }
        if (message.includes('authorization_declined') || message.includes('access_denied')) {
            return 'Connexion Microsoft refusée.';
        }
        if (message.includes('expired_token')) {
            return 'Code de connexion expiré, relancez la connexion Microsoft.';
        }
        return firstLine;
    };

    const persistMicrosoftLogin = (xboxManager) => {
        const token = xboxManager.getMinecraft();
        return token.then((minecraftToken) => {
            if (!minecraftToken || typeof minecraftToken.mclc !== 'function') {
                throw new Error('Aucun token Microsoft valide reçu.');
            }
            userAuth = minecraftToken.mclc();
            if (!userAuth || !userAuth.name) {
                throw new Error('Impossible de récupérer le profil Microsoft après connexion.');
            }
            if (!fs.existsSync(path.dirname(authFilePath))) fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
            fs.writeFileSync(authFilePath, JSON.stringify({ type: 'microsoft', token: xboxManager.save ? xboxManager.save() : null }), 'utf-8');
            mainWindow.webContents.send('launcher-log', 'Connexion Microsoft réussie pour: ' + userAuth.name);
            mainWindow.webContents.send('microsoft-success', { name: userAuth.name, type: 'microsoft' });
        });
    };

    try {
        mainWindow.webContents.send('launcher-log', 'Démarrage connexion Microsoft...');
        try {
            mainWindow.webContents.send('launcher-log', 'Ouverture de la fenêtre Microsoft...');
            const xboxManager = await defaultAuthManager.launch('electron', {
                width: 520,
                height: 720,
                resizable: true,
                title: 'Connexion Microsoft'
            });
            await persistMicrosoftLogin(xboxManager);
            return;
        } catch (primaryError) {
            const primaryMsg = primaryError && primaryError.stack
                ? primaryError.stack
                : (primaryError && primaryError.message ? primaryError.message : String(primaryError));
            const fallbackNeeded = /invalid_request|first party|consent|removed=true|error\.state\.invalid/i.test(primaryMsg);
            if (!fallbackNeeded) {
                throw primaryError;
            }

            mainWindow.webContents.send('launcher-log', 'Connexion Microsoft directe refusée, bascule en mode code...');
            const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
            const deviceResponse = await axios.post(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
                new URLSearchParams({
                    client_id: deviceClientId,
                    scope: 'XboxLive.signin offline_access'
                }).toString(),
                { headers: formHeaders, timeout: 15000 }
            );

            const deviceData = deviceResponse.data || {};
            const deviceCode = deviceData.device_code;
            const userCode = deviceData.user_code;
            const verificationUri = deviceData.verification_uri || 'https://www.microsoft.com/link';
            if (!deviceCode || !userCode) {
                throw new Error('Réponse Microsoft invalide pour la connexion device code.');
            }

            mainWindow.webContents.send('microsoft-device', { code: userCode, verificationUri });
            await shell.openExternal(verificationUri);

            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            let intervalSeconds = Math.max(2, Number(deviceData.interval) || 5);
            const expiresAt = Date.now() + (Math.max(60, Number(deviceData.expires_in) || 900) * 1000);
            let refreshToken = null;

            while (Date.now() < expiresAt) {
                await wait(intervalSeconds * 1000);
                const tokenResponse = await axios.post(
                    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                    new URLSearchParams({
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                        client_id: deviceClientId,
                        device_code: deviceCode
                    }).toString(),
                    { headers: formHeaders, timeout: 15000, validateStatus: () => true }
                );

                if (tokenResponse.status === 200 && tokenResponse.data && tokenResponse.data.refresh_token) {
                    refreshToken = tokenResponse.data.refresh_token;
                    break;
                }

                const oauthErr = tokenResponse.data && tokenResponse.data.error;
                if (oauthErr === 'authorization_pending') continue;
                if (oauthErr === 'slow_down') {
                    intervalSeconds += 5;
                    continue;
                }
                if (oauthErr === 'authorization_declined' || oauthErr === 'access_denied') {
                    throw new Error('Connexion Microsoft refusée par l\'utilisateur.');
                }
                if (oauthErr === 'expired_token') {
                    throw new Error('Code Microsoft expiré. Relancez la connexion.');
                }
                throw new Error('Erreur OAuth Microsoft: ' + (oauthErr || `HTTP ${tokenResponse.status}`));
            }

            if (!refreshToken) {
                throw new Error('Connexion Microsoft expirée avant validation.');
            }

            const deviceXboxManager = await deviceAuthManager.refresh(refreshToken);
            await persistMicrosoftLogin(deviceXboxManager);
            return;
        }
    } catch (error) {
        const errMsg = formatMicrosoftError(error);
        console.error('[Erreur Microsoft]', errMsg);
        mainWindow.webContents.send('launcher-log', '[Erreur Microsoft] : ' + errMsg);
        mainWindow.webContents.send('microsoft-failed', errMsg);
        return;
    } finally {
        loginInProgress = false;
    }
});

ipcMain.handle('logout', async () => {
    try {
        userAuth = null;
        if (fs.existsSync(authFilePath)) fs.unlinkSync(authFilePath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('select-mods', async () => {
    try {
        ensureLauncherDataDirectories();
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

ipcMain.handle('list-installed-mods', async () => {
    try {
        ensureLauncherDataDirectories();
        return { success: true, mods: listInstalledModFiles(), folder: modsFolderPath };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('set-mod-enabled', async (event, payload = {}) => {
    try {
        ensureLauncherDataDirectories();
        const modName = String(payload && payload.modName ? payload.modName : '').trim();
        const shouldEnable = !!(payload && payload.enabled);
        if (!modName || path.basename(modName) !== modName) {
            return { success: false, error: 'Nom de mod invalide.' };
        }
        if (!/\.(jar|zip)$/i.test(modName)) {
            return { success: false, error: 'Extension de mod invalide.' };
        }

        const enabledPath = path.join(modsFolderPath, modName);
        const disabledPath = path.join(modsFolderPath, `${modName}.disabled`);
        const enabledExists = fs.existsSync(enabledPath);
        const disabledExists = fs.existsSync(disabledPath);

        if (shouldEnable) {
            if (enabledExists) {
                return { success: true, changed: false, mods: listInstalledModFiles() };
            }
            if (!disabledExists) {
                return { success: false, error: 'Mod introuvable.' };
            }
            fs.renameSync(disabledPath, enabledPath);
        } else {
            if (disabledExists) {
                return { success: true, changed: false, mods: listInstalledModFiles() };
            }
            if (!enabledExists) {
                return { success: false, error: 'Mod introuvable.' };
            }
            fs.renameSync(enabledPath, disabledPath);
        }

        return { success: true, changed: true, mods: listInstalledModFiles() };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('list-custom-modpacks', async () => {
    try {
        const entries = readCustomModpacks()
            .sort((a, b) => (b && b.updatedAt ? Number(b.updatedAt) : 0) - (a && a.updatedAt ? Number(a.updatedAt) : 0));
        return { success: true, entries, filePath: customModpacksFilePath };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('create-custom-modpack', async (event, payload = {}) => {
    try {
        ensureLauncherDataDirectories();
        const nameRaw = payload && payload.name ? String(payload.name).trim() : 'Mon-Pack-Perso';
        const version = payload && payload.version ? String(payload.version).trim() : '1.0.0';
        const manifestUrl = payload && payload.manifestUrl ? normalizeManifestUrl(payload.manifestUrl) : '';
        const safeName = nameRaw.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Mon-Pack-Perso';
        const defaultZip = `${safeName}-${version}.zip`;

        const saveResult = await dialog.showSaveDialog(mainWindow, {
            title: 'Créer un modpack personnalisé',
            defaultPath: path.join(app.getPath('desktop'), defaultZip),
            filters: [{ name: 'Zip', extensions: ['zip'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) return { success: false, canceled: true };

        await createPackZipFromLauncherData(saveResult.filePath, safeName);
        const entry = {
            id: `custom-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
            name: safeName,
            version,
            manifestUrl,
            lastFilePath: saveResult.filePath,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        upsertCustomModpackEntry(entry);
        return { success: true, entry, filePath: saveResult.filePath };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('check-custom-modpacks-updates', async () => {
    try {
        const entries = readCustomModpacks();
        const checked = [];
        for (const entry of entries) {
            const row = { ...entry, updateAvailable: false, remoteVersion: null, notes: '', error: null };
            if (!entry.manifestUrl) {
                row.error = 'manifestUrl manquante';
                checked.push(row);
                continue;
            }
            try {
                const remote = await getCustomModpackRemoteMeta(entry);
                if (!remote) {
                    row.error = 'Manifest invalide (version/downloadUrl requis).';
                } else {
                    row.remoteVersion = remote.version;
                    row.notes = remote.notes;
                    row.updateAvailable = compareVersions(remote.version, entry.version || '0.0.0') === 1;
                }
            } catch (e) {
                row.error = e && e.message ? e.message : String(e);
            }
            checked.push(row);
        }
        return { success: true, entries: checked };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('get-launcher-settings', async () => {
    return { success: true, settings: readLauncherSettings() };
});

ipcMain.handle('save-launcher-settings', async (event, payload = {}) => {
    try {
        const settings = writeLauncherSettings(payload);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setSize(settings.windowWidth, settings.windowHeight, true);
        }
        return { success: true, settings };
    } catch (err) {
        return { success: false, message: err && err.message ? err.message : String(err) };
    }
});

ipcMain.handle('install-custom-modpack-update', async (event, payload = {}) => {
    try {
        ensureLauncherDataDirectories();
        const id = payload && payload.id ? String(payload.id) : '';
        if (!id) return { success: false, error: 'id manquant.' };

        const entries = readCustomModpacks();
        const target = entries.find(e => e && e.id === id);
        if (!target) return { success: false, error: 'Pack personnalisé introuvable.' };
        if (!target.manifestUrl) return { success: false, error: 'manifestUrl manquante pour ce pack.' };

        const remote = await getCustomModpackRemoteMeta(target);
        if (!remote) return { success: false, error: 'Manifest distant invalide.' };

        const tempZipPath = path.join(launcherDataPath, `custom-pack-update-${id}.zip`);
        await downloadFileToPath(remote.downloadUrl, tempZipPath);
        const imported = await importCurseForgePackFromZip(tempZipPath);
        try { fs.unlinkSync(tempZipPath); } catch (_) { }

        target.version = remote.version;
        target.updatedAt = Date.now();
        target.lastUpdateNotes = remote.notes || '';
        upsertCustomModpackEntry(target);

        return {
            success: true,
            entry: target,
            import: imported,
            message: `Pack ${target.name} mis à jour vers ${remote.version}`
        };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('curseforge-key-status', async () => {
    try {
        const apiKey = getCurseForgeApiKey();
        return {
            success: true,
            configured: !!apiKey,
            keyFilePath: curseForgeKeyFilePath,
            message: apiKey ? 'Clé CurseForge détectée.' : 'Clé CurseForge absente.'
        };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('curseforge-search', async (event, payload = {}) => {
    try {
        const apiKey = getCurseForgeApiKey();
        if (!apiKey) {
            return {
                success: false,
                error: `Clé API CurseForge manquante. Ajoute-la dans ${curseForgeKeyFilePath}`
            };
        }

        const query = payload && payload.query ? String(payload.query).trim() : '';
        const type = payload && payload.type ? String(payload.type).trim() : 'mods';
        const gameVersion = payload && payload.gameVersion ? String(payload.gameVersion).trim() : '1.21.1';
        const modLoaderType = Number(payload && payload.modLoaderType ? payload.modLoaderType : 0);
        const categoryId = Number(payload && payload.categoryId ? payload.categoryId : 0);
        const sortMode = payload && payload.sortMode ? String(payload.sortMode).trim() : 'popular';
        const pageSize = Math.min(50, Math.max(5, Number(payload && payload.pageSize ? payload.pageSize : 20)));
        const index = Math.max(0, Number(payload && payload.index ? payload.index : 0));

        const classId = type === 'modpacks' ? 4471 : 6;
        const sortField = sortMode === 'newest' ? 3 : (sortMode === 'relevance' ? 1 : 2);
        const searchParams = {
            gameId: 432,
            classId,
            gameVersion,
            searchFilter: query,
            sortField,
            sortOrder: 'desc',
            pageSize,
            index
        };
        if (Number.isFinite(modLoaderType) && modLoaderType > 0) searchParams.modLoaderType = modLoaderType;
        if (Number.isFinite(categoryId) && categoryId > 0) searchParams.categoryId = categoryId;

        const headers = { 'x-api-key': apiKey, Accept: 'application/json' };
        const response = await axios.get('https://api.curseforge.com/v1/mods/search', {
            headers,
            params: searchParams,
            timeout: 20000
        });
        const dataBlock = response && response.data ? response.data : {};
        const rows = Array.isArray(dataBlock.data) ? dataBlock.data : [];
        const pagination = dataBlock.pagination || {};

        const items = Array.isArray(rows) ? rows.map(row => ({
            id: row.id,
            name: row.name,
            summary: row.summary || '',
            slug: row.slug || '',
            websiteUrl: row.links && row.links.websiteUrl ? row.links.websiteUrl : '',
            downloadCount: row.downloadCount || 0,
            logoUrl: row.logo && row.logo.thumbnailUrl ? row.logo.thumbnailUrl : '',
            dateReleased: row.dateReleased || row.dateCreated || '',
            latestFilesIndexes: Array.isArray(row.latestFilesIndexes) ? row.latestFilesIndexes.slice(0, 4) : []
        })) : [];

        return {
            success: true,
            items,
            type,
            gameVersion,
            count: items.length,
            totalCount: Number(pagination.totalCount || items.length || 0),
            index: Number(pagination.index || index),
            pageSize: Number(pagination.pageSize || pageSize),
            modLoaderType,
            categoryId,
            sortMode
        };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('curseforge-install-latest', async (event, payload = {}) => {
    try {
        ensureLauncherDataDirectories();
        const apiKey = getCurseForgeApiKey();
        if (!apiKey) {
            return {
                success: false,
                error: `Clé API CurseForge manquante. Ajoute-la dans ${curseForgeKeyFilePath}`
            };
        }

        const projectId = Number(payload && payload.projectId ? payload.projectId : 0);
        const type = payload && payload.type ? String(payload.type).trim() : 'mods';
        const gameVersion = payload && payload.gameVersion ? String(payload.gameVersion).trim() : '1.21.1';
        if (!Number.isFinite(projectId) || projectId <= 0) {
            return { success: false, error: 'projectId invalide.' };
        }

        const latest = await findLatestCurseForgeFile(projectId, gameVersion, apiKey);
        if (!latest || !latest.id) {
            return { success: false, error: 'Aucun fichier compatible trouvé pour ce projet.' };
        }

        if (type === 'modpacks') {
            const url = await fetchCurseForgeJson(`/mods/${projectId}/files/${latest.id}/download-url`, apiKey);
            if (!url) return { success: false, error: 'URL de téléchargement introuvable pour ce modpack.' };
            const tempZipPath = path.join(launcherDataPath, `curseforge-pack-${projectId}-${latest.id}.zip`);
            const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 60000 });
            await new Promise((resolve, reject) => {
                const writer = fs.createWriteStream(tempZipPath);
                response.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            const imported = await importCurseForgePackFromZip(tempZipPath);
            try { fs.unlinkSync(tempZipPath); } catch (_) { }
            return {
                success: true,
                mode: 'modpack',
                projectId,
                fileId: latest.id,
                message: `Modpack importé: ${imported.message}`,
                import: imported
            };
        }

        const downloaded = await downloadCurseForgeModFile(projectId, latest.id, apiKey);
        mainWindow.webContents.send('mods-installed', { installed: listInstalledModFiles(), folder: modsFolderPath });
        return {
            success: true,
            mode: 'mod',
            projectId,
            fileId: latest.id,
            file: downloaded,
            message: `Mod installé: ${downloaded.name}`
        };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('import-curseforge-pack', async () => {
    try {
        ensureLauncherDataDirectories();
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Importez un modpack CurseForge (.zip)',
            properties: ['openFile'],
            filters: [
                { name: 'Modpacks ZIP', extensions: ['zip'] }
            ]
        });
        if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };

        const zipPath = result.filePaths[0];
        return await importCurseForgePackFromZip(zipPath);
    } catch (err) {
        console.error('Erreur import-curseforge-pack:', err);
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('export-modpack', async () => {
    try {
        ensureLauncherDataDirectories();
        const saveResult = await dialog.showSaveDialog(mainWindow, {
            title: 'Exporter un pack de mods',
            defaultPath: path.join(app.getPath('desktop'), 'Mon-Launcher-Modpack.zip'),
            filters: [
                { name: 'Zip', extensions: ['zip'] }
            ]
        });
        if (saveResult.canceled || !saveResult.filePath) return { success: false, canceled: true };

        const packName = path.basename(saveResult.filePath, '.zip');
        const exported = await createPackZipFromLauncherData(saveResult.filePath, packName);
        return {
            success: true,
            filePath: saveResult.filePath,
            exportedFolders: exported.exportedFolders,
            message: `Pack exporté vers ${saveResult.filePath}`
        };
    } catch (err) {
        console.error('Erreur export-modpack:', err);
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('import-tlauncher-profile', async () => {
    try {
        ensureLauncherDataDirectories();
        const defaultMinecraftDir = path.join(app.getPath('appData'), '.minecraft');
        const dialogResult = await dialog.showOpenDialog(mainWindow, {
            title: 'Sélectionner le dossier profil TLauncher/.minecraft',
            defaultPath: defaultMinecraftDir,
            properties: ['openDirectory']
        });

        if (dialogResult.canceled || !dialogResult.filePaths || !dialogResult.filePaths.length) {
            return { success: false, canceled: true };
        }

        const imported = importTLauncherProfileFrom(dialogResult.filePaths[0]);
        const installedMods = listInstalledModFiles();
        mainWindow.webContents.send('mods-installed', { installed: installedMods, folder: modsFolderPath });

        return {
            success: true,
            sourceDir: imported.sourceDir,
            importedFolders: imported.importedFolders,
            importedFiles: imported.importedFiles,
            importedFolderCount: imported.importedFolderCount,
            installedModsCount: installedMods.length,
            message: `Import TLauncher terminé (${imported.importedFolderCount} fichier(s) dossier + ${imported.importedFiles.length} fichier(s) racine).`
        };
    } catch (err) {
        return { success: false, error: err && err.message ? err.message : String(err) };
    }
});

ipcMain.on('open-external', (event, url) => {
    try { shell.openExternal(url); } catch (e) { console.error('open-external failed', e); }
});

ipcMain.on('launch-game', async (event, useForge = false) => {
    if (gameLaunchInProgress) {
        mainWindow.webContents.send('launcher-log', 'Un lancement est déjà en cours...');
        mainWindow.webContents.send('launch-finished', { success: false, error: 'Lancement déjà en cours.' });
        return;
    }
    if (!userAuth) {
        mainWindow.webContents.send('launcher-log', "Erreur : Connectez-vous !");
        mainWindow.webContents.send('launch-finished', { success: false, error: 'Connectez-vous avant de lancer le jeu.' });
        return;
    }
    const syncedMods = syncModsFromAppFolder();
    if (syncedMods.length) {
        mainWindow.webContents.send('mods-installed', { installed: syncedMods, folder: modsFolderPath });
    }
    const javaInfo = await resolveJavaPath(true);
    const javaPath = javaInfo.javaPath;
    if (!javaPath) {
        mainWindow.webContents.send('launcher-log', 'Java introuvable. Cliquez sur Télécharger pour installer Java et NeoForge.');
        mainWindow.webContents.send('launch-finished', { success: false, error: 'Java introuvable.' });
        return;
    }
    if (javaInfo.source === 'system') mainWindow.webContents.send('launcher-log', `Java système trouvé : ${javaPath}`);
    if (javaInfo.source === 'bundled') mainWindow.webContents.send('launcher-log', `Java local détecté : ${javaPath}`);
    if (javaInfo.source === 'downloaded') mainWindow.webContents.send('launcher-log', `Java téléchargé : ${javaPath}`);
    const selectedJavaInfo = probeJavaExecutable(javaPath);
    if (!selectedJavaInfo.major || selectedJavaInfo.major < REQUIRED_JAVA_MAJOR) {
        const reason = `Java ${REQUIRED_JAVA_MAJOR}+ requis pour Minecraft 1.21.1 (détecté: ${selectedJavaInfo.major || 'inconnu'}).`;
        mainWindow.webContents.send('launcher-log', reason);
        mainWindow.webContents.send('launch-finished', { success: false, error: reason });
        return;
    }

    gameLaunchInProgress = true;
    let launchSettled = false;
    const launchDebugTail = [];
    const pushLaunchDebug = (msg) => {
        const line = String(msg || '').trim();
        if (!line) return;
        launchDebugTail.push(line);
        if (launchDebugTail.length > 12) launchDebugTail.shift();
    };
    const finishLaunch = (success, error) => {
        if (launchSettled) return;
        launchSettled = true;
        gameLaunchInProgress = false;
        mainWindow.webContents.send('launch-finished', { success, error: error || null });
    };

    try {
        const launcherSettings = readLauncherSettings();
        const memoryMaxGb = launcherSettings.minecraftRamGb;
        const memoryMinGb = Math.max(1, Math.min(memoryMaxGb - 1, Math.floor(memoryMaxGb / 2)));
        const baseOpts = {
            clientPackage: null,
            authorization: userAuth,
            root: launcherDataPath,
            version: { number: "1.21.1", type: "release" },
            javaPath: javaPath,
            memory: { max: `${memoryMaxGb}G`, min: `${memoryMinGb}G` }
        };

        launcher.removeAllListeners('close');
        launcher.removeAllListeners('error');
        launcher.removeAllListeners('debug');
        launcher.removeAllListeners('data');
        launcher.removeAllListeners('download-status');
        launcher.removeAllListeners('progress');
        const downloadAggregate = new Map();
        launcher.on('close', (code) => {
            const codeNum = Number(code);
            if (codeNum === 0) {
                mainWindow.webContents.send('launcher-log', 'Le jeu a été fermé normalement.');
                finishLaunch(true, null);
                return;
            }
            const closeMsg = `Le jeu s'est fermé avec le code ${codeNum}.`;
            mainWindow.webContents.send('launcher-log', closeMsg);
            finishLaunch(false, closeMsg);
        });
        launcher.on('error', (err) => {
            const msg = err && err.message ? err.message : String(err);
            console.error('Erreur launcher event:', err);
            mainWindow.webContents.send('launcher-log', 'Erreur launcher : ' + msg);
            finishLaunch(false, msg);
        });
        launcher.on('debug', (msg) => {
            if (!msg) return;
            pushLaunchDebug(msg);
            mainWindow.webContents.send('launcher-log', String(msg));
        });
        launcher.on('data', (msg) => {
            if (!msg) return;
            pushLaunchDebug(msg);
            mainWindow.webContents.send('launcher-log', String(msg));
        });
        launcher.on('download-status', (data) => {
            const name = data && data.name ? String(data.name) : `asset-${downloadAggregate.size}`;
            const current = Number(data && data.current ? data.current : 0);
            const total = Number(data && data.total ? data.total : 0);
            downloadAggregate.set(name, {
                current: Number.isFinite(current) ? current : 0,
                total: Number.isFinite(total) ? total : 0
            });

            let sumCurrent = 0;
            let sumTotal = 0;
            for (const item of downloadAggregate.values()) {
                sumCurrent += item.current;
                if (item.total > 0) sumTotal += item.total;
            }

            mainWindow.webContents.send('launcher-download-status', {
                current: sumCurrent,
                total: sumTotal,
                files: downloadAggregate.size
            });
        });
        launcher.on('progress', (e) => mainWindow.webContents.send('launcher-progress', e));

        if (useForge) {
            try {
                const forgePath = await downloadNeoForgeInstaller();
                const forgeOpts = { ...baseOpts, forge: forgePath };
                mainWindow.webContents.send('launcher-log', 'Mode moddé activé : utilisation de Forge.');
                const forgeChild = await launcher.launch(forgeOpts);
                if (!forgeChild) {
                    const details = launchDebugTail.length ? ` Détails: ${launchDebugTail.join(' | ')}` : '';
                    throw new Error(`Le process Minecraft moddé n'a pas démarré (retour null). Java: ${javaPath}.${details}`);
                }
                mainWindow.webContents.send('launcher-log', 'Processus de jeu lancé (mode moddé).');
                return;
            } catch (forgeErr) {
                const forgeMsg = forgeErr && forgeErr.message ? forgeErr.message : String(forgeErr);
                mainWindow.webContents.send('launcher-log', 'Échec du lancement moddé : ' + forgeMsg);
                mainWindow.webContents.send('launcher-log', 'Tentative automatique en mode vanilla...');
            }
        }

        mainWindow.webContents.send('launcher-log', 'Lancement en mode vanilla (sans Forge / mods).');
        const vanillaChild = await launcher.launch(baseOpts);
        if (!vanillaChild) {
            const details = launchDebugTail.length ? ` Détails: ${launchDebugTail.join(' | ')}` : '';
            throw new Error(`Le process Minecraft vanilla n'a pas démarré (retour null). Java: ${javaPath}.${details}`);
        }
        mainWindow.webContents.send('launcher-log', 'Processus de jeu lancé (vanilla).');
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error('Erreur lancement jeu:', err);
        mainWindow.webContents.send('launcher-log', 'Erreur lancement jeu : ' + msg);
        finishLaunch(false, msg);
    } finally {
        // Keep gameLaunchInProgress true while the game process is running.
        if (launchSettled) gameLaunchInProgress = false;
    }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
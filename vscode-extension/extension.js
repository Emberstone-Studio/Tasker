const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const INSTALL_DIR = path.join(os.homedir(), '.claude', 'tasker');

function findNode() {
    const isWin = process.platform === 'win32';

    // Try node in PATH first
    try {
        cp.execFileSync(isWin ? 'node.exe' : 'node', ['--version'], { timeout: 5000, stdio: 'ignore' });
        return isWin ? 'node.exe' : 'node';
    } catch (e) {}

    // Common install locations
    const candidates = isWin ? [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs', 'node.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    ] : [
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
        path.join(os.homedir(), '.volta', 'bin', 'node'),
    ];

    if (!isWin) {
        try {
            const nvmBase = path.join(os.homedir(), '.nvm', 'versions', 'node');
            const versions = fs.readdirSync(nvmBase).sort().reverse();
            for (const v of versions) candidates.push(path.join(nvmBase, v, 'bin', 'node'));
        } catch (e) {}
    }

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function readVersion(taskerJsPath) {
    try {
        const match = fs.readFileSync(taskerJsPath, 'utf8').match(/const VERSION = "([^"]+)"/);
        return match ? match[1] : null;
    } catch (e) { return null; }
}

async function activate(context) {
    const srcDir = path.join(context.extensionPath, 'tasker');
    const bundledVersion = readVersion(path.join(srcDir, 'tasker.js'));
    const installedVersion = readVersion(path.join(INSTALL_DIR, 'tasker.js'));

    if (bundledVersion && bundledVersion === installedVersion) return;

    try {
        fs.mkdirSync(INSTALL_DIR, { recursive: true });
        for (const file of ['tasker.js', 'tasker.html', 'README.md']) {
            fs.copyFileSync(path.join(srcDir, file), path.join(INSTALL_DIR, file));
        }

        const nodePath = findNode();
        if (!nodePath) {
            const sel = await vscode.window.showErrorMessage(
                'Tasker requires Node.js. Please install it from nodejs.org, then reload VS Code.',
                'Open nodejs.org'
            );
            if (sel === 'Open nodejs.org') vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org'));
            return;
        }

        cp.execFileSync(nodePath, [path.join(INSTALL_DIR, 'tasker.js')], { timeout: 30000 });

        const msg = installedVersion
            ? `Tasker updated to v${bundledVersion}.`
            : 'Tasker installed! Reload VS Code to activate.';

        const sel = await vscode.window.showInformationMessage(msg, 'Reload Window');
        if (sel === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');

    } catch (err) {
        vscode.window.showErrorMessage(`Tasker: Installation failed — ${err.message}`);
    }
}

function deactivate() {}
module.exports = { activate, deactivate };

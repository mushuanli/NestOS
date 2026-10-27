// scripts/release.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ✨ 重点修改这里 ---
// 1. rootDir 是项目的根目录 (因为脚本在 scripts/ 下，所以往上两级)
const rootDir = path.resolve(__dirname, '..');

// 2. 指定你的 Web App 所在的真实目录
const appDir = path.resolve(rootDir, 'apps/web-app');

// 3. 构建输出目录 (Vite 默认输出到 app 目录下的 dist)
const distDir = path.resolve(appDir, 'dist');

// 4. 发布包生成目录 (我们把它生成在根目录的 release 文件夹下，方便你查找)
const releaseDir = path.resolve(rootDir, 'release');
// -----------------------

// 下面的逻辑基本不用变，稍微检查一下即可
if (!fs.existsSync(distDir)) {
    console.error(`❌ Error: dist folder not found at: ${distDir}`);
    console.error('👉 Please make sure you built the app first.');
    process.exit(1);
}

// ... 保持原有的清理、复制、生成脚本逻辑不变 ...
// (只需确保 fs.cpSync 里的 source 是 distDir 即可，上面已经定义了)

if (fs.existsSync(releaseDir)) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir);

// --- 复制构建文件 ---
console.log('📂 Copying compiled assets...');
fs.cpSync(distDir, path.join(releaseDir, 'dist'), { recursive: true });

// ==========================================
// ✨ 核心改进：生成一个零依赖的 server.js
// ==========================================
const serverScriptContent = `
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4173;
const DIST_DIR = path.join(__dirname, 'dist');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
  console.log(\`\${req.method} \${req.url}\`);

  // 防止目录遍历攻击
  const safePath = path.normalize(req.url).replace(/^(\.\.[\\/])+/, '');
  let filePath = path.join(DIST_DIR, safePath === '/' ? 'index.html' : safePath);

  const extname = String(path.extname(filePath)).toLowerCase();
  let contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        // SPA Fallback: 如果找不到文件，且不是资源文件，返回 index.html
        if (!extname) {
            fs.readFile(path.join(DIST_DIR, 'index.html'), (err, indexContent) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Error loading index.html');
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(indexContent, 'utf-8');
                }
            });
        } else {
            res.writeHead(404);
            res.end('404 Not Found');
        }
      } else {
        res.writeHead(500);
        res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\\n');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(\`\\n🚀 Server running at http://localhost:\${PORT}/\`);
  console.log('Press Ctrl+C to stop.');
});
`;

fs.writeFileSync(path.join(releaseDir, 'server.js'), serverScriptContent);
console.log('✅ Generated zero-dependency server.js');


// --- 生成 Mac/Linux 脚本 (更新版) ---
const shContent = `#!/bin/bash
cd "$(dirname "$0")"

# 检查 Node
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed."
    echo "Please install Node.js (v18+) from https://nodejs.org/"
    read -p "Press enter to exit..."
    exit 1
fi

echo "🚀 Starting NestOS..."

# 打开浏览器 (等待1秒确保服务器启动)
(sleep 1 && (open "http://localhost:4173" 2>/dev/null || xdg-open "http://localhost:4173" 2>/dev/null)) &

# ✨ 启动我们生成的 server.js，而不是 npx serve
node server.js
`;

fs.writeFileSync(path.join(releaseDir, 'start.sh'), shContent, { mode: 0o755 });

// --- 生成 Windows 脚本 (更新版) ---
const batContent = `@echo off
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Error: Node.js is not installed.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit
)

echo 🚀 Starting NestOS...
echo 🌐 Opening Browser...
start http://localhost:4173

echo ⚡ Starting Server...
:: ✨ 启动 server.js
node server.js
pause
`;

fs.writeFileSync(path.join(releaseDir, 'start.bat'), batContent);

console.log(`\n🎉 Release created successfully at: ${releaseDir}`);
console.log('👉 You can now execute ./start.sh inside the release folder without internet connection.');
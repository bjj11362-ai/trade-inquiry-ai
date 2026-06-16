const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const url = 'http://127.0.0.1:5174/pet.html';
const electronBin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const main = path.join(__dirname, 'main.cjs');

function waitForServer(retries = 80) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry(left);
      });
      req.on('error', () => retry(left));
      req.setTimeout(600, () => {
        req.destroy();
        retry(left);
      });
    };

    const retry = (left) => {
      if (left <= 0) {
        reject(new Error('Vite pet server did not become ready.'));
        return;
      }
      setTimeout(() => tryOnce(left - 1), 250);
    };

    tryOnce(retries);
  });
}

waitForServer()
  .then(() => {
    const child = spawn(electronBin, [main], {
      stdio: 'inherit',
      env: {
        ...process.env,
        GUGU_PET_URL: `${url}?desktop=1`
      }
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const targetFile = path.join(
  repoRoot,
  "node_modules",
  "wechaty-puppet-wechat",
  "dist",
  "esm",
  "src",
  "bridge.js",
);

function patchReadyAngular(source) {
  const before = `await page.waitForFunction("typeof window.angular !== 'undefined'");`;
  const after = `await page.waitForFunction(\`typeof window.angular !== 'undefined'
                && !!window.angular.element
                && !!window.angular.element(document)
                && !!window.angular.element(document).injector()\`);`;

  if (!source.includes(before)) {
    return source;
  }

  return source.replace(before, after);
}

function patchInjectRetry(source) {
  const before = `            retObj = await this.proxyWechaty('init');
            if (retObj && /^(2|3)/.test(retObj.code.toString())) {
                // HTTP Code 2XX & 3XX
                log.silly('PuppetWeChatBridge', 'inject() Wechaty.init() return code[%d] message[%s]', retObj.code, retObj.message);
            }
            else { // HTTP Code 4XX & 5XX
                throw new Error('execute proxyWechaty(init) error: ' + retObj?.code + ', ' + retObj?.message);
            }`;

  const after = `            let lastInitError;
            for (let attempt = 0; attempt < 5; attempt++) {
                retObj = await this.proxyWechaty('init');
                if (retObj && /^(2|3)/.test(retObj.code.toString())) {
                    log.silly('PuppetWeChatBridge', 'inject() Wechaty.init() return code[%d] message[%s]', retObj.code, retObj.message);
                    lastInitError = undefined;
                    break;
                }
                const isAngularRace = retObj?.code === 503 && /ready angular env/i.test(String(retObj?.message));
                if (!isAngularRace) {
                    throw new Error('execute proxyWechaty(init) error: ' + retObj?.code + ', ' + retObj?.message);
                }
                lastInitError = new Error('execute proxyWechaty(init) error: ' + retObj?.code + ', ' + retObj?.message);
                log.warn('PuppetWeChatBridge', 'inject() angular env not ready, retry %d/5', attempt + 1);
                await page.waitForTimeout(1000);
            }
            if (lastInitError) {
                throw lastInitError;
            }`;

  if (!source.includes(before)) {
    return source;
  }

  return source.replace(before, after);
}

function main() {
  if (!fs.existsSync(targetFile)) {
    console.warn(`[patch-wechaty-puppet-wechat] target file not found: ${targetFile}`);
    process.exitCode = 0;
    return;
  }

  const original = fs.readFileSync(targetFile, "utf8");
  let patched = original;

  patched = patchReadyAngular(patched);
  patched = patchInjectRetry(patched);

  if (patched === original) {
    console.log("[patch-wechaty-puppet-wechat] no changes applied");
    return;
  }

  fs.writeFileSync(targetFile, patched, "utf8");
  console.log("[patch-wechaty-puppet-wechat] patch applied");
}

main();

#!/usr/bin/env node
// contracts/out의 Foundry 산출물에서 ABI를 읽어 src/generated.ts를 만든다 (design.md 11장).
// 컨트랙트를 바꾼 뒤: (WSL) forge build → (Windows) pnpm gen:abi
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../../contracts/out");
const targets = [
  ["stableTokenAbi", "StableToken.sol/StableToken.json"],
  ["timelockControllerAbi", "TimelockController.sol/TimelockController.json"],
  ["proxyAdminAbi", "ProxyAdmin.sol/ProxyAdmin.json"],
  ["transparentProxyAbi", "TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json"],
];

let src = "// 자동 생성 파일. 직접 고치지 않는다. `pnpm gen:abi`로 다시 만든다.\n// 원본: contracts/out (forge build)\n\n";
for (const [name, file] of targets) {
  const artifact = JSON.parse(readFileSync(join(out, file), "utf8"));
  src += `export const ${name} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n\n`;
}
writeFileSync(resolve(here, "../src/generated.ts"), src);
console.log("wrote packages/abi/src/generated.ts");

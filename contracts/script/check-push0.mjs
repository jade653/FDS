#!/usr/bin/env node
// 빌드 산출물의 바이트코드에 PUSH0(0x5f)이 없는지 검사한다.
// 자체 체인이 Shanghai 이전이므로 PUSH0이 하나라도 있으면 배포 시 invalid opcode가 난다.
// 사용: node script/check-push0.mjs [out/StableToken.sol/StableToken.json ...]
// 인자가 없으면 out/ 아래의 모든 아티팩트를 검사한다.

import {readFileSync, readdirSync, statSync} from "node:fs";
import {join, resolve} from "node:path";

const root = resolve(process.argv[1], "..", "..");
const outDir = join(root, "out");

function listArtifacts(dir) {
    const found = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
            if (entry === "build-info") continue;
            found.push(...listArtifacts(p));
        } else if (entry.endsWith(".json")) {
            found.push(p);
        }
    }
    return found;
}

// 명령어 스트림을 걸으며 PUSH1..PUSH32의 즉시값은 건너뛴다.
function findPush0(hex) {
    const code = Buffer.from(hex.replace(/^0x/, ""), "hex");
    const hits = [];
    let i = 0;
    while (i < code.length) {
        const op = code[i];
        if (op === 0x5f) hits.push(i);
        if (op >= 0x60 && op <= 0x7f) {
            i += op - 0x60 + 1;
        }
        i += 1;
    }
    return hits;
}

const targets = process.argv.length > 2 ? process.argv.slice(2).map((p) => resolve(p)) : listArtifacts(outDir);

let checked = 0;
let failed = 0;
for (const file of targets) {
    let artifact;
    try {
        artifact = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        continue;
    }
    const creation = artifact?.bytecode?.object;
    const runtime = artifact?.deployedBytecode?.object;
    if (!creation || creation === "0x") continue;
    const name = file.slice(root.length + 1);
    checked += 1;
    const hits = [...findPush0(creation), ...findPush0(runtime ?? "0x")];
    if (hits.length > 0) {
        failed += 1;
        console.error(`FAIL ${name}: PUSH0 at offsets ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? " ..." : ""}`);
    } else {
        console.log(`ok   ${name}`);
    }
}

console.log(`\n${checked} artifact(s) checked, ${failed} with PUSH0`);
process.exit(failed > 0 ? 1 : 0);

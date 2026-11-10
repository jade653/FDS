import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {describe, expect, it} from "vitest";
import {mnemonicToAccount} from "viem/accounts";
import {loadRuntimeConfig, lower} from "@stb/common";
import {DEMO_MINT, DEMO_ROUNDS, demoActors, demoAddressesYaml, setEnvIfEmpty} from "../src/demo";

// 시연 지갑 파생과 주소 분류 파일. 실제 체인 시나리오 자체는 packages/e2e/test/demo.test.ts가 Anvil에서 돌린다.
const MNEMONIC = "test test test test test test test test test test test junk";
const REPO = resolve(__dirname, "../../../..");

describe("demoActors", () => {
  it("is deterministic and gives distinct wallets per round", () => {
    const a = demoActors(MNEMONIC, 0);
    expect(demoActors(MNEMONIC, 0).hot.address).toBe(a.hot.address);
    const all = new Set<string>();
    for (let r = 0; r < DEMO_ROUNDS; r++) {
      const x = demoActors(MNEMONIC, r);
      for (const addr of [x.hot.address, x.victim.address, x.partner.address, x.exchange, x.attacker1b, x.attacker2.address, ...x.launder]) {
        expect(all.has(lower(addr))).toBe(false);
        all.add(lower(addr));
      }
      expect(x.launder).toHaveLength(20);
      expect(lower(x.funder.address)).toBe(lower(a.funder.address));
    }
  });

  it("keeps role wallets away from the first 20 accounts (Anvil uses them for Safes, minter and bot)", () => {
    const low = new Set(Array.from({length: 20}, (_, i) => lower(mnemonicToAccount(MNEMONIC, {addressIndex: i}).address)));
    for (let r = 0; r < DEMO_ROUNDS; r++) {
      const x = demoActors(MNEMONIC, r);
      for (const addr of [x.hot.address, x.victim.address, x.partner.address, x.exchange, x.attacker1b, x.attacker2.address, ...x.launder]) {
        expect(low.has(lower(addr))).toBe(false);
      }
    }
  });

  it("rejects rounds outside 0..DEMO_ROUNDS-1", () => {
    expect(() => demoActors(MNEMONIC, -1)).toThrow();
    expect(() => demoActors(MNEMONIC, DEMO_ROUNDS)).toThrow();
    expect(() => demoActors(MNEMONIC, 0.5)).toThrow();
  });

  it("mints within the 1,000,000 STB minter allowance per round", () => {
    expect(DEMO_MINT.hot + DEMO_MINT.victim + DEMO_MINT.partner).toBeLessThanOrEqual(1_000_000);
  });
});

describe("demoAddressesYaml", () => {
  it("is a valid addresses file that classifies every round's wallets", () => {
    const dir = mkdtempSync(join(tmpdir(), "stb-demo-"));
    const deployment = resolve(REPO, "deployments/anvil.json").replace(/\\/g, "/");
    const bot = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
    const p = join(dir, "addresses.yaml");
    writeFileSync(p, demoAddressesYaml({chainId: 31337, deployment, mnemonic: MNEMONIC, bot}));
    const {book} = loadRuntimeConfig({rules: resolve(REPO, "config/rules.yaml"), addresses: p});
    for (let r = 0; r < DEMO_ROUNDS; r++) {
      const x = demoActors(MNEMONIC, r);
      expect(book.category(lower(x.hot.address))).toBe("hot");
      expect(book.isWatched(lower(x.partner.address))).toBe(true);
      expect(book.category(lower(x.exchange))).toBe("whitelabel");
      expect(book.category(lower(x.attacker1b))).toBe("normal");
      expect(book.category(lower(x.victim.address))).toBe("normal");
    }
    expect(book.bot).toBe(lower(bot));
  });
});

describe("setEnvIfEmpty", () => {
  it("fills an empty key, appends a missing one, and never overwrites a set value", () => {
    const lines = ["A=", "B=keep", "# comment", ""];
    expect(setEnvIfEmpty(lines, "A", "1")).toBe(true);
    expect(setEnvIfEmpty(lines, "B", "2")).toBe(false);
    expect(setEnvIfEmpty(lines, "C", "3")).toBe(true);
    expect(lines).toEqual(["A=1", "B=keep", "# comment", "C=3", ""]);
  });

  it("keeps values that contain '='", () => {
    const lines = ["K=a=b"];
    expect(setEnvIfEmpty(lines, "K", "x")).toBe(false);
    expect(lines).toEqual(["K=a=b"]);
  });
});

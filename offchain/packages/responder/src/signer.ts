import {createDecipheriv, pbkdf2Sync, scryptSync} from "node:crypto";
import {readFileSync} from "node:fs";
import {bytesToHex, hexToBytes, keccak256, type TransactionSerializable} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "@stb/common";
import {lower} from "@stb/common";
import {FREEZE_BATCH_SELECTOR, FREEZE_SELECTOR} from "@stb/abi";

/** 트랜잭션 서명자. 키를 밖으로 꺼내지 않는 구현(KMS)도 같은 인터페이스를 따른다. */
export interface TxSigner {
  readonly address: Address;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
}

export class SignRefused extends Error {
  constructor(reason: string) {
    super(`refused to sign: ${reason}`);
  }
}

/**
 * calldata가 토큰의 `freeze` 또는 `freezeBatch`가 아니면 서명하지 않는다 (design.md 8.2 4단계, 8장 서두).
 * 해제·정지·소각·발행·역할 변경·ETH 송금 등 다른 모든 요청은 코드 레벨에서 거부한다.
 */
export function assertFreezeOnly(tx: TransactionSerializable, token: Address): void {
  if (!tx.to || lower(tx.to) !== lower(token)) throw new SignRefused(`target ${tx.to ?? "(create)"} is not the token`);
  if (tx.value !== undefined && tx.value !== 0n) throw new SignRefused("non-zero value");
  const data = (tx.data ?? "0x").toLowerCase();
  const sel = data.slice(0, 10);
  if (sel !== FREEZE_SELECTOR && sel !== FREEZE_BATCH_SELECTOR) throw new SignRefused(`selector ${sel || "(none)"} is not freeze/freezeBatch`);
  if ("authorizationList" in tx && tx.authorizationList && tx.authorizationList.length > 0) {
    throw new SignRefused("authorization list not allowed");
  }
}

/** 어떤 서명자든 감싸서 동결 외 서명을 막는다. Responder는 이 래퍼만 쓴다. */
export class FreezeOnlySigner implements TxSigner {
  constructor(
    private readonly inner: TxSigner,
    private readonly token: Address,
  ) {}
  get address() {
    return this.inner.address;
  }
  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    assertFreezeOnly(tx, this.token);
    return this.inner.signTransaction(tx);
  }
}

/** 개인키 서명자. 로컬 Anvil 테스트 전용 (Anvil 기본 키). */
export function privateKeySigner(key: Hex): TxSigner {
  const acct = privateKeyToAccount(key);
  return {address: lower(acct.address), signTransaction: (tx) => acct.signTransaction(tx)};
}

/**
 * Web3 Secret Storage v3 키스토어 (Sepolia 기본, docs/decisions.md 3절).
 * scrypt 또는 pbkdf2 + aes-128-ctr. 복호화한 키는 이 클로저 밖으로 나가지 않는다.
 */
export function keystoreSigner(path: string, password: string): TxSigner {
  const ks = JSON.parse(readFileSync(path, "utf8"));
  const c = ks.crypto ?? ks.Crypto;
  if (!c || c.cipher !== "aes-128-ctr") throw new Error("unsupported keystore cipher");
  const salt = Buffer.from(c.kdfparams.salt, "hex");
  let derived: Buffer;
  if (c.kdf === "scrypt") {
    const {n, r, p, dklen} = c.kdfparams;
    derived = scryptSync(Buffer.from(password, "utf8"), salt, dklen, {N: n, r, p, maxmem: 256 * n * r + 1024 * 1024});
  } else if (c.kdf === "pbkdf2") {
    const {c: iter, dklen, prf} = c.kdfparams;
    if (prf !== "hmac-sha256") throw new Error("unsupported pbkdf2 prf");
    derived = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iter, dklen, "sha256");
  } else {
    throw new Error(`unsupported kdf ${c.kdf}`);
  }
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(new Uint8Array(Buffer.concat([derived.subarray(16, 32), ciphertext])));
  if (mac.slice(2).toLowerCase() !== String(c.mac).toLowerCase()) throw new Error("keystore password is wrong (MAC mismatch)");
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  const key = bytesToHex(new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()])));
  derived.fill(0);
  const acct = privateKeyToAccount(key);
  return {address: lower(acct.address), signTransaction: (tx) => acct.signTransaction(tx)};
}

/**
 * KMS 서명자 자리. 어떤 KMS를 쓸지는 docs/decisions.md 3절에서 아직 정하지 않았다.
 * 정해지면 이 함수가 해당 SDK의 비대칭 서명(secp256k1)으로 TxSigner를 만든다.
 */
export function kmsSigner(keyId: string): TxSigner {
  throw new Error(`KMS signer for ${keyId} is not implemented yet: choose the KMS in docs/decisions.md 3절 first`);
}

export {hexToBytes};

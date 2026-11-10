import type {Address} from "@stb/common";
import {lower} from "@stb/common";
import type {ChainReader} from "./chain";
import type {AddressInfo, AddressStore} from "./stores/types";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** 이벤트 위치를 정렬 가능한 문자열로. */
export function posKey(block: bigint, txIndex: number, logIndex: number): string {
  return `${block.toString().padStart(20, "0")}:${String(txIndex).padStart(6, "0")}:${String(logIndex + 1).padStart(6, "0")}`;
}

/**
 * 주소 첫 등장 시각, 누적 거래 수, 동결 여부, 체인 nonce를 붙인다 (design.md 7.1 Enricher).
 * "신규 주소"는 토큰 기준 첫 등장과 체인 nonce를 함께 본다. nonce는 첫 조회 때 RPC로 읽어 저장한다.
 */
export class Enricher {
  private cache = new Map<Address, AddressInfo>();

  constructor(
    private readonly store: AddressStore,
    private readonly chain: ChainReader,
  ) {}

  private async load(a: Address): Promise<AddressInfo | undefined> {
    const k = lower(a);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const v = await this.store.getAddress(k);
    if (v) this.cache.set(k, v);
    return v;
  }

  private async save(info: AddressInfo) {
    this.cache.set(lower(info.address), info);
    await this.store.putAddress(info);
  }

  /** 주소가 이벤트에 등장했음을 기록한다. 같은 위치를 두 번 세지 않는다(멱등). */
  async observe(a: Address, ts: number, block: bigint, pos: string): Promise<AddressInfo> {
    const k = lower(a);
    const cur = await this.load(k);
    if (!cur) {
      const info: AddressInfo = {address: k, firstSeenTs: ts, firstSeenBlock: block, txCount: 1, lastPos: pos, nonce: null, frozen: false};
      await this.save(info);
      return info;
    }
    if (pos > cur.lastPos) {
      const next = {...cur, txCount: cur.txCount + 1, lastPos: pos};
      if (ts < next.firstSeenTs) (next.firstSeenTs = ts), (next.firstSeenBlock = block);
      await this.save(next);
      return next;
    }
    return cur;
  }

  async info(a: Address): Promise<AddressInfo | undefined> {
    return this.load(a);
  }

  /** 토큰 첫 등장이 maxAgeSec 이내이고 체인 nonce가 maxNonce 이하면 신규. 처음 보는 주소도 nonce를 본다. */
  async isNew(a: Address, now: number, maxAgeSec: number, maxNonce: number): Promise<boolean> {
    const k = lower(a);
    if (k === ZERO) return false;
    let info = await this.load(k);
    if (info && info.firstSeenTs < now - maxAgeSec) return false;
    let nonce = info?.nonce ?? null;
    if (nonce === null) {
      nonce = await this.chain.getTransactionCount(k);
      if (info) {
        info = {...info, nonce};
        await this.save(info);
      }
    }
    return nonce <= maxNonce;
  }

  async isFrozen(a: Address): Promise<boolean> {
    return (await this.load(a))?.frozen ?? false;
  }

  async setFrozen(a: Address, frozen: boolean, ts: number, block: bigint): Promise<void> {
    const k = lower(a);
    const cur = (await this.load(k)) ?? {
      address: k,
      firstSeenTs: ts,
      firstSeenBlock: block,
      txCount: 0,
      lastPos: "",
      nonce: null,
      frozen,
    };
    await this.save({...cur, frozen});
  }

  /** 재조직 뒤에는 캐시를 버리고 저장소에서 다시 읽는다. */
  clearCache() {
    this.cache.clear();
  }
}

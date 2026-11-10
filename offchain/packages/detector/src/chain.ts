import type {PublicClient} from "viem";
import {stableTokenAbi} from "@stb/abi";
import type {Address, Hex} from "@stb/common";

/** 룰과 Enricher가 체인에서 읽는 것. 테스트에서는 가짜로 바꾼다. */
export interface ChainReader {
  /** blockNumber 시점의 nonce. 그 블록 상태를 못 읽으면(오래된 블록, 비아카이브 노드) 최신 값으로 대신한다. */
  getTransactionCount(a: Address, blockNumber?: bigint): Promise<number>;
  /** blockNumber를 못 읽으면(아카이브 아님) 최신 잔고로 대신한다. */
  balanceOf(a: Address, blockNumber?: bigint): Promise<bigint>;
  getCode(a: Address): Promise<Hex>;
  isFrozen(a: Address): Promise<boolean>;
}

export function viemChainReader(client: PublicClient, token: Address): ChainReader {
  return {
    async getTransactionCount(a, blockNumber) {
      if (blockNumber === undefined) return client.getTransactionCount({address: a});
      try {
        return await client.getTransactionCount({address: a, blockNumber});
      } catch {
        return client.getTransactionCount({address: a});
      }
    },
    async balanceOf(a, blockNumber) {
      try {
        return await client.readContract({address: token, abi: stableTokenAbi, functionName: "balanceOf", args: [a], blockNumber});
      } catch {
        return client.readContract({address: token, abi: stableTokenAbi, functionName: "balanceOf", args: [a]});
      }
    },
    getCode: async (a) => (await client.getCode({address: a})) ?? "0x",
    isFrozen: (a) => client.readContract({address: token, abi: stableTokenAbi, functionName: "isFrozen", args: [a]}),
  };
}

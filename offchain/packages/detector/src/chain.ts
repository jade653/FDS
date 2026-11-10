import type {PublicClient} from "viem";
import {stableTokenAbi} from "@stb/abi";
import type {Address, Hex} from "@stb/common";

/** 룰과 Enricher가 체인에서 읽는 것. 테스트에서는 가짜로 바꾼다. */
export interface ChainReader {
  getTransactionCount(a: Address): Promise<number>;
  /** blockNumber를 못 읽으면(아카이브 아님) 최신 잔고로 대신한다. */
  balanceOf(a: Address, blockNumber?: bigint): Promise<bigint>;
  getCode(a: Address): Promise<Hex>;
  isFrozen(a: Address): Promise<boolean>;
}

export function viemChainReader(client: PublicClient, token: Address): ChainReader {
  return {
    getTransactionCount: (a) => client.getTransactionCount({address: a}),
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

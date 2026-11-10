export * from "./generated";
import {toFunctionSelector} from "viem";

/** Responder가 서명할 수 있는 유일한 선택자 (design.md 8장). */
export const FREEZE_SELECTOR = toFunctionSelector("freeze(address,bytes32)");
export const FREEZE_BATCH_SELECTOR = toFunctionSelector("freezeBatch(address[],bytes32)");

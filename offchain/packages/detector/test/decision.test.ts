import {describe, expect, it} from "vitest";
import type {Category, Decision, RuleId} from "@stb/common";
import {decide} from "../src/decision";

const thresholds = {auto_freeze: 80, human_review: 50};
const d = (category: Category, score: number, rules: RuleId[] = ["R2"]): Decision =>
  decide({category, score, rules, thresholds});

// design.md 12장: 주소 분류(보호, 핫, 화이트 라벨, 일반)와 점수의 모든 조합에서 8.1 표와 같은지
describe("Decision (8.1 표)", () => {
  const scores = [0, 49, 50, 79, 80, 200];

  it("일반: 80 이상 자동, 50 이상 사람 확인, 그 아래 기록", () => {
    const expected: Decision[] = ["record", "record", "human_review", "human_review", "auto_freeze", "auto_freeze"];
    expect(scores.map((s) => d("normal", s))).toEqual(expected);
  });

  for (const c of ["protected", "whitelabel"] as const) {
    it(`${c}: 점수와 룰에 관계없이 자동 동결하지 않는다`, () => {
      const expected: Decision[] = ["record", "record", "human_review", "human_review", "human_review", "human_review"];
      expect(scores.map((s) => d(c, s))).toEqual(expected);
      expect(scores.map((s) => d(c, s, ["R1", "R6"]))).toEqual(expected);
    });
  }

  it("hot: R1 발동이면 점수와 무관하게 자동 동결", () => {
    for (const s of scores) expect(d("hot", s, ["R1"])).toBe("auto_freeze");
  });

  it("hot: R6 발동이면 점수와 무관하게 자동 동결", () => {
    for (const s of scores) expect(d("hot", s, ["R6"])).toBe("auto_freeze");
  });

  it("hot: 다른 룰만으로 80을 넘으면 사람 확인 (별도 케이스)", () => {
    expect(d("hot", 80, ["R9"])).toBe("human_review");
    expect(d("hot", 130, ["R2", "R4", "R10"])).toBe("human_review");
    expect(d("hot", 40, ["R2"])).toBe("record");
  });
});

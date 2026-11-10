import type {Category, Decision, RuleId} from "@stb/common";

export interface DecisionInput {
  category: Category;
  score: number;
  /** 윈도우 안에서 발동한 룰 */
  rules: readonly RuleId[];
  thresholds: {auto_freeze: number; human_review: number};
}

/**
 * 점수와 정책으로 자동 동결 / 사람 확인 / 기록만 중 하나를 고른다 (design.md 7.3, 8.1). 순수 함수.
 *
 * - protected, whitelabel: 자동 동결하지 않는다. 사람 확인 점수 이상이면 사람에게 넘긴다.
 * - hot: 점수가 아니라 룰로 결정한다. R1 또는 R6이 발동하면 자동 동결. 그 외에는 점수가 80을 넘어도 사람 확인.
 * - normal: 80 이상 자동 동결, 50 이상 사람 확인, 그 아래 기록만.
 */
export function decide({category, score, rules, thresholds}: DecisionInput): Decision {
  const review = score >= thresholds.human_review ? "human_review" : "record";
  switch (category) {
    case "protected":
    case "whitelabel":
      return review;
    case "hot":
      if (rules.includes("R1") || rules.includes("R6")) return "auto_freeze";
      return review;
    case "normal":
      return score >= thresholds.auto_freeze ? "auto_freeze" : review;
  }
}

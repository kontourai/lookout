import type { ReviewItem } from "@kontourai/survey";
import type { SemanticReviewItem, SemanticReviewWork } from "../../src/index.js";

declare const item: SemanticReviewItem;
declare const work: SemanticReviewWork;
const compatible: ReviewItem = item;
const compatibleBatch: readonly ReviewItem[] = work.items;
void [compatible, compatibleBatch];
